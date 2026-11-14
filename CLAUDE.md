# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working on this repository.

## What this repo is

`pob-mcp-server` — a TypeScript/Node MCP server that exposes the [Path of Building Community](https://pathofbuilding.community/) calculation engine to LLM clients. The server spawns a LuaJIT subprocess that runs PoB's real engine in headless mode and drives it via JSON over stdio.

PoB itself is an **external runtime dependency**. The user's PoB install at `%APPDATA%\Path of Building Community\` (or platform equivalent) provides `Launch.lua`, the calculation modules, and the lua libraries. The compiled Windows installer flattens those into the install root (`Launch.lua`, `Modules/`, `Data/`, `lua/`); a source clone keeps them under `src/` and `runtime/lua/`. `bridge.lua` detects which layout it's looking at via `arg[1]` and sets `package.path` accordingly. This repo owns only the Node server, the Lua bridge adapter, and tests.

## Common commands

```bash
npm install
npm run build         # tsc to dist/ (fails on tsc errors), marks dist/server.js executable
npm run typecheck     # tsc --noEmit
npm run dev           # tsx src/server.ts (no build needed)
npm run start         # node dist/server.js (built artifacts)

# Tests — POB_PATH must point at a real PoB install, or each integration test prints SKIPPED and exits 0
# (with REQUIRE_POB=1 it fails instead; CI sets it).
npm run test:paths    # unit tests for paths / discovery / config store (no LuaJIT needed)
npm run test:startup  # builds, starts dist/server.js unconfigured, configure_pob_path, saved config, reload_engine, elicitation
npm run test:safety   # engine safety tests
npm run test:bridge   # ~10s, Lua bridge round-trip — run first when debugging
npm run test:session
npm run test:server
npm run test:phase3   # item swap / compare
npm run test:phase4   # passive tree
npm run test:phase5   # gems
npm run test:phase6   # config / scenarios
npm run test:phase7   # diagnostics / upgrades / export / snapshots
npm run test:integrity  # bit-exact snapshot/restore stress
npm run test:crash-recovery  # crash breaker, timeouts, respawn restores the last committed build
npm run test:errors   # input validation paths
npm run test:all      # everything (over 10 min)
```

Single test: `tsx test/<file>.ts` — they're plain Node scripts.

Path resolution order: **env var → saved config (`configure_pob_path`) → auto-detect probe table** (`src/paths.ts`, `src/luajit-paths.ts`). Errors list everything probed.

Env vars:
- `POB_PATH` — PoB install (PoE1 only; the PoE2 edition is rejected). If set but invalid, auto-detect is skipped. Auto-detect probes `%APPDATA%\Path of Building Community`, the installer's `HKCU`/`HKLM` uninstall key `...\Uninstall\Path of Building Community` → `InstallLocation`, `%ProgramData%\Path of Building`, `%LOCALAPPDATA%\Programs\Path of Building Community`; macOS `~/Library/Application Support/Path of Building Community`; Linux `~/.local/share/...`, Flatpak, `/opt/path-of-building`.
- `LUAJIT_PATH` — `luajit` binary or a folder containing it. The Windows PoB installer does **not** ship `luajit.exe` (only `lua51.dll`); probes `<POB_PATH>/runtime/`, `%LOCALAPPDATA%\Programs\LuaJIT\bin`, scoop, Homebrew, `/usr/{local/,}bin`, then PATH.
- `POB_MCP_CONFIG_DIR` — overrides the saved-config dir (default `%APPDATA%\pob-mcp-server`, `~/Library/Application Support/pob-mcp-server`, `$XDG_CONFIG_HOME|~/.config/pob-mcp-server`). Tests must always set it to a temp dir.
- `POB_TIMING=1` — per-command timing on stderr.
- `REQUIRE_POB=1` — tests only: a missing PoB, LuaJIT or `POB_SOURCE_PATH` fails the test instead of printing `SKIPPED` and exiting 0 (`skipOrFail` in `test/_skip.ts`). CI (`.github/workflows/ci.yml`) sets it and points `POB_SOURCE_PATH` at a clone of the pinned `POB_TAG` and `POB_PATH` at a copy flattened into the installed layout.

## Architecture

```
Claude Desktop  <-stdio MCP->  pob-mcp-server  <-stdio JSON->  bridge.lua (LuaJIT)
                                                                       |
                                                                       v
                                                       <POB_PATH>/src, runtime/lua/, ...
```

| Layer | File | Job |
|---|---|---|
| Path resolution | `src/paths.ts`, `src/luajit-paths.ts`, `src/path-utils.ts` | `resolvePoB()` / `resolveLuaJIT()` / `resolveAllPaths()` — env var, saved config, probe table, error listing probes. Single source of truth for install discovery. |
| Install inspection | `src/pob-install.ts` | Layout + `manifest.xml` version, PoE2 detection, install fingerprint (version + mtime), PoB self-updater state (`Update/opFile.txt` = staged, `Update/manifest.xml` without it = applying). Read-only. |
| Config store | `src/config-store.ts` | Per-user `config.json` written by `configure_pob_path`. |
| Engine manager | `src/engine-manager.ts` | Owns the LuaBridge + BuildSession pair. Lazy/background boot, `run()` gate (unconfigured / updating / stale → `EngineNotReadyError`), `configure()`, `reload()` (export build → dispose old bridge → boot → reload build), `info()`. |
| Lua bridge | `lua/bridge.lua` | Stubs out PoB's graphics host (the same job upstream's `HeadlessWrapper.lua` does for the busted test suite), `dofile`s `Launch.lua`, reads JSON commands from stdin, dispatches to `build.itemsTab`, `build.skillsTab`, `build.spec`, `build.configTab`. Knows nothing about MCP. |
| BuildSession | `src/build-session.ts` | TS class owning the LuaJIT subprocess. Snapshot/restore, undo stack, `withTemporaryChange`, async mutex, build-code/URL/XML loading, higher-level workflows. |
| MCP server | `src/server.ts`, `src/tool-registry.ts`, `src/engine-tools.ts` | Registers 37 tools via `@modelcontextprotocol/sdk`, validates with Zod + `UserError`, formats responses. `tools.engine(...)` handlers run inside `engine.run()` (shared gate slot + readiness checks) and receive the live session; `tools.plain(...)` handlers (configure_pob_path, get_engine_info, reload_engine, list_scenarios) work without an engine. |

