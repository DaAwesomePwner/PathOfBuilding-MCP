# Path of Building MCP Server — Getting Started Guide

## What it is

A long-lived process that lets Claude (or any MCP-compatible client) read and mutate Path of Building character builds in real time. Claude can load a build code, inspect every stat PoB calculates, swap items/gems/passives, simulate scenarios, and rank upgrades — all backed by the actual PoB calculation engine, not approximations.

## Architecture

```
┌─────────────────┐   stdio (MCP)    ┌─────────────────┐   stdio (JSON-lines) ┌──────────────────┐
│  Claude Desktop │ ◄──────────────► │  pob-mcp (Node) │ ◄──────────────────► │  bridge.lua      │
│   (or any MCP   │   37 tools       │  TypeScript     │   ~50 commands       │  (LuaJIT, runs   │
│    client)      │                  │  BuildSession   │                      │   the real PoB   │
└─────────────────┘                  └─────────────────┘                      │   engine)        │
                                                                               └──────────────────┘
```

Three layers, three responsibilities:

| Layer | Lives in | Job |
|---|---|---|
| **Lua bridge** | `lua/bridge.lua` | Runs the real PoB engine in headless mode (stubs the graphics host and `dofile`s `<POB_PATH>/Launch.lua` or `<POB_PATH>/src/Launch.lua` depending on layout). Reads JSON commands from stdin, dispatches to `build.itemsTab`, `build.skillsTab`, `build.spec`, `build.configTab`, etc., and writes JSON responses to stdout. Knows nothing about MCP. |
| **BuildSession** | `src/build-session.ts` | TypeScript class that owns the LuaJIT subprocess. Provides snapshot/restore, undo stack, `withTemporaryChange`, async mutex (PoB is a singleton — never two ops at once), build-code/URL/XML loading, and all higher-level workflows like `compareItems`, `findOptimalLinks`, `suggestUpgrades`. |
| **Engine manager** | `src/engine-manager.ts` | Resolves the PoB/LuaJIT paths (env → saved config → auto-detect, see `src/paths.ts`), boots the engine in the background, records the PoB version from `manifest.xml`, detects when PoB updates on disk, and handles `configure_pob_path` / `reload_engine`. |
| **MCP server** | `src/server.ts` | Registers 37 tools via `@modelcontextprotocol/sdk`, validates inputs with Zod + a custom `UserError` class, formats responses. This is what Claude actually talks to. |

### Key design choices

- **One LuaJIT process per session.** Booting the PoB engine takes ~2 seconds (loads 2820 tree nodes, all gems, all bases). The server connects to the MCP client first, then pre-warms the engine in the background; tool calls wait for it.
- **Never exits for a missing install.** If PoB or LuaJIT can't be found the server still starts; engine tools return an error asking for the PoB folder (`configure_pob_path`), or ask you directly via MCP elicitation when the client supports it.
- **Version-aware.** If PoB updates itself on disk (new league), tools refuse to run on the stale in-memory engine and point at `reload_engine`.
- **Serial execution.** A mutex guarantees only one operation runs at a time. PoB is fundamentally a single-threaded singleton with shared global state.
- **Snapshot-and-restore for "what-if" queries.** `compare_items`, `find_best_next_nodes`, `suggest_upgrades`, etc. all wrap their probes in a snapshot/restore pair so the build state is always restored *exactly* (verified bit-exact across Life/CombinedDPS/TotalEHP).
- **Three-strike crash circuit breaker.** If the LuaJIT process dies unexpectedly, hangs past its timeout or fails to start 3 times, the server refuses further restarts until you restart the whole MCP server, or update Path of Building and then call `reload_engine`. Prevents silent respawn loops eating your session. Before that, a crashed engine is restarted by the next tool call with your build as of the last committed change; that call tells you so (and that undo history was cleared) instead of running.
- **Heuristic-based error classification.** User-input errors (bad slot name, unknown gem, etc.) are surfaced verbatim. Anything else becomes "Internal error: … try `reset_build`".

## The 37 tools

