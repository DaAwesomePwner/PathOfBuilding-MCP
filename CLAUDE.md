# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working on this repository.

## What this repo is

`pob-mcp-server` — a TypeScript/Node MCP server that exposes the [Path of Building Community](https://pathofbuilding.community/) calculation engine to LLM clients. The server spawns a LuaJIT subprocess that runs PoB's real engine in headless mode and drives it via JSON over stdio.

PoB itself is an **external runtime dependency**. The user's PoB install at `%APPDATA%\Path of Building Community\` (or platform equivalent) provides `src/HeadlessWrapper.lua`, the calculation modules, and the lua libraries. This repo owns only the Node server, the Lua bridge adapter, and tests.

## Common commands

```bash
npm install
npm run build         # tsc to dist/, marks dist/server.js executable
npm run dev           # tsx src/server.ts (no build needed)
npm run start         # node dist/server.js (built artifacts)

# Tests — POB_PATH must point at a real PoB install, or each integration test prints SKIPPED and exits 0.
npm run test:paths    # unit tests for paths.ts (no LuaJIT needed)
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

Env vars:
- `POB_PATH` — path to PoB install. Defaults: `%APPDATA%\Path of Building Community` on Windows, `~/Library/Application Support/Path of Building Community` on macOS, `~/.local/share/Path of Building Community` on Linux.
- `LUAJIT_PATH` — path to a `luajit` binary. Probes `<POB_PATH>/runtime/luajit{,.exe}` and PATH if unset.
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
| Path resolution | `src/paths.ts` | `resolvePoBPath()` + `resolveLuaJITPath()` — env var, auto-detect, error. Single source of truth for install discovery. |
| Lua bridge | `lua/bridge.lua` | Boots PoB via `HeadlessWrapper.lua`, reads JSON commands from stdin, dispatches to `build.itemsTab`, `build.skillsTab`, `build.spec`, `build.configTab`. Knows nothing about MCP. |
| BuildSession | `src/build-session.ts` | TS class owning the LuaJIT subprocess. Snapshot/restore, undo stack, `withTemporaryChange`, async mutex, build-code/URL/XML loading, higher-level workflows. |
| MCP server | `src/server.ts` | Registers 33 tools via `@modelcontextprotocol/sdk`, validates with Zod + `UserError`, formats responses. |

## Non-negotiable invariants

- **One LuaJIT process per session.** Engine boot is ~2s; pre-warmed on startup.
- **Serial execution via async mutex.** PoB is single-threaded with shared globals. Two ops at once corrupts state.
- **Snapshot-and-restore for "what-if" queries.** Every `simulate_*`, `compare_*`, `find_*`, `evaluate_*` wraps its probe in a `try/finally` snapshot/restore pair. Must restore bit-exact (`Life`, `CombinedDPS`, `TotalEHP` spot-checked in `state-integrity-test.ts`).
- **Three-strike crash circuit breaker.** After 3 unexpected LuaJIT exits, the server refuses respawns. Don't disable — it prevents silent respawn loops.
- **Mutations push to the undo stack.** `swap_item`, `unequip_item`, `swap_gem`, `set_config`, and the commit-variant of `simulate_passive_change` push. `undo_last_change` pops; `reset_build` reverts to the originally-loaded XML.
- **Error classification.** User-input errors (bad slot, unknown gem) → `UserError`, surfaced verbatim. Anything else → "Internal error: ... try reset_build".

## Adding a tool

1. Extend `lua/bridge.lua` with a new dispatch case.
2. Expose it in `BuildSession` (route mutations through `withLock`, push to undo stack as needed).
3. Register a Zod-validated entry in `src/server.ts`.

All 33 existing tools follow this pattern.

## Conventions

- **Item text format** in MCP tools comes from PoB's "Copy item" (right-click) — must start with a `Rarity:` line. The server validates strictly.
- **Build code round-trip is lossless.** `export_build({format:"code"})` produces a base64 zlib string that `load_build` accepts back. Same for `xml`.

## Reference files

- [`README.md`](./README.md) — installation, configuration, tool catalog.
- [`GETTING_STARTED.md`](./GETTING_STARTED.md) — narrative tour with examples.
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — error catalog and fixes.
- [`docs/history/`](./docs/history/) — original design rationale and phase plans, pre-extraction.
