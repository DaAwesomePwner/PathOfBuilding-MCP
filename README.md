# pob-mcp-server

An [MCP](https://modelcontextprotocol.io/) server that exposes Path of Building's calculation engine to LLM clients (Claude Desktop, etc.). It loads PoB builds, computes stats, and returns structured analysis through MCP tools.

## Architecture

```
Claude Desktop  <-stdio->  pob-mcp-server (Node.js)  <-stdio->  luajit + bridge.lua  ->  PoB engine
```

The MCP server speaks MCP/JSON-RPC on its own stdio. It spawns a child `luajit` process that runs `mcp-server/lua/bridge.lua` against the PoB source tree. All state is mediated by `BuildSession`, which serializes commands, snapshots state for safe comparisons, and supports undo/reset.

## Prerequisites

- Node.js 18+
- LuaJIT 2.1 on `PATH` (or set `LUAJIT_PATH`)
- A clone of the PathOfBuilding repository (this repo)

## Setup

```bash
cd mcp-server
npm install
npm run build
```

Optional environment variables:

| Variable | Description |
|----------|-------------|
| `POB_PATH` | Absolute path to the PathOfBuilding repo root (containing `src/Launch.lua`). If unset, the server auto-detects from its install location. |
| `LUAJIT_PATH` | Absolute path to the `luajit` executable. Defaults to `luajit` on `PATH`. |
| `POB_TIMING` | Set to `1` to log per-operation timing to stderr (useful for profiling). |

## Run

```bash
# development (no build needed):
npm run dev

# production after `npm run build`:
npm start
```

## Claude Desktop Registration

Add an entry to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "pob": {
      "command": "node",
      "args": ["/absolute/path/to/PathOfBuilding/mcp-server/dist/src/server.js"],
      "env": {
        "POB_PATH": "/absolute/path/to/PathOfBuilding"
      }
    }
  }
}
```

Restart Claude Desktop and the `pob` server should appear.

## Tools

### `load_build`
Load a build before any analysis. Accepts:
- A PoB build code (base64-encoded zlib XML)
- A pastebin.com URL
- A pobb.in URL
- Raw XML starting with `<?xml` or `<PathOfBuilding`

Returns: class, ascendancy, level, main skill name.

### `get_stats`
Returns calculated stats categorized into `offense`, `defense`, `sustain`, `charges`, `attributes`, `movement`. Zero-value stats are filtered. Pass `categories` to limit the response.

### `get_skill_breakdown`
Returns the active gem and support gems for a socket group with levels, qualities, and enabled state. When the queried group is the main skill, also returns DPS / hit / cast-rate stats.

Optional `skillIndex` (1-based). Defaults to the main socket group.

### `list_equipped_items`
Returns each equipped item by slot with rarity, base type, name, item level, quality, sockets, corruption, and structured implicit / explicit / enchant mod lines (each tagged with `crafted`, `fractured`, `enchant`, `implicit`).

### `list_valid_slots`
Lists every currently valid equipment slot with its `occupied` flag and the equipped item name (if any). Includes active jewel slots created by allocated tree sockets.

### `get_item_in_slot`
Returns `{ slot, empty, item }` for a single slot. `item` includes the full PoB raw text (suitable for round-tripping through `swap_item`) plus rarity / name / base.

### `swap_item`
Equips an item in a slot. Returns a stat diff bucketed by category plus convenient `keyDeltas` for `CombinedDPS` / `Life` / `EnergyShield` / `TotalEHP`. **Permanently mutates** the build — pair with `undo_last_change` to revert.

### `unequip_item`
Same shape as `swap_item` but removes the slot's contents. Permanently mutates; revert with `undo_last_change`.

### `compare_items`
Tests 2–5 candidate items in a slot sequentially against the currently equipped item. Each candidate runs in isolation with full state restoration between tests, so the build returns to its original state after the call. Returns per-candidate stats and diffs plus `bestForDPS`, `bestForEHP`, and `bestForLife` indices.

### `undo_last_change`
Pops the most recent mutation from the undo stack and restores the build state.

### `get_passive_tree`
Returns full tree state: every allocated node with stats, currently active keystones, allocated notables, point counts (used / max / extra), ascendancy points, class and ascendancy names, and counts by node type.

### `simulate_passive_change`
Temporarily allocates and/or deallocates passive nodes (by name or numeric ID) and returns the stat diff. Always restores the tree afterward. Includes a connectivity validator (`valid` + `validationErrors`).

### `find_best_next_nodes`
Iterates every reachable unallocated node, simulates allocating each, and ranks by improvement of the chosen stat (default `CombinedDPS`). Skips jewel sockets by default. Returns top-N (default 10) with `delta`, `tradeoffs`, and node stats. Build is restored when the scan completes.

### `find_worst_allocated_nodes`
Identifies the least valuable currently-allocated `Normal` nodes by simulating their removal. Skips keystones, ascendancy nodes, jewel sockets, masteries, and any node whose removal disconnects the tree. Returns top-N with `lossIfRemoved`.

### `evaluate_keystone`
Toggles a keystone (allocates if not taken, removes if taken) and returns the full stat diff. Tree is restored afterward.

### `list_skill_groups`
Lists every socket group (skill setup) with active gems and support gems split out, plus slot, label, and the main-skill flag.

### `lookup_gem`
Returns metadata for a gem by name (active or support): tags, color, requirements, max level, and whether it is a support / vaal / awakened gem.

### `list_available_supports`
Lists all support gems in PoB's data, optionally filtered to those that share at least one tag with a given active skill.

### `swap_gem`
Temporarily replaces a gem in a skill group and returns the stat diff. The original gem is restored automatically after the call (no undo entry is pushed).

### `compare_supports`
Identifies the weakest enabled support in a group (by simulating its removal) and ranks 1–10 candidate replacements by resulting DPS. Build is fully restored after.

### `evaluate_gem_levels`
Tests a range of levels for a single gem and returns the DPS for each. By default tests `current ± 1` through `+4` (capped at 24); `levels` overrides the explicit list.

### `find_optimal_links`
Heuristically searches for the best support combination for an active skill: ranks supports individually, takes the top N, then iteratively swaps in next-best candidates to detect synergies. Mutates and restores the **main** skill group. Locked supports can be required via `constraints`. Typical runtime 10–60 s depending on `topN` and slot count.

### `get_config`
Returns the current build configuration grouped into PoB's tab sections (Combat, Enemy, Map, Skill Options, etc.). Each entry includes label, type (`check` / `count` / `text` / `list`), value, and `validValues` for list-type options. Returns the raw key→value map under `raw`.

### `set_config`
**Permanently** apply config changes. Accepts the raw PoB config keys (e.g. `{ enemyIsBoss: "Pinnacle", usePowerCharges: true }`). Returns a categorized stat diff. Pushes a config-only undo entry; revert with `undo_last_change`.

### `simulate_scenario`
Apply a named preset scenario (e.g. `mapping`, `pinnacle_boss`, `uber_boss`, `delirium`, `no_buffs`) inside a snapshot/restore cycle and return the stat diff. The build is fully restored after the call. Use `list_scenarios` to discover available presets.

### `compare_scenarios`
Run 2+ named scenarios sequentially and report `before`, `after`, and `diff` for each, plus a baseline. Build state is fully restored.

### `list_scenarios`
Returns the catalog of preset scenarios (name, description, options).

### `toggle_buffs`
Convenience wrapper: takes a friendly buff map (e.g. `{ onslaught: true, fortify: false, powerCharges: 5 }`) and applies it inside a snapshot/restore cycle. Returns the stat diff without persisting changes.

### `diagnose_build`
Read-only multi-check diagnostics. Returns an array of `{ category, severity, code, title, detail, suggestion? }` covering resistance caps, life pool, EHP, mana sustain, accuracy/crit hit-chance, weapon presence, and main-skill DPS sanity. Optional `focus` filters to `defense` / `offense` / `sustain` / `gear` / `tree`.

### `suggest_upgrades`
For each tracked equipment slot, temporarily unequips the item, measures the loss across `CombinedDPS` / `Life` / `EnergyShield` / `TotalEHP`, and ranks slots by total contribution. Restores the build after every iteration. Use `slots` to limit, `optimizeFor` to choose the ranking metric. Typical runtime 20–40 s for the full set.

### `export_build`
Returns the build in the requested `format`:
- `xml` — full PoB build XML
- `code` — base64 zlib build code (round-trips back to XML)
- `summary` — human-readable text overview (class, level, key stats, main skill, equipped items)

### `snapshot_and_compare`
Manage labeled snapshots for ad-hoc comparisons. Actions:
- `take` — capture current state under `label`
- `list` — list known labels
- `compare` — diff two labels (`labelA` vs `labelB`) and return the stat changes

### `reset_build`
Reverts to the originally loaded build XML, discarding all mutations and clearing the undo stack.

## Tests

```bash
npm run test:bridge   # raw Lua bridge round-trips
npm run test:session  # BuildSession snapshot/restore/undo/reset
npm run test:server   # MCP client <-> server end-to-end (Phase 2 tools)
npm run test:phase3   # item swap / compare / undo end-to-end
npm run test:phase4   # passive tree analysis end-to-end
npm run test:phase5   # skill gem manipulation end-to-end
npm run test:phase6   # config & scenario tools end-to-end
npm run test:phase7   # diagnostics, upgrades, export, snapshots end-to-end
npm run test:integrity # state integrity stress test (snapshot/restore drift)
npm run test:errors   # input validation and error path coverage
npm run test:all      # run every suite sequentially
```

## Limitations

- Single build at a time per server process (PoB engine is a global singleton).
- No live trade-API integration.
- `find_optimal_links` always operates on the main skill group; manual targeting of secondary groups is not yet wired up.

See [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) for common failure modes and recovery steps.
