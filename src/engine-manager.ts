import { BuildSession } from './build-session.js';
import { configFilePath, loadConfig, saveConfig, SavedConfig } from './config-store.js';
import { CrashLedger } from './crash-ledger.js';
import { EngineGate } from './engine-gate.js';
import * as msg from './engine-messages.js';
import { BuildInfo, encodeBuildCode, LuaBridge } from './lua-bridge.js';
import {
  bridgeLuaPath,
  FullyResolvedPaths,
  LuaJITNotFoundError,
  PathSource,
  PoBInstallNotFoundError,
  resolveLuaJIT,
  resolvePoB,
  ResolveOptions,
  ResolvedPaths,
  validateLuajitArgument,
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

/** Asks the user for a path (MCP elicitation). */
export type PathPrompt = () => Promise<{ configured: boolean; message?: string }>;

export type BridgeFactory = (paths: ResolvedPaths, opts: { initialCrashCount: number }) => LuaBridge;

export interface EngineManagerOptions {
  env?: NodeJS.ProcessEnv;
  bridgeFactory?: BridgeFactory;
  log?: (line: string) => void;
  /** Extra resolve options (tests inject probe tables). */
  resolveOptions?: Partial<ResolveOptions>;
}

/** What happened to the loaded build across an engine swap. */
export interface CarryResult {
  buildReloaded: boolean;
  build: BuildInfo | null;
  buildNote?: string;
  buildExportError?: string;
  buildError?: string;
  /** PoB import code of a build that could not be loaded into the new engine (pass to load_build). */
  buildCode?: string;
}

export interface ReloadResult extends CarryResult {
  oldVersion: string | null;
  newVersion: string | null;
  pobPath: string;
  luajitPath: string;
}

export class EngineManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly bridgeFactory: BridgeFactory;
  private readonly log: (line: string) => void;
  private readonly resolveOptions: Partial<ResolveOptions>;
  private readonly gate = new EngineGate();
  private readonly ledger = new CrashLedger();
  private readonly retiring = new Set<LuaBridge>();

  private paths: FullyResolvedPaths | null = null;
  private resolveError: string | null = null;
  private bridge: LuaBridge | null = null;
  private bridgePaths: ResolvedPaths | null = null;
  /** Install fingerprint when the current bridge last attempted a start (its crashes belong to it). */
  private bridgeBootFingerprint: InstallFingerprint | null = null;
  private session: BuildSession | null = null;
  private booting: Promise<void> | null = null;
  private bootError: string | null = null;
  private startFingerprint: InstallFingerprint | null = null;
  private startedAt: string | null = null;
  private carryXML: string | null = null;
  private lastExport: { xml: string | null; error?: string } | null = null;
  private lastCarry: { info: BuildInfo | null; error?: string; xml?: string } | null = null;
  private pathPrompt: PathPrompt | null = null;
  private prompted = false;
  private promptMessage: string | undefined;
  private initDone = false;
  private shuttingDown = false;

  constructor(opts: EngineManagerOptions = {}) {
    this.env = opts.env ?? process.env;
    this.bridgeFactory = opts.bridgeFactory ?? ((p, o) => new LuaBridge(p, 60_000, o));
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
    if (this.paths || this.gate.busy) return; // configure_pob_path already ran
    const saved = this.loadVettedConfig();
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
      this.paths = {
        pobPath: pob.info.dir, luajitPath: lj.luajitPath, bridgeLua: bridgeLuaPath(),
        pobSource: pob.source, luajitSource: lj.source, pobInfo: pob.info,
      };
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

  /**
   * Saved config with its luajitPath re-checked by the same rules as the tool
   * argument (it is executed). A failing value is ignored with a warning, so
   * resolution falls back to auto-detect.
   */
  private loadVettedConfig(): SavedConfig {
    const saved = loadConfig(this.env);
    if (saved.luajitPath) {
      try {
        saved.luajitPath = validateLuajitArgument(saved.luajitPath, this.env);
      } catch (e) {
        this.log(`ignoring saved luajitPath (${(e as Error).message}); falling back to auto-detect`);
        delete saved.luajitPath;
      }
    }
    return saved;
  }

  // ------------------------------------------------------------------ boot / stop

  private boot(): Promise<void> {
    if (this.booting) return this.booting;
    const paths = this.paths;
    if (!paths) return Promise.reject(new EngineNotReadyError(msg.unconfigured(this.resolveError)));
    if (this.shuttingDown) return Promise.reject(new EngineNotReadyError('The server is shutting down.'));
    const run = (async () => {
      if (detectUpdateState(paths.pobPath) === 'applying') {
        throw new EngineNotReadyError(msg.updating(paths.pobPath));
      }
      if (!this.bridge) {
        const inherited = this.ledger.initial(paths.pobPath, paths.luajitPath);
        this.bridge = this.bridgeFactory(paths, { initialCrashCount: inherited.count });
        this.bridgePaths = paths;
        this.bridgeBootFingerprint = inherited.fingerprint;
        this.session = new BuildSession(this.bridge);
      }
      const fp = fingerprintInstall(paths.pobPath); // before start, so an update mid-boot is caught
      // Only a real start attempt (breaker closed) ties future crashes to this install state;
      // a refused start after a PoB update must not re-stamp the old crashes as "current".
      if (!this.bridge.isCircuitOpen()) this.bridgeBootFingerprint = fp;
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
          // Keep the build: returned as a PoB import code in the swap result.
          this.lastCarry = { info: null, error: (e as Error).message, xml };
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

  /** Retire the current bridge: crash count goes to the ledger, the process is always killed. */
  private async stopEngine(): Promise<void> {
    if (this.booting) await this.booting.catch(() => undefined);
    const bridge = this.bridge;
    const bp = this.bridgePaths;
    const bootFp = this.bridgeBootFingerprint;
    this.bridge = null;
    this.bridgePaths = null;
    this.bridgeBootFingerprint = null;
    this.session = null;
    this.startFingerprint = null;
    this.startedAt = null;
    if (!bridge) return;
    if (bp) {
      this.ledger.record(bp.pobPath, bp.luajitPath, bridge.getCrashCount(), bootFp ?? fingerprintInstall(bp.pobPath));
    }
    this.retiring.add(bridge);
    try {
      await bridge.dispose();
    } finally {
      this.retiring.delete(bridge);
    }
  }

  // ------------------------------------------------------------------ tool-call gate

  /**
   * Run an engine-backed tool call. Holds a shared gate slot for the whole
   * call, so engine swaps wait for it and it never sees a half-swapped engine.
   */
  async run<T>(fn: (session: BuildSession) => Promise<T>): Promise<T> {
    this.init(); // no-op after the first call
    if (!this.paths && !this.gate.busy) await this.promptOnce();
    const release = await this.gate.enterShared();
    try {
      return await fn(await this.readySession());
    } finally {
      release();
    }
  }

  /** Readiness check without running anything (tests, diagnostics). */
  async ensureReady(): Promise<BuildSession> {
    return this.run(async (session) => session);
  }

  private async promptOnce(): Promise<void> {
    if (!this.pathPrompt || this.prompted) return;
    this.prompted = true;
    const r = await this.pathPrompt().catch((e: unknown) => ({ configured: false, message: String(e) }));
    if (!r.configured) this.promptMessage = r.message;
  }

  /** Must be called while holding a shared gate slot. */
  private async readySession(): Promise<BuildSession> {
    const paths = this.paths;
    if (!paths) throw new EngineNotReadyError(msg.unconfigured(this.resolveError, this.promptMessage));
    if (this.shuttingDown) throw new EngineNotReadyError('The server is shutting down.');
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
    if (!this.session) throw new EngineNotReadyError(msg.bootFailed(paths, this.bootError ?? 'engine not started'));
    return this.session;
  }

  // ------------------------------------------------------------------ swaps

  /** Export the loaded build (if any) from the current engine so it survives a restart. */
  private async exportCurrentBuild(): Promise<{ xml: string | null; error?: string }> {
    if (this.carryXML) return { xml: this.carryXML };
    if (!this.session || !this.startFingerprint) return { xml: null };
    try {
      await this.session.getBuildInfo(); // throws UserError("No build loaded …") when none is loaded
    } catch (e) {
      if (e instanceof UserError && /no build loaded/i.test(e.message)) return { xml: null };
      const error = (e as Error).message;
      this.log(`could not read the current build before restart: ${error}`);
      return { xml: null, error };
    }
    try {
      return { xml: await this.session.exportXML() };
    } catch (e) {
      const error = (e as Error).message;
      this.log(`could not export the current build before restart: ${error}`);
      return { xml: null, error };
    }
  }

  /** Must run inside gate.exclusive(). */
  private async restartWith(next: FullyResolvedPaths): Promise<void> {
    const exp = await this.exportCurrentBuild();
    await this.stopEngine();
    this.paths = next;
    this.carryXML = exp.xml;
    this.lastExport = exp;
    this.lastCarry = null;
    await this.boot();
  }

  private carryResult(): CarryResult {
    const exp = this.lastExport;
    const c = this.lastCarry;
    if (exp?.error) {
      return {
        buildReloaded: false,
        build: null,
        buildExportError: exp.error,
        buildNote: msg.exportFailedNote(exp.error),
      };
    }
    if (c?.error) {
      return {
        buildReloaded: false,
        build: null,
        buildError: c.error,
        ...(c.xml ? { buildCode: encodeBuildCode(c.xml) } : {}),
        buildNote: msg.carryLoadFailedNote(c.error),
      };
    }
    if (c?.info) return { buildReloaded: true, build: c.info };
    return { buildReloaded: false, build: null, buildNote: 'No build was loaded, so none was carried over.' };
  }

  /** Restart LuaJIT against the on-disk install, carrying the current build over. */
  async reload(): Promise<ReloadResult> {
    return this.gate.exclusive(async () => {
      const paths = this.paths;
      if (!paths) throw new EngineNotReadyError(msg.unconfigured(this.resolveError));
      const r = inspectPoBInstall(paths.pobPath);
      if (!r.ok) throw new UserError(`Cannot reload: ${r.message}`);
      if (detectUpdateState(paths.pobPath) === 'applying') throw new EngineNotReadyError(msg.updating(paths.pobPath));
      const oldVersion = this.startFingerprint?.version ?? null;
      try {
        await this.restartWith({ ...paths, pobInfo: r.info });
      } catch (e) {
        const exportErr = this.lastExport?.error ? `\n${msg.exportFailedNote(this.lastExport.error)}` : '';
        throw new EngineNotReadyError(msg.bootFailed(paths, (e as Error).message) + exportErr);
      }
      return {
        oldVersion,
        newVersion: this.startFingerprint?.version ?? null,
        pobPath: paths.pobPath,
        luajitPath: paths.luajitPath,
        ...this.carryResult(),
      };
    });
  }

  /**
   * Validate + switch to a user-supplied PoB (and optional LuaJIT) path, then
   * persist it. Tool arguments are never env-expanded, and a luajitPath must
   * be an existing file named luajit* — that binary is executed.
   */
  async configure(pobPathRaw: string, luajitPathRaw?: string) {
    return this.gate.exclusive(async () => {
      let info: PoBInstallInfo;
      try {
        info = validatePoBPath(pobPathRaw, 'pobPath', this.env, { expandEnv: false, rejectNetwork: true });
      } catch (e) {
        throw new UserError((e as Error).message);
      }
      let luajitPath: string;
      let luajitSource: PathSource;
      if (luajitPathRaw && luajitPathRaw.trim()) {
        try {
          luajitPath = validateLuajitArgument(luajitPathRaw, this.env);
        } catch (e) {
          throw new UserError((e as Error).message);
        }
        luajitSource = 'argument';
      } else {
        try {
          const saved = this.loadVettedConfig();
          const lj = resolveLuaJIT(info.dir, { env: this.env, savedLuaJITPath: saved.luajitPath, ...this.resolveOptions });
          luajitPath = lj.luajitPath;
          luajitSource = lj.source;
        } catch (e) {
          throw new UserError(`Path of Building ${info.version ?? ''} found at ${info.dir}, but: ${(e as Error).message}`);
        }
      }

      const previous = this.paths;
      const next: FullyResolvedPaths = {
        pobPath: info.dir, luajitPath, bridgeLua: bridgeLuaPath(),
        pobSource: 'argument', luajitSource, pobInfo: info,
      };
      const oldVersion = this.startFingerprint?.version ?? null;
      try {
        await this.restartWith(next);
      } catch (e) {
        // Keep the previous configuration (booted lazily on next use, with its
        // crash count from the ledger) and the build; save nothing.
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

  // ------------------------------------------------------------------ info / shutdown

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
    else if (this.booting || this.gate.busy) status = 'starting';
    else if (this.startFingerprint) status = 'ready';
    else if (this.bootError) status = 'failed';
    else status = 'stopped';

    // Never start or respawn the engine from here: only ask for build info when the
    // process is up and no boot/swap is in progress; otherwise omit it.
    let build: unknown = null;
    const engineUp = !!(this.bridge?.isRunning() && this.startFingerprint && !this.booting && !this.gate.busy);
    if (this.session && engineUp) {
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
      circuitOpen: this.bridge?.isCircuitOpen() ?? false,
      configFile: configFilePath(this.env),
      build,
      ...(this.resolveError ? { configurationError: this.resolveError } : {}),
      ...(this.bootError && !this.startFingerprint ? { startError: this.bootError } : {}),
      ...(status === 'unconfigured' ? { hint: msg.ASK_USER } : {}),
      ...(status === 'stale' ? { hint: 'Call reload_engine to switch to the updated Path of Building.' } : {}),
    };
  }

  /** Server shutdown: no new boots; in-flight calls get the retry error; the process is killed. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.stopEngine();
  }

  /** Synchronous last-resort kill of every LuaJIT process this manager owns (live or retiring). */
  killProcess(): void {
    this.bridge?.forceKill();
    for (const b of this.retiring) b.forceKill();
  }
}
