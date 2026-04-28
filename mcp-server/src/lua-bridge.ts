import { Buffer } from 'buffer';
import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { deflateRawSync, inflateRawSync, inflateSync } from 'zlib';
import { startTimer } from './timing.js';

export interface BuildInfo {
  class?: string;
  ascendancy?: string;
  level?: number;
  mainSkill?: string;
}

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

export function encodeBuildCode(xml: string): string {
  const compressed = deflateRawSync(Buffer.from(xml, 'utf-8'));
  return compressed.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

export function decodeBuildCode(code: string): string {
  if (!code.trim()) {
    throw new Error('Build code is empty');
  }

  const normalized = code.trim().replace(/-/g, '+').replace(/_/g, '/');
  const buffer = Buffer.from(normalized, 'base64');

  try {
    return inflateRawSync(buffer).toString('utf-8');
  } catch {
    return inflateSync(buffer).toString('utf-8');
  }
}

export async function fetchBuildFromURL(url: string): Promise<string> {
  if (url.includes('pastebin.com')) {
    const id = url.split('/').filter(Boolean).pop();
    if (!id) {
      throw new Error(`Unable to determine pastebin id from URL: ${url}`);
    }
    const rawUrl = `https://pastebin.com/raw/${id}`;
    const resp = await fetch(rawUrl);
    if (!resp.ok) {
      throw new Error(`Failed to fetch pastebin build: ${resp.status} ${resp.statusText}`);
    }
    const code = await resp.text();
    return decodeBuildCode(code.trim());
  }

  if (url.includes('pobb.in')) {
    const resp = await fetch(url, { headers: { Accept: 'text/plain' } });
    if (!resp.ok) {
      throw new Error(`Failed to fetch pobb.in build: ${resp.status} ${resp.statusText}`);
    }
    const code = await resp.text();
    return decodeBuildCode(code.trim());
  }

  throw new Error(`Unsupported URL: ${url}`);
}

export class LuaBridge {
  private process: ChildProcess | null = null;
  private readonly repoRoot: string;
  private readonly luajitPath: string;
  private readonly timeoutMs: number;
  private readonly stderrLines: string[] = [];
  private pending: PendingRequest | null = null;
  private lastLoadedXML: { xml: string; name?: string } | null = null;
  private starting: Promise<void> | null = null;
  private readyResolve: { resolve: () => void; reject: (err: Error) => void; timeout: NodeJS.Timeout } | null = null;
  private stdoutBuffer = '';
  private crashCount = 0;
  private readonly maxCrashes = 3;

  constructor(repoRoot: string, luajitPath?: string, timeoutMs = 30_000) {
    this.repoRoot = repoRoot;
    this.luajitPath = luajitPath ?? this.findLuaJITPath();
    this.timeoutMs = timeoutMs;
  }

  async start(): Promise<void> {
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
    const bridgePath = path.join(this.repoRoot, 'mcp-server', 'lua', 'bridge.lua');
    const srcCwd = path.join(this.repoRoot, 'src');

    this.stderrLines.length = 0;
    this.stdoutBuffer = '';
    const proc = spawn(this.luajitPath, [bridgePath, this.repoRoot], {
      cwd: srcCwd,
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
      }
      if (this.readyResolve) {
        clearTimeout(this.readyResolve.timeout);
        this.readyResolve.reject(new Error(`Lua bridge exited during init (code=${code}, signal=${signal}). Stderr:\n${this.getStderr()}`));
        this.readyResolve = null;
      }
      if (this.pending) {
        clearTimeout(this.pending.timeout);
        this.pending.reject(new Error(`Lua bridge exited unexpectedly. Stderr:\n${this.getStderr()}`));
        this.pending = null;
      }
      this.cleanupProcessReferences();
    });

    proc.on('error', (error) => {
      if (this.process !== proc) return; // Stale process
      if (this.readyResolve) {
        clearTimeout(this.readyResolve.timeout);
        this.readyResolve.reject(error);
        this.readyResolve = null;
      }
      if (this.pending) {
        clearTimeout(this.pending.timeout);
        this.pending.reject(error);
        this.pending = null;
      }
      this.cleanupProcessReferences();
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
      const result = JSON.parse(line);
      if (result.error) {
        // Strip lua source path/line prefixes like "...path/file.lua:123: " so
        // surface-level error messages are user-readable.
        const cleaned = String(result.error).replace(/^\.\.\.[^:]*\.lua:\d+:\s*/, '').replace(/^[^:]*\.lua:\d+:\s*/, '');
        pending.reject(new Error(cleaned));
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

  private findLuaJITPath(): string {
    const candidates = [
      path.join(this.repoRoot, 'runtime', 'luajit'),
      path.join(this.repoRoot, 'runtime', 'bin', 'luajit'),
      path.join(this.repoRoot, 'runtime', 'win32', 'lua51.dll'),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return 'luajit';
  }
}
