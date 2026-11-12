# Backlog

Findings from the 2026-11-12 code review (against PoB Community 2.67.2) that were
not part of the launch-critical fix set. Line numbers refer to commit `8e939be5`.
Each item says whether the reviewer confirmed it by reading source or only found
it plausible.

## Do first

- **Install DLL lock can block PoB's updater (plausible).** `lua/bridge.lua:30,236-241`
  loads `lua-utf8.dll` from the PoB install. PoB's `UpdateApply.lua:30-32` loops
  until a locked file can be opened, so an update that replaces that DLL may hang
  while the MCP server is running. Until fixed, stop the MCP server before
  updating PoB. Options: load native modules from a private temp copy, use the
  pure-Lua UTF-8 fallback, or shut the engine down when idle.
- **`convert_tree_to_latest` tool.** A build saved on an old tree stays on that
  tree, so node advice targets the old league. Call
  `build.treeTab:ConvertToVersion(latestTreeVersion, ...)` (`Classes/TreeTab.lua`),
  push to the undo stack, report nodes lost.
- **Source-clone layout cannot boot (confirmed).** LuaJIT is spawned with the
  working directory at `POB_PATH` (`src/lua-bridge.ts:271`) but PoB loads files
  relative to `src/`. Spawn from the script path and set
  `main.disableDevAutoSave = true` (dev mode autosaves `~~temp~~.xml`).

## What-if restore exactness

