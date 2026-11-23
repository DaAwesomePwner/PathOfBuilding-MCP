# Troubleshooting

## "Path of Building is not configured yet" (PoB not found)

The server could not find your Path of Building install. It **keeps running** anyway: `configure_pob_path`, `get_engine_info` and `list_scenarios` work, and every other tool returns this error. The message lists every location that was probed (env var, saved config, `%APPDATA%`, the installer's registry key, …).

**Fix (no restart needed):** tell the assistant where PoB is installed. It calls `configure_pob_path({ pobPath })`, which validates the folder, starts the engine, reports the PoB version and saves the path to the config file:

- Windows: `%APPDATA%\pob-mcp-server\config.json`
- macOS: `~/Library/Application Support/pob-mcp-server/config.json`
- Linux: `$XDG_CONFIG_HOME/pob-mcp-server/config.json` (default `~/.config/pob-mcp-server/`)

If your MCP client supports elicitation, the server asks you for the folder the first time a tool needs it.

**Alternative:** set `POB_PATH` in the server's `env` block of your MCP client config. `POB_PATH` takes precedence over the saved config, so remove a wrong `POB_PATH` before relying on `configure_pob_path`.

A valid folder contains `Launch.lua` and `Modules/Build.lua` at its root (installed layout) or under `src/` (source clone):

```bash
# Windows (installed layout)
dir "%APPDATA%\Path of Building Community\Modules\Build.lua"
# source clone
ls "$POB_PATH/src/Modules/Build.lua"
```

If neither exists, your install is incomplete. Re-run the Path of Building Community installer, or clone <https://github.com/PathOfBuildingCommunity/PathOfBuilding>.

A source clone is run read-only (the server switches PoB's dev-mode autosave off). The default branch can use Lua syntax only PoB's patched LuaJIT parses (e.g. `count += 1`); the bridge rewrites it on load (`lua/compound-assign.lua`), but a release tag (`git clone --branch v2.68.1 --depth 1 <repo>`) is the safest choice. To check a clone, run `POB_SOURCE_PATH=<clone> npm run test:source-clone`.

## "… is Path of Building for Path of Exile 2"

Only the Path of Exile 1 edition is supported. The PoE2 edition installs to a sibling folder, `Path of Building Community (PoE2)`, and is detected from its contents (its `manifest.xml` updates from the `PathOfBuilding-PoE2` repository, it ships `Path of Building-PoE2.exe`, and `GameVersions.lua` targets `0_x` trees). Point the server at the folder **without** "(PoE2)".

## LuaJIT not found

PoB Community embeds `lua51.dll` for its own GUI. The Windows installer does **not** include a standalone `luajit.exe`, so install LuaJIT separately:

- Windows (scoop): `scoop install luajit`
- Windows (winget): `winget install DEVCOM.LuaJIT`
- macOS (brew): `brew install luajit`
- Linux (apt): `sudo apt-get install luajit`

Then pass `luajitPath` to `configure_pob_path`, or set `LUAJIT_PATH`. **The server executes this file.** As a `configure_pob_path` argument it must be the full path of an existing file named like `luajit` (`luajit.exe` on Windows; `.bat`/`.cmd`/`.sh` scripts are refused), and environment variables in it are not expanded. Network/device paths (`\\host\share`, `//host/share`, `\\?\…`, `\\.\…`) are refused for both `pobPath` and `luajitPath` — use `POB_PATH` / `LUAJIT_PATH` in the server's environment for those. A saved `luajitPath` that no longer passes these checks is ignored at startup (with a stderr warning) and LuaJIT is auto-detected instead. `LUAJIT_PATH` may also be a folder containing `luajit[.exe]` or `bin/luajit[.exe]`. Auto-detect also checks `%LOCALAPPDATA%\Programs\LuaJIT\bin`, scoop shims and apps, Homebrew, `/usr/local/bin`, `/usr/bin` and `PATH`.

## "Path of Building was updated on disk from X to Y"

PoB updated itself (typically for a new league) while the server was running. The engine still has the old code and data in memory, so the server refuses to compute with it. Call `reload_engine`: it waits for running tool calls to finish (new calls queue behind it), exports the current build, restarts LuaJIT against the updated install, reloads the build and reports the old → new version. If exporting fails (e.g. the old engine is wedged) the engine is still restarted and the result says plainly that the build was **not** carried over (`buildExportError`). If the new PoB can't load the build, the result carries it as a PoB import code in `buildCode` — pass that to `load_build` or import it in PoB. Undo history and stat snapshots are cleared, and `reset_build` then returns to the reloaded state. `get_engine_info` shows `installChangedSinceStart` and both versions.

## "Path of Building … is in the middle of applying an update"

PoB's updater replaces files in place. While `Update/manifest.xml` (or `Update/opFileRuntime.txt`) exists without `Update/opFile.txt`, files are being swapped and loading the install is unsafe. Wait for the update to finish; if it was interrupted, open Path of Building once so it completes. Then call `reload_engine`. A *downloaded but not yet applied* update (`Update/opFile.txt` present) is harmless: the install stays on the old version until PoB applies it.

## Lua engine fails to start

**Symptoms:** tools return `The Path of Building engine failed to start` with `Lua bridge exited during init` in the error text.

**Causes & fixes:**
- The wrong `luajit` (e.g. a PUC Lua 5.3/5.4 binary). Point `luajitPath` / `LUAJIT_PATH` at a LuaJIT binary.
- Wrong PoB folder: see the sections above, then `configure_pob_path`.
- `'=' expected near '+'` (or near another operator) while loading a PoB module such as `Modules/Main.lua`: PoB 2.68+ uses compound assignment (`count += 1`), which only PoB's own LuaJIT parses. Update pob-mcp-server; current versions translate it for stock LuaJIT. If a current server still shows a syntax error in a PoB file, that PoB release uses other syntax the server does not translate yet: report it.
- Corrupted PoB install. Re-run the PoB Community installer, or if you're using a source clone, run `git clean -xdf` inside it.

## "Lua engine has crashed N times — refusing to restart"

**Cause:** The luajit child process failed three times for the same PoB/LuaJIT path pair: it exited unexpectedly, a command timed out (the process is killed), or a startup failed or hung. This circuit breaker stops rapid restart loops. Successful commands in between do not reset the count. The count is kept per path pair across engine swaps: `reload_engine` and `configure_pob_path` with the same paths are refused too, and a failed `configure_pob_path` to other paths does not reset it. `get_engine_info` shows `crashCount` and `circuitOpen`.

**Fix:** Restart the MCP server process, or update Path of Building and then call `reload_engine` (a new `manifest.xml` version/mtime on disk starts a fresh count for that path pair). Calling `configure_pob_path` with the same paths does not clear it; a genuinely different PoB/LuaJIT path pair has its own count. If it recurs immediately, capture stderr (it is forwarded to the parent stderr by default) and inspect the failure. It is usually a malformed build XML or a missing data file in the loaded build.

## "Lua bridge timeout after Nms"

**Cause:** A single Lua command took longer than the default 60 s budget. Most legitimately long-running operations (`find_optimal_links`, `find_best_next_nodes` on huge trees) batch internally and stay under that limit, so a timeout usually means the engine is stuck on a single calc.

**What the server does:** the stuck process is killed and the timeout counts as one of the three strikes (see above); the in-flight tool call returns an error. The next tool call restarts the engine — see the next section.

**Fix:**
- Reduce work: lower `count` on `find_best_next_nodes`, use a narrower `slot` filter or a smaller `modSlots` on `suggest_upgrades`.
- If a specific build always times out, capture stderr (`POB_TIMING=1` helps) and try simplifying the build (remove very large jewel clusters, exotic skill setups) to isolate the offending data.

## "The Path of Building engine stopped unexpectedly and was restarted"

**Cause:** The LuaJIT engine crashed or hung (strike 1 or 2 of 3) and the server restarted it at the start of this tool call.

**What the server did:** the new engine holds the build as it was after the last committed change (`load_build`, `reset_build`, `swap_item`, `unequip_item`, `set_config`, `convert_tree_to_latest` or `undo_last_change`); a change whose call failed when the engine stopped was not kept, and a `load_build` that PoB rejected is never restored. Undo history is cleared (its entries belonged to the old engine process); `undo_last_change` then says so. Labelled stat snapshots are kept. `reset_build` still returns to the originally loaded build. The call that reports this does nothing else. A `load_build` or `reset_build` after a crash does not fail: it loads normally and its result carries an `engineRestart` note with the strike count instead.

**Fix:** retry the call. If the notice says the build could not be restored, call `reset_build` or `load_build`.

An internal error ending in *"the change itself WAS applied and is kept in the build"* means a committed change went through but reading the result failed: the change stays (also across a later restart); call `undo_last_change` to revert it.

A call that was running when the engine stopped fails with *"The Path of Building engine stopped during this call"*: it did not finish, and nothing it was doing is retried on the new engine.

## "Build code is empty" / "Invalid build code"

`load_build` validates input at the boundary:
- `Build source is empty` — input was empty or whitespace
- `Invalid build code — contains characters outside the URL-safe base64 alphabet` — likely you pasted only a URL fragment or HTML
- `Build code is too short to be a real PoB build` — minimum length is 32 chars; real codes are 5,000+ chars
- `Unsupported URL — only pastebin.com and pobb.in URLs are accepted` — pass the full pastebin/pobb URL or extract the raw code yourself
- `Invalid XML — missing <PathOfBuilding> root element` — only paste the full PoB XML, not a fragment

## "Item text must start with a `Rarity:` line"

`swap_item`, `compare_items` and item variants in `evaluate_changes` require PoB item-paste format. Copy the item text from PoB itself (`Right click → Copy`) — the first line is always `Rarity: <Normal|Magic|Rare|Unique>`. The one exception is a Viscera (Wickerman) item copied from the game, whose first line is `Item Class: Viscera` and which has no `Rarity:` line; it is accepted as is.

## "Cannot equip an item in Head: Path of Building shows the Wickerman slots … only on 3.30 passive trees"

The Wickerman slots (`Head`, `Body`, `Arm`, `Leg`) are shown only on 3.30 passive trees, and `Graft 1`/`Graft 2` only on 3.27 trees, as in PoB's UI. On other trees `list_valid_slots` leaves them out and nothing can be equipped in them.

- **Wickerman:** run `convert_tree_to_latest` to move the build to the 3.30 tree, then equip.
- **Graft:** only a 3.27 tree shows them; no conversion helps (`convert_tree_to_latest` goes to the latest tree, not 3.27).

An item already in a hidden slot is still listed by `list_equipped_items` (with `hidden: true` and a note) and `unequip_item` removes it. PoB still counts a hidden Wickerman item in its calculations; a hidden graft is ignored.

## State drift / unexpected stat values after multiple operations

**Cause:** Should not happen. The what-if tools (`evaluate_changes`, `compare_items`, `find_best_next_nodes`, `simulate_scenario`, etc.) run through PoB's calculator (`lua/probe.lua`) without changing or recalculating the build. The variants it cannot reproduce exactly (several node changes at once, jewel sockets, skill-granting nodes or items) are applied, recalculated and restored, and the restore is compared with a fingerprint of the build taken before; a mismatch is an internal error naming `reset_build`. If you see drift anyway, a snapshot or fingerprint field is missing.

**Diagnostic steps:**
1. Run `npm run test:integrity` — this exact scenario is the regression suite.
2. Use `reset_build` to return to original loaded state and try again.
3. If the drift is reproducible, file an issue with: build XML + sequence of tool calls + observed vs expected values.

## "Node … is a mastery; pass it in `masteries` as { node, effect }" / mastery effect errors

A mastery is always allocated together with the effect chosen on it, so it cannot go in `allocate` (evaluate_changes / apply_changes) or `nodes` (allocate_nodes). Pass `masteries: [{ node, effect }]` instead; `get_passive_tree({ masteries: [<id or name>] })` lists each mastery's effects with their ids.

- **"does not offer effect N"** / **"no effect of mastery … matches"** — the effect id or text is not one of that mastery's options (each mastery type has its own list). Use an id from `masteryOptions`, or a text that only one of its effects contains.
- **"Effect N … is already chosen on mastery M"** — Path of Exile allows each mastery effect on one mastery only (`takenBy` in `masteryOptions`). Switch mastery M to another effect, or deallocate it, first.
- **"mastery name … matches N nodes"** — masteries share names ("Life Mastery"). A name picks the allocated mastery that has the effect already, else the only allocated one of that name, else the only one a path reaches; otherwise pass the node id from the list in the error (also to allocate a second mastery of a name you already have).
- **"mastery … is removed by this change's deallocation"** — the same variant deallocates a node the mastery depends on. Deallocate the mastery too, or keep that node.
- **"mainSkill cannot be combined with a change that may add or remove skill groups"** — an item or passive in the same variant grants (or replaced one that grants) a skill, so socket group indices may shift. Apply that change first, re-read `list_skill_groups`, then set the main skill.
- **`status: "unchanged"`** — every mastery listed already had that effect; nothing changed and nothing was pushed to undo.
- A mastery has no "allocated without an effect" state: to clear one, deallocate it with `deallocate_nodes`.

## "Nothing to undo"

The undo stack is empty. Either nothing has been mutated yet, or a previous `reset_build` (or `load_build`, `reload_engine`, an engine restart) cleared the stack. Only `swap_item`, `unequip_item`, `set_config` and `convert_tree_to_latest` push an entry, and only when the change succeeded; the what-if tools (`evaluate_changes`, `simulate_*`, `compare_*`, `find_*`, `swap_gem`, ...) never do.

## "The Path of Building engine was restarted … Retry the call"

A tool call was queued or running when the engine was replaced (`reload_engine`, `configure_pob_path`) or the server shut down. Engine swaps normally wait for running calls, so this only appears in edge cases such as shutdown. Retry the call.

## "Lua bridge only supports one in-flight command at a time"

**Cause:** Two MCP tool calls reached the bridge simultaneously without going through `BuildSession`'s lock. This should not happen in normal use; all session methods route through `withLock`.

**Fix:** This is an internal invariant violation. Capture stderr and the call sequence and file an issue.

## "The temporary Path of Building engine stopped while … the source build"

`compare_builds` evaluates the other build in a second, short-lived engine started for that call. It crashed, timed out (60 s per step) or could not start, so the call failed. That engine is always discarded and never restarted, and its failures do not count towards the main engine's three-strike limit: the loaded build, its undo history and the main engine are unaffected. Retry the call; if it keeps failing for the same build, check that the build opens in Path of Building itself ("Path of Building could not load the source build: …" means PoB refused it).

`compare_builds is refused: the Path of Building engine has crashed N times …` means the main engine's crash breaker is open for this install: no second engine is started for it either (see "Lua engine has crashed N times" above). After a Path of Building update on disk, `compare_builds` asks for `reload_engine` first, like every engine tool.

## `stat_weights` lists a line under `unparsed`

Path of Building's mod parser could not use the line (the same check its Custom modifiers box applies: a line with any unrecognised text is skipped there), so it was not evaluated; `reason` says whether nothing or only part of it was recognised. Write it the way the game or PoB shows the mod on an item, one modifier per line, with numbers filled in (`+50 to maximum Life`, not `+# to maximum Life`). A line that grants a skill is not supported. Lines are added as global modifiers, so local item mods (a weapon's added damage, an armour piece's own armour) are counted as global ones.

## Performance reference (OccVortex on a typical desktop)

| Operation | Expected wall time |
|---|---|
| `load_build` | 1–3 s |
| `get_stats` | <50 ms |
| `evaluate_changes` (30 single-change variants) | ~0.15 s (a few ms per variant; each `fallback` variant ~0.3–0.5 s) |
| `compare_items` (2–5 candidates) | <0.2 s |
| `find_best_next_nodes` (default `maxPoints` 3) | ~2 s (~0.4 s with `maxPoints: 1`) |
| `find_worst_allocated_nodes` | 2–3 s |
| `compare_supports`, `swap_gem`, `evaluate_gem_levels` | milliseconds |
| `find_optimal_links` (6-link, default topN) | 1–3 s |
| `suggest_upgrades` (all slots; suggested mods for 3) | ~2 s (`modSlots: 10` ~5 s, `modSlots: 0` <0.1 s) |
| `stat_weights` (default 37 lines) | ~0.1 s |
| `compare_builds` | ~5 s (a second engine boots and loads the other build; with `against` both builds load in that engine) |
| `simulate_scenario`, `compare_scenarios`, `toggle_buffs` | milliseconds |

Run the server with `POB_TIMING=1` to log every Lua bridge command's wall time to stderr.

## Resetting everything

If anything ever looks wrong, the safe recovery sequence is:
1. `reset_build` — discard mutations, clear undo stack
2. `get_engine_info` — check the PoB version/paths and whether PoB changed on disk; `reload_engine` restarts the engine and keeps the build
3. If still wrong, restart the MCP server (Claude Desktop: toggle the server off and on)
4. If still wrong: re-run `load_build` from the original code/URL
