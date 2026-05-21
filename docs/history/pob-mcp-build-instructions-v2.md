# Building a Path of Building MCP Server — Phased Instructions for Claude Code

> **How to use this document:** Feed each phase to Claude Code as a separate prompt. Complete and test each phase before moving to the next. The phases are ordered by dependency — later phases build on earlier ones.

---

## Phase 0: Reconnaissance (Run First)

```
Explore the PathOfBuilding repo structure I have cloned here. I need you to understand the codebase before we build anything. Specifically:

1. Find and read `HeadlessWrapper.lua` (or any headless/CLI entry point). Document:
   - How it loads a build (XML or build code)
   - What calc functions it exposes
   - How it outputs results
   - What Lua runtime it expects (LuaJIT? Standard Lua?)
   - Which functions are STUBBED or non-functional in headless mode (pay special attention to Inflate/Deflate, lcurl, path functions)

2. Find the core calculation files. Look for:
   - The main DPS calculation pipeline
   - How items are represented internally (item slots, mod parsing)
   - How the passive tree is represented and traversed
   - How skill gems / links are structured
   - How config options (enemy type, charges, flasks, etc.) are stored
   - How the "frame pump" works — where runCallback("OnFrame") is required to flush calculations

3. Find the data files:
   - Where base item data lives
   - Where passive tree data lives
   - Where gem data lives
   - What format they're in (Lua tables? JSON?)

4. Check for any existing CLI, API, or test harness code that invokes the calc engine programmatically. Look at the test suite (spec/ directory) for patterns — especially how tests mutate build state, pump frames, and read outputs.

5. Specifically investigate these known architectural constraints and document how they manifest in the code:
   - The global singleton pattern (launch, main, build objects are all global)
   - One active build at a time (newBuild/loadBuildFromXML both switch to BUILD mode)
   - The frame pump requirement (changes don't update outputs until runCallback("OnFrame") runs)
   - Inflate/Deflate being empty stubs in headless mode (build code import is broken)
   - lcurl.safe returning nil (no network in headless)
   - Path functions (GetScriptPath, GetRuntimePath, GetUserPath, GetWorkDir) returning empty strings
   - Output tables (mainOutput, calcsOutput, etc.) being replaced during recalculation — old references go stale
   - Config input aliasing (configTab.input points directly to the active config set's input table)
   - Tree loading being intentionally deferred after items
   - Jewel radii being global and potentially mutated by tree/spec changes

Output a summary document (ARCHITECTURE.md) covering:
   - File paths for all of the above
   - The data flow from "load build XML" → "run calcs" → "output stats"
   - Any dependencies (LuaJIT version, external libs, data file update mechanism)
   - A dedicated "Constraints & Gotchas" section with each of the above items, the exact file/line references, and their implications for our bridge design
   - Whether the data files load correctly when path stub functions return empty strings, or whether we need to override them with real paths

Do NOT write any code yet. This is purely reconnaissance.
```

---

## Phase 1: Lua Bridge — Spawn and Communicate with PoB's Engine

