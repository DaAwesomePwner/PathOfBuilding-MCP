import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import { decodeBuildCode, fetchBuildFromURL } from './build-source.js';
import { circuitOpen, engineDown, MAX_CRASHES } from './engine-messages.js';
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

/** What a respawn after a crash or timeout put back into the new engine process. */
export interface RespawnReport {
  /** Strikes counted so far (the breaker opens at MAX_CRASHES). */
  crashCount: number;
  /** 'build': the recovery build was reloaded; 'none': no build had been loaded; 'failed': it could not be reloaded. */
  restored: 'build' | 'none' | 'failed';
  info?: BuildInfo;
  error?: string;
}

export interface LuaBridgeOptions {
  /** Strike count carried over from a previous bridge for the same paths (CrashLedger). */
  initialCrashCount?: number;
  /**
   * Test-only fault names for lua/bridge.lua (POB_MCP_TEST_FAULTS). Only this
   * option sets it for the LuaJIT child; the server's own environment value is
   * never passed through.
   */
  testFaults?: string;
}

const TEST_FAULTS_ENV = 'POB_MCP_TEST_FAULTS';

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
  /**
   * What a respawned process is given back: the last build the engine
   * accepted (loadBuildXML; never a build it rejected) and the committed
   * commands applied to it since (recordCommitted), replayed in order. Kept as
   * commands rather than a fresh export because PoB's save re-parses every
   * item of the live build.
   */
  private recoveryBuild: { xml: string; name?: string } | null = null;
  private recoveryOps: object[] = [];
  private starting: Promise<void> | null = null;
  private readyResolve: { resolve: () => void; reject: (err: Error) => void; timeout: NodeJS.Timeout } | null = null;
  private stdoutBuffer = '';
  /**
   * Strikes: unexpected exits (any exit not asked for with a shutdown
   * command), command timeouts, and failed or timed-out startups of a process
   * that ran. Never forgiven by later successes; a count starts over only
   * with a new bridge whose CrashLedger entry was cleared (the PoB install
   * changed on disk) or in a new server process.
   */
  private crashCount = 0;
  private disposed = false;
  /** Process handle captured by dispose(), so forceKill() still reaches it after references are cleared. */
  private retiredProcess: ChildProcess | null = null;
  private readonly testFaults: string | undefined;
  /** Processes that reached "ready". A start after the first is a respawn. */
  private spawnCount = 0;
  private respawnReport: RespawnReport | null = null;
  /** While set, send() refuses to respawn a dead process (see setRespawnHeld). */
  private respawnHeld = false;
  /** A shutdown command was sent to the live process, so its exit is expected. */
  private shutdownRequested = false;

  constructor(paths: ResolvedPaths, timeoutMs = 30_000, options: LuaBridgeOptions = {}) {
    this.pobPath = paths.pobPath;
    this.luajitPath = paths.luajitPath;
    this.bridgeLua = paths.bridgeLua;
    this.timeoutMs = timeoutMs;
    // Carried over from a previous bridge for the same paths so the three-strike
    // breaker can't be reset by swapping bridge instances.
    this.crashCount = options.initialCrashCount ?? 0;
    this.testFaults = options.testFaults;
  }

  async start(): Promise<void> {
    if (this.disposed) {
      throw new UserError(ENGINE_REPLACED_MESSAGE);
    }
    if (this.process && !this.process.killed) {
      return;
    }
    if (this.crashCount >= MAX_CRASHES) {
      throw new UserError(circuitOpen(this.crashCount));
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
    return this.crashCount >= MAX_CRASHES;
  }

  /** Number of engine processes that reached "ready" (above 1 means the engine was respawned). */
  getSpawnCount(): number {
    return this.spawnCount;
  }

  /**
   * The report of a respawn nobody has handled yet; reading it clears it. A
   * successful loadBuildXML clears it too: the new build replaces whatever
   * the respawn restored.
   */
  takeRespawnReport(): RespawnReport | null {
    const r = this.respawnReport;
    this.respawnReport = null;
    return r;
  }

  /**
   * While held, a send() that finds the process dead (it exited, or was
   * killed after a timeout) fails instead of starting a new one, so a
   * multi-command operation never carries on against a fresh engine with the
   * old engine's state in hand. BuildSession holds it for the body of every
   * locked operation and respawns only at the start of the next one.
   */
  setRespawnHeld(held: boolean): void {
    this.respawnHeld = held;
  }

  /** The build XML a respawn reloads before replaying committed commands (null when none was accepted). */
  getRecoveryXML(): string | null {
    return this.recoveryBuild?.xml ?? null;
  }

  /** Record a command the engine just completed as a committed change, replayed after a respawn. */
  recordCommitted(command: object): void {
    if (this.recoveryBuild) this.recoveryOps.push(command);
  }

  /** Number of committed commands recorded since the last accepted load. */
  committedCount(): number {
    return this.recoveryOps.length;
  }

  /** Forget committed commands past the first `count` (an undo reverted them). */
  truncateCommitted(count: number): void {
    if (count < this.recoveryOps.length) this.recoveryOps.length = Math.max(0, count);
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
    if (this.respawnHeld && this.spawnCount > 0 && !this.isRunning() && !this.disposed) {
      throw new Error(engineDown(this.crashCount));
    }
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

    if (cmdName === 'shutdown') this.shutdownRequested = true;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending = null;
        const stderr = this.getStderr();
        // The process may be stuck mid-command with half-changed state: it is
        // killed, and the timeout counts as a strike like a crash.
        const strike = this.isRunning() && !this.shutdownRequested;
        this.killProcess();
        if (strike) this.crashCount++;
        stopTimer();
        reject(
          new Error(
            `Lua bridge timeout after ${effectiveTimeout}ms on cmd "${cmdName}"` +
              (strike ? ` (the engine was stopped; strike ${this.crashCount} of ${MAX_CRASHES})` : '') +
              (stderr ? `\nStderr tail:\n${stderr.split('\n').slice(-10).join('\n')}` : ''),
          ),
        );
      }, effectiveTimeout);

      this.pending = {
        resolve: (value) => {
          stopTimer();
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
    const result = await this.send<{ ok: true; info: BuildInfo }>({ cmd: 'loadXML', xml, name });
    // Recorded only once the engine accepted it: a rejected build is never replayed.
    this.recoveryBuild = { xml, name };
    this.recoveryOps = [];
    this.respawnReport = null;
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
    this.shutdownRequested = false;
    const proc = spawn(this.luajitPath, [bridgePath, this.pobPath], {
      cwd,
      env: this.childEnv(),
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
      // Every exit not asked for with a shutdown command is a strike.
      const unexpected = !this.shutdownRequested;
      if (unexpected) this.crashCount++;
      const strike = unexpected ? ` (strike ${this.crashCount} of ${MAX_CRASHES})` : '';
      this.failPending(
        new Error(`Lua bridge exited during init (code=${code}, signal=${signal})${strike}. Stderr:\n${this.getStderr()}`),
        new Error(`Lua bridge exited unexpectedly (code=${code}, signal=${signal})${strike}. Stderr:\n${this.getStderr()}`),
      );
    });

    proc.on('error', (error) => {
      if (this.process !== proc) return; // Stale process
      this.failPending(error, error);
    });

    if (!proc.stdout) {
      throw new Error('Lua bridge stdout was not created');
    }

    try {
      await this.waitForReady();
    } catch (error) {
      // A failed or timed-out startup of a process that is still alive: never
      // leave it running unready. It ran and could not be used, so it is a
      // strike (an exit during init was already counted by the exit handler).
      if (this.process === proc) {
        this.killProcess(); // no-op if it already exited
        this.cleanupProcessReferences(); // so a queued exit event is not counted again
        this.crashCount++;
      }
      throw error;
    }

    const respawn = this.spawnCount > 0;
    this.spawnCount++;
    if (respawn) await this.restoreAfterRespawn();
  }

  /**
   * Give a respawned process the recovery build back: the accepted XML, then
   * every committed command in order. A crash or timeout while doing so is
   * thrown (and already counted); anything the new engine refuses is
   * reported as 'failed' and the recovery state is dropped.
   */
  private async restoreAfterRespawn(): Promise<void> {
    const build = this.recoveryBuild;
    if (!build) {
      this.respawnReport = { crashCount: this.crashCount, restored: 'none' };
      return;
    }
    const ops = [...this.recoveryOps];
    let step = 'reloading the build';
    try {
      await this.send({ cmd: 'loadXML', xml: build.xml, name: build.name });
      for (let i = 0; i < ops.length; i++) {
        step = `replaying committed change ${i + 1} of ${ops.length} (${(ops[i] as { cmd?: string }).cmd})`;
        await this.send(ops[i]);
      }
      step = 'reading the build info';
      const info = await this.send<{ ok: true; info: BuildInfo }>({ cmd: 'getBuildInfo' });
      this.respawnReport = { crashCount: this.crashCount, restored: 'build', info: info.info };
    } catch (error) {
      if (!this.isRunning()) throw error;
      this.recoveryBuild = null;
      this.recoveryOps = [];
      this.respawnReport = { crashCount: this.crashCount, restored: 'failed', error: `${step}: ${(error as Error).message}` };
    }
  }

  /** The server's environment without the test fault switch, plus this bridge's own test faults, if any. */
  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.toUpperCase() !== TEST_FAULTS_ENV) env[key] = value;
    }
    if (this.testFaults) env[TEST_FAULTS_ENV] = this.testFaults;
    return env;
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
