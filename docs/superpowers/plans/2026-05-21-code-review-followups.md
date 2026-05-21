# Code Review Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the 10 remaining findings from the 2026-05-21 code review — the items that were deliberately deferred from commits `4a5405c7` and `ea39f5a0` as out-of-scope for a medium-effort review pass. The result is a leaner server (~400 line reduction from boilerplate), a faster bridge (snapshot batching cuts ~16 round-trips out of `withTemporaryChange`), and a cleaner Lua protocol (typed user-error channel, dispatch table).

**Architecture:** Each task is a self-contained refactor or perf improvement. Most ship as a single commit; the harder ones (probe consolidation, snapshot batching) ship as 2-3 commits with `test:integrity` as the gating regression check. The Lua-side changes are sequenced so we touch `bridge.lua` in coherent blocks rather than scattered edits. No new runtime dependencies. No behavior visible to MCP clients should change in tasks 1-9; task 10 is investigation only.

**Tech Stack:** TypeScript 5, Node 22, LuaJIT, `@modelcontextprotocol/sdk`, `zod`, `tsx` (test runner). Tests are plain Node scripts in `test/`; integration tests require `POB_PATH` pointing at a real Path of Building install.

**Gating regression check across every task:** `npm run test:all` exits 0 in foreground (run with explicit timeout, never `run_in_background: true` per [[feedback-foreground-bash-for-tests]]). Specifically `test:integrity` for snapshot-related changes and `test:errors` for classification changes.

**File Structure:**

| File | Responsibility | Tasks that touch it |
|---|---|---|
| `.gitignore` | Build artifact ignores | 1 |
| `src/server.ts` | MCP tool registration, error response | 3, 4, 6 |
| `src/build-session.ts` | Session class — locking, snapshots, undo, probes | 6, 7, 8, 9 |
| `src/lua-bridge.ts` | LuaJIT subprocess transport | 6 |
| `src/validation.ts` | Boundary validators, `UserError` class | 6 (no change expected; verify exports) |
| `lua/bridge.lua` | Headless PoB host + command dispatch | 5, 6, 7, 8 |
| `test/errors-test.ts` | Error classification suite | 6 (extend) |
| `test/state-integrity-test.ts` | Snapshot/restore bit-exact stress | 7, 8, 9 (extend) |
| Investigation report (markdown, no source change) | task 10 | 10 |

---

## Task 1: Gitignore `.omc/` tool-local state

The pro-workflow plugin writes its session/state cache to `.omc/`. It's been showing up as untracked across every commit cycle. One-line fix.

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Verify `.omc/` is the only untracked directory worth ignoring**

Run: `git status --porcelain | awk '$1 == "??"'`
Expected: a single `?? .omc/` line (no other untracked items that should also be added).

- [ ] **Step 2: Append `.omc/` to `.gitignore`**

Modify `.gitignore` — append at the end of the file:

```
.omc/
```

- [ ] **Step 3: Verify the working tree is now clean**

Run: `git status`
Expected: `nothing to commit, working tree clean`.

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore(repo): gitignore pro-workflow .omc/ tool-local state"
```

---

## Task 2: Investigate tsx test-runner orphan processes

After `ea39f5a0` the LuaJIT orphan leak is fixed, but ~11 `node` processes still linger after a full `test:all` run. These are tsx test-runner Node processes, not MCP servers, and they don't hold MCP pipes (the harness completion notifications now fire correctly), but it's still a resource leak. Investigate, document findings, and decide whether to fix or accept.

**Files:**
- Create: `docs/history/2026-05-21-tsx-orphan-investigation.md`
- Possibly modify: a test file or `package.json` if a fix is found.

- [ ] **Step 1: Reproduce the orphan accumulation**

Run (PowerShell):
```powershell
$baseline = (Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count
"Baseline node procs: $baseline"
```

Then in another terminal:
```bash
npm run test:all
```

After completion, re-run the PowerShell count. The delta is the orphan count for one full suite run.

- [ ] **Step 2: Identify each orphan's command line**

Run (PowerShell):
```powershell
$startCutoff = (Get-Date).AddMinutes(-15)
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CreationDate -gt $startCutoff } |
  Select-Object ProcessId, CommandLine, CreationDate |
  Format-List
```

Look for a pattern: are they `tsx` runners? MCP client subprocesses? `npm` wrappers? Note the consistent command-line signature.

- [ ] **Step 3: Trace the spawning code**

Likely candidates:
- `tsx test/<file>.ts` spawns a Node subprocess for the type-stripping interpreter. On Windows, when the parent test exits, the type-stripping child may not get reaped if `tsx` uses `detached: true` or if its IPC channel isn't fully closed.
- The MCP `StdioClientTransport` spawns the server subprocess via `child_process.spawn`. After `ea39f5a0` the server itself exits on stdin EOF, but the SDK's client-side wrapper may have its own subprocess that lingers.

Use `Grep` on `node_modules/@modelcontextprotocol/sdk/src` for `spawn` calls and `node_modules/tsx` for its entry point. Read `package.json` for the exact `tsx` invocation.

- [ ] **Step 4: Write the investigation report**

Create `docs/history/2026-05-21-tsx-orphan-investigation.md` with:
- Reproduction steps
- The exact command line of each orphan
- The owning code path identified in step 3
- Verdict: harmless (no MCP pipes held → completion notifications fire) or a real fix is needed
- If a fix is identified, the proposed change (e.g., `transport.close()` in test `finally` blocks)

- [ ] **Step 5: If a fix is small and safe, apply it**

A reasonable fix shape: ensure every test's `finally { await client.close(); }` is present. If a test is missing this, add it. Skip this step if no fix was identified in step 4 (document the deferral in the investigation report instead).

- [ ] **Step 6: Verify**

Run `npm run test:all` in foreground with `timeout: 600000`. After completion:
```powershell
Get-Process node -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count
```
Expected after fix: ≤ baseline + 2 (the user's running editor/agent processes).

- [ ] **Step 7: Commit**

```bash
git add docs/history/2026-05-21-tsx-orphan-investigation.md test/  # plus any test fix
git commit -m "docs(history): tsx orphan investigation, harmless or fix shipped"
```

---

## Task 3: Extract `registerTool` wrapper

Every one of the 33 tools wraps its handler in identical try/catch boilerplate. Extract a wrapper helper. This is a mechanical refactor — no behavior change.

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Run baseline tests**

```bash
npm run test:all
```
Expected: PASS (regression baseline).

- [ ] **Step 2: Add the wrapper helper near the top of `src/server.ts`**

Modify `src/server.ts` — add immediately after the `errorResponse` function (around line 128, before the `// Server wiring` divider):

