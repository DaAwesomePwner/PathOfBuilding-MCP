import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homeDir } from './path-utils.js';

/**
 * Small per-user JSON config holding the PoB / LuaJIT paths chosen via
 * `configure_pob_path`. Location:
 *   POB_MCP_CONFIG_DIR (override, used by tests)
 *   Windows: %APPDATA%\pob-mcp-server\config.json
 *   macOS:   ~/Library/Application Support/pob-mcp-server/config.json
 *   Linux:   $XDG_CONFIG_HOME/pob-mcp-server/config.json (default ~/.config/...)
 */

export interface SavedConfig {
  pobPath?: string;
  luajitPath?: string;
  /** PoB version detected when the path was saved (informational only). */
  pobVersion?: string | null;
  savedAt?: string;
}

const APP_DIR = 'pob-mcp-server';

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.POB_MCP_CONFIG_DIR) return path.resolve(env.POB_MCP_CONFIG_DIR);
  if (process.platform === 'win32') {
    const appData = env.APPDATA || path.join(homeDir(env), 'AppData', 'Roaming');
    return path.join(appData, APP_DIR);
  }
  if (process.platform === 'darwin') {
    return path.join(homeDir(env), 'Library', 'Application Support', APP_DIR);
  }
  const xdg = env.XDG_CONFIG_HOME || path.join(homeDir(env), '.config');
  return path.join(xdg, APP_DIR);
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'config.json');
}

/** Load the saved config. Missing file → {}. Corrupt file → {} plus a stderr warning. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SavedConfig {
  const file = configFilePath(env);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const obj = parsed as Record<string, unknown>;
    const out: SavedConfig = {};
    if (typeof obj.pobPath === 'string') out.pobPath = obj.pobPath;
    if (typeof obj.luajitPath === 'string') out.luajitPath = obj.luajitPath;
    if (typeof obj.pobVersion === 'string') out.pobVersion = obj.pobVersion;
    if (typeof obj.savedAt === 'string') out.savedAt = obj.savedAt;
    return out;
  } catch (e) {
    process.stderr.write(`pob-mcp-server: ignoring unreadable config ${file}: ${String(e)}\n`);
    return {};
  }
}

/** Atomically write the config (temp file + rename). Returns the file path. */
export function saveConfig(config: SavedConfig, env: NodeJS.ProcessEnv = process.env): string {
  const file = configFilePath(env);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return file;
}
