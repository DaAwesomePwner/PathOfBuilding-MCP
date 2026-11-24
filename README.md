# pob-mcp-server

[![CI](https://github.com/DaAwesomePwner/PathOfBuilding-MCP/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/DaAwesomePwner/PathOfBuilding-MCP/actions/workflows/ci.yml)

An MCP server that exposes [Path of Building Community](https://pathofbuilding.community/)'s build-planning and calculation engine to LLM clients (Claude Desktop, Claude Code, and other [MCP](https://modelcontextprotocol.io/) hosts).

The server runs PoB's real Lua calculation engine in headless mode and surfaces 58 tools for creating and inspecting builds, committing passive tree, gem and item changes, simulating and ranking "what-ifs," planning passive points, comparing builds, building items from PoB's data, and generating weighted trade searches.

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

The server exposes 58 MCP tools. Every tool replies with compact JSON (no pretty-printing) and carries MCP annotations: `readOnlyHint` on every tool that never changes the build, `destructiveHint` on `load_build`, `new_build`, `reset_build`, `configure_pob_path` and `reload_engine`. See [`GETTING_STARTED.md`](./GETTING_STARTED.md) for a narrative tour with examples.

- **Engine setup:** `configure_pob_path`, `get_engine_info`, `reload_engine` (these work even when PoB is not configured).
- **Build I/O:** `load_build`, `new_build` (a blank build, as PoB's New gives, with the class, ascendancy, secondary ascendancy (bloodline), level (default 1, manual) and tree version (default the latest) chosen; names are checked against PoB's tree data and a refusal lists the choices and leaves the loaded build alone; it replaces the build exactly as `load_build` does, and `reset_build` returns to it), `export_build` (summary, XML or PoB build code — round-trip lossless), `reset_build`.
- **Build fundamentals (committed, undoable, replayed after an engine crash):** `set_character_level` (1-100, as PoB's level box: manual level mode, stat diff), `set_ascendancy` (ascendancy, bloodline or, with `className`, class, as PoB's dropdowns: passives that no longer connect are removed and listed with the points refunded; a class change that would reset the tree is refused unless `allowTreeReset`), `set_flask_active` (turn a flask slot on or off, as PoB's "Activate this flask" box: PoB applies a flask or tincture only while its slot is active; `unchanged` when already so; an empty slot or a non-flask slot is refused).
- **Inspection:** `get_stats` (by category, or exactly the PoB output keys given in `stats`; unknown keys come back as null), `get_skill_breakdown`, `list_equipped_items` (compact by default: mods as `{ line }` plus true flags, no item text; `includeItemText: true` adds the PoB text, `detail: "full"` gives every field; abyss jewels carry their `parentSlot`; flask slots carry `active`, with a note when inactive), `list_valid_slots` (flask slots with `active`; abyssal sockets only where the item in their `parentSlot` has them; passive-tree jewel sockets with `allocated`, and `requiresClusterIn` for a socket a cluster jewel adds that is not on the tree yet), `get_item_in_slot` (always includes the item text).
- **Stat weights:** `stat_weights` (what each mod line is worth to this build: every line, default a generic pack of 37 single-roll mods, is added on its own as a custom modifier through PoB's calculator, existing custom modifiers kept; ranked by any stat with absolute and % change; lines PoB's mod parser cannot use are listed in `unparsed`, never as worth zero; read-only, ~5 ms a line).
- **Batch what-ifs:** `evaluate_changes` (up to 500 variants mixing node, mastery, item, flask-slot, gem, config and main-skill changes in one call; a compact table ranked by any stat or by a weighted multi-stat `objective`, with hard `constraints`; read-only, see below), `apply_changes` (commits one variant in exactly that format as one undoable step, with the stats `evaluate_changes` reported for it; checked in full first, so a refused variant changes nothing; replayed after an engine crash; returns the nodes changed, points and the stat diff).
- **Items:** `swap_item` (a jewel in an unallocated passive-tree socket is equipped, with a `note` that it counts for nothing until the socket is allocated; PoB's UI hides such sockets), `unequip_item`, `compare_items` (2-5 candidates for a slot, read-only, well under a second; an unallocated passive-tree jewel socket is refused, as are `evaluate_changes` jewel variants for one unless the variant allocates it; an inactive flask slot is refused too unless `activate: true`, which evaluates the candidates with the slot turned on, as are `evaluate_changes` item variants for one unless the variant's `flasks` turns it on; `swap_item` into an inactive flask slot equips with a `note`), `suggest_upgrades` (every item slot PoB counts — gear of the weapon set in use, `Ring 3` while PoB shows it, flask slots, allocated passive-tree jewel sockets, abyssal sockets the item in their slot has, the Wickerman / graft slots while shown — each with `kind`; each slot's DPS/EHP contribution, measured by emptying it, read-only; an inactive flask slot, or a flask that adds nothing to DPS or EHP, is listed unranked (`priority: null`, with a `note`), and at most 16 passive-tree jewel sockets are measured per call (each takes a full recalculation), the rest listed unmeasured; empty gear and flask slots lead the ranking, while empty jewel and abyssal sockets are listed unranked after the occupied slots and get `suggestedMods` only when asked for with `slot`; the highest-priority slots PoB's trade generator supports — 3 by default, `modSlots` up to 10, or the given `slot` — also get `suggestedMods`: the mods PoB's own weighted trade query generator weighs highest for that slot, as `{ mod, weight }`, about 0.5-1 s a slot; Wickerman / graft slots, tinctures and empty flask slots get a `modsError` instead).
- **Item data:** `search_items` (PoB's uniques and item bases by name, base or type, optionally for a slot or with a mod text: base, type, slot, level requirement, variant names, a short mod summary), `get_item_text` (the full PoB item text of a unique — chosen variant, ranged mods at `roll` max / min / avg, default max — or of a plain normal base), `list_item_mods` (the prefixes and suffixes that can roll on a base per PoB's spawn weights at an item level, default 86, and with influences: id, tier, level, mod group, weight, text with ranges; `includeCrafted` adds crafting bench mods, named by their text; essences, eldritch implicits, fossils and veiled mods are not covered), `build_item` (a normal / magic / rare item from a base and mod ids or texts — a rolled line such as `+110 to maximum Life` picks the tier and roll that give it — plus bench crafts, implicits, influences, quality and corruption, built by PoB's own crafting code; a mod that cannot roll on the base or item level, too many prefixes or suffixes, or two mods of one group is refused, and so is a name or implicit line PoB would read as an item header or flag, such as `Corrupted` or `Shaper Item`). Implicit lines that change PoB's crafting rules (`+1 Prefix Modifier allowed`, crucible tree lines, `Cannot roll …`) and rare names PoB reads as a unique (rare-like uniques such as `Dread Captain's Cutlass`, crucible uniques, `Foulborn …`) are refused too. A one-line mod with two ranges (`Adds (22-29) to (45-52) Physical Damage`) gets one roll per range. Cluster jewels: pass the enchant as implicits (`["Adds 8 Passive Skills", "Added Small Passive Skills grant: 12% increased Fire Damage"]`); PoB sets the cluster skill from it, and that skill's notables can then roll. All four are read-only; their `text` goes straight into `swap_item`, `compare_items`, `evaluate_changes` or `apply_changes`, so item text never needs to be written by hand.
- **Passive tree:** `get_passive_tree` (compact by default: keystones and notables with stats, every allocated node as id/name/type (masteries with their chosen effect id and text); `detail: "full"` gives every node with its stats; `masteries: [ids or names]` adds each mastery's effect options with their ids, which effect is chosen and which are taken by another mastery), `simulate_passive_change`, `find_best_next_nodes` (every node whose path costs at most `maxPoints` points, default 3, ranked by gain per point or in total with `rankBy`; reports each node's cost and path; a few seconds), `find_worst_allocated_nodes` (every allocated node, notables and keystones included, removed with the nodes that depend on it; ranked by loss per refunded point or in total; the few needing a full recalculation are capped at the most promising and the rest listed in `skipped`), `plan_passive_points` (the best sequence of nodes for N points, 1-40: step by step from the tree as each step leaves it, by gain per point of a stat or a weighted `objective`, with optional `constraints`, `beamWidth` 2-3, `includeMasteries` and `excludeNodes`; returns the steps, the stat change and ready `apply_changes` / `allocate_nodes` arguments; ~10 s for 10 points, at most 40 s, holding the engine meanwhile), `plan_respec` (from the current tree to a `target` node set: the nodes removed and added, points, the stat change and ready `apply_changes` / `deallocate_nodes` + `allocate_nodes` arguments; both apply the change to a temporary tree and restore it exactly, so nothing is committed), `evaluate_keystone`, `allocate_nodes` / `deallocate_nodes` (commit tree edits: a node with its shortest path, or with the nodes that depend on it; by id or name; undoable, replayed after an engine crash, included in `export_build`; returns the nodes changed, points used or refunded, the tree's point totals and the stat diff; `allocate_nodes` `masteries: [{ node, effect }]` allocates a mastery with its path and the chosen effect, or switches an allocated mastery to another effect — deallocate a mastery to clear it), `convert_tree_to_latest` (moves an old-league tree to PoB's latest tree, undoable, reports the nodes and masteries lost).
- **Gems:** `list_skill_groups` (compact gems by default; `detail: "full"` adds gem/skill ids, color and `isSupport`), `lookup_gem`, `list_available_supports`, `swap_gem`, `compare_supports` (a refused candidate gets its own `error`), `evaluate_gem_levels`, `find_optimal_links` (scores every support PoB's own compatibility check accepts for the skill, each at its natural maximum level up to 20, then searches combinations of the best: exhaustive within a budget, else pairwise swaps; reports the winner's DPS delta and how many combinations were evaluated; about 1-3 s for a 6-link). All read-only, through PoB's own calculator in milliseconds. Committed (undoable, replayed after an engine crash): `create_socket_group` (a new group after the others, optionally the main one), `delete_socket_group` (later groups move up by one; groups granted by items or the tree are refused), `set_main_skill` (the main group and, with `activeSkill`, which of its active skills); gem changes on an existing group are committed with `apply_changes`.
- **Config / scenarios:** `get_config`, `set_config`, `list_scenarios`, `simulate_scenario`, `compare_scenarios` (a refused scenario gets its own `error`), `toggle_buffs`. The what-if ones are read-only, through PoB's own calculator in milliseconds.
- **Build comparison:** `compare_builds` (the loaded build against another build — a build code, pobb.in / pastebin link or XML, as `load_build` takes — or, with `against`, two other builds; the other build is evaluated in a short-lived second engine started for the call (a few seconds), so the loaded build, its undo history and config are untouched. Returns `meta` (class, ascendancy, level, main skill, tree version per side), `stats` (a, b, delta, pct: the key DPS/defence stats always, other stats when they differ), `tree` (points, keystones / notables / masteries / ascendancy nodes only in a or only in b by name and id, normal nodes counted, mastery effect changes), `items` (same / changed slots with the mod lines only in a or b, and `flaskActive` {a, b} for a flask slot turned on in one build only / slots filled on one side; passive-tree jewels as `Tree jewel <node id>`, allocated sockets only; `swap` marks weapon-swap slots and `inactive` items PoB ignores: the weapon set not in use, or an abyss jewel in a socket its item does not have), `gems` (socket groups matched by active skill: supports and other active gems added or removed, level/quality changes, main skill) and `config` (options that differ); long lists say how many entries were cut).
- **State / analysis:** `undo_last_change`, `snapshot_and_compare`, `diagnose_build` (one JSON reply: `checks`). `suggest_upgrades` also replies with one JSON part (`suggestions`, without the full item; `list_equipped_items` has it; `modsNote` when some slots got no suggested mods).
- **Trade:** `generate_trade_search` (runs PoB's own weighted trade query generator for a gear or flask slot, an abyssal socket the item in its slot has, or an allocated passive-tree jewel socket — `jewelType` `base` / `abyss` / `any` (both kinds, which PoB's query generator takes though its popup offers only the first two) picks which jewels a tree socket searches, default the kind socketed there; `flaskType` `life` / `mana` / `hybrid` / `utility` picks the flask a flask slot searches for, default the kind equipped there, needed for an empty slot (every kind is weighed from PoB's flask mod list in the trade site's `flask` category, so results can include other kinds; a kind the slot does not hold is weighed on a blank base, reported as `testBase`); an inactive flask slot is evaluated active for the call (`evaluatedActive: true`, the build unchanged); tinctures (a tincture in a flask slot, `flaskType` `tincture`) and grafts (`Graft 1`/`Graft 2`, shown on 3.27 trees) have no trade category in PoB's data, so their mods are weighed from PoB's tincture / graft mods that can roll on the base in the slot, through PoB's own mod processing, and the search is filtered by that base type (`baseType`; the slot must hold one; graft base implicits have no mod data in PoB and are not weighed); Wickerman slots (`Head`/`Body`/`Arm`/`Leg`, shown on 3.30 trees) hold Viscera parts, which have fixed implicits and no mods, so there it returns no URL but every Viscera part that fits the slot measured in it and ranked by `statWeights` (top 10 `candidates`: `name`, `score`, `stats`, `change`, `itemText` for `compare_items` / `swap_item`; PoB's trade data has no Viscera category, so no link); cluster jewels have no weighted search (PoB's generator has no cluster jewel category or mods; a tree socket searches regular or abyss jewels); refused: a weapon slot of the weapon set the build does not use, or an abyssal socket on one (PoB weighs every mod there at 0); `unique` runs PoB's searches for its special uniques: `"Watcher's Eye"` (aura mods, `slot` = an allocated passive-tree jewel socket not holding a cluster jewel), `"Pearl of Tsoatha"` (each support gem per skill-group slot, `slot` = a ring slot PoB shows) and `"Megalomaniac"` (each cluster notable weighed as a passive node, reported as `notable`; `slot` optional, default PoB's own socket pick, skipping sockets that hold a cluster jewel; refused on passive trees that lack some of its notables — `convert_tree_to_latest`), always excluding mirrored items and refusing options PoB does not offer there — and returns a pathofexile.com trade search URL sorted by weighted sum, with the weights so they can be adjusted, plus required mods and a minimum; read-only, no network access — the link is only opened by you), `search_trade_mods` (find trade stat ids for a slot by text, jewel sockets by `jewelType` too, flask slots take `flaskType`; all/hybrid resistance and attribute ids come back with `weightable: false` and the pseudo totals to weight instead in `preferredTradeIds` — they still work as required mods; with `unique` it lists that unique's pool instead: Watcher's Eye mods, Megalomaniac notables, Pearl of Tsoatha's support filters, whose ids also work in `weightAdjustments` / `requiredMods`).

### Iterating fast

What-if questions run through PoB's own calculator (the one its tooltips use) without changing or recalculating the build: a few milliseconds per variant. Use them to search, then commit only the winner.

- **`evaluate_changes`** tries many candidate changes in one call. Each variant can combine `allocate` / `deallocate` (node names or ids), `items` (`{ slot, itemText }` or `{ slot, unequip: true }`), `gems` (`set` / `remove` / `add` / `clear` ops on a group from `list_skill_groups`), `config` (set_config keys), `masteries` (`[{ node, effect }]`: allocate a mastery with an effect, or switch an allocated one; effect by id or text; a mastery name picks the allocated one with that effect, else the only allocated one of that name — pass an id to allocate another), `mainSkill` (`{ group, activeSkill? }`: the variant's stats are computed with that socket group as the main skill — "what does this tree/gear do for my other skill?") and `flasks` (`[{ slot, active }]`: turn flask slots on or off, applied after `items`; through the calculator like any single change; the slot must hold a flask or tincture once the variant's items are in. This is the per-slot state PoB's "Activate this flask" box sets, not the `flasks` config alias of `toggle_buffs` / scenarios, which is `conditionUsingFlask`: the "while using a flask" condition only). The reply is `base` plus one short row per variant sorted by the change of `rankBy` (default `CombinedDPS`; `order: "asc"` for smallest first): `value`, `delta` for each requested `stats` key (default DPS, EHP, Life, ES, Mana, resistances), `pointsAdded` / `pointsRemoved`, `fallback`. A refused variant (unknown node or gem, a node name several nodes share — the error lists their ids —, item that does not fit, bad config key) is listed last with its `error`; the call still succeeds. Per variant: at most 50 nodes in each of `allocate` / `deallocate`, 20 masteries, 10 items (item text up to 10 KB), 20 gem changes and 50 config keys. `objective: { weights: { CombinedDPS: 1, TotalEHP: 0.5, ManaCost: -0.2 }, mode }` ranks by `score` = Σ weight × change instead of `rankBy` (pass one, not both): `mode: "relative"` (default) uses delta / |base| so stats of different scale compare (a tiny base then dominates the score: use `"absolute"` or small weights for those), `"absolute"` the raw delta; negative weights penalise; a stat whose base is 0 or not a number (or an unknown key) counts for nothing in relative mode and is listed in `objective.ignored`, and a variant whose own value is not a number lists it in `unscored`. `constraints: [{ stat, min?, max?, minDelta?, maxDelta? }]` limit the variant's resulting stat value (or its change from the base); a variant that breaks one carries `violates` (e.g. `"FireResist 72 < 75"`; a stat that is not a number breaks every bound), is ranked after all passing variants (still by score or `rankBy` among themselves; refused variants stay last) and is counted in `violating`; `onlyPassing: true` leaves them out of `results`. Weighted and constrained stats are added to `stats`; at most 20 weights and 20 constraints. Nothing is applied: pass the winning variant to `apply_changes` to keep it as-is (one undo step), or commit single changes with `swap_item` / `unequip_item`, `set_config` and `allocate_nodes` / `deallocate_nodes`.
- **`find_best_next_nodes`** with `maxPoints` (largest path cost, default 3) and `rankBy` (`perPoint` or `total`), and **`find_worst_allocated_nodes`**, rank the whole tree in a few seconds.
- **Fast vs fallback:** single-node changes, one mastery change, item swaps and unequips, gem changes, config changes and a main-skill change take the fast path. A variant with several node or mastery changes at once, a passive-tree jewel socket, or a node or item that grants a skill is applied, recalculated and restored exactly instead (~0.3-0.5 s each, at most 50 per call; marked `fallback`).

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