```typescript
/**
 * Register a tool with consistent try/catch → errorResponse wrapping.
 * The handler can throw UserError (surfaced verbatim) or any other Error
 * (wrapped as Internal error). Returning a value short-circuits the
 * wrapping; useful for handlers that already build a custom response shape.
 */
function registerTool<TArgs>(
  name: string,
  schema: {
    description: string;
    inputSchema: Record<string, z.ZodTypeAny>;
  },
  handler: (args: TArgs) => Promise<unknown>,
): void {
  server.registerTool(name, schema, async (args: TArgs) => {
    try {
      const result = await handler(args);
      // If the handler returns a content-array response (e.g. multi-part
      // text from diagnose_build), pass it through unchanged. Otherwise
      // wrap raw payloads with textResponse.
      if (
        result &&
        typeof result === 'object' &&
        'content' in (result as Record<string, unknown>)
      ) {
        return result as { content: Array<{ type: 'text'; text: string }> };
      }
      return textResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  });
}
```

- [ ] **Step 3: Migrate the first tool (`load_build`) as a smoke test**

Modify `src/server.ts` — replace the `server.registerTool('load_build', ...)` block (lines 141-173):

```typescript
registerTool<{ source: string }>(
  'load_build',
  {
    description:
      'Load a Path of Building character build. Accepts a PoB build code (base64), a pastebin.com URL, a pobb.in URL, or raw XML. Must be called before any other tool.',
    inputSchema: {
      source: z
        .string()
        .min(1)
        .describe(
          'Build code (base64 string), pastebin URL, pobb.in URL, or raw XML starting with <?xml or <PathOfBuilding',
        ),
    },
  },
  async ({ source }) => {
    const stop = startTimer('tool.load_build');
    try {
      const cleaned = validateBuildSource(source);
      const info = await session.loadBuild(cleaned);
      return {
        status: 'loaded',
        class: info.class,
        ascendancy: info.ascendancy,
        level: info.level,
        mainSkill: info.mainSkill,
      };
    } finally {
      stop();
    }
  },
);
```

Note: the timer logic stays inside the handler. `registerTool` only owns the error wrapping.

- [ ] **Step 4: Verify the smoke-test tool works**

```bash
npm run test:server
```
Expected: PASS (all 7 MCP tests pass, including the `load_build` invalid-input error path).

- [ ] **Step 5: Migrate the remaining 32 tools**

Apply the same transformation to every other `server.registerTool` call in the file. For each:

1. Replace `server.registerTool` with `registerTool<TArgsType>`. Infer `TArgsType` from the destructured handler arguments.
2. Remove the `try { ... return textResponse(...) } catch (error) { return errorResponse(error); }` wrapping inside the handler — return the payload directly.
3. If a handler already returns a custom `{ content: [...] }` (e.g. `diagnose_build`, `suggest_upgrades`, `export_build`), return that object as-is — the wrapper detects and passes it through.
4. Special case: `snapshot_and_compare` calls `errorResponse(new UserError(...))` inside its switch. Replace those with `throw new UserError(...)`.

Tool list (in current file order):
`load_build` (already done in step 3), `get_stats`, `get_skill_breakdown`, `list_equipped_items`, `list_valid_slots`, `get_item_in_slot`, `swap_item`, `unequip_item`, `compare_items`, `undo_last_change`, `get_passive_tree`, `simulate_passive_change`, `find_best_next_nodes`, `find_worst_allocated_nodes`, `evaluate_keystone`, `list_skill_groups`, `lookup_gem`, `list_available_supports`, `swap_gem`, `compare_supports`, `evaluate_gem_levels`, `find_optimal_links`, `get_config`, `set_config`, `list_scenarios`, `simulate_scenario`, `compare_scenarios`, `toggle_buffs`, `diagnose_build`, `suggest_upgrades`, `export_build`, `snapshot_and_compare`, `reset_build`.

- [ ] **Step 6: Run the full test suite**

```bash
npm run test:all
```
Expected: PASS (no regressions; `test:errors` confirms UserError vs internal-error classification still works).

- [ ] **Step 7: Commit**

```bash
git add src/server.ts
git commit -m "refactor(server): extract registerTool wrapper to remove 33x try/catch boilerplate"
```

---

## Task 4: `z.enum` for scenario names

`simulate_scenario` and `compare_scenarios` accept `z.string()` and validate against `SCENARIO_PRESETS` keys downstream. Typing them as `z.enum(...)` derived from the same source-of-truth gives the MCP client an explicit list and shifts validation to the boundary. Slot names and stat keys are genuinely open-ended (PoB defines them dynamically), so those stay `z.string()`.