### Engine setup (3)
- `configure_pob_path` — `{ pobPath, luajitPath? }`: validates the folder (rejects the PoE2 edition), (re)starts the engine, returns the PoB version, and saves the path for next time. A loaded build is carried over. Arguments are taken literally (no `%VAR%` expansion), and `luajitPath` — which the server executes — must be an existing file named like `luajit` (`luajit.exe` on Windows).
- `get_engine_info` — status (`unconfigured` / `starting` / `ready` / `stopped` / `failed` / `stale` / `updating`), PoB version, paths and where they came from, layout, whether PoB changed on disk, config file location, loaded-build info.
- `reload_engine` — restart LuaJIT against the PoB currently on disk (after a PoB update); reloads the current build, clears undo history, reports old → new version.

### Loading and inspection (5)
- `load_build` — accepts a base64 PoB code, pastebin/pobb.in URL, or raw XML. Must be called first.
- `get_stats` — returns calculated stats grouped into categories (`offense`, `defense`, `sustain`, `charges`, `attributes`, `movement`).
- `get_skill_breakdown` — active gem + supports + DPS for the main skill (or any group by index).
- `list_equipped_items` — every equipped item with rarity, base, mods (split into implicit/explicit/crafted/fractured/enchant), quality, item level, sockets.
- `export_build` — `summary` (human-readable text), `xml` (raw PoB XML), or `code` (round-trippable base64 build code).

### Item manipulation (5)
- `list_valid_slots` — every slot with `occupied: true/false`.
- `get_item_in_slot` — full item text and metadata for one slot, or `{empty: true}`.
- `swap_item` — equip an item from PoB-format text, **mutates** the build, returns before/after diff.
- `unequip_item` — remove an item from a slot, **mutates**, returns diff.
- `compare_items` — test 2-5 candidate items in a slot non-destructively. Returns ranked results plus `bestForDPS`/`bestForEHP`/`bestForLife`.

