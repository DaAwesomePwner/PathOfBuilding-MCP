# pob-mcp-server

[![CI](https://github.com/DaAwesomePwner/PathOfBuilding-MCP/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/DaAwesomePwner/PathOfBuilding-MCP/actions/workflows/ci.yml)

An MCP server that exposes [Path of Building Community](https://pathofbuilding.community/)'s build-planning and calculation engine to LLM clients (Claude Desktop, Claude Code, and other [MCP](https://modelcontextprotocol.io/) hosts).

The server runs PoB's real Lua calculation engine in headless mode and surfaces 46 tools for inspecting builds, swapping items and gems, manipulating the passive tree, simulating "what-ifs," comparing alternatives, and generating weighted trade searches.

## Prerequisites

1. **Path of Building Community (Path of Exile 1)** installed locally — download from <https://pathofbuilding.community/>. The Windows installer places it at `%APPDATA%\Path of Building Community\`. A git clone of the PoB repo also works. The **Path of Exile 2** edition ("Path of Building Community (PoE2)") is **not supported** and is rejected with a specific message.
2. **Node.js >= 20**.
3. **LuaJIT (5.1 ABI)**, installed separately. PoB's GUI embeds `lua51.dll`; the Windows PoB installer does **not** ship a standalone `luajit.exe`, so install one:
   - Windows (scoop): `scoop install luajit`
   - Windows (winget): `winget install DEVCOM.LuaJIT`
   - macOS (Homebrew): `brew install luajit`
   - Linux (apt): `sudo apt-get install luajit`

## Quick start

Run via npx (no install):

```bash
npx -y pob-mcp-server
```

Then wire it into your MCP client. **Claude Desktop** — edit `claude_desktop_config.json` (the `env` block is optional, see below):

```json
{
  "mcpServers": {
    "pob": {
      "command": "npx",
      "args": ["-y", "pob-mcp-server"],
      "env": {
        "POB_PATH": "C:\\Users\\you\\AppData\\Roaming\\Path of Building Community",
        "LUAJIT_PATH": "C:\\Users\\you\\scoop\\shims\\luajit.exe"
      }
    }
  }
}
```

**Claude Code**:

```bash
# auto-detect PoB + LuaJIT (or configure later from the chat, see below)
claude mcp add pob -- npx -y pob-mcp-server

# or pin the paths; --env options go before the server name, the command after --
claude mcp add --env POB_PATH="C:\Users\you\AppData\Roaming\Path of Building Community" --env LUAJIT_PATH="C:\Users\you\scoop\shims\luajit.exe" pob -- npx -y pob-mcp-server
```

`POB_PATH` and `LUAJIT_PATH` are optional. If the server cannot find PoB or LuaJIT it **still starts**: every engine tool returns an error telling the assistant to ask you for your PoB folder and call `configure_pob_path`. Clients that support MCP elicitation show you a prompt for the folder directly. The chosen path is saved and reused on the next start.

> **`configure_pob_path({ pobPath, luajitPath? })` — the `luajitPath` you give is executed by the server.** As a tool argument it must be the full path of an existing file named like `luajit` (`luajit.exe` on Windows; scripts such as `.bat`/`.cmd`/`.sh` are refused). Tool arguments are taken literally: `~` is expanded but environment variables (`%VAR%`, `$VAR`) are not, and network/device paths (`\\host\share`, `//host/share`, `\\?\…`, `\\.\…`) are refused — set `POB_PATH` / `LUAJIT_PATH` in the server's environment if you really need one. `POB_PATH` / `LUAJIT_PATH` env values keep their more lenient handling (env-var expansion, `LUAJIT_PATH` may be a folder).

## Configuration

Paths are resolved in this order: **environment variable → saved config → auto-detect**.

| Env var              | Purpose | Default |
|----------------------|---------|---------|
| `POB_PATH`           | Your PoB install folder. Must contain `Launch.lua` + `Modules/Build.lua` (installed layout) or `src/Launch.lua` + `src/Modules/Build.lua` (source clone). Surrounding quotes, `~`, `%VAR%` and trailing slashes are handled. When set but invalid, auto-detect is skipped and the error says why. | Saved config, then auto-detect. |
| `LUAJIT_PATH`        | A `luajit` binary, or a folder containing `luajit[.exe]` or `bin/luajit[.exe]`. | Saved config, then auto-detect. |
| `POB_MCP_CONFIG_DIR` | Overrides the config directory (used by the tests). | See below. |
| `POB_TIMING`         | When set to `1`, prints per-command timing to stderr. | unset |
| `REQUIRE_POB`        | Tests only. When set to `1`, an integration test that cannot find PoB, LuaJIT or `POB_SOURCE_PATH` fails instead of printing `SKIPPED` and exiting 0. CI sets it. | unset |

**Saved config.** `configure_pob_path` writes `config.json` to:

- Windows: `%APPDATA%\pob-mcp-server\config.json`
- macOS: `~/Library/Application Support/pob-mcp-server/config.json`
- Linux: `$XDG_CONFIG_HOME/pob-mcp-server/config.json` (default `~/.config/pob-mcp-server/`)

**Auto-detect** probes, in order:

- PoB on Windows: `%APPDATA%\Path of Building Community`; the installer's uninstall registry key `HKCU` / `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\Path of Building Community` → `InstallLocation`; `%ProgramData%\Path of Building`; `%LOCALAPPDATA%\Programs\Path of Building Community`.
- PoB on macOS: `~/Library/Application Support/Path of Building Community`.
- PoB on Linux: `~/.local/share/Path of Building Community` (honours `XDG_DATA_HOME`), Flatpak data under `~/.var/app/community.pathofbuilding.PathOfBuilding/data`, `/opt/path-of-building`.
- LuaJIT: `<PoB>/runtime/luajit[.exe]`, `%LOCALAPPDATA%\Programs\LuaJIT\bin\luajit.exe`, scoop (`~/scoop/shims`, `~/scoop/apps/luajit/current`, global scoop), Homebrew / `/usr/local/bin` / `/usr/bin`, then `PATH`.

Errors list every location that was probed.

### PoB updates (new leagues)

PoB updates itself in place. The server reads the PoB version from `manifest.xml` when the engine starts (logged to stderr, reported by `get_engine_info`). If PoB is updated on disk while the server is running, engine tools return an error saying *"Path of Building was updated on disk from X to Y"* rather than quietly keep using the old engine. Call `reload_engine` to restart against the new version: it waits for running tool calls to finish, the loaded build is carried over, and undo history is cleared. If the build can't be exported from the old engine, or can't be loaded by the new PoB, the result says so (in the second case it includes the build as a PoB import code). While PoB is applying an update, engine tools report "not ready" until it finishes.

## Tools

The server exposes 48 MCP tools. Every tool replies with compact JSON (no pretty-printing) and carries MCP annotations: `readOnlyHint` on every tool that never changes the build, `destructiveHint` on `load_build`, `reset_build`, `configure_pob_path` and `reload_engine`. See [`GETTING_STARTED.md`](./GETTING_STARTED.md) for a narrative tour with examples.

- **Engine setup:** `configure_pob_path`, `get_engine_info`, `reload_engine` (these work even when PoB is not configured).
- **Build I/O:** `load_build`, `export_build` (summary, XML or PoB build code — round-trip lossless), `reset_build`.
- **Inspection:** `get_stats` (by category, or exactly the PoB output keys given in `stats`; unknown keys come back as null), `get_skill_breakdown`, `list_equipped_items` (compact by default: mods as `{ line }` plus true flags, no item text; `includeItemText: true` adds the PoB text, `detail: "full"` gives every field), `list_valid_slots`, `get_item_in_slot` (always includes the item text).
- **Stat weights:** `stat_weights` (what each mod line is worth to this build: every line, default a generic pack of 37 single-roll mods, is added on its own as a custom modifier through PoB's calculator, existing custom modifiers kept; ranked by any stat with absolute and % change; lines PoB's mod parser cannot use are listed in `unparsed`, never as worth zero; read-only, ~5 ms a line).
- **Batch what-ifs:** `evaluate_changes` (up to 500 variants mixing node, item, gem and config changes in one call; a compact table ranked by any stat or by a weighted multi-stat `objective`, with hard `constraints`; read-only, see below), `apply_changes` (commits one variant in exactly that format as one undoable step, with the stats `evaluate_changes` reported for it; checked in full first, so a refused variant changes nothing; replayed after an engine crash; returns the nodes changed, points and the stat diff).
- **Items:** `swap_item`, `unequip_item`, `compare_items` (2-5 candidates for a slot, read-only, well under a second), `suggest_upgrades` (each slot's DPS/EHP contribution, measured by emptying it, read-only; the highest-priority slots — 3 by default, `modSlots` up to 10, or the given `slot` — also get `suggestedMods`: the mods PoB's own weighted trade query generator weighs highest for that slot, as `{ mod, weight }`, about 0.5-1 s a slot).
- **Passive tree:** `get_passive_tree` (compact by default: keystones and notables with stats, every allocated node as id/name/type (masteries with their chosen effect); `detail: "full"` gives every node with its stats), `simulate_passive_change`, `find_best_next_nodes` (every node whose path costs at most `maxPoints` points, default 3, ranked by gain per point or in total with `rankBy`; reports each node's cost and path; a few seconds), `find_worst_allocated_nodes` (every allocated node, notables and keystones included, removed with the nodes that depend on it; ranked by loss per refunded point or in total; the few needing a full recalculation are capped at the most promising and the rest listed in `skipped`), `evaluate_keystone`, `allocate_nodes` / `deallocate_nodes` (commit tree edits: a node with its shortest path, or with the nodes that depend on it; by id or name; undoable, replayed after an engine crash, included in `export_build`; returns the nodes changed, points used or refunded, the tree's point totals and the stat diff; masteries are refused for now), `convert_tree_to_latest` (moves an old-league tree to PoB's latest tree, undoable, reports the nodes and masteries lost).
- **Gems:** `list_skill_groups` (compact gems by default; `detail: "full"` adds gem/skill ids, color and `isSupport`), `lookup_gem`, `list_available_supports`, `swap_gem`, `compare_supports` (a refused candidate gets its own `error`), `evaluate_gem_levels`, `find_optimal_links` (scores every support PoB's own compatibility check accepts for the skill, each at its natural maximum level up to 20, then searches combinations of the best: exhaustive within a budget, else pairwise swaps; reports the winner's DPS delta and how many combinations were evaluated; about 1-3 s for a 6-link). All read-only, through PoB's own calculator in milliseconds. Committed (undoable, replayed after an engine crash): `create_socket_group` (a new group after the others, optionally the main one), `delete_socket_group` (later groups move up by one; groups granted by items or the tree are refused), `set_main_skill` (the main group and, with `activeSkill`, which of its active skills); gem changes on an existing group are committed with `apply_changes`.
- **Config / scenarios:** `get_config`, `set_config`, `list_scenarios`, `simulate_scenario`, `compare_scenarios` (a refused scenario gets its own `error`), `toggle_buffs`. The what-if ones are read-only, through PoB's own calculator in milliseconds.
- **Build comparison:** `compare_builds` (the loaded build against another build — a build code, pobb.in / pastebin link or XML, as `load_build` takes — or, with `against`, two other builds; the other build is evaluated in a short-lived second engine started for the call (a few seconds), so the loaded build, its undo history and config are untouched. Returns `meta` (class, ascendancy, level, main skill, tree version per side), `stats` (a, b, delta, pct: the key DPS/defence stats always, other stats when they differ), `tree` (points, keystones / notables / masteries / ascendancy nodes only in a or only in b by name and id, normal nodes counted, mastery effect changes), `items` (same / changed slots with the mod lines only in a or b / slots filled on one side; passive-tree jewels as `Tree jewel <node id>`, allocated sockets only; `swap` marks weapon-swap slots and `inactive` items PoB ignores: the weapon set not in use, or an abyss jewel in a socket its item does not have), `gems` (socket groups matched by active skill: supports added or removed, level/quality changes, main skill) and `config` (options that differ); long lists say how many entries were cut).
- **State / analysis:** `undo_last_change`, `snapshot_and_compare`, `diagnose_build` (one JSON reply: `checks`). `suggest_upgrades` also replies with one JSON part (`suggestions`, without the full item; `list_equipped_items` has it; `modsNote` when some slots got no suggested mods).
- **Trade:** `generate_trade_search` (runs PoB's own weighted trade query generator for a gear or flask slot and returns a pathofexile.com trade search URL sorted by weighted sum, with the weights so they can be adjusted, plus required mods and a minimum; read-only, no network access — the link is only opened by you), `search_trade_mods` (find trade stat ids for a slot by text; all/hybrid resistance and attribute ids come back with `weightable: false` and the pseudo totals to weight instead in `preferredTradeIds` — they still work as required mods).

### Iterating fast

What-if questions run through PoB's own calculator (the one its tooltips use) without changing or recalculating the build: a few milliseconds per variant. Use them to search, then commit only the winner.

- **`evaluate_changes`** tries many candidate changes in one call. Each variant can combine `allocate` / `deallocate` (node names or ids), `items` (`{ slot, itemText }` or `{ slot, unequip: true }`), `gems` (`set` / `remove` / `add` / `clear` ops on a group from `list_skill_groups`) and `config` (set_config keys). The reply is `base` plus one short row per variant sorted by the change of `rankBy` (default `CombinedDPS`; `order: "asc"` for smallest first): `value`, `delta` for each requested `stats` key (default DPS, EHP, Life, ES, Mana, resistances), `pointsAdded` / `pointsRemoved`, `fallback`. A refused variant (unknown node or gem, a node name several nodes share — the error lists their ids —, item that does not fit, bad config key) is listed last with its `error`; the call still succeeds. Per variant: at most 50 nodes in each of `allocate` / `deallocate`, 10 items (item text up to 10 KB), 20 gem changes and 50 config keys. `objective: { weights: { CombinedDPS: 1, TotalEHP: 0.5, ManaCost: -0.2 }, mode }` ranks by `score` = Σ weight × change instead of `rankBy` (pass one, not both): `mode: "relative"` (default) uses delta / |base| so stats of different scale compare (a tiny base then dominates the score: use `"absolute"` or small weights for those), `"absolute"` the raw delta; negative weights penalise; a stat whose base is 0 or not a number (or an unknown key) counts for nothing in relative mode and is listed in `objective.ignored`, and a variant whose own value is not a number lists it in `unscored`. `constraints: [{ stat, min?, max?, minDelta?, maxDelta? }]` limit the variant's resulting stat value (or its change from the base); a variant that breaks one carries `violates` (e.g. `"FireResist 72 < 75"`; a stat that is not a number breaks every bound), is ranked after all passing variants (still by score or `rankBy` among themselves; refused variants stay last) and is counted in `violating`; `onlyPassing: true` leaves them out of `results`. Weighted and constrained stats are added to `stats`; at most 20 weights and 20 constraints. Nothing is applied: pass the winning variant to `apply_changes` to keep it as-is (one undo step), or commit single changes with `swap_item` / `unequip_item`, `set_config` and `allocate_nodes` / `deallocate_nodes`.
- **`find_best_next_nodes`** with `maxPoints` (largest path cost, default 3) and `rankBy` (`perPoint` or `total`), and **`find_worst_allocated_nodes`**, rank the whole tree in a few seconds.
- **Fast vs fallback:** single-node changes, item swaps and unequips, gem changes and config changes take the fast path. A variant with several node changes at once, a passive-tree jewel socket, or a node or item that grants a skill is applied, recalculated and restored exactly instead (~0.3-0.5 s each, at most 50 per call; marked `fallback`).

## Troubleshooting

See [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md). Common issues:

- **"Path of Building is not configured"**: give the assistant your PoB folder (it calls `configure_pob_path`), or set `POB_PATH`.
- **LuaJIT not found**: install LuaJIT separately (the Windows PoB installer has no `luajit.exe`), then pass `luajitPath` to `configure_pob_path` or set `LUAJIT_PATH`.
- **"Path of Building was updated on disk"**: call `reload_engine`.
- **Bridge timeout / crash**: see the troubleshooting doc. After a crash or a timeout the next tool call restarts the engine with the build as of the last committed change, clears undo history and says so once. The server includes a three-strike circuit breaker per PoB/LuaJIT path pair (unexpected exits, command timeouts and failed starts all count; successes in between do not reset it); it survives `reload_engine` and failed `configure_pob_path` attempts and clears only on a server restart, a different path pair, or PoB changing on disk.

## Development

```bash
git clone https://github.com/DaAwesomePwner/PathOfBuilding-MCP.git
cd PathOfBuilding-MCP
npm install
npm run build        # tsc → dist/ (fails if tsc fails)
npm run typecheck    # tsc --noEmit
```

Run tests against your local PoB install:

```bash
# Windows PowerShell
$env:POB_PATH = "$env:APPDATA\Path of Building Community"
npm run test:all
```

If `POB_PATH` is unset and auto-detect fails, the integration tests print `SKIPPED:` and exit 0 — unless `REQUIRE_POB=1` is set, in which case they fail. `test:source-clone` additionally needs `POB_SOURCE_PATH` pointing at a PoB git clone. `npm run test:paths` and the first two parts of `npm run test:startup` need no PoB install. The tests never read or write your real saved config (`test:startup` uses a temp `POB_MCP_CONFIG_DIR`).

`test:all` runs the test scripts in parallel (`scripts/run-tests.mjs`). `npm run test:all -- bridge phase4` runs only those scripts, and `--jobs 1` (or `TEST_JOBS=1`) runs them one at a time.

Single test file:

```bash
tsx test/bridge-test.ts
```

CI: [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs on pushes to `master` and on pull requests. On Ubuntu and Windows (Node 22) it type-checks, builds and runs `npm run test:all` with `REQUIRE_POB=1` against a pinned PoB release (`POB_TAG`), both as a git clone and flattened into the installer's layout, and LuaJIT (apt on Linux, built from source on Windows). A Node 20 job runs typecheck, build and `test:paths`.

## License

MIT — see [`LICENSE`](./LICENSE). Path of Building Community remains under its own license at your install.