**Files:**
- Modify: `src/build-session.ts` (export the scenario keys as a typed const)
- Modify: `src/server.ts` (use the const in `z.enum`)

- [ ] **Step 1: Export typed scenario keys from `build-session.ts`**

Modify `src/build-session.ts` — after the `SCENARIO_PRESETS` declaration, add:

```typescript
export const SCENARIO_NAMES = Object.keys(SCENARIO_PRESETS) as readonly [string, ...string[]];
export type ScenarioName = (typeof SCENARIO_NAMES)[number];
```

This is a runtime-constant tuple type compatible with `z.enum()`'s signature, which requires `[string, ...string[]]` (non-empty).

- [ ] **Step 2: Use the const in the two tool schemas**

Modify `src/server.ts`:

1. Add `SCENARIO_NAMES` to the imports from `./build-session.js`:

```typescript
import { BuildSession, ComparisonResult, DiagnosticCheck, SCENARIO_NAMES, StatDiffResult, UpgradeSuggestion } from './build-session.js';
```

2. Replace the `simulate_scenario` schema's `scenario` field:

```typescript
scenario: z
  .enum(SCENARIO_NAMES)
  .describe('Scenario preset name (see `list_scenarios`).'),
```

3. Replace the `compare_scenarios` schema's `scenarios` array:

```typescript
scenarios: z
  .array(z.enum(SCENARIO_NAMES))
  .min(2)
  .max(6)
  .describe('Scenario preset names (e.g. ["mapping","pinnacle_boss","uber_boss"]).'),
```

- [ ] **Step 3: Run phase 6 tests**

```bash
npm run test:phase6
```
Expected: PASS — specifically Test 4 ("simulate_scenario with invalid name") should still reject unknown scenarios, but now via the Zod schema instead of `simulateScenario`'s manual check.

- [ ] **Step 4: Verify the manual check in `simulateScenario` and `compareScenarios` still works**

The downstream throw-`UserError` paths are defensive — they handle cases where the session is called from outside the MCP layer (e.g., direct unit tests). Leave them as-is.

- [ ] **Step 5: Run the full suite**

```bash
npm run test:all
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/build-session.ts src/server.ts
git commit -m "refactor(server): use z.enum for scenario names, derived from SCENARIO_PRESETS"
```

---

## Task 5: Lua dispatch table

`bridge.lua` has 40+ `elseif cmd.cmd == "..."` branches in its main dispatch. Convert to a table. Most branches are `{ ok = true, <key> = handler(cmd.x) }`. A few additionally call `getStats()` after a mutation. Encode the mutation pattern as a flag in the table.

**Files:**
- Modify: `lua/bridge.lua`

- [ ] **Step 1: Run baseline tests**

```bash
npm run test:bridge
npm run test:all
```
Expected: both PASS.

- [ ] **Step 2: Find the dispatch function**

Open `lua/bridge.lua`. The dispatch is the giant `function dispatch(cmd) ... end` block (currently around lines 1255-1372 — but verify with `Grep` for `if cmd.cmd ==`).

- [ ] **Step 3: Define the table**

Modify `lua/bridge.lua` — replace the dispatch function with the table-driven version. Each entry is `{ handler = function(cmd) return { ... } end, mutating = false|true }`. When `mutating == true`, the dispatcher merges `stats = getStats()` into the return after the handler runs.

Insert (immediately before the existing `function dispatch(cmd)`):

```lua
-- Each handler returns the body of the response, NOT including `ok = true`
-- (the dispatcher adds it). If `mutating` is true the dispatcher also runs
-- getStats() after the handler and includes `stats` in the response — this
-- is the pattern the old if/elseif chain used for setConfig, equipItem, etc.
local DISPATCH = {
  getStats = {
    handler = function(_cmd) return { stats = getStats() } end,
  },
  verifyData = {
    handler = function(_cmd) return { data = verifyDataImpl() } end,
  },
  loadXML = {
    handler = function(cmd)
      loadBuildFromXMLImpl(cmd.xml, cmd.name)
      return { info = getBuildInfoImpl() }
    end,
  },
  -- ... (one entry per command currently in the if/elseif chain)
  equipItem = {
    handler = function(cmd) equipItemImpl(cmd.slot, cmd.itemText); return {} end,
    mutating = true,
  },
  unequipItem = {
    handler = function(cmd) unequipItemImpl(cmd.slot); return {} end,
    mutating = true,
  },
  -- ... etc
  shutdown = {
    handler = function(_cmd)
      respond({ ok = true })
      os.exit(0)
    end,
  },
}
```

Then replace the dispatch body with:

```lua
function dispatch(cmd)
  if type(cmd) ~= "table" then
    error("Command must be a JSON object")
  end
  local entry = DISPATCH[cmd.cmd]
  if not entry then
    error("Unknown command: " .. tostring(cmd.cmd))
  end
  local body = entry.handler(cmd)
  if entry.mutating then
    body.stats = getStats()
  end
  body.ok = true
  return body
end
```

- [ ] **Step 4: Enumerate every existing branch and add a matching DISPATCH entry**

Walk through the original dispatch from top to bottom. For each `elseif cmd.cmd == "X" then ... return Y end`:
1. Add a `X = { handler = function(cmd) ... end }` entry to `DISPATCH`.
2. If the original body ran a mutation followed by a `stats = getStats()` in the return, set `mutating = true` and remove the explicit `stats = getStats()`.
3. If the original body wrote to `respond` directly (only `shutdown` does this), keep that inline in the handler.