- **Mastery selections lost on tree restore (confirmed).** The TS tree snapshot
  (`src/build-session.ts:17-19,260-276`) stores node ids only. Deallocating a node
  upstream of a mastery clears its selection, and the restore then skips that
  mastery. Snapshot `masterySelections` (or use PoB's `CreateUndoState`).
- **Item restore duplicates the item (confirmed).** `restoreSlotUnlocked`
  (`src/build-session.ts:219-229`) re-adds the item instead of re-selecting
  `snapshot.itemId`; exports grow and ids churn. Probe items are never deleted.
- **Wrong item equipped on id gaps (confirmed).** `lua/bridge.lua:432-436` assumes
  a new item gets the highest id; PoB assigns the lowest free id. Use
  `itemsTab.displayItem.id` and return a user error when the item does not fit.
- **Skills snapshot misses fields (confirmed).** `lua/bridge.lua:1224-1299` omits
  `imbuedSupport`, `groupCount`, `skillMinion*`, `skillMineCountCalcs`.
- **Untraced Life mismatch.** `test/session-test.ts` test 3 logged
  `Mismatch on Life: 6457 vs 6728` on a Ring 1 round-trip yet printed PASS.
- **Hardcoded slot list (confirmed).** `DEFAULT_TRACKED_SLOTS`
  (`src/build-session.ts:45-63`) lacks `Ring 3`, `Graft 1`, `Graft 2`, jewel and
  abyss sockets; snapshots and undo skip them. Take slots from `getValidSlots`.
- **Batch commands validate mid-mutation (confirmed).** `replaceSocketGroup`,
  `allocNodes` (`lua/bridge.lua:781-803,1138-1165`) can leave partial state.
- **Tattoo/hash-override exactness (plausible).** Restore reuses current
  `hashOverrides`, not the snapshot's.

## Robustness and security

- **URL build loading (confirmed).** `src/lua-bridge.ts:58-83`,
  `src/validation.ts:42`: substring host check allows SSRF
  (`http://169.254.169.254/?pobb.in`), no timeout or size cap, fetch runs under the
  session lock, pobb.in fetches the HTML page instead of `/pob/<id>`, poe.ninja
  unsupported.
- **Build-code decoding (confirmed).** `src/lua-bridge.ts:51-55`: no
  `maxOutputLength` on inflate; malformed codes surface as "Internal error".
- **Crash breaker never trips (confirmed).** Strikes reset after 5 successful
  commands and timeouts never count (`src/lua-bridge.ts:104,176-182,253-259`).
- **Respawn restores the wrong build (confirmed).** After a crash the originally
  loaded XML is reloaded, dropping committed changes; `lastLoadedXML` is set
  before the load succeeds; a failed startup leaves a live unready process.
- **Swallowed errors give wrong answers (confirmed).** Empty `catch {}` in
  `compareSupports`, `suggestUpgrades`, `compareScenarios`
  (`src/build-session.ts:998,1364,1490`) turn failures into zero deltas.
- **Undo edge cases (confirmed).** Entry pushed before a mutation and not removed
  on failure; `undoLastChange` pops before restoring; a throwing restore in
  `finally` hides the original error.
- **Protocol framing.** No request ids between TS and Lua, so one stray stdout
  line desynchronises responses. No `'error'` listener on the child's stdin
  (EPIPE, plausible).
- **User errors misreported (plausible).** With a short bridge path the Lua error
  prefix keeps the drive letter and the `__USER__` check fails
  (`lua/bridge.lua:253-255,1558-1559`). Use `error(msg, 0)`.
- **`arg[1]` leaks into PoB (confirmed).** `Modules/Main.lua` treats it as a
  `pob://` link; clear `arg` before loading `Launch.lua`.
- **`allocNode` silently no-ops** when a node has no path; check `node.alloc`.
- **Missing graphics stubs.** `GetDrawColor`, `GetDrawLayer`, `SetBlendMode`,
  `SetForeground`, `NewArtHandle`, `IsLoading`; consider a catch-all or loading
  upstream's `_SimpleGraphic.def.lua` when present.
- **Boot-time API check.** Verify every PoB method the bridge calls exists with
  the expected arity and fail with "PoB vX unsupported: `<symbol>` changed".
- **Hardcoded stat lists and limits.** `lua/bridge.lua:328-334,651-656` and
  `src/server.ts:33-65` (use `build.displayStats`); max points `99+23` / `8`
  (`lua/bridge.lua:851-852`); `optimizeFor` accepts unknown stats and returns
  zero deltas.
- **Gem lookup quirks.** "X Support" names fail; archetype detection uses name
  regexes (`src/build-session.ts:1985-1993`). Fall back to `data.gemForBaseName`
  and gem tags.

## MCP layer

- **Internal errors leak stderr, local paths and Lua tracebacks** to the client
  (`src/server.ts:114-136`). Log in full, return a sanitised message.
- **No tool annotations** (`readOnlyHint`, `destructiveHint`), `outputSchema` or
  `structuredContent`.
- **Unbounded inputs.** No `.max()` on `itemText`, `source`, config records; no
  upper bound on gem/skill indices.
- **Shutdown.** No `unhandledRejection` handler, no kill timeout on
  `bridge.shutdown()`, `server.close()` not called.
- **Duplicate payloads.** `diagnose_build` and `suggest_upgrades` return the data
  twice; JSON is pretty-printed everywhere.
- **`swap_gem` description says it does not push undo**, contradicting
  `CLAUDE.md`; `undo_last_change` mentions a non-existent `allocate_node` tool.
- **`snapshot_and_compare` leaks a `__current_compare__` snapshot.**
- **Unbounded growth** of `stderrLines` and labelled snapshots.

## Tests and CI

- **Skipped tests exit 0.** Add a `REQUIRE_POB=1` mode and a CI workflow.
- **Fixture is pinned to tree `3_13`** (`test/fixtures/OccVortex.xml`) with
  hardcoded gem names in `test/phase5-test.ts`; assert on structure, add a
  current-league fixture.
- **No tests** for the crash breaker, timeout recovery, stdin-EOF shutdown, or
  that all tools are registered. `test/` is not type-checked.
- **Nightly run against PoB's `dev` branch** to catch internal API changes early.
- **Attribution.** The host stub block in `lua/bridge.lua` is adapted from PoB's
  MIT-licensed `HeadlessWrapper.lua`; add an attribution line.
