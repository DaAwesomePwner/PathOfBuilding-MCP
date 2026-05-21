# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Two distinct projects living together:

1. **Path of Building Community** (`src/`, `spec/`, `runtime/`, `docs/`) — the upstream PoB build planner for Path of Exile. Lua codebase that runs inside a custom 2D graphics host (`SimpleGraphic`) on LuaJIT 5.1.
2. **pob-mcp-server** (`mcp-server/`) — a TypeScript/Node.js MCP server (added in commit `2b492df1`) that exposes PoB's calculation engine to LLM clients. It spawns a LuaJIT child process and drives the **real** PoB engine in headless mode via JSON over stdio. Not upstream.

The two interact through `mcp-server/lua/bridge.lua`, which loads PoB via `HeadlessWrapper.lua` and exposes ~50 commands. If you change anything in `src/`, the bridge may break — `mcp-server/test/bridge-test.ts` is the fastest way to verify.

## Common commands

### MCP server (`mcp-server/`)
```bash
cd mcp-server
npm install
npm run build            # tsc to dist/
npm run dev              # tsx src/server.ts (no build needed)
npm run test:bridge      # ~10s — Lua bridge round-trip (run first when debugging)
npm run test:session     # BuildSession snapshot/restore/undo/reset
npm run test:server      # MCP client <-> server end-to-end
npm run test:phase3      # item swap / compare / undo
npm run test:phase4      # passive tree analysis
npm run test:phase5      # skill gem manipulation
npm run test:phase6      # config & scenario tools
npm run test:phase7      # diagnostics, upgrades, export, snapshots
npm run test:integrity   # bit-exact snapshot/restore stress
npm run test:errors      # input validation paths
npm run test:all         # everything sequentially (~3 min)
```

Single test file: `tsx mcp-server/test/<file>.ts` (these are plain Node scripts, not a runner).

Useful env vars: `POB_PATH` (repo root, autodetected), `LUAJIT_PATH` (luajit binary), `POB_TIMING=1` (per-command timing on stderr).

### PoB itself (Lua)
```bash
docker-compose up        # runs all busted specs in spec/System
# inside a configured environment:
busted                   # uses .busted config — runs spec/ excluding [builds] tag
busted --tags builds     # only the heavy TestBuilds_spec
busted spec/System/TestSkills_spec.lua    # one file
```

The `.busted` config sets `lpath=../runtime/lua/?.lua;...` and `helper=HeadlessWrapper.lua` — tests run from the `src/` directory using the headless PoB stubs.

### Manifest / data regeneration
```bash
python update_manifest.py   # rebuilds SHA-1 hashes in manifest.xml after adding files
```
If you change parsing logic in `src/Modules/ModParser.lua`, regenerate `src/Data/ModCache.lua` by launching PoB with `Ctrl` held, and **commit the regenerated file**. Files in `src/Data` headed with "automatically generated, do not edit" are produced by scripts in `src/Export/Scripts/`.

## Architecture

### MCP server (three layers)
```
Claude Desktop <-stdio MCP-> pob-mcp (Node) <-stdio JSON-lines-> bridge.lua (LuaJIT runs PoB)
```

| Layer | File | Job |
|---|---|---|
| Lua bridge | `mcp-server/lua/bridge.lua` | Loads PoB via `HeadlessWrapper.lua`, reads JSON commands from stdin, dispatches to `build.itemsTab`, `build.skillsTab`, `build.spec`, `build.configTab`. Knows nothing about MCP. |
| BuildSession | `mcp-server/src/build-session.ts` | TS class owning the LuaJIT subprocess. Provides snapshot/restore, undo stack, `withTemporaryChange`, async mutex (PoB is a singleton), build-code/URL/XML loading, higher-level workflows (`compareItems`, `findOptimalLinks`, `suggestUpgrades`). |
| MCP server | `mcp-server/src/server.ts` | Registers 33 tools via `@modelcontextprotocol/sdk`, validates with Zod + `UserError`, formats responses. |