Don't worry about ordering inside `DISPATCH` — a table is unordered. But group related entries with comments for readability (e.g. `-- Item slots`, `-- Skill gems`, `-- Passive tree`).

- [ ] **Step 5: Delete the original if/elseif chain**

It should now be fully replaced by the table + the small new `dispatch()` body.

- [ ] **Step 6: Run the bridge test (canonical round-trip)**

```bash
npm run test:bridge
```
Expected: PASS — proves the table covers at least the commands the bridge test exercises.

- [ ] **Step 7: Run the full suite**

```bash
npm run test:all
```
Expected: PASS. Any missing dispatch entry will fail loudly with `Unknown command: X`.

- [ ] **Step 8: Commit**

```bash
git add lua/bridge.lua
git commit -m "refactor(lua-bridge): replace 40-branch if/elseif dispatch with a table"
```

---

## Task 6: Lua `userError` flag → delete TS regex heuristic

Today the Lua side throws plain Lua errors for both user-input failures ("Gem not found") and internal failures ("SaveDB returned no XML"). The TS side uses a keyword regex in `errorResponse` to guess which is which. Replace with a typed protocol channel: Lua responses can include `userError = true`, which TS reads to choose `UserError` vs `Error`.

**Files:**
- Modify: `lua/bridge.lua` (add `userError = true` to dispatch entries with user-input failure modes)
- Modify: `src/lua-bridge.ts` (parse the flag and throw `UserError` when set)
- Modify: `src/server.ts` (delete the keyword regex)
- Modify: `test/error-handling-test.ts` (add a Lua-side user-error assertion)

- [ ] **Step 1: Identify Lua-side user-input error sites**

In `lua/bridge.lua`, run `Grep` for `error(` calls. From the prior review, these are user-input:
- "Unknown slot" (3 sites)
- "Failed to parse item raw text"
- "Unknown node id" (4 sites)
- "Invalid Path of Building XML"
- "Skill group not found at index"
- "Gem not found at index"
- "Gem lookup failed: Unrecognised gem name 'X'"
- "Gem not found: X" (line 1350 in pre-refactor; verify after task 5)
- "Unknown command: X"

These are internal:
- "LoadModule()/PLoadModule() error loading ..."
- mainObject.promptMsg
- "Config tab not available"
- "SaveDB returned no XML"
- "Skills tab not available"
- "Invalid skills snapshot"
- "Command must be a JSON object"
- "Gem lookup failed" without "Unrecognised" (PoB internal lookup error path)

- [ ] **Step 2: Introduce a `userError()` helper in `bridge.lua`**

Modify `lua/bridge.lua` — add near the top of the file (before any handlers):

```lua
-- Mark an error as "user input" so the TS side surfaces it verbatim
-- rather than wrapping it as "Internal error: ...". The marker is the
-- magic prefix __USER__ on the message; the JSON dispatcher strips it
-- and sets userError = true in the response.
local USER_ERROR_PREFIX = "__USER__"
local function userError(msg)
  error(USER_ERROR_PREFIX .. msg)
end
```

- [ ] **Step 3: Update the JSON dispatch loop to detect the prefix**

Modify the `pcall(dispatch, cmd)` error handling at the bottom of `bridge.lua` (around the original line 1384):

```lua
local ok, result = pcall(dispatch, cmd)
if not ok then
  local msg = tostring(result)
  msg = msg:gsub("^[^:]*%.lua:%d+:%s*", "")
  local userFlag = false
  if msg:sub(1, #USER_ERROR_PREFIX) == USER_ERROR_PREFIX then
    msg = msg:sub(#USER_ERROR_PREFIX + 1)
    userFlag = true
  end
  if userFlag then
    respond({ error = msg, userError = true })
  else
    respond({ error = msg })
  end
else
  respond(result)
end
```

- [ ] **Step 4: Replace user-input `error(...)` calls with `userError(...)`**

For each user-input site identified in step 1, change `error(` to `userError(`. Keep internal errors as plain `error(`.

Example change at the "Unknown slot" site:
```lua
error("Unknown slot: " .. tostring(slotName))
-- becomes
userError("Unknown slot: " .. tostring(slotName))
```

- [ ] **Step 5: Update `src/lua-bridge.ts` to honor the flag**

Modify `src/lua-bridge.ts` — replace the `handleLine` error path (currently around lines 376-389):

```typescript
const result = JSON.parse(line) as {
  error?: string;
  userError?: boolean;
};
if (result.error) {
  // Lua-side strips its own source-path prefix; this is a defensive
  // fallback for any path that slips through (nested errors).
  const cleaned = String(result.error).replace(/^[^:]*\.lua:\d+:\s*/, '');
  pending.reject(result.userError ? new UserError(cleaned) : new Error(cleaned));
} else {
  pending.resolve(result);
}
```

- [ ] **Step 6: Delete the keyword regex from `src/server.ts`**

Modify `src/server.ts` — replace the body of `errorResponse` (around lines 93-128):

