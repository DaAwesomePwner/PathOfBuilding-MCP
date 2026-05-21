# Troubleshooting

## `PoBInstallNotFoundError`

The server cannot find your Path of Building install. The error message lists every path that was probed. Fix it by setting `POB_PATH`:

- **Windows PowerShell**: `$env:POB_PATH = "$env:APPDATA\Path of Building Community"`
- **Windows cmd**: `set POB_PATH=%APPDATA%\Path of Building Community`
- **MCP client config** (preferred for Claude Desktop/Code): add `POB_PATH` to the server's `env` block.

Validate the install by checking for `Launch.lua` (either at the install root for a compiled install, or under `src/` for a source clone):

```bash
# Windows (compiled install)
dir "%APPDATA%\Path of Building Community\Launch.lua"
# macOS / Linux (source clone)
ls "$POB_PATH/src/Launch.lua"
```

If neither exists, your install is incomplete. Re-run the Path of Building Community installer, or clone <https://github.com/PathOfBuildingCommunity/PathOfBuilding>.

## `LuaJITNotFoundError`

PoB Community ships an embedded `lua51.dll` for its own GUI but does not generally bundle a standalone `luajit` executable. Install one:

- Windows (scoop): `scoop install luajit`
- Windows (winget): `winget install DEVCOM.LuaJIT`
- macOS (brew): `brew install luajit`
- Linux (apt): `sudo apt-get install luajit`

Or set `LUAJIT_PATH=/path/to/luajit` (the path must be a binary that exists, not just a directory).

## Lua engine fails to start

**Symptoms:** server exits during startup with `Lua bridge exited during init`, or every tool call returns `Internal error: Lua bridge ...`.

**Causes & fixes:**
- See `LuaJITNotFoundError` above if `paths.ts` couldn't locate a luajit binary.
- See `PoBInstallNotFoundError` above if `POB_PATH` validation failed.
- Corrupted PoB install. Re-run the PoB Community installer, or if you're using a source clone, run `git clean -xdf` inside it.

## "Lua engine has crashed N times — refusing to restart"

**Cause:** The luajit child process died unexpectedly more than three times in a single server session. This is a circuit breaker against rapid restart loops.

**Fix:** Restart the MCP server process. If it recurs immediately, capture stderr (it is forwarded to the parent stderr by default) and inspect the failure — usually it is a malformed build XML or a missing data file in the loaded build.

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
2. If still wrong, restart the MCP server (Claude Desktop: toggle the server off and on)
3. If still wrong: re-run `load_build` from the original code/URL
