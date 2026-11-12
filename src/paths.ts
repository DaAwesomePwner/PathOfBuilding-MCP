import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir, isNetworkOrDevicePath, networkPathMessage, normalizeUserPath } from './path-utils.js';
import { resolveLuaJIT } from './luajit-paths.js';
import { inspectPoBInstall, PoBInstallInfo } from './pob-install.js';

export class PoBInstallNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoBInstallNotFoundError';
  }
}

export interface ResolvedPaths {
  pobPath: string;
  luajitPath: string;
  bridgeLua: string;
}

/** Where a resolved path came from. 'argument' = configure_pob_path / elicitation. */
export type PathSource = 'env' | 'config' | 'auto-detect' | 'argument';

export interface FullyResolvedPaths extends ResolvedPaths {
  pobSource: PathSource;
  luajitSource: PathSource;
  pobInfo: PoBInstallInfo;
}

/** One auto-detect probe. `resolve` is lazy so slow probes (registry, PATH) only run when needed. */
export interface ProbeCandidate {
  label: string;
  resolve: () => string | null;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  savedPoBPath?: string;
  savedLuaJITPath?: string;
  /** Override the auto-detect probe tables (tests). */
  pobCandidates?: ProbeCandidate[];
  luajitCandidates?: ProbeCandidate[];
}

const fixed = (p: string): ProbeCandidate => ({ label: p, resolve: () => p });

// ---------------------------------------------------------------------------
// PoB discovery
// ---------------------------------------------------------------------------

const UNINSTALL_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Path of Building Community';