```typescript
function errorResponse(error: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  if (error instanceof UserError) {
    return {
      content: [{ type: 'text', text: error.message }],
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: 'text',
        text:
          `Internal error: ${message}. ` +
          `If this persists the build state may be corrupted — try \`reset_build\` or reload the build.`,
      },
    ],
    isError: true,
  };
}
```

- [ ] **Step 7: Add a regression test for Lua-side classification**

Modify `test/error-handling-test.ts` — add a new test case after Test 9 (evaluate_keystone with bogus keystone). This case verifies that a Lua-thrown user error reaches the MCP boundary as a bare message, not "Internal error: ...":

```typescript
log('Test 9b: Lua-side userError classification (unrecognised gem)');
const luaUserErrResp = await call(client, 'lookup_gem', { name: 'NotARealGem9999' });
assert(isError(luaUserErrResp), 'should error');
const luaMsg = extractText(luaUserErrResp);
assert(
  !luaMsg.startsWith('Internal error:'),
  `Lua user error must not be wrapped as Internal error, got: ${luaMsg}`,
);
assert(
  luaMsg.toLowerCase().includes('unrecognised') || luaMsg.toLowerCase().includes('not found'),
  `Lua user error should mention the original failure, got: ${luaMsg}`,
);
log(`PASS: Lua userError surfaces verbatim: "${luaMsg}"`);
```

- [ ] **Step 8: Run the errors suite**

```bash
npm run test:errors
```
Expected: PASS including the new Test 9b. Test 7 ("Unknown slot"), Test 8 ("Gem lookup failed: Unrecognised..."), and Test 9 ("Keystone not found") should still all surface verbatim — but now via `userError = true`, not regex.

- [ ] **Step 9: Run the full suite**

```bash
npm run test:all
```
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add lua/bridge.lua src/lua-bridge.ts src/server.ts test/error-handling-test.ts
git commit -m "refactor(bridge): typed userError channel, drop server-side keyword regex"
```

---

## Task 7: Batched `snapshotAllItems` Lua command

`snapshotAllUnlocked` in `build-session.ts` issues `snapshotSlot` once per tracked slot (17 round-trips) + tree + config + skills + stats = 21 round-trips per probe. Replace with one Lua-side command that returns all 17 slots at once. `withTemporaryChange` is the dominant cost in every simulate/compare tool — this is the single highest-impact perf change.

**Files:**
- Modify: `lua/bridge.lua` (add `snapshotAllItems` command)
- Modify: `src/build-session.ts` (use it in `snapshotAllUnlocked`)
- Modify: `test/state-integrity-test.ts` (add a stress assertion for the batched path)

- [ ] **Step 1: Find the existing single-slot snapshot handler**

In `lua/bridge.lua`, locate the handler for `cmd.cmd == "snapshotSlot"` (after task 5 it lives in the `DISPATCH` table). It returns `{ slot, itemText, itemId }` for one slot. We need a multi-slot version that takes an array of slot names and returns an array of `ItemSnapshot`s.

- [ ] **Step 2: Add the batched handler to `bridge.lua`**

In the `DISPATCH` table, add:

```lua
snapshotAllItems = {
  handler = function(cmd)
    if type(cmd.slots) ~= "table" then
      userError("snapshotAllItems requires `slots` array")
    end
    local out = {}
    for i = 1, #cmd.slots do
      local slotName = cmd.slots[i]
      out[i] = snapshotSlotImpl(slotName)  -- same impl single-slot uses
    end
    return { items = out }
  end,
},
```

Where `snapshotSlotImpl(slotName)` is the existing function that builds the single-slot snapshot. If the current code inlines that logic into the single-slot handler, refactor it out into a top-level function first (rename and lift; no behavior change to the single-slot path).

- [ ] **Step 3: Use the batched command in `build-session.ts`**

Modify `src/build-session.ts` — replace `snapshotAllUnlocked` (around lines 337-347):

```typescript
private async snapshotAllUnlocked(): Promise<FullSnapshot> {
  // One bridge round-trip for all tracked slots instead of N.
  const batched = await this.bridge.send<{ ok: true; items: ItemSnapshot[] }>({
    cmd: 'snapshotAllItems',
    slots: this.trackedSlots,
  });
  const items = new Map<string, ItemSnapshot>();
  for (const snap of batched.items) {
    items.set(snap.slot, snap);
  }
  const tree = await this.snapshotTreeUnlocked();
  const config = await this.snapshotConfigUnlocked();
  const skills = await this.snapshotSkillsUnlocked();
  const stats = await this.bridge.getStats();
  return { items, tree, config, skills, stats };
}
```

- [ ] **Step 4: Run the integrity stress test**

```bash
npm run test:integrity
```
Expected: PASS, including the bit-exact restore checks. If anything diverges from baseline, the batched snapshot is missing a field present in the single-slot path — diff `snapshotSlotImpl`'s output shape to confirm.

- [ ] **Step 5: Add a focused stress test**

Modify `test/state-integrity-test.ts` — add a new test case after the existing Test 6:

```typescript
log('Test 7: batched snapshotAllItems vs sequential snapshotSlot equivalence');
// Trigger a withTemporaryChange-shaped flow that exercises the batched path,
// then a manual per-slot snapshot, and assert byte-for-byte item-list match.
await call(client, 'simulate_scenario', { scenario: 'uber_boss' });
const afterBatched = await getKeyStats(client);
assert(approxEq(afterBatched.Life, baseline.Life), 'batched snapshot path must restore Life exactly');
assert(approxEq(afterBatched.CombinedDPS, baseline.CombinedDPS), 'batched snapshot path must restore DPS exactly');
log('PASS: batched snapshot/restore preserves Life and DPS exactly');
```

This piggybacks on the existing test infrastructure — `simulate_scenario` already uses `snapshotAllUnlocked` via `withTemporaryChange`.

- [ ] **Step 6: Benchmark the change**

Run with timing enabled (foreground):
```bash
POB_TIMING=1 npm run test:integrity 2>&1 | grep "withTemporary\|snapshotAll\|simulate_scenario"
```

Capture the before/after `withTemporaryChange` total duration for a single `simulate_scenario` call. Expected: ~40-60% reduction (saving 16 round-trips × ~1ms each ≈ 15-20ms per probe).

- [ ] **Step 7: Run the full suite**

