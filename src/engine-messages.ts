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

/** Strikes (unexpected exits, command timeouts, failed starts) after which the engine is not restarted. */
export const MAX_CRASHES = 3;

/**
 * The crash count is kept per (PoB path, LuaJIT path) pair (CrashLedger), so calling
 * configure_pob_path or reload_engine with the same paths does not clear it.
 */
export function circuitOpen(crashCount: number): string {
  return (
    `Lua engine has crashed ${crashCount} times (unexpected exits, command timeouts or failed starts) — ` +
    'refusing to restart. Restart the MCP server process to clear this state, or update Path of Building ' +
    'and then call reload_engine (the count clears once the install has changed on disk).'
  );
}

/** A command found the engine process gone part-way through a tool call. */
export function engineDown(crashCount: number): string {
  const strike = crashCount > 0 ? ` (strike ${crashCount} of ${MAX_CRASHES})` : '';
  return (
    `The Path of Building engine stopped during this call${strike}, so the call did not finish. ` +
    'The next tool call restarts the engine with the build as of the last committed change.'
  );
}

export interface RestartNotice {
  crashCount: number;
  restored: 'build' | 'none' | 'failed';
  error?: string;
  undoEntriesCleared: number;
  snapshotsKept: number;
}

/**
 * Told once, by the first tool call after the engine was restarted following
 * a crash or a timeout. That call does nothing else.
 */
export function engineRestarted(n: RestartNotice): string {
  const left = MAX_CRASHES - n.crashCount;
  const build =
    n.restored === 'build'
      ? 'The build was restored as it was after the last committed change (load_build, reset_build, swap_item, ' +
        'unequip_item, set_config, convert_tree_to_latest or undo_last_change). A change whose call failed when the ' +
        'engine stopped was not kept.'
      : n.restored === 'none'
        ? 'No build was loaded, so none was restored.'
        : `The build could NOT be fully restored (${n.error ?? 'unknown error'}), so do not rely on the engine's ` +
          'current build. Call reset_build to reload the originally loaded build, or load_build.';
  const undo =
    n.undoEntriesCleared > 0
      ? `Undo history was cleared (${n.undoEntriesCleared} entr${n.undoEntriesCleared === 1 ? 'y' : 'ies'}): ` +
        'those entries belonged to the stopped engine and cannot be applied to the new one.'
      : 'There was no undo history to keep.';
  return [
    `The Path of Building engine stopped unexpectedly and was restarted (strike ${n.crashCount} of ${MAX_CRASHES}; ` +
      (left > 0
        ? `after ${left} more the engine is not restarted again).`
        : 'it will not be restarted again).'),
    build,
    undo,
    n.restored === 'failed' ? '' : 'reset_build still returns to the originally loaded build.',
    n.snapshotsKept > 0 ? `Labelled stat snapshots (${n.snapshotsKept}) are kept; they hold stats only.` : '',
    'Nothing else was done for this call: retry it.',
  ]
    .filter(Boolean)
    .join(' ');
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
