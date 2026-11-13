import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import { decodeBuildCode, fetchBuildFromURL } from './build-source.js';
import { ResolvedPaths } from './paths.js';
import { inspectPoBInstall } from './pob-install.js';
import { startTimer } from './timing.js';
import { UserError } from './validation.js';

export interface BuildInfo {
  class?: string;
  ascendancy?: string;
  level?: number;
  mainSkill?: string;
  /** Tree version of the loaded build, when the bridge reports it. */
  treeVersion?: string;
  /** Latest tree version known to the running PoB, when the bridge reports it. */
  latestTreeVersion?: string;
}

/** Thrown to a call that was queued or in flight when its engine was replaced. */
export const ENGINE_REPLACED_MESSAGE =
  'The Path of Building engine was restarted (reload_engine / configure_pob_path / shutdown) while this ' +
  'call was queued or running. Retry the call.';

export interface Stats {
  [key: string]: number | string | boolean | null | undefined;
}

export interface VerifyDataResult {
  treeNodes: number;
  gemsLoaded: boolean;
  itemBasesLoaded: boolean;
  paths: {
    script: string;
    runtime: string;
    user: string;
    workDir: string;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
}

// Build-code and URL handling lives in build-source.ts; re-exported for existing importers.
export { decodeBuildCode, encodeBuildCode, fetchBuildFromURL } from './build-source.js';

function waitForExit(proc: ChildProcess, ms: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    proc.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * Directory LuaJIT is spawned in. PoB loads its files relative to the directory
 * holding Launch.lua: the install root for an installed layout, `src/` for a
 * source clone. Layout detection is `inspectPoBInstall`'s; anything it does not
 * accept keeps the install root (the engine will not boot from it anyway).
 */
export function bridgeWorkingDir(pobPath: string): string {
  const inspected = inspectPoBInstall(pobPath);
  return inspected.ok && inspected.info.layout === 'source' ? path.join(pobPath, 'src') : pobPath;
}

export class LuaBridge {
  private process: ChildProcess | null = null;
  private readonly pobPath: string;
  private readonly luajitPath: string;
  private readonly bridgeLua: string;
  private readonly timeoutMs: number;
  private readonly stderrLines: string[] = [];
  private pending: PendingRequest | null = null;
  private lastLoadedXML: { xml: string; name?: string } | null = null;
  private starting: Promise<void> | null = null;
  private readyResolve: { resolve: () => void; reject: (err: Error) => void; timeout: NodeJS.Timeout } | null = null;
  private stdoutBuffer = '';
  private crashCount = 0;
  private readonly maxCrashes = 3;
  private successesSinceCrash = 0;
  private disposed = false;
  /** Process handle captured by dispose(), so forceKill() still reaches it after references are cleared. */
  private retiredProcess: ChildProcess | null = null;
  // After this many clean round-trips since the last crash, treat the
  // process as healthy again and reset crashCount — otherwise a long-running
  // session accumulates strikes from unrelated transient hiccups until it
  // trips the breaker on a real problem.
  private readonly successesToClearCrashes = 5;

  constructor(paths: ResolvedPaths, timeoutMs = 30_000, options: { initialCrashCount?: number } = {}) {
    this.pobPath = paths.pobPath;
    this.luajitPath = paths.luajitPath;
    this.bridgeLua = paths.bridgeLua;
    this.timeoutMs = timeoutMs;
    // Carried over from a previous bridge for the same paths so the three-strike
    // breaker can't be reset by swapping bridge instances.
    this.crashCount = options.initialCrashCount ?? 0;
  }

  async start(): Promise<void> {
    if (this.disposed) {
      throw new UserError(ENGINE_REPLACED_MESSAGE);
    }
    if (this.process && !this.process.killed) {
      return;
    }
    if (this.crashCount >= this.maxCrashes) {
      throw new Error(
        `Lua engine has crashed ${this.crashCount} times — refusing to restart. ` +
          `Restart the server process to clear this state.`,
      );
    }
    if (this.starting) {
      return this.starting;
    }

    this.starting = this.spawnProcess();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed && this.process.exitCode === null;
  }

  /** Number of times the underlying luajit process has died unexpectedly this session. */
  getCrashCount(): number {
    return this.crashCount;
  }

  /** True once the three-strike crash breaker has tripped. */
  isCircuitOpen(): boolean {
    return this.crashCount >= this.maxCrashes;
  }

  /** PID of the live LuaJIT process, if any (tests / diagnostics). */
  getPid(): number | undefined {
    return this.process?.pid;
  }

  /**
   * Shut the process down and refuse any future (re)start. Used when the
   * engine is replaced, so a call still holding the old session can never
   * spawn a second LuaJIT process. Always ends with the captured process
   * handle killed (unless it already exited), and any in-flight call
   * rejected with a retry UserError.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    const proc = this.process;
    this.retiredProcess = proc;
    // Graceful shutdown only when nothing is in flight — otherwise send() would
    // refuse ("one in-flight command") and leave the process running.
    if (proc && !this.pending && !this.starting && this.isRunning()) {
      try {
        await this.send({ cmd: 'shutdown' }, 5_000);
      } catch {
        // fall through to the hard kill
      }
      await waitForExit(proc, 2_000);
    }
    this.disposed = true;
    const retry = new UserError(ENGINE_REPLACED_MESSAGE);
    this.failPending(retry, retry);
    this.forceKill();
  }

  /** Synchronous hard kill of the live process and of any process captured by dispose(). */
  forceKill(): void {
    for (const proc of [this.process, this.retiredProcess]) {
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    }
    if (this.process) this.cleanupProcessReferences();
  }

  async send<T = unknown>(command: object, timeoutOverrideMs?: number): Promise<T> {
    await this.start();

    if (!this.process?.stdin?.writable) {
      throw new Error('Lua bridge stdin is not writable');
    }
    if (this.pending) {
      throw new Error('Lua bridge only supports one in-flight command at a time');
    }

    const cmdName =
      typeof (command as { cmd?: unknown }).cmd === 'string' ? (command as { cmd: string }).cmd : 'unknown';
    const stopTimer = startTimer(`bridge.${cmdName}`);
    const effectiveTimeout = timeoutOverrideMs ?? this.timeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending = null;
        const stderr = this.getStderr();
        this.killProcess();
        stopTimer();
        reject(
          new Error(
            `Lua bridge timeout after ${effectiveTimeout}ms on cmd "${cmdName}"` +
              (stderr ? `\nStderr tail:\n${stderr.split('\n').slice(-10).join('\n')}` : ''),
          ),
        );
      }, effectiveTimeout);

      this.pending = {
        resolve: (value) => {
          stopTimer();
          if (this.crashCount > 0) {
            this.successesSinceCrash++;
            if (this.successesSinceCrash >= this.successesToClearCrashes) {
              this.crashCount = 0;
              this.successesSinceCrash = 0;
            }
          }
          resolve(value as T);
        },
        reject: (reason) => {
          stopTimer();
          reject(reason);
        },
        timeout,
      };

      this.process?.stdin?.write(`${JSON.stringify(command)}\n`, (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending = null;
          stopTimer();
          reject(error);
        }
      });
    });
  }

  async loadBuildXML(xml: string, name?: string): Promise<BuildInfo> {
    this.lastLoadedXML = { xml, name };
    const result = await this.send<{ ok: true; info: BuildInfo }>({ cmd: 'loadXML', xml, name });
    return result.info;
  }

  async loadBuildCode(code: string, name?: string): Promise<BuildInfo> {
    return this.loadBuildXML(decodeBuildCode(code), name);
  }

  async loadBuildFromURL(url: string, name?: string): Promise<BuildInfo> {
    return this.loadBuildXML(await fetchBuildFromURL(url), name);
  }

  async getStats(): Promise<Stats> {
    const result = await this.send<{ ok: true; stats: Stats }>({ cmd: 'getStats' });
    return result.stats;
  }

  async getConfig(): Promise<Record<string, unknown>> {
    const result = await this.send<{ ok: true; config: Record<string, unknown> }>({ cmd: 'getConfig' });
    return result.config;
  }

  async setConfig(options: Record<string, unknown>): Promise<Stats> {
    const result = await this.send<{ ok: true; stats: Stats }>({ cmd: 'setConfig', options });
    return result.stats;
  }

  async verifyData(): Promise<VerifyDataResult> {
    const result = await this.send<{ ok: true; data: VerifyDataResult }>({ cmd: 'verifyData' });
    return result.data;
  }

  async shutdown(): Promise<void> {
    if (!this.process) {
      return;
    }

    try {
      await this.send({ cmd: 'shutdown' });
    } catch (error) {
      if (this.isRunning()) {
        throw error;
      }
    } finally {
      this.cleanupProcessReferences();
    }
  }

  killProcess(): void {
    const proc = this.process;
    if (proc && this.isRunning()) {
      this.process = null; // Clear reference immediately so stale handlers don't interfere
      this.stdoutBuffer = '';
      proc.kill('SIGKILL');
    }
  }

  getStderr(): string {
    return this.stderrLines.join('\n');
  }

  private async spawnProcess(): Promise<void> {
    const bridgePath = this.bridgeLua;
    // Run from the directory holding Launch.lua: PoB opens Modules/, Data/ and
    // manifest.xml relative to the working directory. That is the install root
    // for an installed layout and `src/` for a source clone (bridge.lua sets
    // package.path for both, but cannot change the process's working directory).
    const cwd = bridgeWorkingDir(this.pobPath);

    this.stderrLines.length = 0;
    this.stdoutBuffer = '';
    const proc = spawn(this.luajitPath, [bridgePath, this.pobPath], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = proc;

    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        this.stderrLines.push(line);
      }
    });

    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      if (this.process !== proc) return; // Stale process
      this.stdoutBuffer += chunk;
      this.processLines();
    });

    proc.on('exit', (code, signal) => {
      if (this.process !== proc) return; // Stale process — don't touch new state
      // Track unexpected exits (anything other than a clean shutdown).
      if (code !== 0 || signal) {
        this.crashCount++;
        this.successesSinceCrash = 0;
      }
      this.failPending(
        new Error(`Lua bridge exited during init (code=${code}, signal=${signal}). Stderr:\n${this.getStderr()}`),
        new Error(`Lua bridge exited unexpectedly. Stderr:\n${this.getStderr()}`),
      );
    });

    proc.on('error', (error) => {
      if (this.process !== proc) return; // Stale process
      this.failPending(error, error);
    });

    if (!proc.stdout) {
      throw new Error('Lua bridge stdout was not created');
    }

    await this.waitForReady();

    if (this.lastLoadedXML) {
      const loaded = this.lastLoadedXML;
      this.lastLoadedXML = null;
      await this.loadBuildXML(loaded.xml, loaded.name);
    }
  }

  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.readyResolve = null;
        reject(new Error(`Lua bridge init timeout after ${this.timeoutMs}ms. Stderr:\n${this.getStderr()}`));
      }, this.timeoutMs);
      this.readyResolve = { resolve, reject, timeout };
    });
  }

  private processLines(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    // Handle ready message during init
    if (this.readyResolve) {
      const ready = this.readyResolve;
      this.readyResolve = null;
      clearTimeout(ready.timeout);
      try {
        const result = JSON.parse(line) as { ok?: boolean; ready?: boolean; error?: string };
        if (result.error) {
          ready.reject(new Error(result.error));
        } else if (result.ok && result.ready) {
          ready.resolve();
        } else {
          ready.reject(new Error(`Unexpected Lua bridge init response: ${line}`));
        }
      } catch (error) {
        ready.reject(new Error(`Invalid JSON from Lua during init: ${line}; ${String(error)}`));
      }
      return;
    }

    if (!this.pending) {
      return;
    }

    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timeout);

    try {
      const result = JSON.parse(line) as {
        error?: string;
        userError?: boolean;
      };
      if (result.error) {
        // The Lua side already strips its own source-path prefixes; this is a
        // defensive fallback for any path that slips through (nested errors).
        const cleaned = String(result.error).replace(/^[^:]*\.lua:\d+:\s*/, '');
        pending.reject(result.userError ? new UserError(cleaned) : new Error(cleaned));
      } else {
        pending.resolve(result);
      }
    } catch (error) {
      pending.reject(new Error(`Invalid JSON from Lua: ${line}; ${String(error)}`));
    }
  }

  private cleanupProcessReferences(): void {
    this.process = null;
    this.stdoutBuffer = '';
  }

  private failPending(readyErr: Error, pendingErr: Error): void {
    if (this.readyResolve) {
      clearTimeout(this.readyResolve.timeout);
      this.readyResolve.reject(readyErr);
      this.readyResolve = null;
    }
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.reject(pendingErr);
      this.pending = null;
    }
    this.cleanupProcessReferences();
  }
}