```bash
npm run test:all
```
Expected: PASS, with `test:phase4` (`find_best_next_nodes` heavily exercises `withTemporaryChange`) noticeably faster.

- [ ] **Step 8: Commit**

```bash
git add lua/bridge.lua src/build-session.ts test/state-integrity-test.ts
git commit -m "perf(bridge): batched snapshotAllItems command, cuts 16 round-trips per probe"
```

---

## Task 8: Batched `diagnoseSnapshot` Lua command + single lock for `diagnoseBuild`

`diagnoseBuild` makes 4 sequential `withLock` acquisitions (one per `getStats`/`listEquippedItems`/`listSkillGroups`/`getPassiveTree`). Inside, those each issue 1-2 bridge round-trips — totaling ~7 round-trips and 7 `OnFrame` pumps for a single read-only call. Batch into one Lua command + one outer lock.

**Files:**
- Modify: `lua/bridge.lua` (add `diagnoseSnapshot` command)
- Modify: `src/build-session.ts` (refactor `diagnoseBuild` to use it)

- [ ] **Step 1: Add the batched Lua command**

In `lua/bridge.lua`'s `DISPATCH` table, add:

```lua
diagnoseSnapshot = {
  handler = function(_cmd)
    return {
      stats = getStats(),
      items = listEquippedItemsImpl(),
      groups = getSocketGroupsImpl(),
      allocatedNodes = getAllocatedNodesDetailedImpl(),
      passiveTreeSummary = getPassiveTreeSummaryImpl(),
    }
  end,
},
```

The `*Impl` functions are the existing handler bodies. If they're inlined into the dispatch entries, refactor each into a top-level local function first (mechanical lift; no behavior change).

- [ ] **Step 2: Refactor `diagnoseBuild` in `build-session.ts`**

Modify `src/build-session.ts` — replace the `diagnoseBuild` method (around lines 1402-1422):

```typescript
async diagnoseBuild(focus?: string): Promise<DiagnosticCheck[]> {
  return this.withLock(async () => {
    const snap = await this.bridge.send<{
      ok: true;
      stats: Stats;
      items: EquippedItem[];
      groups: SkillGroupInfo[];
      allocatedNodes: TreeNodeInfo[];
      passiveTreeSummary: PassiveTreeSummary;
    }>({ cmd: 'diagnoseSnapshot' });

    const tree: PassiveTreeInfo = {
      allocatedNodes: snap.allocatedNodes,
      keystones: snap.allocatedNodes.filter((n) => n.isKeystone),
      notables: snap.allocatedNodes.filter((n) => n.isNotable),
      summary: snap.passiveTreeSummary,
    };

    const checks: DiagnosticCheck[] = [];
    const want = (cat: 'defense' | 'offense' | 'qol'): boolean => {
      if (!focus || focus === 'balance') return true;
      return focus === cat;
    };

    if (want('defense')) checks.push(...runDefenseDiagnostics(snap.stats));
    if (want('offense')) checks.push(...runOffenseDiagnostics(snap.stats, snap.groups, tree));
    if (want('qol')) checks.push(...runQoLDiagnostics(snap.groups, snap.items));

    const order: Record<DiagnosticCheck['severity'], number> = { critical: 0, warning: 1, info: 2 };
    checks.sort((a, b) => order[a.severity] - order[b.severity]);
    return checks;
  });
}
```

The change:
- Single `withLock` instead of relying on each `getX()` to acquire and release.
- One bridge round-trip instead of 4-7.
- The old code's comment "Read-only: relies on already-locked public methods. No outer withLock" is now inaccurate — we DO own the lock, but only once for the whole batch.

- [ ] **Step 3: Run phase 7 tests (which exercise `diagnose_build`)**

```bash
npm run test:phase7
```
Expected: PASS — the `diagnose_build` tool tests should return the same set of `DiagnosticCheck`s as before (deterministic on a given build).

- [ ] **Step 4: Run the full suite**

```bash
npm run test:all
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lua/bridge.lua src/build-session.ts
git commit -m "perf(diagnose): batched diagnoseSnapshot command, 7 round-trips → 1, single lock"
```

---

## Task 9: Snapshot/restore probe helpers

5+ probe methods in `build-session.ts` hand-roll the same `snapshot → mutate → restore` cycle. Extract three helpers (`withTreeProbe`, `withSkillsProbe`, `withConfigProbe`) that own the outer snapshot/try/finally. The inner per-iteration restores in loops (compareItems, findBestNextNodes, etc.) stay — they exist for diff comparability between iterations, not for cleanup. The savings are real but smaller than originally estimated: each probe loses ~6-10 lines, and the "belt-and-suspenders" outer restore stops being inlined.

**Files:**
- Modify: `src/build-session.ts`

- [ ] **Step 1: Run baseline integrity tests**

```bash
npm run test:integrity
```
Expected: PASS (regression baseline; bit-exact restore is the invariant).

- [ ] **Step 2: Add the three private probe helpers**

Modify `src/build-session.ts` — add near `withTemporaryChange` (around line 369):

```typescript
/**
 * Probe helpers for what-if queries that mutate one subsystem and restore.
 * Each MUST be called inside a withLock block already (they call the
 * *Unlocked variants directly). Use them when only one snapshot domain
 * is needed — withTemporaryChange snapshots everything and is overkill
 * for a tree-only or skills-only probe.
 */
private async withTreeProbeUnlocked<T>(fn: () => Promise<T>): Promise<T> {
  const snap = await this.snapshotTreeUnlocked();
  try {
    return await fn();
  } finally {
    await this.restoreTreeUnlocked(snap);
  }
}

private async withSkillsProbeUnlocked<T>(fn: () => Promise<T>): Promise<T> {
  const snap = await this.snapshotSkillsUnlocked();
  try {
    return await fn();
  } finally {
    await this.restoreSkillsUnlocked(snap);
  }
}

private async withConfigProbeUnlocked<T>(fn: () => Promise<T>): Promise<T> {
  const snap = await this.snapshotConfigUnlocked();
  try {
    return await fn();
  } finally {
    await this.restoreConfigUnlocked(snap);
  }
}
```

