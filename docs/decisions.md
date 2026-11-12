# Decisions

Choices that later work must respect: policy, scope, interface and convention
decisions, one line each, current state only.

## Scope

- Only the launch-critical fix set shipped for the new-league PoB update; every other 2026-11-12 review finding lives in `docs/backlog.md`. Why: the user said a new Path of Exile 1 update was due the next day and chose to postpone the rest. (2026-11-12, launch-critical-fixes, docs/backlog.md)
- Postponed by the user, not rejected: `convert_tree_to_latest` tool, what-if restore exactness (masteries, items, skills), URL-loading hardening, crash-breaker tuning, the install DLL locks, tests/CI and docs polish. Why: outside the launch-critical set. (2026-11-12, launch-critical-fixes, docs/backlog.md)

## Engine and PoB install

- The bridge never writes inside the PoB install: writes, removes and renames targeting it are refused, and only plain read modes (`r`, `rb`) are allowed there. Why: the old stubs could truncate PoB's cached jewel data and trigger its updater. (2026-11-12, launch-critical-fixes, ed9853dd)
- When PoB changes on disk under a running server, engine tools return an error naming `reload_engine`; the server never restarts the engine silently. Why: a silent restart would clear undo history unnoticed. (2026-11-12, launch-critical-fixes, a4b9218e)
- A failed `loadXML` keeps the previously loaded build active; the engine goes blank only when there was none or restoring it fails, and the error says which. Why: the TypeScript session still holds the previous build's state. (2026-11-12, launch-critical-fixes, ed9853dd)
- Config keys are validated against the running engine's own config metadata before any mutation; unknown keys are a `UserError`, and presets or aliases must fail loudly if PoB renames a key. Why: dead keys silently did nothing. (2026-11-12, launch-critical-fixes, bdbe9663)

## Configuration and security

- Path resolution order is environment variable, then saved config, then auto-detect; a missing PoB or LuaJIT never exits the server. Why: MCP clients only show "server disconnected" on exit, so the user could not be asked. (2026-11-12, launch-critical-fixes, a4b9218e)
- Paths supplied through `configure_pob_path` or elicitation are not environment-expanded and may not be network or device paths; `luajitPath` must be an existing file named `luajit*` (`.exe` on Windows). Paths from `POB_PATH`/`LUAJIT_PATH` keep expansion. Why: these values can come from the model, and they are executed or echoed back. (2026-11-12, launch-critical-fixes, a4b9218e)
- The three-strike crash count is kept per resolved (PoB path, LuaJIT path) pair and clears only when that install changes on disk. Why: reconfiguring must not be a way around the breaker, and a PoB update must be a way out. (2026-11-12, launch-critical-fixes, a4b9218e)
