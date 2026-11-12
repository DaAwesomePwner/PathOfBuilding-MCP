import { BuildSession } from './build-session.js';
import { configFilePath, loadConfig, saveConfig } from './config-store.js';
import * as msg from './engine-messages.js';
import { BuildInfo, LuaBridge } from './lua-bridge.js';
import {
  bridgeLuaPath,
  FullyResolvedPaths,
  luajitAt,
  LuaJITNotFoundError,
  PathSource,
  PoBInstallNotFoundError,
  resolveLuaJIT,
  resolvePoB,
  ResolveOptions,
  ResolvedPaths,
  validatePoBPath,
} from './paths.js';
import {
  detectUpdateState,
  fingerprintInstall,
  InstallFingerprint,
  installChanged,
  inspectPoBInstall,
  PoBInstallInfo,
} from './pob-install.js';
import { UserError } from './validation.js';

/** Engine is not usable right now; the message tells the model exactly what to do. */
export class EngineNotReadyError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = 'EngineNotReadyError';
  }
}

export type EngineStatus = 'unconfigured' | 'stopped' | 'starting' | 'ready' | 'failed' | 'stale' | 'updating';

/** Asks the user for a path (MCP elicitation). Resolves to an error message, or null on success. */
export type PathPrompt = () => Promise<{ configured: boolean; message?: string }>;

export interface EngineManagerOptions {
  env?: NodeJS.ProcessEnv;
  bridgeFactory?: (paths: ResolvedPaths) => LuaBridge;
  log?: (line: string) => void;
  /** Extra resolve options (tests inject probe tables). */
  resolveOptions?: Partial<ResolveOptions>;
}

export interface ReloadResult {
  oldVersion: string | null;
  newVersion: string | null;
  pobPath: string;
  luajitPath: string;
  buildReloaded: boolean;
  build: BuildInfo | null;
  buildError?: string;
}