```
Using the ARCHITECTURE.md we created, build a Node.js (TypeScript) bridge layer that can spawn PoB's Lua engine and communicate with it.

### Requirements:

1. Create a TypeScript module `src/lua-bridge.ts` that:
   - Spawns the PoB Lua engine as a child process using the headless wrapper
   - Communicates via stdin/stdout using a JSON lines protocol
   - Handles errors gracefully (bad build data, Lua crashes, timeouts)
   - Supports a persistent process model — spawn once, query many times
   - If the Lua process crashes, detect it and auto-restart on the next command

2. Create a Lua script `bridge.lua` that wraps the headless engine and:
   - Reads commands from stdin as JSON lines
   - Writes results to stdout as JSON lines
   - **CRITICAL: Overrides the stubbed path functions** (GetScriptPath, GetRuntimePath, GetUserPath, GetWorkDir) to return the actual repo directory path so data files load correctly. Test this — if the passive tree data, gem data, and base item data don't load, nothing else works.
   - Implements these commands:
     - `{"cmd": "loadXML", "xml": "..."}`  — load a build from raw XML string using loadBuildFromXML(), then pump a frame, then read and return basic build info
     - `{"cmd": "getStats"}`  — pump a frame (to ensure fresh outputs), serialize the current calcsTab.mainOutput and calcsTab.mainEnv to JSON, return it. IMPORTANT: Read the output tables IMMEDIATELY after the frame pump. Do not cache references — they go stale on the next recalculation.
     - `{"cmd": "shutdown"}`  — clean exit
   - **FRAME PUMP RULE:** Every command that reads calculated stats MUST call `runCallback("OnFrame")` before reading. Every command that mutates build state (items, tree, config, gems) MUST call `runCallback("OnFrame")` after the mutation and before returning results. This is non-negotiable — without the frame pump, outputs reflect the previous state.
   - Wraps all output reads in pcall() for safety

3. **BUILD CODE DECODING HAPPENS IN TYPESCRIPT, NOT LUA.**
   PoB build codes are base64-encoded, zlib-compressed XML. The headless wrapper stubs out Inflate() and Deflate(), so Lua-side build code decoding is broken. Handle this entirely in TypeScript:
   - Accept build codes (the base64 strings like "eNrtfW1z...")
   - Base64-decode them
   - Inflate using Node.js `zlib.inflateSync()` (try both raw inflate and standard inflate — PoB uses raw deflate)
   - The result is XML — pass it to the Lua engine via the `loadXML` command
   - Similarly, for export: receive XML from Lua, deflate + base64-encode in TypeScript

4. **PASTEBIN/URL FETCHING HAPPENS IN TYPESCRIPT, NOT LUA.**
   lcurl is disabled in headless mode. If a build source is a pastebin URL or pobb.in URL:
   - Fetch the raw content via Node.js `fetch()` in TypeScript
   - Extract the build code from the response
   - Decode it per step 3
   - Pass XML to Lua

5. Create a test script `test/bridge-test.ts` that:
   - Loads a known PoB build code (hardcode a simple one for testing — you can base64+zlib encode a minimal valid XML build in the test setup)
   - Retrieves stats
   - Logs them to console
   - Verifies the bridge works end-to-end
   - Tests error handling (malformed XML, empty build code)

### Important constraints:
- Check what Lua runtime PoB uses (almost certainly LuaJIT). Make sure we invoke the correct runtime.
- The PoB data files (tree data, gem data, base items) must be accessible to the Lua process. Set the working directory to the repo root AND override the path stub functions.
- Keep this module focused — it's just the communication layer. No MCP code yet. No state management yet.
- ALL communication is serial. Only one command can be in-flight at a time. The Lua engine is single-threaded with global state.

### Output structure:
src/
  lua-bridge.ts       — the TypeScript bridge (spawn, stdin/stdout JSON lines, build code decoding, URL fetching)
  bridge.lua          — the Lua stdin/stdout wrapper (with path overrides and frame pump discipline)
test/
  bridge-test.ts      — end-to-end test
```

---

## Phase 1.5: State Management Layer (BuildSession)

