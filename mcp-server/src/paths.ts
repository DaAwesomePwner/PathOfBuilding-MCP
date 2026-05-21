import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class PoBInstallNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoBInstallNotFoundError';
  }
}

export class LuaJITNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LuaJITNotFoundError';
  }
}

export interface ResolvedPaths {
  pobPath: string;
  luajitPath: string;
  bridgeLua: string;
}

function defaultPoBCandidates(): string[] {
  const candidates: string[] = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'Path of Building Community'));
  }
  if (process.platform === 'darwin') {
    candidates.push(
      path.join(os.homedir(), 'Library', 'Application Support', 'Path of Building Community'),
    );
  }
  if (process.platform === 'linux') {
    candidates.push(path.join(os.homedir(), '.local', 'share', 'Path of Building Community'));
  }
  return candidates;
}

function isValidPoBInstall(dir: string): boolean {
  return existsSync(path.join(dir, 'src', 'HeadlessWrapper.lua'));
}

export function resolvePoBPath(): string {
  const probed: string[] = [];

  if (process.env.POB_PATH) {
    const abs = path.resolve(process.env.POB_PATH);
    probed.push(abs);
    if (isValidPoBInstall(abs)) return abs;
    throw new PoBInstallNotFoundError(
      `POB_PATH=${process.env.POB_PATH} does not look like a Path of Building install ` +
        `(missing src/HeadlessWrapper.lua at ${abs}). Point POB_PATH at the directory ` +
        `containing src/HeadlessWrapper.lua.`,
    );
  }

  for (const candidate of defaultPoBCandidates()) {
    probed.push(candidate);
    if (isValidPoBInstall(candidate)) return candidate;
  }

  throw new PoBInstallNotFoundError(
    `Could not find a Path of Building Community install. Probed:\n` +
      probed.map((p) => `  - ${p}`).join('\n') +
      `\n\nSet POB_PATH to your install directory. Typical locations:\n` +
      `  Windows: %APPDATA%\\Path of Building Community\n` +
      `  macOS:   ~/Library/Application Support/Path of Building Community\n` +
      `  Linux:   ~/.local/share/Path of Building Community`,
  );
}

export function resolveLuaJITPath(pobPath: string): string {
  const isWin = process.platform === 'win32';
  const exe = isWin ? 'luajit.exe' : 'luajit';

  if (process.env.LUAJIT_PATH) {
    if (existsSync(process.env.LUAJIT_PATH)) return process.env.LUAJIT_PATH;
    throw new LuaJITNotFoundError(
      `LUAJIT_PATH=${process.env.LUAJIT_PATH} does not exist.`,
    );
  }

  const probed: string[] = [];
  for (const candidate of [
    path.join(pobPath, 'runtime', exe),
    path.join(pobPath, 'runtime', 'bin', exe),
  ]) {
    probed.push(candidate);
    if (existsSync(candidate)) return candidate;
  }

  try {
    const which = isWin ? 'where' : 'which';
    const out = execFileSync(which, [isWin ? 'luajit' : 'luajit'], { encoding: 'utf-8' })
      .trim()
      .split(/\r?\n/)[0];
    if (out && existsSync(out)) return out;
    probed.push(`${exe} on PATH (${which} luajit returned: ${out || '<empty>'})`);
  } catch {
    probed.push(`${exe} on PATH (not found)`);
  }

  throw new LuaJITNotFoundError(
    `Could not find a luajit executable. Probed:\n` +
      probed.map((p) => `  - ${p}`).join('\n') +
      `\n\nInstall LuaJIT 5.1:\n` +
      `  Windows (scoop):  scoop install luajit\n` +
      `  Windows (winget): winget install LuaJIT.LuaJIT\n` +
      `  macOS (brew):     brew install luajit\n` +
      `  Linux (apt):      sudo apt-get install luajit\n` +
      `Or set LUAJIT_PATH to a luajit binary.`,
  );
}

export function resolvePaths(): ResolvedPaths {
  const pobPath = resolvePoBPath();
  const luajitPath = resolveLuaJITPath(pobPath);
  // bridge.lua is shipped with this package. From dev (src/paths.ts) or build
  // (dist/paths.js), it sits at ../lua/bridge.lua relative to this module.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bridgeLua = path.resolve(here, '..', 'lua', 'bridge.lua');
  return { pobPath, luajitPath, bridgeLua };
}