export class EngineManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly bridgeFactory: (paths: ResolvedPaths) => LuaBridge;
  private readonly log: (line: string) => void;
  private readonly resolveOptions: Partial<ResolveOptions>;

  private paths: FullyResolvedPaths | null = null;
  private resolveError: string | null = null;
  private bridge: LuaBridge | null = null;
  private session: BuildSession | null = null;
  private booting: Promise<void> | null = null;
  private bootError: string | null = null;
  private startFingerprint: InstallFingerprint | null = null;
  private startedAt: string | null = null;
  private carryXML: string | null = null;
  private lastCarry: { info: BuildInfo | null; error?: string } | null = null;
  private transition: Promise<unknown> | null = null;
  private pathPrompt: PathPrompt | null = null;
  private prompted = false;
  private initDone = false;

  constructor(opts: EngineManagerOptions = {}) {
    this.env = opts.env ?? process.env;
    this.bridgeFactory = opts.bridgeFactory ?? ((p) => new LuaBridge(p, 60_000));
    this.log = opts.log ?? ((line) => process.stderr.write(`pob-mcp-server: ${line}\n`));
    this.resolveOptions = opts.resolveOptions ?? {};
  }

  setPathPrompt(prompt: PathPrompt | null): void {
    this.pathPrompt = prompt;
  }

  /** Resolve paths (env → saved config → auto-detect) and boot in the background. Never throws. */
  init(): void {
    if (this.initDone) return;
    this.initDone = true;
    if (this.paths || this.transition) return; // configure_pob_path already ran
    const saved = loadConfig(this.env);
    const opts: ResolveOptions = {
      env: this.env,
      savedPoBPath: saved.pobPath,
      savedLuaJITPath: saved.luajitPath,
      ...this.resolveOptions,
    };
    let pobNote = '';
    try {
      const pob = resolvePoB(opts);
      pobNote = `Found Path of Building ${pob.info.version ?? '(unknown version)'} at ${pob.info.dir}, but LuaJIT is missing.\n`;
      const lj = resolveLuaJIT(pob.info.dir, opts);
      this.setPaths(pob.info.dir, lj.luajitPath, pob.source, lj.source);
      this.log(`using PoB at ${pob.info.dir} (${pob.source}), LuaJIT ${lj.luajitPath} (${lj.source})`);
      void this.boot().catch(() => undefined); // failure recorded in bootError
    } catch (e) {
      const known = e instanceof PoBInstallNotFoundError || e instanceof LuaJITNotFoundError;
      const text = e instanceof Error ? e.message : String(e);
      this.resolveError =
        (e instanceof LuaJITNotFoundError ? pobNote : '') + (known ? text : `Path discovery failed: ${text}`);
      this.log(`not configured yet — engine tools will ask for the PoB folder.\n${this.resolveError}`);
    }
  }

  private setPaths(pobPath: string, luajitPath: string, pobSource: PathSource, luajitSource: PathSource): void {
    const r = inspectPoBInstall(pobPath);
    if (!r.ok) throw new PoBInstallNotFoundError(r.message);
    this.paths = { pobPath, luajitPath, bridgeLua: bridgeLuaPath(), pobSource, luajitSource, pobInfo: r.info };
    this.resolveError = null;
  }

  private boot(): Promise<void> {
    if (this.booting) return this.booting;
    const paths = this.paths;
    if (!paths) return Promise.reject(new EngineNotReadyError(msg.unconfigured(this.resolveError)));
    const run = (async () => {
      if (detectUpdateState(paths.pobPath) === 'applying') {
        throw new EngineNotReadyError(msg.updating(paths.pobPath));
      }
      if (!this.bridge) {
        this.bridge = this.bridgeFactory(paths);
        this.session = new BuildSession(this.bridge);
      }
      const fp = fingerprintInstall(paths.pobPath); // before start, so an update mid-boot is caught
      await this.bridge.start();
      this.startFingerprint = fp;
      this.startedAt = new Date().toISOString();
      this.bootError = null;
      this.log(
        `engine started: Path of Building ${fp.version ?? '(unknown version)'} ` +
          `(${paths.pobInfo.layout} layout) at ${paths.pobPath}; LuaJIT ${paths.luajitPath}`,
      );
      if (this.carryXML && this.session) {
        const xml = this.carryXML;
        this.carryXML = null;
        try {
          this.lastCarry = { info: await this.session.loadBuild(xml) };
        } catch (e) {
          this.lastCarry = { info: null, error: (e as Error).message };
          this.log(`could not reload the previous build into the new engine: ${(e as Error).message}`);
        }
      }
    })();
    this.booting = run;
    run.then(
      () => undefined,
      (e: unknown) => {
        this.bootError = e instanceof Error ? e.message : String(e);
        this.log(`engine failed to start: ${this.bootError}`);
      },
    ).finally(() => {
      if (this.booting === run) this.booting = null;
    });
    return run;
  }

  /** Gate for every engine-backed tool. Returns the live session or throws EngineNotReadyError. */
  async ensureReady(): Promise<BuildSession> {
    this.init(); // no-op after the first call
    if (this.transition) await this.transition.catch(() => undefined);
    if (!this.paths) {
      let extra: string | undefined;
      if (this.pathPrompt && !this.prompted) {
        this.prompted = true;
        const r = await this.pathPrompt().catch((e: unknown) => ({ configured: false, message: String(e) }));
        if (r.configured && this.paths) return this.ensureReady();
        extra = r.message;
      }
      throw new EngineNotReadyError(msg.unconfigured(this.resolveError, extra));
    }
    const paths: FullyResolvedPaths = this.paths;
    if (detectUpdateState(paths.pobPath) === 'applying') {
      throw new EngineNotReadyError(msg.updating(paths.pobPath));
    }
    if (this.startFingerprint) {
      const current = fingerprintInstall(paths.pobPath);
      if (installChanged(this.startFingerprint, current)) {
        throw new EngineNotReadyError(msg.stale(this.startFingerprint, current, paths.pobPath));
      }
    } else {
      try {
        await this.boot();
      } catch (e) {
        if (e instanceof EngineNotReadyError) throw e;
        throw new EngineNotReadyError(msg.bootFailed(paths, (e as Error).message));
      }
    }
    if (!this.session) throw new EngineNotReadyError(msg.unconfigured(this.resolveError));
    return this.session;
  }

  /** Serialize engine swaps; tool calls wait for an in-progress swap in ensureReady. */
  private async runTransition<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.transition ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.transition = run;
    try {
      return await run;
    } finally {
      if (this.transition === run) this.transition = null;
    }
  }

  /** Export the loaded build (if any) from the current engine so it survives a restart. */
  private async exportCurrentBuild(): Promise<string | null> {
    if (this.carryXML) return this.carryXML;
    if (!this.session || !this.startFingerprint) return null;
    try {
      await this.session.getBuildInfo(); // throws UserError when no build is loaded
    } catch {
      return null;
    }
    try {
      return await this.session.exportXML();
    } catch (e) {
      this.log(`could not export the current build before restart: ${(e as Error).message}`);
      return null;
    }
  }

  private async stopEngine(): Promise<void> {
    if (this.booting) await this.booting.catch(() => undefined);
    const bridge = this.bridge;
    this.bridge = null;
    this.session = null;
    this.startFingerprint = null;
    this.startedAt = null;
    if (bridge) await bridge.dispose();
  }

  private async restartWith(next: FullyResolvedPaths | null): Promise<void> {
    const xml = await this.exportCurrentBuild();
    await this.stopEngine();
    if (next) this.paths = next;
    this.carryXML = xml;
    this.lastCarry = null;
    await this.boot();
  }

  private carryResult(): Pick<ReloadResult, 'buildReloaded' | 'build' | 'buildError'> {
    const c = this.lastCarry;
    return { buildReloaded: !!c?.info, build: c?.info ?? null, ...(c?.error ? { buildError: c.error } : {}) };
  }

  /** Restart LuaJIT against the on-disk install, carrying the current build over. */
  async reload(): Promise<ReloadResult> {
    return this.runTransition(async () => {
      if (!this.paths) throw new EngineNotReadyError(msg.unconfigured(this.resolveError));
      if (this.bridge?.isCircuitOpen()) throw new UserError(msg.circuitOpen());
      const r = inspectPoBInstall(this.paths.pobPath);
      if (!r.ok) throw new UserError(`Cannot reload: ${r.message}`);
      if (detectUpdateState(this.paths.pobPath) === 'applying') throw new EngineNotReadyError(msg.updating(this.paths.pobPath));
      const oldVersion = this.startFingerprint?.version ?? null;
      try {
        await this.restartWith({ ...this.paths, pobInfo: r.info });
      } catch (e) {
        throw new EngineNotReadyError(msg.bootFailed(this.paths, (e as Error).message));
      }
      return {
        oldVersion,
        newVersion: this.startFingerprint?.version ?? null,
        pobPath: this.paths.pobPath,
        luajitPath: this.paths.luajitPath,
        ...this.carryResult(),
      };
    });
  }

  /** Validate + switch to a user-supplied PoB (and optional LuaJIT) path, then persist it. */
  async configure(pobPathRaw: string, luajitPathRaw?: string) {
    return this.runTransition(async () => {
      let info: PoBInstallInfo;
      try {
        info = validatePoBPath(pobPathRaw, 'pobPath', this.env);
      } catch (e) {
        throw new UserError((e as Error).message);
      }
      let luajitPath: string;
      let luajitSource: PathSource;
      if (luajitPathRaw && luajitPathRaw.trim()) {
        const found = luajitAt(luajitPathRaw, process.platform, this.env);
        if (!found) throw new UserError(`luajitPath=${luajitPathRaw} is not a luajit binary or a folder containing one.`);
        luajitPath = found;
        luajitSource = 'argument';
      } else {
        try {
          const saved = loadConfig(this.env);
          const lj = resolveLuaJIT(info.dir, { env: this.env, savedLuaJITPath: saved.luajitPath, ...this.resolveOptions });
          luajitPath = lj.luajitPath;
          luajitSource = lj.source;
        } catch (e) {
          throw new UserError(`Path of Building ${info.version ?? ''} found at ${info.dir}, but: ${(e as Error).message}`);
        }
      }
      const samePaths = this.paths?.pobPath === info.dir && this.paths?.luajitPath === luajitPath;
      if (samePaths && this.bridge?.isCircuitOpen()) throw new UserError(msg.circuitOpen());

      const previous = this.paths;
      const next: FullyResolvedPaths = {
        pobPath: info.dir, luajitPath, bridgeLua: bridgeLuaPath(),
        pobSource: 'argument', luajitSource, pobInfo: info,
      };
      const oldVersion = this.startFingerprint?.version ?? null;
      try {
        await this.restartWith(next);
      } catch (e) {
        // Leave the previous configuration in place (booted lazily on next use) and save nothing.
        const keep = this.carryXML;
        await this.stopEngine();
        this.paths = previous;
        this.carryXML = keep;
        throw new UserError(
          `The engine failed to start with pobPath=${info.dir} and luajitPath=${luajitPath}; nothing was saved.\n${(e as Error).message}`,
        );
      }
      const configFile = saveConfig(
        {
          pobPath: info.dir,
          ...(luajitSource === 'argument' ? { luajitPath } : {}),
          pobVersion: this.startFingerprint?.version ?? info.version,
          savedAt: new Date().toISOString(),
        },
        this.env,
      );
      return {
        status: 'configured' as const,
        pobVersion: this.startFingerprint?.version ?? info.version,
        previousVersion: oldVersion,
        pobPath: info.dir,
        layout: info.layout,
        luajitPath,
        luajitSource,
        configFile,
        ...this.carryResult(),
        ...(this.env.POB_PATH ? { warning: msg.envOverride(this.env.POB_PATH) } : {}),
      };
    });
  }

  /** Snapshot for get_engine_info. Never throws, never starts the engine. */
  async info(): Promise<Record<string, unknown>> {
    const p = this.paths;
    const onDisk = p ? fingerprintInstall(p.pobPath) : null;
    const changed = !!(this.startFingerprint && onDisk && installChanged(this.startFingerprint, onDisk));
    const updateState = p ? detectUpdateState(p.pobPath) : null;
    let status: EngineStatus;
    if (!p) status = 'unconfigured';
    else if (updateState === 'applying') status = 'updating';
    else if (changed) status = 'stale';
    else if (this.booting || this.transition) status = 'starting';
    else if (this.startFingerprint) status = 'ready';
    else if (this.bootError) status = 'failed';
    else status = 'stopped';

    let build: unknown = null;
    if (this.session && this.startFingerprint) {
      try {
        build = await this.session.getBuildInfo();
      } catch {
        build = null;
      }
    }
    return {
      status,
      pobVersion: this.startFingerprint?.version ?? onDisk?.version ?? null,
      onDiskVersion: onDisk?.version ?? null,
      installChangedSinceStart: changed,
      pobUpdateState: updateState,
      pobPath: p?.pobPath ?? null,
      pobPathSource: p?.pobSource ?? null,
      layout: p?.pobInfo.layout ?? null,
      luajitPath: p?.luajitPath ?? null,
      luajitPathSource: p?.luajitSource ?? null,
      engineStartedAt: this.startedAt,
      crashCount: this.bridge?.getCrashCount() ?? 0,
      configFile: configFilePath(this.env),
      build,
      ...(this.resolveError ? { configurationError: this.resolveError } : {}),
      ...(this.bootError && !this.startFingerprint ? { startError: this.bootError } : {}),
      ...(status === 'unconfigured' ? { hint: msg.ASK_USER } : {}),
      ...(status === 'stale' ? { hint: 'Call reload_engine to switch to the updated Path of Building.' } : {}),
    };
  }

  async shutdown(): Promise<void> {
    await this.stopEngine();
  }

  /** Synchronous last-resort kill (startup failure paths). */
  killProcess(): void {
    this.bridge?.killProcess();
  }
}
