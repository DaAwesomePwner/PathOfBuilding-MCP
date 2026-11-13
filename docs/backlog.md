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

## Found during the launch-critical fixes

Raised by reviewers of the 2026-11-12 fix set (merged as `a4b9218e`) and left
for later.

- **PoB `dev` branch does not parse under plain LuaJIT.** `src/Modules/Main.lua:342`
  (`count += 1`, added in upstream commit `c38c8f6b`, 2026-08-23) uses Lua 5.3
  syntax, so a clone of the default branch fails to boot with `'=' expected
  near '+'`. Release tags (checked: `v2.67.2`) work. Needs an upstream fix, or
  a source transform in `bridge.lua`'s module loader. `POB_SOURCE_PATH` for
  `npm run test:source-clone` should point at a release tag until then.
- **`zlib1.dll` is held open in the install**, in addition to
  `lua-utf8.dll` (see "Do first").
- **Write-guard path forms.** UNC paths, 8.3 short names and junctions into the
  install are not normalised. Network-path installs get no zlib.
- **`__proto__` dropped by the input schema.** `z.record` removes the key
  before `set_config`/`toggle_buffs` validate it, so the call quietly does
  nothing.
- **Preset descriptions mention flasks** but set no flask key; the `flasks`
  alias only sets `conditionUsingFlask`.
- **`reload_engine` result size.** The returned `buildCode` has no size cap.
- **Reload and reconfigure wait** behind long calls such as
  `find_optimal_links`.
- **Manifest read hiccup looks like an install change**, which lets a later
  `reload_engine` reset the crash count.
- **Mapped network drive letters** are accepted by `configure_pob_path`.
- **After `reload_engine`, `reset_build` returns to the reloaded build**, not
  the originally loaded one.
- **Registry and `where luajit` probes run synchronously** after connect.
- **`src/engine-manager.ts` is well past the ~200-line guideline.**

## What-if restore exactness

Tree, item and skills restores are exact for the active build
(`restoreTreeState`, `restoreItemsState`, `restoreSkills` in
`lua/bridge.lua`), and the batch commands (`replaceSocketGroup`,
`allocNodes`, `deallocNodes`) check the whole batch before changing anything.
Two smaller gaps are listed under "Found during the restore and crash-recovery
work" (explosion gems in inactive skill sets, the unchecked
`replaceSocketGroup` rollback). One known difference remains: a tree restore that has to re-import nodes
puts back the same node set in a different `allocNodes` order, so the saved
node list and tree URL can come out reordered.

## Found during the restore and crash-recovery work

Raised by reviewers on 2026-11-13 (merged up to `c9b63635`) and left for later.

- **Replay journal is unbounded.** After a crash the engine replays every
  committed change since the last load, so recovery time grows with them.
  Folding the journal into a new baseline needs an export, which re-parses
  every item in the live build.
- **Partial change is not journaled.** If a mutation command itself fails with
  the engine still alive, the undo entry is kept but the change is never
  recorded for replay; a later crash restores the build without it.
- **Explosion gems in inactive skill sets** lose their settings on a skills
  restore without any report; the relink-or-refuse check covers the active set
  only.
- **`replaceSocketGroup` rollback is not checked for exactness** (the tree
  rollback is).
- **Untested failure paths.** The `convert_tree_to_latest` rollback, a LuaJIT
  exit or timeout during a what-if restore, and the "build lost" engine-swap
  carry have no test; each needs a fault from the `POB_MCP_TEST_FAULTS` seam.
- **Node list order after a tree re-import.** See "What-if restore exactness";
  the restore tests compare that list as a set where a re-import happened.
- **Wording.** A failed-restore reply can name `reset_build` twice; the
  swap-carry note says "failed again while being restarted" even when no
  process ever started.

## Robustness and security

- **poe.ninja build links unsupported.** `load_build` accepts only pobb.in and
  pastebin links (`parseBuildURL` in `src/validation.ts`); poe.ninja links are
  refused with a UserError.
- **Swallowed errors give wrong answers (confirmed).** Empty `catch {}` in
  `compareSupports`, `suggestUpgrades`, `compareScenarios`
  (`src/build-session.ts:998,1364,1490`) turn failures into zero deltas.
- **Undo edge cases (confirmed).** `undoLastChange` pops the entry before
  restoring, so a failed restore loses it. `set_config` pushes an undo entry
  even when the bridge refuses the change with a user error (`swap_item` does
  not). (Fixed 2026-11-13: entries are pushed only after the call succeeds, and
  a failing what-if restore no longer hides the probe's error.)
- **Protocol framing.** No request ids between TS and Lua, so one stray stdout
  line desynchronises responses. No `'error'` listener on the child's stdin
  (EPIPE, plausible).
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
- **Unbounded growth** of `stderrLines` and labelled snapshots.

## Tests and CI

- **Skipped tests exit 0.** Add a `REQUIRE_POB=1` mode and a CI workflow.
- **Fixture is pinned to tree `3_13`** (`test/fixtures/OccVortex.xml`) with
  hardcoded gem names in `test/phase5-test.ts`; assert on structure, add a
  current-league fixture.
- **No tests** for stdin-EOF shutdown, or that all tools are registered.
  `test/` is not type-checked.
- **Nightly run against PoB's `dev` branch** to catch internal API changes early.