```
Before we build MCP tools, we need a state management layer that centralizes all the "gotcha" mitigations from PoB's global singleton architecture. Every MCP tool will call through this layer — never the raw Lua bridge.

### Create `src/build-session.ts` — a BuildSession class that wraps lua-bridge and provides:

1. **Serial execution lock:**
   - PoB has a single global build object. Only one operation can run at a time.
   - Implement a mutex/queue so that if two tool calls arrive simultaneously, the second waits for the first to complete.
   - Use a simple promise-based lock (no external deps needed).

2. **Build loading pipeline:**
   - Accept build codes (base64 strings), pastebin/pobb.in URLs, or raw XML
   - Route through the appropriate decoding path:
     - URL → fetch in TS → extract build code → decode
     - Build code → base64 decode → zlib inflate in TS → XML
     - Raw XML → pass through
   - Send XML to Lua bridge's loadXML command
   - Store the original XML as the "clean" baseline for reset

3. **Snapshot and restore system:**
   - `snapshotSlot(slot: string)` — capture the current item XML/data for a gear slot before modification
   - `restoreSlot(slot: string)` — restore a previously snapshotted item and pump a frame
   - `snapshotTree()` — capture current passive allocations
   - `restoreTree()` — restore passive allocations and pump a frame
   - `snapshotConfig()` — capture current config input values (IMPORTANT: config input is an alias to the active config set — snapshot must deep-copy the values, not store a reference)
   - `restoreConfig()` — restore config values and pump a frame
   - `snapshotAll()` / `restoreAll()` — convenience methods for full build state
   - These are used internally by comparison tools to implement safe "try and revert" patterns.

4. **Safe comparison helper:**
   - `withTemporaryChange<T>(changeFn, readFn): Promise<T>` — a helper that:
     a. Takes a snapshot of relevant state
     b. Applies the change (changeFn)
     c. Pumps a frame (via the bridge)
     d. Reads results (readFn)
     e. Restores the snapshot in a finally block (guaranteeing cleanup even on error)
     f. Returns the results
   - This is the core pattern for every "swap and compare" operation.

5. **Labeled snapshots for multi-step comparisons:**
   - `takeSnapshot(label: string)` — save full stat output with a label (e.g., "before upgrades")
   - `getSnapshot(label: string)` — retrieve a previous snapshot
   - `diffSnapshots(labelA: string, labelB: string)` — compute stat deltas between two snapshots
   - Store snapshots in a Map<string, StatSnapshot> in memory

6. **Reset:**
   - `resetBuild()` — reload the original XML (stored at load time) to revert all changes
   - `undoLastChange()` — revert the most recent mutation (maintain a stack of snapshots, max depth ~20)

7. **Build metadata:**
   - After loading, parse and cache: class, ascendancy, level, main skill name, league/version
   - Expose via `getBuildInfo()`

### Testing:
- Write `test/session-test.ts` that:
  - Loads a build
  - Takes a snapshot
  - Swaps an item via the bridge
  - Verifies stats changed
  - Restores the snapshot
  - Verifies stats match original
  - Tests the serial lock with concurrent requests
  - Tests resetBuild()

### Important:
- This class owns all state. MCP tools should NEVER call lua-bridge directly.
- Every method that reads stats must ensure a frame pump happened after the last mutation.
- Snapshot restore must also pump a frame before returning.
- The undo stack should store lightweight diffs, not full build XML (unless that's simpler — optimize later).
```

---

## Phase 2: MCP Server Scaffold with Core Stats Tools

```
Using the BuildSession from Phase 1.5, create an MCP server with the foundational tools for loading builds and reading stats.

### Requirements:

1. Initialize the project as a proper MCP server using the @modelcontextprotocol/sdk package (npm install @modelcontextprotocol/sdk). Use the stdio transport.

2. Create `src/server.ts` as the MCP server entry point with these tools:

   **Tool: `load_build`**
   - Input: `{ source: string }` — accepts a PoB build code (the encoded base64 string), a pastebin URL, a pobb.in URL, or raw XML
   - Decoding and fetching are handled by BuildSession (TypeScript-side). No Lua-side network or compression.
   - Loads the build into the engine via BuildSession
   - Returns: confirmation + basic summary (class, ascendancy, level, main skill)

   **Tool: `get_stats`**
   - Input: `{ categories?: string[] }` — optional filter for stat categories
   - Returns the full stat block from the current loaded build, organized into categories:
     - `offense`: Combined DPS, skill DPS breakdown, crit chance, crit multi, hit chance, attack/cast speed, damage types
     - `defense`: Life, ES, mana, evasion, armour, block (attack/spell), dodge, resistances (ele + chaos), max hit taken, EHP
     - `sustain`: Life regen, ES regen/recharge, mana regen, leech rates, recoup
     - `charges`: Current/max endurance, frenzy, power charges
     - `config`: Active configuration options (enemy type, boss, map mods, etc.)
   - All stat reads go through BuildSession, which guarantees frame pump freshness.

   **Tool: `get_skill_breakdown`**
   - Input: `{ skillIndex?: number }` — which skill group to analyze (defaults to main skill)
   - Returns: per-skill-gem breakdown including DPS contribution, support gems active, mana cost, cast rate, damage effectiveness, and any special mechanics (e.g., Archmage mana added, Inspiration charge reduction)

   **Tool: `list_equipped_items`**
   - Input: none
   - Returns: all currently equipped items by slot, with their mod lists and which mods are local vs global

3. Create `package.json` with:
   - Correct MCP server bin entry
   - Build scripts (TypeScript → JS)
   - All dependencies

4. Create a README.md with setup instructions.

### Test by running the server locally and verifying each tool with a test build code.
```