### Passive tree (6)
- `get_passive_tree` — every allocated node with stats, plus point counts and class info.
- `simulate_passive_change` — temporarily allocate/deallocate by node ID or name. Validates connectivity. Always restored.
- `find_best_next_nodes` — scans every reachable unallocated node, ranks by your chosen stat (Life, CombinedDPS, TotalEHP, etc.). ~26s on a typical end-game build.
- `find_worst_allocated_nodes` — finds your least valuable Normal nodes (skips keystones, ascendancy, sockets, masteries; refuses to disconnect the tree).
- `evaluate_keystone` — toggle any keystone, return full stat diff.
- `convert_tree_to_latest` — move a build saved on an old league's tree to PoB's latest tree (a ruthless/alternate sub-type is kept, like PoB's own convert button). **Mutates** (undoable with `undo_last_change`). Reports old → new tree version, allocated node counts, the nodes lost or renamed, mastery selections the new tree no longer offers on that node, and tattoos it lacks (each capped at 50, with an omitted count) and key stat deltas. Already on the latest tree → no change.

### Skill gems and links (7)
- `list_skill_groups` — every socket group with active gem, supports, slot, isMainSkill flag.
- `lookup_gem` — gem metadata by name (tags, isSupport, awakened flag).
- `list_available_supports` — every support gem in the data tables, optionally filtered by active-skill tags.
- `swap_gem` — replace a gem in a group. **Mutates**, returns diff.
- `compare_supports` — identifies the weakest support in a group, ranks 2-10 candidate replacements.
- `evaluate_gem_levels` — DPS scaling from current ±1 through level 24.
- `find_optimal_links` — three-phase heuristic: best single supports → top-K combinations → swap iteration. Honors locked-in supports as constraints. ~16s.

### Configuration & scenarios (6)
- `get_config` — every config var grouped into 8 sections (Combat, Enemy, Map, Skill Options, etc.) with type metadata.
- `set_config` — permanently change config (with config-only undo).
- `list_scenarios` — the 6 built-in presets: `mapping`, `map_boss`, `pinnacle_boss`, `uber_boss`, `no_buffs`, `delirium`.
- `simulate_scenario` — apply a preset, return stats, restore.
- `compare_scenarios` — DPS/EHP across 2+ scenarios.
- `toggle_buffs` — friendly-named on/off for buffs (`onslaught`, `fortify`, etc.).

### Optimization advisor (5)
- `diagnose_build` — read-only sweep: uncapped resists, low EHP, mana sustain, missing crit/accuracy, low-level main gem, etc. Filterable by `defense`/`offense`/`qol`/`balance`.
- `suggest_upgrades` — unequips each slot in turn to measure its DPS+EHP contribution, ranks by upgrade priority, suggests archetype-aware mods.
- `snapshot_and_compare` — `take` / `list` / `compare` named stat snapshots across a session.
- `undo_last_change` — pops the undo stack (works for swap/unequip/swap_gem/set_config/convert_tree_to_latest/etc.).
- `reset_build` — discard everything, return to the originally loaded state.

## Setup

This server requires:

1. **Path of Building Community (Path of Exile 1)** installed locally (download from <https://pathofbuilding.community/>). On Windows the default install path is `%APPDATA%\Path of Building Community\`. The PoE2 edition is not supported.
2. **Node.js 20+**.
3. **LuaJIT (5.1 ABI)**, installed separately — the Windows PoB installer does **not** include `luajit.exe` (see [`README.md`](./README.md#prerequisites) for install commands).

To run the server in your MCP client, add this to `claude_desktop_config.json` (Claude Desktop), or for Claude Code run `claude mcp add pob -- npx -y pob-mcp-server` (env vars go before the name: `claude mcp add --env POB_PATH=... pob -- npx -y pob-mcp-server`):

```json
{
  "mcpServers": {
    "pob": {
      "command": "npx",
      "args": ["-y", "pob-mcp-server"],
      "env": {
        "POB_PATH": "C:\\Users\\you\\AppData\\Roaming\\Path of Building Community"
      }
    }
  }
}
```

`POB_PATH` is optional. Paths resolve as **env var → saved config → auto-detect** (standard install folder, the installer's registry entry, common LuaJIT locations, `PATH`). If nothing is found the server still starts: just tell Claude where PoB is installed and it calls `configure_pob_path`, which saves the path to `%APPDATA%\pob-mcp-server\config.json` (macOS `~/Library/Application Support/pob-mcp-server/`, Linux `~/.config/pob-mcp-server/`).

Restart Claude Desktop. You should see `pob` appear in the MCP tools indicator and 37 tools become callable. Ask *"which Path of Building version are you using?"* — Claude calls `get_engine_info`.

### Environment variables

| Var | Default | What it does |
|---|---|---|
| `POB_PATH` | saved config, then autodetect | Your Path of Building Community install (the directory containing `Launch.lua` and `Modules/Build.lua`, or a source clone with them under `src/`). |
| `LUAJIT_PATH` | saved config, then autodetect | The `luajit` binary, or a folder containing it. |
| `POB_MCP_CONFIG_DIR` | per-user config dir | Where `config.json` lives (tests point it at a temp dir). |
| `POB_TIMING` | unset | Set to `1` to log every Lua command's wall time to stderr (useful for performance debugging). |

### Verify (local checkout)

If you've cloned this repo for development:

```bash
npm install
npm run build
npm run typecheck        # tsc --noEmit
npm run test:paths       # unit tests, no PoB needed
npm run test:startup     # starts dist/server.js unconfigured, then configure_pob_path / reload_engine (needs PoB for the last part)
npm run test:bridge      # Lua bridge end-to-end (needs POB_PATH + luajit)
npm run test:all         # full suite, in parallel, ~2.5 min
```

Tests print `SKIPPED:` and exit 0 when no PoB install is found or luajit is missing.

## A typical session

A user prompt to Claude like *"Here's my build code: `eNrtPGtv28b...` — what's the weakest item and what should I look for?"* triggers something like this under the hood:

1. `load_build({ source: "eNrtPGtv28b..." })` — Claude pastes the code in.
2. `get_stats({})` — sanity check on baseline stats.
3. `diagnose_build({})` — see if anything jumps out (uncapped resist, low EHP, bad mana, etc.).
4. `suggest_upgrades({})` — full unequip-and-measure sweep across every slot, ~26s.
5. `list_equipped_items({})` — pull mod text on the slot it flagged.
6. Claude reasons about *what mods* would help and replies with a prioritized recommendation.

For an interactive iteration loop:

1. Claude proposes an upgrade — say a new chest with `+life`, `+%life`, and high evasion.
2. User pastes the proposed item text.
3. Claude calls `compare_items({ slot: "Body Armour", items: [user_text, current_text] })` — ranked diff with no permanent change.
4. If user wants to commit it, Claude calls `swap_item({ slot, itemText })`. `undo_last_change` rolls back if needed.

## Important behavior to know

- **All work is serial.** If you ask Claude to compare 5 items and find optimal links at the same time, the second tool call waits. This is intentional — PoB cannot run concurrent calculations.
- **Mutations require explicit undo or reset.** `swap_item`, `unequip_item`, `swap_gem`, `set_config`, `simulate_passive_change` (when written as commit) all push to the undo stack. `undo_last_change` reverts one step; `reset_build` reverts everything.
- **Simulation tools never persist.** `simulate_*`, `compare_*`, `evaluate_*`, `find_*` always restore the state in `finally`, even if the operation throws. Verified bit-exact across 70+ tests.
- **Build code round-trip is lossless.** `export_build({ format: "code" })` produces a string you can paste back into PoB-the-app or back into `load_build`. Same for `format: "xml"`.
- **First call is slow, subsequent calls are fast.** ~2s engine warm + ~1s first build load. After that most ops are 50-300 ms; full-tree scans 16-26s.
- **Crash circuit breaker.** After 3 strikes (unexpected exits, command timeouts or failed starts) the server refuses to respawn LuaJIT and tells you to restart the MCP server (or update Path of Building and call `reload_engine`). Prevents respawn loops. Earlier crashes restart the engine with the last committed build; the first call afterwards reports it and clears undo history.
- **PoB updates.** When PoB updates itself (new league), tools stop with *"Path of Building was updated on disk from X to Y"*. `reload_engine` restarts the engine and reloads your build; undo history is cleared.

## Troubleshooting quick reference

| Symptom | Fix |
|---|---|
| `Path of Building is not configured yet` | Tell Claude your PoB folder (it calls `configure_pob_path`), or set `POB_PATH`. |
| `Could not find a luajit executable` | Install LuaJIT separately, then `configure_pob_path` with `luajitPath`, or set `LUAJIT_PATH`. |
| `… is Path of Building for Path of Exile 2` | Use the PoE1 install (folder without "(PoE2)"). |
| `Path of Building was updated on disk from X to Y` | Call `reload_engine`. |
| `Lua engine has crashed 3 times` | Restart the MCP server (restarting Claude Desktop does this), or update Path of Building and call `reload_engine`. Check stderr (visible in Claude logs) for the cause. |
| `Lua bridge timeout after 60000ms` | A command stuck. The `cmd` name is in the error message; check Lua side for bugs. |
| `Build code is too short to be a real PoB build` | You probably pasted only the URL prefix or a fragment. |
| `Item text must start with a "Rarity: ..." line` | Use the PoB *Copy* button (right-click → Copy item) — gives the exact format. |
| Stats look wrong after lots of mutations | Run `reset_build` to revert to the originally loaded state. |
| MCP server doesn't appear in Claude | Check the JSON config syntax, the absolute paths, and that `dist/server.js` exists (`npm run build`). Then restart Claude Desktop. |

Full troubleshooting guide: [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)

## Where to go next

- **Add a new tool**: extend `bridge.lua` with a new dispatch case → expose it in `BuildSession` (preferably routed through `withLock`) → register a Zod-validated entry in `server.ts` with `tools.engine(...)` (the handler receives the live `BuildSession`). Pattern is identical for all engine-backed tools.
- **Add a scenario preset**: append to `SCENARIO_PRESETS` in `build-session.ts` — `simulate_scenario` and `list_scenarios` pick it up automatically.
- **Tune performance**: set `POB_TIMING=1` and inspect the per-command histogram. `bridge.getStats` and `bridge.exportXML` dominate; everything else is sub-100ms typically.
- **Pull upstream PoB updates**: `git fetch upstream && git merge upstream/dev`. `bridge.lua` only depends on stable PoB internals (`build.itemsTab`, `build.spec:CountAllocNodes`, etc.), so upstream churn rarely breaks anything.

That's the whole picture: 37 tools, three layers, deterministic state, and a real PoB engine behind every number.
