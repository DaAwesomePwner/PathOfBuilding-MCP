# Decisions

Choices that later work must respect: policy, scope, interface and convention
decisions, one line each, current state only.

## Scope

- Only the launch-critical fix set shipped for the new-league PoB update; every other 2026-11-12 review finding lives in `docs/backlog.md`. Why: the user said a new Path of Exile 1 update was due the next day and chose to postpone the rest. (2026-11-12, launch-critical-fixes, docs/backlog.md)
- Postponed by the user, not rejected: `convert_tree_to_latest` tool, what-if restore exactness (masteries, items, skills), poe.ninja build links, crash-breaker tuning, the install DLL locks, the remaining test gaps and docs polish. Why: outside the launch-critical set; URL-loading hardening and the CI workflow have since shipped, and poe.ninja support is a new feature left in the backlog. (2026-11-13, make-repo-public-add-ci, 4a5463fd) Replaces: the same list including tests/CI (2026-11-13)

## Engine and PoB install

- The bridge never writes inside the PoB install: writes, removes and renames targeting it are refused, and only plain read modes (`r`, `rb`) are allowed there. Why: the old stubs could truncate PoB's cached jewel data and trigger its updater. (2026-11-12, launch-critical-fixes, ed9853dd)
- When PoB changes on disk under a running server, engine tools return an error naming `reload_engine`; the server never restarts the engine silently. Why: a silent restart would clear undo history unnoticed. (2026-11-12, launch-critical-fixes, a4b9218e)
- A failed `loadXML` keeps the previously loaded build active; the engine goes blank only when there was none or restoring it fails, and the error says which. Why: the TypeScript session still holds the previous build's state. (2026-11-12, launch-critical-fixes, ed9853dd)
- Config keys are validated against the running engine's own config metadata before any mutation; unknown keys are a `UserError`, and presets or aliases must fail loudly if PoB renames a key. Why: dead keys silently did nothing. (2026-11-12, launch-critical-fixes, bdbe9663)

## Configuration and security

- Path resolution order is environment variable, then saved config, then auto-detect; a missing PoB or LuaJIT never exits the server. Why: MCP clients only show "server disconnected" on exit, so the user could not be asked. (2026-11-12, launch-critical-fixes, a4b9218e)
- Paths supplied through `configure_pob_path` or elicitation are not environment-expanded and may not be network or device paths; `luajitPath` must be an existing file named `luajit*` (`.exe` on Windows). Paths from `POB_PATH`/`LUAJIT_PATH` keep expansion. Why: these values can come from the model, and they are executed or echoed back. (2026-11-12, launch-critical-fixes, a4b9218e)
- `load_build` URLs are accepted only for the exact hosts `pastebin.com` and `pobb.in` (with or without `www.`, as https or http links, default port only); the request is always made over https to a URL rebuilt from a fixed origin plus the build id, redirects are refused, and the fetch and the decoded build are size- and time-bounded. Why: the source string can come from the model, so the caller's URL must never reach `fetch`. (2026-11-13, backlog-ready-items, 65426efd)
- `load_build` downloads and decodes before taking the session lock, so overlapping loads take effect in completion order, not call order. Why: a slow fetch must not block every other engine call; making the later call win was not asked for. (2026-11-13, backlog-ready-items, 65426efd)
- The three-strike crash count is kept per resolved (PoB path, LuaJIT path) pair and clears only when that install changes on disk. Why: reconfiguring must not be a way around the breaker, and a PoB update must be a way out. (2026-11-12, launch-critical-fixes, a4b9218e)

## Repository and CI

- The repository is public with its git history as it was; no history rewrite. Why: the user accepted the commit identities already in history, and GitHub keeps pull-request refs that a rewrite cannot clear. (2026-11-13, make-repo-public-add-ci, 4a5463fd)
- CI runs the full suite with `REQUIRE_POB=1` against a pinned Path of Building release and a pinned LuaJIT, on Ubuntu and Windows; the workflow uses `pull_request` (never `pull_request_target`), read-only permissions, no secrets, and actions pinned to commit SHAs. Why: fork pull requests run it, and a silent skip must not pass. (2026-11-13, make-repo-public-add-ci, 4a5463fd)