## Non-negotiable invariants

- **The server never exits because PoB/LuaJIT is missing.** The MCP transport connects first; paths resolve and the engine boots in the background. While unconfigured, engine tools return `isError` text naming `configure_pob_path` (and elicit the path once when the client supports form elicitation). Nothing but MCP frames on stdout — log to stderr.
- **One LuaJIT process per session.** Engine boot is ~2s; pre-warmed in the background after connect. Engine-backed tool calls hold a shared slot in `EngineGate` (`src/engine-gate.ts`); an engine swap (`reload_engine` / `configure_pob_path`) takes it exclusively, waits for running calls, then disposes the old bridge before booting the new one. `LuaBridge.dispose()` always kills the captured process and rejects any pending call with a retry `UserError`; a disposed bridge refuses to respawn.
- **Never auto-restart on a PoB update.** The manifest version + mtime are recorded at engine start; if they change, engine tools error and point at `reload_engine`. Never write to the PoB directory.
- **Serial execution via async mutex.** PoB is single-threaded with shared globals. Two ops at once corrupts state.
- **Snapshot-and-restore for "what-if" queries.** Every `simulate_*`, `compare_*`, `find_*`, `evaluate_*` wraps its probe in a `try/finally` snapshot/restore pair. Must restore bit-exact (`Life`, `CombinedDPS`, `TotalEHP` spot-checked in `state-integrity-test.ts`). Items are restored by id (`captureItemsState` / `restoreItemsState` in `lua/bridge.lua`): every non-socket slot the engine has re-selects its item and items added since the snapshot are deleted, so the item list and export stay unchanged (`item-restore-test.ts`). Passive-tree jewel sockets belong to the tree state (`spec.jewels`), never to the item state. Items present when any live snapshot or undo entry was taken are never deleted, so the ids they hold stay valid. Skills are snapshotted as every plain field of every socket group and gem in every skill set, plus set order, the active set, the skills tab settings and the main socket group (`snapshotSkills` / `restoreSkills`); the export stays byte-identical (`skills-restore-test.ts`). What-if probes restore through `probeThenRestore`: if the restore fails the result is an internal error that keeps the probe's error as `cause` (undo and `reset_build` do not use it). A skills restore that cannot relink a monster-explosion gem to its source raises an internal error instead of differing silently. Batch commands (`replaceSocketGroup`, `allocNodes`, `deallocNodes`) check the whole batch before changing anything, so a user error leaves the build untouched.
- **Three-strike crash circuit breaker.** After 3 strikes the server refuses respawns (a `UserError` with the `circuitOpen` text; no process is started). Don't disable — it prevents silent respawn loops. A strike is any LuaJIT exit not asked for with a `shutdown` command, a command timeout (the process is killed), or a startup that fails or times out after the process ran (it is killed; nothing is left running unready). Strikes are never forgiven by later successful commands. The count is kept per (pobPath, luajitPath) in `CrashLedger` (`src/crash-ledger.ts`) and handed to each new bridge, so engine swaps can't reset it; it clears only when that PoB install changes on disk relative to the fingerprint taken when the crashing engine was started, or when the server process restarts. Keys use the real path of both files (lower-cased on Windows), so spelling variants share one count.
- **Crash recovery restores the last committed build, and says so once.** The bridge keeps a recovery build: the XML of the last `loadXML` the engine *accepted* (a rejected build is never recorded) plus a journal of the commands committed since (`swap_item` / `unequip_item` / `set_config` / `convert_tree_to_latest` record their bridge command, together with their undo entry, only once the whole tool call succeeded, or when the call failed after the engine applied the change while the engine is still alive (then the internal error says the change was applied and undo_last_change reverts it); with the engine gone nothing is recorded; undo entries remember the journal length and `undo_last_change` truncates back to it). The journal is not bounded: there is no exact, side-effect-free point to fold it into a new baseline. It is not refreshed with `exportXML`: PoB's save re-parses every item of the live build. A dead engine is respawned only at the start of a locked `BuildSession` operation, and the respawned process reloads the XML and replays the journal. While an operation runs the bridge refuses to respawn (`setRespawnHeld`), so a crash or timeout part-way through fails that call (no rollback or probe restore runs against a fresh engine). The first call after a respawn throws `EngineRestartedError` (a `UserError`) naming the strike count, the restored build, and how many undo entries were cleared — undo entries hold per-process item tokens, so they are dropped; labelled stat snapshots (stats only) are kept; `reset_build` still returns to the originally loaded build. That call does nothing else. `load_build` / `reset_build` skip the notice and the replay (they replace the build): a respawn for them starts blank, a successful load carries the strike once in an `engineRestart` note, and a rejected load puts the last committed build back (then the next call gives the notice). A restore that fails marks the recovery build lost: it is kept for engine swaps, never replayed again, and every later restart reports it as failed. An engine swap whose engine already crashed carries the accepted XML, or restarts the old engine once to export the replayed build; when that is impossible (breaker open, the restart or its replay failed, or the build was lost) it carries the last accepted XML with a `buildNote` saying which committed changes are missing.
- **Test fault seam.** `POB_MCP_TEST_FAULTS` (read by `lua/bridge.lua`) reaches the LuaJIT child only through the `LuaBridge` `testFaults` option; the server's own environment value is stripped. Faults may only raise an error, exit the process or stall — never write files or print to stdout.
- **Tool arguments are untrusted.** `configure_pob_path` arguments are never env-expanded (no `%VAR%`/`$VAR` leaks via error text), and a `luajitPath` argument must be an existing file named `luajit*` (`.exe` on Windows, no scripts) because it is executed. Network/device paths (`\\host\share`, `//host/share`, `\\?\…`, `\\.\…`) are refused for tool/elicitation arguments by a string check before any filesystem access. A saved-config `luajitPath` is re-checked with the same rules at startup and ignored (stderr warning) if it fails.
- **Mutations push to the undo stack.** `swap_item` and `unequip_item` (full snapshot; nothing is pushed when the bridge refuses the change with a user error, e.g. an item that does not fit the slot), `set_config` (config entry) and `convert_tree_to_latest` (a spec-level entry that carries the old tree version; nothing is pushed when already on the latest tree) push; no other tool does. What-if tools such as `simulate_passive_change` and `swap_gem` are temporary probes (snapshot/restore) and push nothing. `undo_last_change` pops; `reset_build` reverts to the originally-loaded XML.
- **Error classification.** User-input errors (bad slot, unknown gem) → `UserError`, surfaced verbatim. Anything else → "Internal error: ... try reset_build".

## Adding a tool

1. Extend `lua/bridge.lua` with a new dispatch case.
2. Expose it in `BuildSession` (route mutations through `withLock`, push to undo stack as needed).
3. Register a Zod-validated entry in `src/server.ts` with `tools.engine(name, schema, async (args, session) => ...)`.

All engine-backed tools follow this pattern.

## Conventions

- **Item text format** in MCP tools comes from PoB's "Copy item" (right-click) — must start with a `Rarity:` line. The server validates strictly.
- **Build code round-trip is lossless.** `export_build({format:"code"})` produces a base64 zlib string that `load_build` accepts back. Same for `xml`.

## Reference files

- [`README.md`](./README.md) — installation, configuration, tool catalog.
- [`GETTING_STARTED.md`](./GETTING_STARTED.md) — narrative tour with examples.
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — error catalog and fixes.
- [`docs/history/`](./docs/history/) — original design rationale and phase plans, pre-extraction.
