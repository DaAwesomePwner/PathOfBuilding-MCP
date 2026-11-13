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

# Tests — POB_PATH must point at a real PoB install, or each integration test prints SKIPPED and exits 0.
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
npm run test:errors   # input validation paths
npm run test:all      # everything (~3 min)
```

Single test: `tsx test/<file>.ts` — they're plain Node scripts.

Path resolution order: **env var → saved config (`configure_pob_path`) → auto-detect probe table** (`src/paths.ts`, `src/luajit-paths.ts`). Errors list everything probed.

Env vars:
- `POB_PATH` — PoB install (PoE1 only; the PoE2 edition is rejected). If set but invalid, auto-detect is skipped. Auto-detect probes `%APPDATA%\Path of Building Community`, the installer's `HKCU`/`HKLM` uninstall key `...\Uninstall\Path of Building Community` → `InstallLocation`, `%ProgramData%\Path of Building`, `%LOCALAPPDATA%\Programs\Path of Building Community`; macOS `~/Library/Application Support/Path of Building Community`; Linux `~/.local/share/...`, Flatpak, `/opt/path-of-building`.
- `LUAJIT_PATH` — `luajit` binary or a folder containing it. The Windows PoB installer does **not** ship `luajit.exe` (only `lua51.dll`); probes `<POB_PATH>/runtime/`, `%LOCALAPPDATA%\Programs\LuaJIT\bin`, scoop, Homebrew, `/usr/{local/,}bin`, then PATH.
- `POB_MCP_CONFIG_DIR` — overrides the saved-config dir (default `%APPDATA%\pob-mcp-server`, `~/Library/Application Support/pob-mcp-server`, `$XDG_CONFIG_HOME|~/.config/pob-mcp-server`). Tests must always set it to a temp dir.
- `POB_TIMING=1` — per-command timing on stderr.

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
- **Snapshot-and-restore for "what-if" queries.** Every `simulate_*`, `compare_*`, `find_*`, `evaluate_*` wraps its probe in a `try/finally` snapshot/restore pair. Must restore bit-exact (`Life`, `CombinedDPS`, `TotalEHP` spot-checked in `state-integrity-test.ts`).
- **Three-strike crash circuit breaker.** After 3 unexpected LuaJIT exits, the server refuses respawns. Don't disable — it prevents silent respawn loops. The count is kept per (pobPath, luajitPath) in `CrashLedger` (`src/crash-ledger.ts`) and handed to each new bridge, so engine swaps can't reset it; it clears only when that PoB install changes on disk relative to the fingerprint taken when the crashing engine was started. Keys use the real path of both files (lower-cased on Windows), so spelling variants share one count.
- **Tool arguments are untrusted.** `configure_pob_path` arguments are never env-expanded (no `%VAR%`/`$VAR` leaks via error text), and a `luajitPath` argument must be an existing file named `luajit*` (`.exe` on Windows, no scripts) because it is executed. Network/device paths (`\\host\share`, `//host/share`, `\\?\…`, `\\.\…`) are refused for tool/elicitation arguments by a string check before any filesystem access. A saved-config `luajitPath` is re-checked with the same rules at startup and ignored (stderr warning) if it fails.
- **Mutations push to the undo stack.** `swap_item`, `unequip_item`, `set_config`, `convert_tree_to_latest` (a spec-level entry that carries the old tree version; nothing is pushed when already on the latest tree), and the commit-variant of `simulate_passive_change` push; `swap_gem` is a temporary probe (skills snapshot/restore) and does not. `undo_last_change` pops; `reset_build` reverts to the originally-loaded XML.
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