**Non-negotiable invariants** — break these and tests fail in subtle ways:
- **One LuaJIT process per session.** Engine boot is ~2s; pre-warmed on startup.
- **Serial execution via async mutex.** PoB is fundamentally single-threaded with shared globals. Two ops at once corrupts state.
- **Snapshot-and-restore for "what-if" queries.** Every `simulate_*`, `compare_*`, `find_*`, `evaluate_*` wraps its probe in a `try/finally` snapshot/restore pair and must restore bit-exact (`Life`, `CombinedDPS`, `TotalEHP` are spot-checked in `state-integrity-test.ts`).
- **Three-strike crash circuit breaker.** After 3 unexpected LuaJIT exits, the server refuses respawns and forces a full restart. Don't disable this — it prevents silent respawn loops.
- **Mutations push to the undo stack.** `swap_item`, `unequip_item`, `swap_gem`, `set_config`, and the "commit" variant of `simulate_passive_change` push. `undo_last_change` pops; `reset_build` reverts to the originally-loaded XML.
- **Error classification.** User-input errors (bad slot, unknown gem) → `UserError` surfaced verbatim. Anything else → "Internal error: ... try reset_build".

To add a tool: extend `bridge.lua` with a new dispatch case → expose it in `BuildSession` (route mutations through `withLock`) → register a Zod-validated entry in `server.ts`. All 33 existing tools follow this pattern.

### Path of Building (Lua) — the parts that matter

`src/Launch.lua` boots the program, decides dev-mode, and loads `src/Modules/Main.lua`. `Main` has two top-level modes: build list (`BuildList.lua`) and an open build (`Build.lua`). Everything else is hung off `Build`.

The calculation pipeline lives in `src/Modules/Calc*.lua`:
- `CalcSetup.lua` assembles the mod database for player + enemy actors from gear, tree nodes, jewels, flasks, granted skills, etc. This is where most "why doesn't my mod apply?" bugs live.
- `CalcOffence.lua` / `CalcDefence.lua` compute the actual numbers.
- `CalcPerform.lua` handles channel/cast/attack performance specifics.
- `CalcBreakdown.lua` produces the per-stat breakdown shown in the Calcs tab.
- `CalcActiveSkill.lua` builds the active-skill list (including supports granted by items).

The mod parser (`src/Modules/ModParser.lua`) is huge and generates `src/Data/ModCache.lua` — see `docs/addingMods.md` and `docs/modSyntax.md` before editing. Skills: `docs/addingSkills.md`.

`HeadlessWrapper.lua` stubs the graphics host so the engine can run from the command line — this is what both `docker-compose` testing and the MCP server's `bridge.lua` rely on.

## Important conventions

- **PRs go to `dev`, not `master`** (per `CONTRIBUTING.md`). The MCP fork's default branch in this checkout is `master` — confirm before pushing upstream.
- **Generated files in `src/Data/`** are marked `-- This file is automatically generated, do not edit!`. Change the script under `src/Export/Scripts/` and re-run, don't hand-edit the data.
- **Dev mode** is auto-enabled when the manifest looks remote; disables auto-updates and unlocks `F5` restart, `Ctrl+~` console, `ConPrintf`, and `Alt`-held tooltip debug info. See `CONTRIBUTING.md` § "Forcing Dev Mode OFF" to disable.
- **Item text format** in MCP tools comes from PoB's "Copy item" (right-click) — must start with a `Rarity:` line. The MCP server validates this strictly.
- **Build code round-trip is lossless.** `export_build({format:"code"})` produces a base64 zlib string that `load_build` accepts back. Same for `xml`.

## Reference files for deep dives

- `docs/rundown.md` — full file-by-file map of `src/`.
- `docs/addingMods.md`, `docs/modSyntax.md`, `docs/addingSkills.md`, `docs/calcOffence.md` — when touching mod parsing, skills, or calc internals.
- `mcp-server/GETTING_STARTED.md` — narrative tour of all 33 MCP tools with a typical session walkthrough.
- `mcp-server/TROUBLESHOOTING.md` — common failure modes for the MCP server.
- `plans/phase*.md` — design docs for each MCP server build phase (read these before changing cross-cutting MCP behavior).
- `pob-mcp-build-instructions-v2.md` — root-level spec for the MCP server build-out.