---

## Phase 3: Item Comparison and Swap Tools

```
Add tools to the MCP server that allow swapping items and comparing the stat impact. All comparison operations use BuildSession's withTemporaryChange() to guarantee clean state restoration.

### New tools to add:

   **Tool: `swap_item`**
   - Input: `{ slot: string, itemText: string }` — slot name (e.g., "Weapon 1", "Ring 1", "Belt", "Helmet") and the item text in PoB format (the copy-paste format from PoB or trade sites)
   - Loads the item into the specified slot, re-runs calcs
   - Returns: full stat diff (before vs after) for all offensive and defensive categories
   - Returns: the new absolute values AND the delta (e.g., "+340,000 DPS", "-200 EHP")

   **Tool: `compare_items`**
   - Input: `{ slot: string, items: string[] }` — a slot and 2-5 candidate items to compare
   - **MUST BE STRICTLY SERIAL.** The global singleton build means each comparison must follow the exact sequence:
     1. Snapshot the current item in the slot (via BuildSession)
     2. For each candidate item:
        a. Equip the candidate
        b. Pump a frame
        c. Read stats IMMEDIATELY (output tables go stale on next recalc)
        d. Restore the original item
        e. Pump a frame
     3. Return all results
   - Use BuildSession.withTemporaryChange() for each candidate — this handles the snapshot/restore/finally pattern.
   - Returns: a comparison table showing all items side-by-side with stat deltas relative to the currently-equipped item
   - Highlight the "best" item for DPS, the "best" for EHP, and any notable tradeoffs

   **Tool: `unequip_item`**
   - Input: `{ slot: string }`
   - Removes the item from the slot, re-calcs
   - Returns: stat diff showing the impact of losing that item

   **Tool: `get_item_in_slot`**
   - Input: `{ slot: string }`
   - Returns: full item text and parsed mods for whatever is currently equipped in that slot

### Important notes:
- After each swap/compare operation, restore the original item so the build state stays clean. BuildSession.withTemporaryChange() guarantees this in a finally block — even if the Lua engine errors mid-calculation, the restore still runs.
- Item text parsing needs to handle PoB's item format including: rarity lines, base type, implicits, explicits, crafted mods, fractured mods, enchants, quality, sockets/links.
- Slot names should match PoB's internal naming. Check the codebase for the exact slot name strings — likely "Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Belt", "Flask 1"-"Flask 5", "Jewel 1"-"Jewel N". Expose the valid slot names in the tool description so Claude knows what to pass.
- NO parallel execution of comparisons. The serial lock in BuildSession enforces this, but the tool implementation should also be written to be naturally sequential.
```

---

## Phase 4: Passive Tree Analysis Tools

