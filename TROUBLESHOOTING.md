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
- Corrupted PoB install. Re-run the PoB Community installer, or if you're using a source clone, run `git clean -xdf` inside it.

## "Lua engine has crashed N times — refusing to restart"

**Cause:** The luajit child process died unexpectedly three times for the same PoB/LuaJIT path pair. This circuit breaker stops rapid restart loops. The count is kept per path pair across engine swaps: `reload_engine` and `configure_pob_path` with the same paths are refused too, and a failed `configure_pob_path` to other paths does not reset it.

**Fix:** Restart the MCP server process, or call `configure_pob_path` with a different PoB/LuaJIT path if the paths were the problem. If PoB has since updated on disk (new `manifest.xml` version/mtime), that path pair starts a fresh count and `reload_engine` works again. If it recurs immediately, capture stderr (it is forwarded to the parent stderr by default) and inspect the failure. It is usually a malformed build XML or a missing data file in the loaded build.

## "Lua bridge timeout after Nms"

**Cause:** A single Lua command took longer than the default 60 s budget. Most legitimately long-running operations (`find_optimal_links`, `find_best_next_nodes` on huge trees) batch internally and stay under that limit, so a timeout usually means the engine is stuck on a single calc.

**What the server does:** the stuck process is killed; the next tool call respawns and reloads the last build automatically. No state corruption — but the in-flight tool call returns an error.

**Fix:**
- Reduce work: lower `count` on `find_best_next_nodes`, use a narrower `slot` filter on `suggest_upgrades`.
- If a specific build always times out, capture stderr (`POB_TIMING=1` helps) and try simplifying the build (remove very large jewel clusters, exotic skill setups) to isolate the offending data.

## "Build code is empty" / "Invalid build code"

`load_build` validates input at the boundary:
- `Build source is empty` — input was empty or whitespace
- `Invalid build code — contains characters outside the URL-safe base64 alphabet` — likely you pasted only a URL fragment or HTML
- `Build code is too short to be a real PoB build` — minimum length is 32 chars; real codes are 5,000+ chars
- `Unsupported URL — only pastebin.com and pobb.in URLs are accepted` — pass the full pastebin/pobb URL or extract the raw code yourself
- `Invalid XML — missing <PathOfBuilding> root element` — only paste the full PoB XML, not a fragment

## "Item text must start with a `Rarity:` line"

`swap_item` and `compare_items` require PoB item-paste format. Copy the item text from PoB itself (`Right click → Copy`) — the first line is always `Rarity: <Normal|Magic|Rare|Unique>`.

## State drift / unexpected stat values after multiple operations

**Cause:** Should not happen — `withTemporaryChange`, `compare_items`, `find_best_next_nodes`, `simulate_scenario`, etc. all snapshot/restore. If you see drift, it means a snapshot field is missing.

**Diagnostic steps:**
1. Run `npm run test:integrity` — this exact scenario is the regression suite.
2. Use `reset_build` to return to original loaded state and try again.
3. If the drift is reproducible, file an issue with: build XML + sequence of tool calls + observed vs expected values.

## "Nothing to undo"

The undo stack is empty. Either nothing has been mutated yet, or a previous `reset_build` cleared the stack. Note that *failed* mutating tools (e.g. `swap_item` with malformed text) still push an undo entry **before** their mutation, so you may sometimes have an undo entry that is effectively a no-op.

## "The Path of Building engine was restarted … Retry the call"

A tool call was queued or running when the engine was replaced (`reload_engine`, `configure_pob_path`) or the server shut down. Engine swaps normally wait for running calls, so this only appears in edge cases such as shutdown. Retry the call.

## "Lua bridge only supports one in-flight command at a time"

**Cause:** Two MCP tool calls reached the bridge simultaneously without going through `BuildSession`'s lock. This should not happen in normal use; all session methods route through `withLock`.

**Fix:** This is an internal invariant violation. Capture stderr and the call sequence and file an issue.

## Performance reference (OccVortex on a typical desktop)

| Operation | Expected wall time |
|---|---|
| `load_build` | 1–3 s |
| `get_stats` | <50 ms |
| `compare_items` (3 candidates) | ~3 s |
| `find_best_next_nodes` (count=10) | 25–35 s |
| `find_worst_allocated_nodes` | 15–20 s |
| `compare_supports` (3 candidates) | 4–8 s |
| `find_optimal_links` (default topN) | 15–60 s |
| `suggest_upgrades` (all slots) | 25–40 s |
| `simulate_scenario` | <500 ms |

Run the server with `POB_TIMING=1` to log every Lua bridge command's wall time to stderr.

## Resetting everything

If anything ever looks wrong, the safe recovery sequence is:
1. `reset_build` — discard mutations, clear undo stack
2. `get_engine_info` — check the PoB version/paths and whether PoB changed on disk; `reload_engine` restarts the engine and keeps the build
3. If still wrong, restart the MCP server (Claude Desktop: toggle the server off and on)
4. If still wrong: re-run `load_build` from the original code/URL
