import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { homeDir, normalizeUserPath } from './path-utils.js';
import type { PathSource, ProbeCandidate, ResolveOptions } from './paths.js';

/** LuaJIT discovery: LUAJIT_PATH env → saved config → probe table → PATH. */

export class LuaJITNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LuaJITNotFoundError';
  }
}

const fixed = (p: string): ProbeCandidate => ({ label: p, resolve: () => p });

const exeName = (platform: NodeJS.Platform) => (platform === 'win32' ? 'luajit.exe' : 'luajit');

/** Accept a luajit binary, or a directory containing luajit[.exe] or bin/luajit[.exe]. */
export function luajitAt(raw: string, platform = process.platform, env = process.env): string | null {
  const abs = normalizeUserPath(raw, env);
  if (!abs) return null;
  try {
    const st = statSync(abs);
    if (st.isFile()) return abs;
    if (st.isDirectory()) {
      for (const sub of [exeName(platform), path.join('bin', exeName(platform))]) {
        if (existsSync(path.join(abs, sub))) return path.join(abs, sub);
      }
    }
  } catch {
    // fall through
  }
  return null;
}

function luajitOnPath(platform: NodeJS.Platform): string | null {
  try {
    const out = execFileSync(platform === 'win32' ? 'where' : 'which', ['luajit'], {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split(/\r?\n/)[0];
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

export function luajitProbeCandidates(
  pobPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ProbeCandidate[] {
  const exe = exeName(platform);
  const out: ProbeCandidate[] = [
    fixed(path.join(pobPath, 'runtime', exe)),
    fixed(path.join(pobPath, 'runtime', 'bin', exe)),
  ];
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) out.push(fixed(path.join(env.LOCALAPPDATA, 'Programs', 'LuaJIT', 'bin', exe)));
    const scoopRoots = [env.SCOOP, path.join(homeDir(env), 'scoop'), env.SCOOP_GLOBAL];
    if (env.ProgramData) scoopRoots.push(path.join(env.ProgramData, 'scoop'));
    for (const root of new Set(scoopRoots.filter((r): r is string => !!r))) {
      out.push(fixed(path.join(root, 'shims', exe)));
      out.push(fixed(path.join(root, 'apps', 'luajit', 'current', 'bin', exe)));
      out.push(fixed(path.join(root, 'apps', 'luajit', 'current', exe)));
    }
  } else {
    if (platform === 'darwin') out.push(fixed('/opt/homebrew/bin/luajit'));
    out.push(fixed('/usr/local/bin/luajit'), fixed('/usr/bin/luajit'));
  }
  out.push({ label: `${exe} on PATH`, resolve: () => luajitOnPath(platform) });
  return out;
}

const LUAJIT_HINT =
  `The Windows PoB installer does NOT include luajit.exe — install LuaJIT (5.1 ABI) separately:\n` +
  `  Windows (scoop):  scoop install luajit\n` +
  `  Windows (winget): winget install DEVCOM.LuaJIT\n` +
  `  macOS (brew):     brew install luajit\n` +
  `  Linux (apt):      sudo apt-get install luajit\n` +
  `Then call configure_pob_path with luajitPath, or set LUAJIT_PATH, to point at the binary.`;

/** Resolve LuaJIT: LUAJIT_PATH env → saved config → probe table (incl. PATH). */
export function resolveLuaJIT(
  pobPath: string,
  opts: ResolveOptions = {},
): { luajitPath: string; source: PathSource } {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  if (env.LUAJIT_PATH && env.LUAJIT_PATH.trim()) {
    const found = luajitAt(env.LUAJIT_PATH, platform, env);
    if (found) return { luajitPath: found, source: 'env' };
    throw new LuaJITNotFoundError(
      `LUAJIT_PATH=${env.LUAJIT_PATH} is not a luajit binary or a folder containing one. ` +
        `Unset LUAJIT_PATH to use auto-discovery, or fix it.\n\n${LUAJIT_HINT}`,
    );
  }
  const probed: string[] = [];
  if (opts.savedLuaJITPath) {
    const found = luajitAt(opts.savedLuaJITPath, platform, env);
    if (found) return { luajitPath: found, source: 'config' };
    probed.push(`${opts.savedLuaJITPath} (saved config): not found`);
  }
  for (const c of opts.luajitCandidates ?? luajitProbeCandidates(pobPath, platform, env)) {
    const p = c.resolve();
    if (p && existsSync(p)) return { luajitPath: p, source: 'auto-detect' };
    probed.push(`${c.label}: not found`);
  }
  throw new LuaJITNotFoundError(
    `Could not find a luajit executable. Probed:\n` +
      probed.map((p) => `  - ${p}`).join('\n') +
      `\n\n${LUAJIT_HINT}`,
  );
}

/** Back-compat wrapper returning just the binary path. */
export function resolveLuaJITPath(pobPath: string, opts: ResolveOptions = {}): string {
  return resolveLuaJIT(pobPath, opts).luajitPath;
}