```
Add tools for analyzing and optimizing the passive skill tree. These tools must respect several PoB engine constraints documented in ARCHITECTURE.md.

### New tools to add:

   **Tool: `get_passive_tree`**
   - Input: none
   - Returns: list of all allocated passives (node ID, name, stats granted), total points used, ascendancy points used, and which keystones are active

   **Tool: `simulate_passive_change`**
   - Input: `{ allocate?: string[], deallocate?: string[] }` — lists of passive node names or IDs to add/remove
   - **DO NOT reload the tree from scratch.** Allocate/deallocate individual nodes on the already-loaded tree, then pump a frame. Reloading the tree triggers the deferred-after-items ordering constraint and could corrupt state.
   - Re-runs calcs with the modified tree
   - Returns: stat diff (before/after) showing impact
   - Must validate that the resulting tree is still connected (no orphaned nodes) and uses a valid number of points
   - Uses BuildSession.withTemporaryChange() to snapshot tree state before and restore after

   **Tool: `find_best_next_nodes`**
   - Input: `{ count?: number, optimizeFor?: string }` — how many candidates to return (default 10), and what stat to optimize for (default "CombinedDPS", but could be "EHP", "ManaRegen", "Life", etc.)
   - Looks at all unallocated nodes that are one step away from current allocation (reachable nodes)
   - **SKIP JEWEL SOCKET NODES by default** unless the user explicitly requests them. Jewel radii are global state and simulating jewel socket allocation can mutate global data, interfering with the build's existing jewel setup. If jewel sockets are requested, warn about potential side effects.
   - **STRICTLY SERIAL iteration:** For each candidate reachable node:
     1. Snapshot tree (via BuildSession)
     2. Allocate the node
     3. Pump a frame
     4. Read stats IMMEDIATELY
     5. Restore tree snapshot
     6. Pump a frame
     7. Next candidate
   - Returns: ranked list of the best next nodes by the target stat, showing the delta each would provide
   - Also flag any notable tradeoffs (e.g., "+50k DPS but -300 EHP")
   - **Performance note:** This may need to run 20-50+ iterations. Each iteration involves two frame pumps (one after allocate, one after restore). If this is slow (>30s total), consider:
     - Filtering out obviously irrelevant nodes (e.g., pure dex travel nodes for a pure int build) before simulating
     - Reporting results in batches

   **Tool: `find_worst_allocated_nodes`**
   - Input: `{ count?: number, optimizeFor?: string }`
   - For each currently allocated non-keystone node, simulates removing it (only if removal keeps tree connected)
   - Same serial pattern as find_best_next_nodes
   - Returns: ranked list of nodes providing the least value, showing what you'd lose by removing each
   - This helps identify "dead" travel nodes or inefficient pathing

   **Tool: `evaluate_keystone`**
   - Input: `{ keystone: string }` — name of a keystone
   - Simulates toggling the keystone (allocating if not taken, removing if taken), including any pathing cost to reach it
   - Returns: full stat diff + pathing cost in passive points
   - Uses withTemporaryChange() for clean restore

### Critical constraints:
- **NEVER reload the passive tree from scratch during simulation.** PoB intentionally defers tree loading after items (src/Modules/Build.lua:632-657). Reloading could break item-dependent tree state (converted trees, jewel sockets that depend on item data). Always mutate the existing tree in place.
- **Jewel radii are global** (src/Classes/TreeTab.lua:543-546). Allocating/deallocating jewel sockets can corrupt jewel radius data for the build's existing jewels. Skip jewel sockets in automated scans.
- **Connected tree validation** must account for: ascendancy nodes connecting through the ascendancy start, cluster jewels having their own sub-graphs, and Scion's special ascendancy pathing.
- All simulation is serial — the global build object cannot handle concurrent tree mutations.
```

---

## Phase 5: Skill Gem and Link Configuration Tools

```
Add tools for analyzing and modifying skill gem setups.

### New tools to add:

   **Tool: `list_skill_groups`**
   - Input: none
   - Returns: all skill groups (socket groups) in the build, with:
     - Which item slot they're in
     - Active skill gem(s) and their level/quality
     - Support gems and their level/quality
     - Whether this group is enabled/disabled
     - Whether it's the "main skill" group

   **Tool: `swap_gem`**
   - Input: `{ skillGroupIndex: number, gemIndex: number, newGemName: string, level?: number, quality?: number }`
   - Swaps a gem in a skill group using withTemporaryChange() for clean restore
   - Pumps a frame after the swap before reading stats
   - Returns: stat diff showing the impact

   **Tool: `compare_supports`**
   - Input: `{ skillGroupIndex: number, candidates: string[] }`
   - For the given skill group, tests each candidate support gem in the weakest support slot
   - **Strictly serial** — each candidate: snapshot → swap → pump frame → read stats immediately → restore → pump frame → next
   - Returns: ranked comparison showing DPS/utility impact of each candidate
   - Identifies which current support is "weakest" by simulating removal of each

   **Tool: `find_optimal_links`**
   - Input: `{ activeSkill: string, availableSlots: number, constraints?: string[] }`
   - Given an active skill and number of support slots (e.g., 5 for a 6-link), finds the optimal support combination
   - If constraints are given (e.g., "must include Archmage Support"), lock those in and optimize remaining slots
   - Returns: best support combination with total DPS, and the top 3-5 alternatives
   - **WARNING: Combinatorially expensive.** Use this heuristic approach:
     1. Test each viable support individually (serial, with frame pumps) to get single-support DPS values
     2. Start with top N supports
     3. Iteratively test swapping lower-ranked supports into the combination to check for synergies
     4. Do NOT brute-force all permutations
   - All iterations are serial with frame pumps between each

   **Tool: `evaluate_gem_levels`**
   - Input: `{ skillGroupIndex: number, gemIndex: number }`
   - Shows the DPS/stat scaling curve for leveling the specified gem from its current level through level 21 (or max)
   - Serial: for each level, set level → pump frame → read stats → restore → pump frame
   - Useful for evaluating whether a 21/20 gem is worth the investment
```