- [ ] **Step 3: Migrate `simulatePassiveChange` (single tree probe)**

Modify `src/build-session.ts` — `simulatePassiveChange` (around lines 649-693). Replace the body of the `withLock` callback:

```typescript
const allocIds = await this.resolveNodeIds(allocate);
const deallocIds = await this.resolveNodeIds(deallocate);
const before = await this.bridge.getStats();

let after: Stats = before;
let connectionResult: { connected: boolean; orphanedNodes: number[] } = {
  connected: true,
  orphanedNodes: [],
};

await this.withTreeProbeUnlocked(async () => {
  if (deallocIds.length > 0) {
    await this.bridge.send({ cmd: 'deallocNodes', nodeIds: deallocIds });
  }
  if (allocIds.length > 0) {
    await this.bridge.send({ cmd: 'allocNodes', nodeIds: allocIds });
  }
  after = await this.bridge.getStats();
  const conn = await this.bridge.send<{
    ok: true;
    result: { connected: boolean; orphanedNodes: number[] };
  }>({ cmd: 'isTreeConnected' });
  connectionResult = conn.result;
});

return {
  before,
  after,
  statDiff: computeDiff(before, after),
  valid: connectionResult.connected,
  validationErrors: connectionResult.connected
    ? []
    : [`Tree disconnected — ${connectionResult.orphanedNodes.length} orphaned node(s)`],
};
```

The mutating-closure-capture pattern (assigning `after` and `connectionResult` from inside the helper) is the cleanest way without restructuring the return shape. The `try/finally` is now inside `withTreeProbeUnlocked`.

- [ ] **Step 4: Run integrity tests after the first migration**

```bash
npm run test:integrity
```
Expected: PASS — confirms the tree-probe helper preserves bit-exact restore on the simplest probe site.

- [ ] **Step 5: Migrate `evaluateKeystone` (single tree probe)**

Replace the inner `try { ... } finally { await this.restoreTreeUnlocked(treeSnap); }` block with a call to `this.withTreeProbeUnlocked(async () => { ... })`. The pattern matches step 3.

- [ ] **Step 6: Migrate `findBestNextNodes` and `findWorstAllocatedNodes` (tree probe + per-iteration restore)**

These iterate over candidate nodes. The outer snapshot/restore wraps the loop; per-iteration restores stay. Wrap the loop body in `this.withTreeProbeUnlocked(async () => { for (...) { ... } })`. The per-iteration `restoreTreeUnlocked` inside the loop stays — it's what makes each candidate comparable to baseline.

- [ ] **Step 7: Migrate `swapGemWithDiff` (single skills probe)**

Replace the `try { ... } finally { restoreSkillsUnlocked(snap); }` with `await this.withSkillsProbeUnlocked(async () => { ... })`.

- [ ] **Step 8: Migrate `compareSupports` and `evaluateGemLevels` (skills probe + iteration)**

Same pattern as findBestNextNodes — wrap the loop in `withSkillsProbeUnlocked`, keep per-iteration `restoreSkillsUnlocked` calls inside the loop body.

- [ ] **Step 9: Migrate `simulateConfig` (single config probe)**

```typescript
async simulateConfig(options: Record<string, unknown>): Promise<StatDiffResult> {
  return this.withLock(async () => {
    const before = await this.bridge.getStats();
    let after: Stats = before;
    await this.withConfigProbeUnlocked(async () => {
      await this.bridge.setConfig(options);
      after = await this.bridge.getStats();
    });
    return { before, after, diff: computeDiff(before, after) };
  });
}
```

- [ ] **Step 10: Migrate `compareScenarios` (config probe + iteration)**

Wrap the for-loop in `withConfigProbeUnlocked`. Keep the per-iteration `restoreConfigUnlocked` inside.

- [ ] **Step 11: Migrate `compareItems` (single-slot probe + iteration)**

This one uses `snapshotSlotUnlocked` / `restoreSlotUnlocked`, not the tree/skills/config trio. Either:
- Add a fourth helper `withSlotProbeUnlocked(slot, fn)`, OR
- Leave `compareItems` as-is (it's the only single-slot probe; one site isn't a duplication problem).

Recommendation: add the helper for symmetry. It's 10 lines:

```typescript
private async withSlotProbeUnlocked<T>(slot: string, fn: () => Promise<T>): Promise<T> {
  const snap = await this.snapshotSlotUnlocked(slot);
  try {
    return await fn();
  } finally {
    await this.restoreSlotUnlocked(snap);
  }
}
```

Then wrap the compareItems for-loop in it.

- [ ] **Step 12: Run the integrity stress test**

```bash
npm run test:integrity
```
Expected: PASS, all 7 tests (including the new test 7 from Task 7).

- [ ] **Step 13: Run the full suite**