/** InstallLocation from the PoB installer's uninstall key (value is stored quoted). */
function registryInstallLocation(key: string): string | null {
  try {
    const out = execFileSync('reg', ['query', key, '/v', 'InstallLocation'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/InstallLocation\s+REG_(?:EXPAND_)?SZ\s+(.+)/);
    return m ? normalizeUserPath(m[1]) : null;
  } catch {
    return null;
  }
}

export function pobProbeCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ProbeCandidate[] {
  const home = homeDir(env);
  const out: ProbeCandidate[] = [];
  if (platform === 'win32') {
    if (env.APPDATA) out.push(fixed(path.join(env.APPDATA, 'Path of Building Community')));
    for (const key of [
      `HKCU\\${UNINSTALL_KEY}`,
      `HKLM\\${UNINSTALL_KEY}`,
      `HKLM\\${UNINSTALL_KEY.replace('Software\\', 'Software\\WOW6432Node\\')}`,
    ]) {
      out.push({ label: `registry ${key} InstallLocation`, resolve: () => registryInstallLocation(key) });
    }
    if (env.ProgramData) out.push(fixed(path.join(env.ProgramData, 'Path of Building')));
    if (env.LOCALAPPDATA) {
      out.push(fixed(path.join(env.LOCALAPPDATA, 'Programs', 'Path of Building Community')));
    }
  } else if (platform === 'darwin') {
    out.push(fixed(path.join(home, 'Library', 'Application Support', 'Path of Building Community')));
  } else {
    const xdgData = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    out.push(fixed(path.join(xdgData, 'Path of Building Community')));
    const flatpakData = path.join(home, '.var', 'app', 'community.pathofbuilding.PathOfBuilding', 'data');
    out.push(fixed(path.join(flatpakData, 'Path of Building Community')));
    out.push(fixed(flatpakData));
    out.push(fixed('/opt/path-of-building'));
  }
  return out;
}

const POB_HINT =
  `Typical locations:\n` +
  `  Windows: %APPDATA%\\Path of Building Community\n` +
  `  macOS:   ~/Library/Application Support/Path of Building Community\n` +
  `  Linux:   ~/.local/share/Path of Building Community\n` +
  `Fix: call the configure_pob_path tool with the folder that contains Launch.lua ` +
  `(or set POB_PATH in your MCP client config).`;

/**
 * Validate a user-supplied PoB folder. Throws PoBInstallNotFoundError with a
 * specific message (missing / not PoB / PoE2 edition).
 */
export function validatePoBPath(
  raw: string,
  label: string,
  env = process.env,
  options: { expandEnv?: boolean; rejectNetwork?: boolean } = {},
): PoBInstallInfo {
  // Network/device check happens on the strings only, before any filesystem access.
  if (options.rejectNetwork && isNetworkOrDevicePath(raw)) {
    throw new PoBInstallNotFoundError(networkPathMessage(label, raw));
  }
  const abs = normalizeUserPath(raw, env, { expandEnv: options.expandEnv });
  if (!abs) throw new PoBInstallNotFoundError(`${label} is empty.`);
  if (options.rejectNetwork && isNetworkOrDevicePath(abs)) {
    throw new PoBInstallNotFoundError(networkPathMessage(label, raw));
  }
  const result = inspectPoBInstall(abs);
  if (result.ok) return result.info;
  throw new PoBInstallNotFoundError(`${label}=${raw}: ${result.message}`);
}

/** Resolve PoB: POB_PATH env → saved config → auto-detect probe table. */
export function resolvePoB(opts: ResolveOptions = {}): { info: PoBInstallInfo; source: PathSource } {
  const env = opts.env ?? process.env;
  if (env.POB_PATH && env.POB_PATH.trim()) {
    try {
      return { info: validatePoBPath(env.POB_PATH, 'POB_PATH', env), source: 'env' };
    } catch (e) {
      throw new PoBInstallNotFoundError(
        `${(e as Error).message}\n\nPOB_PATH is set, so auto-detection was skipped. Fix or remove ` +
          `POB_PATH in your MCP client config, or call configure_pob_path.`,
      );
    }
  }

  const probed: string[] = [];
  if (opts.savedPoBPath) {
    const abs = normalizeUserPath(opts.savedPoBPath, env);
    const r = abs ? inspectPoBInstall(abs) : null;
    if (r?.ok) return { info: r.info, source: 'config' };
    probed.push(`${opts.savedPoBPath} (saved config): ${r && !r.ok ? r.message : 'empty'}`);
  }

  for (const c of opts.pobCandidates ?? pobProbeCandidates(opts.platform, env)) {
    const dir = c.resolve();
    if (!dir) {
      probed.push(`${c.label}: not found`);
      continue;
    }
    const r = inspectPoBInstall(dir);
    if (r.ok) return { info: r.info, source: 'auto-detect' };
    probed.push(c.label === dir ? r.message : `${c.label} → ${r.message}`);
  }

  throw new PoBInstallNotFoundError(
    `Could not find a Path of Building Community (Path of Exile 1) install. Probed:\n` +
      probed.map((p) => `  - ${p}`).join('\n') +
      `\n\n${POB_HINT}`,
  );
}

/** Back-compat wrapper returning just the directory. */
export function resolvePoBPath(opts: ResolveOptions = {}): string {
  return resolvePoB(opts).info.dir;
}

export {
  LuaJITNotFoundError,
  luajitAt,
  luajitProbeCandidates,
  resolveLuaJIT,
  resolveLuaJITPath,
  validateLuajitArgument,
} from './luajit-paths.js';

// ---------------------------------------------------------------------------
// Combined
// ---------------------------------------------------------------------------

/**
 * bridge.lua ships in this package at <pkg>/lua/bridge.lua. With rootDir ./src
 * the module is src/paths.ts in dev and dist/paths.js when built — both resolve
 * `../lua/bridge.lua`. The second candidate covers a nested dist/src layout.
 */
export function bridgeLuaPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', 'lua', 'bridge.lua'),
    path.resolve(here, '..', '..', 'lua', 'bridge.lua'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

export function resolveAllPaths(opts: ResolveOptions = {}): FullyResolvedPaths {
  const pob = resolvePoB(opts);
  const lj = resolveLuaJIT(pob.info.dir, opts);
  return {
    pobPath: pob.info.dir,
    luajitPath: lj.luajitPath,
    bridgeLua: bridgeLuaPath(),
    pobSource: pob.source,
    luajitSource: lj.source,
    pobInfo: pob.info,
  };
}

export function resolvePaths(opts: ResolveOptions = {}): ResolvedPaths {
  const { pobPath, luajitPath, bridgeLua } = resolveAllPaths(opts);
  return { pobPath, luajitPath, bridgeLua };
}