---

## Phase 6: Configuration and Scenario Tools

```
Add tools for modifying PoB's configuration options and simulating different combat scenarios.

### CRITICAL CONSTRAINT — Config Aliasing:
PoB's build.configTab.input is a DIRECT REFERENCE to the active config set's input table (src/Classes/ConfigTab.lua:983-985). Mutating configTab.input mutates the config set in place. All config modifications MUST:
1. Deep-copy the current config values into a snapshot BEFORE any changes
2. Apply changes
3. Pump a frame
4. Read stats
5. Restore the snapshot in a finally block (via BuildSession.withTemporaryChange or snapshotConfig/restoreConfig)

### New tools to add:

   **Tool: `get_config`**
   - Input: none
   - Returns: all configuration options and their current values (enemy type, boss tier, map mods, charges, flasks, custom modifiers, etc.)
   - Document the most commonly useful config keys in the tool description so Claude knows what to ask for

   **Tool: `set_config`**
   - Input: `{ options: Record<string, any> }` — key-value pairs of config options to change
   - Applies config changes, pumps a frame, re-calcs
   - Returns: stat diff showing impact of the config change
   - WARNING: This MUTATES the active config set in place. Use withTemporaryChange() if the caller wants to preview without committing.

   **Tool: `simulate_scenario`**
   - Input: `{ scenario: string }` — a preset scenario name or custom description
   - Preset scenarios (map each to the actual PoB config keys):
     - "mapping" — standard map boss, flasks up, charges up, onslaught active
     - "pinnacle_boss" — Uber boss / Shaper-tier enemy, no flask uptime assumed, boss curse effect reduction applied
     - "breach" — breach mob density assumptions, Headhunter buffs active (if HH equipped), flasks up, charges up
     - "maven" — Maven witness fight, 10 bosses
     - "delirium" — Delirium mirror, high density
   - Uses withTemporaryChange() with config snapshot/restore — the build returns to its original config state after the scenario runs
   - Returns: full stat readout under that scenario

   **Tool: `compare_scenarios`**
   - Input: `{ scenarios: string[] }`
   - Runs multiple scenarios SEQUENTIALLY (serial lock, each with its own snapshot/restore cycle)
   - Returns: side-by-side comparison table
   - Useful for "how does my build perform mapping vs bossing?"

   **Tool: `toggle_buffs`**
   - Input: `{ buffs: Record<string, boolean> }` — toggle specific buffs on/off (e.g., "flasksActive", "powerCharges", "frenzyCharges", "onslaught", "headhunterBuffs")
   - Uses withTemporaryChange() with config snapshot/restore
   - Re-calcs and returns stat diff
```

---

## Phase 7: Build Optimization Advisor Tools

