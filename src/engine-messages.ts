import path from 'node:path';
import type { ResolvedPaths } from './paths.js';
import type { InstallFingerprint } from './pob-install.js';

/** User/model-facing texts for engine readiness problems. Each one says what to do next. */

export const ASK_USER =
  'Ask the user for their Path of Building Community install folder (the folder containing ' +
  'Launch.lua — on Windows usually C:\\Users\\<name>\\AppData\\Roaming\\Path of Building Community), then call ' +
  'configure_pob_path with { pobPath } as a full local path — environment variables like %APPDATA% are not ' +
  'expanded and network paths are refused (add luajitPath, the full path of luajit.exe, if LuaJIT is not on ' +
  'PATH; the Windows PoB installer does not include luajit.exe).';

export function unconfigured(resolveError: string | null, extra?: string): string {
  return [
    'Path of Building is not configured yet, so this tool cannot run.',
    extra ? `\n${extra}` : '',
    resolveError ? `\n${resolveError}` : '',
    `\n${ASK_USER}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function updating(pobPath: string): string {
  return (
    `Path of Building at ${pobPath} is in the middle of applying an update ` +
    `(${path.join('Update', 'manifest.xml')} or opFileRuntime.txt present without opFile.txt). ` +
    `Wait for it to finish — if it was interrupted, open Path of Building once so it completes — ` +
    `then call reload_engine.`
  );
}

export function stale(start: InstallFingerprint, current: InstallFingerprint, pobPath: string): string {
  const from = start.version ?? 'unknown';
  const to = current.version ?? 'unknown';
  const what =
    from === to
      ? `Path of Building's manifest.xml at ${pobPath} changed on disk since the engine started (version ${to})`
      : `Path of Building was updated on disk from ${from} to ${to} since the engine started`;
  return (
    `${what}. The running engine still has the old code and data loaded, so results could be wrong. ` +
    `Call reload_engine to restart it against the updated install (the current build is carried ` +
    `over; undo history is cleared).`
  );
}

export function bootFailed(paths: ResolvedPaths, error: string): string {
  return (
    `The Path of Building engine failed to start.\n` +
    `  PoB:    ${paths.pobPath}\n  LuaJIT: ${paths.luajitPath}\n` +
    `Error: ${error}\n\n` +
    `If either path is wrong, ask the user for the correct folder / luajit binary and call ` +
    `configure_pob_path. If PoB was just updated, call reload_engine.`
  );
}

export function circuitOpen(): string {
  return (
    'The Lua engine has crashed 3 times with these paths and the crash breaker is open. ' +
    'Restart the MCP server process, or call configure_pob_path with a different PoB/LuaJIT path.'
  );
}

export function envOverride(pobEnv: string): string {
  return (
    `POB_PATH is set in the server environment (${pobEnv}). It takes precedence over the saved ` +
    `config on the next server start — remove it from your MCP client config to use the saved path.`
  );
}

export function exportFailedNote(error: string): string {
  return (
    `The current build was NOT carried over: exporting it from the old engine failed (${error}). ` +
    `The engine was restarted anyway; load the build again with load_build.`
  );
}

export function carryLoadFailedNote(error: string): string {
  return (
    `The build was exported but could not be loaded into the new engine (${error}). Its PoB import ` +
    `code is in buildCode: pass it to load_build to retry, or import it into Path of Building.`
  );
}