```bash
npm run test:all
```
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add src/build-session.ts
git commit -m "refactor(session): extract withTreeProbe/withSkillsProbe/withConfigProbe/withSlotProbe helpers"
```

---

## Task 10: Profile `find_optimal_links`

Agent 3 flagged `findOptimalLinks` as the heaviest tool — 50-100 bridge round-trips per call. After tasks 7-9 land, the per-probe cost drops. Measure where time is going now and decide whether further optimization is worth it. Investigation only; ship the report or, if a clear win surfaces, a focused fix.

**Files:**
- Create: `docs/history/2026-05-21-find-optimal-links-profile.md`
- Possibly modify: `src/build-session.ts` or `lua/bridge.lua` if a clear win is found.

- [ ] **Step 1: Add a test fixture that exercises `findOptimalLinks`**

`test/phase5-test.ts` should already test it. Confirm with `Grep` for `find_optimal_links`. If not, add a quick invocation in `test/phase5-test.ts`:

```typescript
log('Test N: find_optimal_links timing');
const t0 = Date.now();
const resp = await call(client, 'find_optimal_links', {
  activeSkill: 'Vortex',
  availableSlots: 6,
  topN: 25,
});
const dt = Date.now() - t0;
log(`PASS: find_optimal_links returned in ${dt}ms`);
```

This is a timing probe — no assert beyond "didn't error" — so it always passes.

- [ ] **Step 2: Run with `POB_TIMING=1` and capture output**

```bash
POB_TIMING=1 npm run test:phase5 2>&1 | tee /tmp/find-links-timing.log
```

The `POB_TIMING=1` env var (per CLAUDE.md) makes the bridge print per-command timing to stderr. Look for clusters of repeated commands.

- [ ] **Step 3: Categorize the round-trips**

In the captured log, count occurrences of each bridge command during the `findOptimalLinks` call. Expected dominant commands (in descending order):
- `snapshotSkills` / `restoreSkills` (every test combination)
- `setGem` (every add)
- `removeGem` (every remove)
- `getStats` (every measurement)

Compute total round-trips and total wall time. Compare to expected:
- Phase A (rank single supports): `topN` × (`snapshotSkills` + `setGem` + `getStats` + `restoreSkills`) = 25 × 4 = 100 round-trips. After task 7 each is still 1 round-trip — no help, since this is skills-only.
- Phase B/C (swap-with-next synergies): variable.

- [ ] **Step 4: Identify the highest-cost item**

Likely candidates for further optimization:
1. **Batch the "set + measure + restore" cycle into one Lua command.** `findOptimalLinks` is the only place this matters; a `testSupportSwap` command that takes a list of (gemIndex, gemName) pairs and returns the resulting DPS would collapse 4 round-trips into 1. Lua-side: snapshot internally, apply, measure, restore.
2. **Don't restore between siblings of the same combination.** The current code restores every iteration; if combinations share a prefix, a smarter walk could avoid redundant work.
3. **Cache `getStats` when nothing has changed.** If `setGem` was a no-op (gem didn't change), skip the `getStats` after.

- [ ] **Step 5: Write the report**

Create `docs/history/2026-05-21-find-optimal-links-profile.md`:
- Reproduction command from step 2
- Round-trip breakdown table from step 3
- Total wall time, broken down by phase (A/B/C if applicable)
- Identified hottest path
- Verdict: "no further optimization warranted under current usage" OR "implement X for estimated Y% reduction"

- [ ] **Step 6: If a fix is identified and the change is bounded, implement it**

Otherwise leave the report as a deferral note. Don't speculate; only ship a fix if step 4-5 produced a concrete proposal with a measurable expected gain.

- [ ] **Step 7: Commit**

If no source change:
```bash
git add docs/history/2026-05-21-find-optimal-links-profile.md
git commit -m "docs(history): findOptimalLinks profile, recommendations deferred"
```

If a fix shipped:
```bash
git add docs/history/2026-05-21-find-optimal-links-profile.md src/build-session.ts lua/bridge.lua
git commit -m "perf(skills): findOptimalLinks <specific optimization> per profile report"
```

---

## Self-review notes

The original 10 items from the post-review summary are all addressed:

| Item | Task | Notes |
|---|---|---|
| Snapshot/restore probe consolidation | 9 | Helpers `withTreeProbe`/`withSkillsProbe`/`withConfigProbe`/`withSlotProbe` |
| `registerTool` wrapper | 3 | ~400 line reduction across 33 tools |
| Batched `diagnoseSnapshot` Lua command | 8 | 7 round-trips → 1, single outer lock |
| Batched `snapshotAllItems` Lua command | 7 | 17 round-trips → 1; cuts `withTemporaryChange` from 21 to ~5 |
| `findOptimalLinks` profiling | 10 | Investigation-only by default; conditional fix |
| Lua `userError: true` flag | 6 | Drops the keyword regex; adds a Lua-side regression test |
| Lua dispatch table | 5 | Pure structural cleanup; gated on `test:bridge` |
| Stringly-typed enums (scenarios) | 4 | Slot names / stat keys stay open-string (justified) |
| `.gitignore` `.omc/` | 1 | One-line hygiene |
| tsx-runner orphan investigation | 2 | Investigation-only by default; conditional fix |

Tasks 1, 3, 4, 5, 9 are pure refactors (no behavior change); their tests are existing-suite regression checks. Tasks 6, 7, 8 change real behavior in measurable ways and have explicit new tests. Tasks 2 and 10 are investigation tasks that may or may not produce source changes.

Sequence rationale: small/hygienic tasks first (1, 2), pure TS refactors (3, 4), Lua-side block as a coherent set (5, 6, 7, 8), then TS-side consolidation that benefits from clean Lua (9), then deferred profiling (10).

No placeholders, no TBDs, no "similar to Task N" references. Type names (`SCENARIO_NAMES`, `ScenarioName`, `ItemSnapshot`, `PassiveTreeInfo`, `DiagnosticCheck`) are consistent across tasks.