```
Add higher-level tools that combine multiple lower-level operations to provide upgrade advice. These tools orchestrate calls to the tools from earlier phases.

### New tools to add:

   **Tool: `diagnose_build`**
   - Input: `{ focus?: string }` — optional focus area ("offense", "defense", "sustain", "balance")
   - Runs a comprehensive analysis using get_stats, list_equipped_items, list_skill_groups, and get_passive_tree:
     - Identifies the weakest defensive layer (low res, no spell suppress, low EHP, poor sustain)
     - Identifies DPS bottlenecks (low crit chance with no resolute technique, low gem levels, weak supports)
     - Checks for common mistakes (unlinked gems, wrong gem tags, overcapped res by large margins, wasted stats)
     - Checks for missing quality-of-life (no movement skill, no guard skill, no curse setup)
   - Returns: prioritized list of issues with severity ratings
   - This is a READ-ONLY tool — it does not modify the build, so no snapshot/restore needed

   **Tool: `suggest_upgrades`**
   - Input: `{ budget?: string, slot?: string }` — optional budget range ("low" = <50c, "medium" = 1-5 div, "high" = 5+ div), optional specific slot to focus on
   - Analyzes current gear and identifies which slot upgrades would give the biggest improvement
   - For each slot, uses unequip_item (via withTemporaryChange) to measure how much value the current item provides — slots where the current item provides the least are the best upgrade candidates
   - For each suggested slot:
     - Explains what mods to look for
     - Estimates the stat improvement
     - Notes the priority relative to other slots
   - Does NOT search trade sites (no API access) — instead describes what the ideal item looks like
   - **Build-archetype awareness:** The tool should recognize the build's scaling mechanics. For example, for an Archmage build, +mana, mana regen, and mana cost mods are offensive stats. For a minion build, minion damage/speed mods matter. Infer this from the active skills and support gems.

   **Tool: `export_build`**
   - Input: `{ format?: string }` — "xml", "code", or "summary"
   - Returns the current build state (with any modifications made during the session) as:
     - Raw XML (read from the Lua engine)
     - Encoded build code (XML → zlib deflate → base64, all done in TypeScript since Lua's Deflate is stubbed)
     - Human-readable summary
   - The "code" format produces a string that can be imported back into PoB desktop

   **Tool: `snapshot_and_compare`**
   - Input: `{ label?: string }`
   - Takes a labeled snapshot of current stats via BuildSession.takeSnapshot()
   - Can compare against previous snapshots via BuildSession.diffSnapshots() to see cumulative impact of multiple changes
   - Useful for "I've swapped 3 items and 5 passives — what's the total impact?"

### Notes:
- diagnose_build and suggest_upgrades call other tools internally. They must respect the serial lock — all sub-operations go through BuildSession.
- Keep the advice actionable and specific — reference exact passive node names, exact mod tiers, exact gem names.
```

---

## Phase 8: Polish, Error Handling, and Documentation

```
Final pass: harden the MCP server for real-world use.

### Requirements:

1. **Error handling throughout:**
   - Graceful handling of invalid build codes (bad base64, corrupt zlib, malformed XML)
   - Timeout protection on Lua calcs (cap at 30 seconds per operation, 120 seconds for batch operations like find_best_next_nodes)
   - Clear error messages when items can't be parsed, passives can't be found, gem names don't match, etc.
   - Recovery from Lua engine crashes — detect process exit, auto-restart on the next command, reload the last build if one was active
   - Handle the case where frame pump doesn't converge (calcs stuck in a loop) — timeout and report

2. **State management verification:**
   - Verify that BuildSession's snapshot/restore cycle is fully clean — after every withTemporaryChange(), the build stats should match the pre-change values exactly. Add assertions for this in tests.
   - Verify the undo stack works across multiple operations
   - Verify resetBuild() fully restores original state (not just stats, but items, tree, config, gems)
   - Stress test: load build → make 20 sequential changes with undo → verify final state matches original

3. **Performance:**
   - Profile the Lua bridge — how long does a single frame pump + stat read take? Log timing data.
   - Profile find_best_next_nodes and find_optimal_links — report total time and per-iteration time
   - If batch operations are slow (>60s), implement progress reporting via MCP's progress notification mechanism
   - Consider whether stat reads can skip the frame pump if no mutation occurred since the last pump (optimization — only if safe)

4. **Documentation:**
   - Update README.md with full setup instructions:
     - Prerequisites (Node.js version, LuaJIT version, PoB repo clone)
     - Build steps (npm install, npm run build)
     - How to register with Claude Desktop (claude_desktop_config.json entry)
     - How to register with claude.ai (if MCP connector support is available)
   - Document all tools with input/output examples
   - Add a TROUBLESHOOTING.md for common issues:
     - Wrong LuaJIT version
     - Missing data files / path resolution failures
     - Inflate/Deflate errors (are we handling build codes in TS?)
     - Lua engine crashes on specific builds
     - Timeout on complex tree operations

5. **MCP server manifest:**
   - Proper tool descriptions that give Claude enough context to use them effectively
   - Parameter descriptions with examples and valid values (especially slot names, stat names, config keys)
   - Return type documentation
   - Flag which tools are read-only vs. mutating

6. **Test suite:**
   - At least one test per tool using a known build
   - A regression test that loads a build, makes changes, and verifies the stat diffs are reasonable
   - A snapshot/restore integrity test (change → restore → verify stats match exactly)
   - An error handling test (bad inputs, Lua crashes, timeouts)
   - A concurrency test (multiple rapid tool calls — verify the serial lock prevents corruption)
```

