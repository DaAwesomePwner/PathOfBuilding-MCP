# Decisions

Choices that later work must respect: policy, scope, interface and convention
decisions, one line each, current state only.

## Scope

- Only the launch-critical fix set shipped for the new-league PoB update; every other 2026-11-12 review finding lives in `docs/backlog.md`. Why: the user said a new Path of Exile 1 update was due the next day and chose to postpone the rest. (2026-11-12, launch-critical-fixes, docs/backlog.md)
- Postponed by the user, not rejected: poe.ninja build links, the install DLL locks, the remaining test gaps and docs polish. Why: outside the launch-critical set; URL-loading hardening, the CI workflow, the `convert_tree_to_latest` tool, what-if restore exactness (tree, items, skills) and the crash-breaker fixes have since shipped, and poe.ninja support is a new feature left in the backlog. (2026-11-13, backlog-restore-and-breaker, c9b63635) Replaces: the same list including `convert_tree_to_latest`, what-if restore exactness and crash-breaker tuning (2026-11-13)

## Engine and PoB install

- The bridge never writes inside the PoB install: writes, removes and renames targeting it are refused, and only plain read modes (`r`, `rb`) are allowed there. Why: the old stubs could truncate PoB's cached jewel data and trigger its updater. (2026-11-12, launch-critical-fixes, ed9853dd)
- When PoB changes on disk under a running server, engine tools return an error naming `reload_engine`; the server never restarts the engine silently. Why: a silent restart would clear undo history unnoticed. (2026-11-12, launch-critical-fixes, a4b9218e)
- A failed `loadXML` keeps the previously loaded build active; the engine goes blank only when there was none or restoring it fails, and the error says which. Why: the TypeScript session still holds the previous build's state. (2026-11-12, launch-critical-fixes, ed9853dd)
- Config keys are validated against the running engine's own config metadata before any mutation; unknown keys are a `UserError`, and presets or aliases must fail loudly if PoB renames a key. Why: dead keys silently did nothing. (2026-11-12, launch-critical-fixes, bdbe9663)

## Snapshots, undo and recovery

- A what-if restore or an undo that cannot reproduce its snapshot exactly returns an internal error naming `reset_build`; it never leaves a silently different build. When a probe and its restore both fail, the result is internal and keeps the probe's message; a probe's user error stays a user error only if the restore succeeded. Why: a quietly wrong tree or item set gave wrong advice with no sign of it. (2026-11-13, backlog-restore-and-breaker, 83fb5934)
- Items are restored by item id, and items added since the snapshot are deleted; one that something still uses is kept and the restore fails with the internal error above; passive-tree jewel sockets belong to the tree state, every other slot to the item state. After a committed `swap_item` the replaced item stays in the build's item list until undo, reset or reload, as in PoB's own UI. Why: re-adding item text duplicated items and grew exports. (2026-11-13, backlog-restore-and-breaker, 8fbe9f26)
- An item that does not fit its slot, or item text PoB cannot parse, is a `UserError` raised before any change; batch commands (`replaceSocketGroup`, `allocNodes`, `deallocNodes`) check the whole batch first, so `simulate_passive_change` refuses unallocated or unreachable nodes instead of returning an empty diff. Why: PoB silently emptied the slot, and a bad element left a half-applied change. (2026-11-13, backlog-restore-and-breaker, 8fbe9f26 for items, 7d5ba562 for batch commands)
- `convert_tree_to_latest` keeps whatever the target tree supports, including a secondary ascendancy (bloodline) that PoB's own convert button drops, and replaces the active tree in place. Why: PoB's `CreateUndoState` loses the secondary ascendancy, and an extra tree would grow every export. (2026-11-13, backlog-restore-and-breaker, 7d5de800)
- After a crash the engine comes back with the last build it accepted plus a replay of the committed changes made since; a change is recorded for replay, and its undo entry pushed, only once the whole tool call has succeeded or the change is known to be applied on a live engine. Undo history is cleared by the restart and the user is told once: the first engine call fails with a restart notice, and `load_build` / `reset_build` succeed with a note instead. Why: the old respawn reloaded the originally loaded build and dropped committed changes without saying so. (2026-11-13, backlog-restore-and-breaker, c9b63635)

## Configuration and security

- Path resolution order is environment variable, then saved config, then auto-detect; a missing PoB or LuaJIT never exits the server. Why: MCP clients only show "server disconnected" on exit, so the user could not be asked. (2026-11-12, launch-critical-fixes, a4b9218e)
- Paths supplied through `configure_pob_path` or elicitation are not environment-expanded and may not be network or device paths; `luajitPath` must be an existing file named `luajit*` (`.exe` on Windows). Paths from `POB_PATH`/`LUAJIT_PATH` keep expansion. Why: these values can come from the model, and they are executed or echoed back. (2026-11-12, launch-critical-fixes, a4b9218e)
- `load_build` URLs are accepted only for the exact hosts `pastebin.com` and `pobb.in` (with or without `www.`, as https or http links, default port only); the request is always made over https to a URL rebuilt from a fixed origin plus the build id, redirects are refused, and the fetch and the decoded build are size- and time-bounded. Why: the source string can come from the model, so the caller's URL must never reach `fetch`. (2026-11-13, backlog-ready-items, 65426efd)
- `load_build` downloads and decodes before taking the session lock, so overlapping loads take effect in completion order, not call order. Why: a slow fetch must not block every other engine call; making the later call win was not asked for. (2026-11-13, backlog-ready-items, 65426efd)
- The three-strike crash count is kept per resolved (PoB path, LuaJIT path) pair and clears only when that install changes on disk. Why: reconfiguring must not be a way around the breaker, and a PoB update must be a way out. (2026-11-12, launch-critical-fixes, a4b9218e)
- A crash-breaker strike is any LuaJIT exit that was not requested, any bridge command timeout (the process is killed) and any failed or hung startup; successful commands never forgive strikes. Why: strikes used to reset after five successful commands and timeouts never counted, so the breaker could not trip. (2026-11-13, backlog-restore-and-breaker, f1df96f9)
- `POB_MCP_TEST_FAULTS` (fault injection in `lua/bridge.lua`) is test-only: the server strips it from the LuaJIT child's environment and only a `LuaBridge` option or its test-only setter (`setTestFaults`) can set it; a fault may only raise an error, exit the process or stall. Why: tests need to fail the engine at exact points, and a stray client environment must not be able to turn faults on. (2026-11-13, backlog-restore-and-breaker, f1df96f9)

## Repository and CI

- The repository is public with its git history as it was; no history rewrite. Why: the user accepted the commit identities already in history, and GitHub keeps pull-request refs that a rewrite cannot clear. (2026-11-13, make-repo-public-add-ci, 4a5463fd)
- CI runs the full suite with `REQUIRE_POB=1` against a pinned Path of Building release and a pinned LuaJIT, on Ubuntu and Windows; the workflow uses `pull_request` (never `pull_request_target`), read-only permissions, no secrets, and actions pinned to commit SHAs. Why: fork pull requests run it, and a silent skip must not pass. (2026-11-13, make-repo-public-add-ci, 4a5463fd)