---

## Appendix A: Key PoB Concepts for Reference

When working with the engine, these PoB-specific concepts matter:

- **Build code**: Base64-encoded, zlib-compressed XML. **Decoding must happen in TypeScript** because the headless wrapper stubs Inflate/Deflate. PoB can also import from pastebin URLs — **fetching must happen in TypeScript** because lcurl is disabled.
- **Frame pump**: `runCallback("OnFrame")` must be called after any mutation and before any stat read. Without it, outputs reflect the previous state. This is the single most important constraint.
- **Output table replacement**: `calcs.perform()` and `CalcsTabClass:BuildOutput()` replace the output table objects entirely. Never hold a reference to `mainOutput` across a frame pump — re-read from `build.calcsTab.mainOutput` each time.
- **Skill groups**: Each socket group in gear is a "skill group" with active + support gems. One is marked as the "main skill" for DPS display.
- **Item slots**: Weapon 1, Weapon 2 (or Weapon 1 Swap/Weapon 2 Swap), Helmet, Body Armour, Gloves, Boots, Amulet, Ring 1, Ring 2, Belt, Flask 1-5, and Jewels (many slots).
- **Calcs table**: The engine produces a giant table of calculated stats. Key fields include `CombinedDPS`, `TotalEHP`, `Life`, `EnergyShield`, `Mana`, `Str`/`Dex`/`Int`, `FireResist`, `ColdResist`, `LightningResist`, `ChaosResist`, etc.
- **Config options**: A table of settings that affect calcs — enemy type (normal/boss/shaper), whether flasks are active, charge generation, conditional buffs, etc. **Config input is aliased** — mutating `configTab.input` mutates the active config set in place. Always deep-copy before modifying.
- **Passive tree**: A graph of nodes. Each node has stats, a position, and connections. Some are keystones (major tradeoffs), notables (strong passives), or small nodes (travel/minor stats). **Tree loading is deferred after items** — never reload the tree from scratch during simulations. **Jewel radii are global** — avoid allocating/deallocating jewel sockets in automated scans.
- **Global singleton**: The build object, main object, and launch object are all global. Only one build can be active at a time. All operations must be serial.

## Appendix B: PoB Engine Constraints Quick Reference

| Constraint | Impact | Mitigation |
|---|---|---|
| Inflate/Deflate stubbed | Can't decode build codes in Lua | Decode in TypeScript (zlib + base64) |
| lcurl disabled | Can't fetch URLs in Lua | Fetch in TypeScript (Node fetch) |
| Path functions return "" | Data files may not load | Override in bridge.lua with real repo path |
| Frame pump required | Stale stats without it | Pump after every mutation, before every read |
| Output tables replaced | Old references go stale | Re-read from build.calcsTab after each pump |
| Config input aliased | Mutates config set in place | Deep-copy before modification, restore after |
| Tree deferred after items | Reloading tree can corrupt state | Mutate tree in place, never reload |
| Jewel radii global | Jewel socket changes corrupt data | Skip jewel sockets in automated scans |
| Single global build | No concurrency possible | Serial lock in BuildSession |
