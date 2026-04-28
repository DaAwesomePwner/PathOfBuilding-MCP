# Phase 8: Polish, Error Handling, and Documentation — Implementation Plan

## Goal
Harden the MCP server for real-world use: comprehensive error handling, state management verification, performance profiling, documentation, and a full test suite.

## Prerequisites
- All prior phases (1–7) complete with functional tools.

---

## Step 1: Error Handling Hardening

### 1.1 Build code validation layer

Add validation at the TypeScript boundary before anything reaches Lua:

```typescript
// src/validation.ts

function validateBuildCode(code: string): void {
  if (!code || code.trim().length === 0) {
    throw new UserError('Build code is empty');
  }
  // PoB build codes are base64 — check for valid characters
  const base64Pattern = /^[A-Za-z0-9+/=_-]+$/;
  if (!base64Pattern.test(code.trim())) {
    throw new UserError('Invalid build code — contains non-base64 characters');
  }
}

function validateXML(xml: string): void {
  if (!xml.includes('<PathOfBuilding')) {
    throw new UserError('Invalid XML — missing <PathOfBuilding> root element');
  }
}

function validateSlotName(slot: string, validSlots: string[]): void {
  if (!validSlots.includes(slot)) {
    throw new UserError(
      `Invalid slot "${slot}". Valid slots: ${validSlots.join(', ')}`
    );
  }
}

class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}
```

### 1.2 Lua bridge timeout protection

Enhance `LuaBridge.send()` with configurable timeouts:

```typescript
async send(command: object, timeoutMs?: number): Promise<any> {
  const timeout = timeoutMs ?? this.defaultTimeout;
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `Lua bridge timeout after ${timeout}ms on command: ${JSON.stringify(command).slice(0, 100)}`
      ));
      // Don't kill the process — it may still be computing
      // But mark it as potentially stuck
      this.possiblyStuck = true;
    }, timeout);
    
    // ... existing send logic ...
  });
}
```

**Timeout values by operation type:**

| Operation | Timeout |
|-----------|---------|
| Default (single command) | 30,000ms |
| Batch scan (find_best_next_nodes) | 120,000ms |
| find_optimal_links | 180,000ms |
| loadXML (large builds) | 60,000ms |

### 1.3 Lua engine crash recovery

```typescript
// In LuaBridge class
private lastLoadedXML: string | null = null;
private crashCount = 0;
private readonly MAX_CRASHES = 3;

private handleProcessExit(code: number | null, signal: string | null): void {
  this.process = null;
  this.possiblyStuck = false;
  this.crashCount++;
  
  // Reject any pending command
  if (this.pendingResolve) {
    this.pendingReject(new Error(
      `Lua engine crashed (exit code: ${code}, signal: ${signal}). ` +
      `Crash #${this.crashCount}. Will auto-restart on next command.`
    ));
  }
}

async ensureRunning(): Promise<void> {
  if (this.process && !this.possiblyStuck) return;
  
  if (this.crashCount >= this.MAX_CRASHES) {
    throw new Error(
      `Lua engine has crashed ${this.crashCount} times. ` +
      `This build may be incompatible. Try a different build or restart the server.`
    );
  }
  
  // Kill stuck process if needed
  if (this.process && this.possiblyStuck) {
    this.process.kill('SIGKILL');
    this.process = null;
  }
  
  await this.spawn();
  
  // Reload the last build if one was active
  if (this.lastLoadedXML) {
    await this.send({ cmd: 'loadXML', xml: this.lastLoadedXML, name: 'Recovered build' });
  }
}
```

### 1.4 Frame pump convergence timeout

Add to bridge.lua — detect if frame pump doesn't converge:

```lua
local function safePumpFrame(maxAttempts)
  maxAttempts = maxAttempts or 3
  for i = 1, maxAttempts do
    runCallback("OnFrame")
    if not build.buildFlag then
      return true  -- Converged
    end
  end
  -- buildFlag still set after max attempts — warn but continue
  io.stderr:write("WARNING: Frame pump did not converge after " .. maxAttempts .. " attempts\n")
  return false
end
```

### 1.5 Wrap all MCP tools with error boundary

```typescript
function wrapTool(handler: ToolHandler): ToolHandler {
  return async (params) => {
    try {
      return await handler(params);
    } catch (error) {
      const message = error instanceof UserError
        ? error.message
        : `Internal error: ${error.message}. The build state may be corrupted — consider using reset_build.`;
      
      return {
        content: [{ type: 'text', text: message }],
        isError: true
      };
    }
  };
}
```

---

## Step 2: State Management Verification

### 2.1 Snapshot/restore integrity assertions

Add a debug mode that automatically verifies state after every `withTemporaryChange`:

```typescript
// In BuildSession
private debugMode = process.env.POB_DEBUG === '1';

async withTemporaryChange<T>(changeFn, readFn): Promise<T> {
  const snapshot = await this.snapshotAll();
  const statsBefore = this.debugMode ? await this.bridge.send({ cmd: 'getStats' }) : null;
  
  try {
    await changeFn();
    return await readFn();
  } finally {
    await this.restoreAll(snapshot);
    
    if (this.debugMode) {
      const statsAfter = await this.bridge.send({ cmd: 'getStats' });
      const drift = findStatDrift(statsBefore, statsAfter);
      if (drift.length > 0) {
        console.error(`STATE DRIFT after withTemporaryChange: ${JSON.stringify(drift)}`);
      }
    }
  }
}

function findStatDrift(before: Stats, after: Stats): string[] {
  const drifts: string[] = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    const b = before[key] ?? 0;
    const a = after[key] ?? 0;
    // Allow tiny floating point drift
    if (Math.abs(b - a) > 0.01) {
      drifts.push(`${key}: ${b} → ${a}`);
    }
  }
  return drifts;
}
```

### 2.2 Undo stack verification test

```typescript
// test/state-integrity-test.ts

async function testUndoStackIntegrity() {
  await session.loadBuild(testBuildCode);
  const originalStats = await session.getStats();
  
  // Make 20 sequential changes
  for (let i = 0; i < 20; i++) {
    await session.setConfig({ customMods: `+${i * 100} to Maximum Life` });
  }
  
  // Undo all 20
  for (let i = 0; i < 20; i++) {
    await session.undoLastChange();
  }
  
  const finalStats = await session.getStats();
  assertStatsMatch(originalStats, finalStats, 'Undo stack integrity failed');
}
```

### 2.3 Reset verification test

```typescript
async function testResetIntegrity() {
  await session.loadBuild(testBuildCode);
  const originalStats = await session.getStats();
  
  // Make diverse changes: item, tree, config, gem
  await session.swapItem('Ring 1', testRingText);
  // ... tree, config, gem changes ...
  
  await session.resetBuild();
  const resetStats = await session.getStats();
  
  assertStatsMatch(originalStats, resetStats, 'Reset integrity failed');
}
```

---

## Step 3: Performance Profiling

### 3.1 Timing infrastructure

```typescript
// src/timing.ts

class Timer {
  private static timings = new Map<string, number[]>();
  
  static start(label: string): () => void {
    const start = performance.now();
    return () => {
      const elapsed = performance.now() - start;
      const list = Timer.timings.get(label) ?? [];
      list.push(elapsed);
      Timer.timings.set(label, list);
      
      if (process.env.POB_TIMING === '1') {
        console.error(`[TIMING] ${label}: ${elapsed.toFixed(1)}ms`);
      }
    };
  }
  
  static report(): Record<string, { count: number; avg: number; min: number; max: number; total: number }> {
    const report: Record<string, any> = {};
    for (const [label, times] of Timer.timings) {
      report[label] = {
        count: times.length,
        avg: times.reduce((a, b) => a + b, 0) / times.length,
        min: Math.min(...times),
        max: Math.max(...times),
        total: times.reduce((a, b) => a + b, 0),
      };
    }
    return report;
  }
}
```

### 3.2 Instrument key operations

```typescript
// In LuaBridge.send()
async send(command: object, timeoutMs?: number): Promise<any> {
  const done = Timer.start(`bridge.${command.cmd}`);
  try {
    // ... existing logic ...
    return result;
  } finally {
    done();
  }
}

// In BuildSession iteration tools
async findBestNextNodes(...) {
  const totalDone = Timer.start('findBestNextNodes.total');
  // ...
  for (const node of candidates) {
    const iterDone = Timer.start('findBestNextNodes.iteration');
    // ... simulate node ...
    iterDone();
  }
  totalDone();
}
```

### 3.3 Frame pump skip optimization

If no mutation occurred since last pump, skip the redundant pump:

```typescript
// In BuildSession
private lastMutationTimestamp = 0;
private lastPumpTimestamp = 0;

private needsPump(): boolean {
  return this.lastMutationTimestamp > this.lastPumpTimestamp;
}

async getStats(): Promise<Stats> {
  // Only pump if there was a mutation since last pump
  if (this.needsPump()) {
    await this.bridge.send({ cmd: 'pumpFrame' });
    this.lastPumpTimestamp = Date.now();
  }
  return await this.bridge.send({ cmd: 'readStats' }); // Read-only, no pump
}
```

**Safety note**: Only enable this optimization after verifying that:
1. All mutation commands correctly update `lastMutationTimestamp`
2. No external state changes can make stats stale without a mutation
3. Tests pass with and without this optimization

### 3.4 Progress reporting for batch operations

Use MCP's progress notification mechanism:

```typescript
// For find_best_next_nodes
for (let i = 0; i < candidates.length; i++) {
  // Report progress if MCP supports it
  if (progressToken) {
    await server.notification({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: i,
        total: candidates.length,
      }
    });
  }
  // ... simulate node ...
}
```

---

## Step 4: Documentation

### 4.1 README.md — complete rewrite

```markdown
# Path of Building MCP Server

An MCP (Model Context Protocol) server that exposes Path of Building's 
calculation engine to Claude. Load PoB builds, analyze stats, compare 
items, optimize passive trees, and get upgrade advice — all through 
natural conversation.

## Prerequisites

- **Node.js** 18+ 
- **LuaJIT** (must be on PATH or set via LUAJIT_PATH env var)
- **Path of Building** repo cloned (this repo)

### Installing LuaJIT

**Windows**: Download from [LuaJIT website] or use the bundled runtime.
**macOS**: `brew install luajit`
**Linux**: `apt install luajit` or `pacman -S luajit`

## Setup

1. Install dependencies:
   ```bash
   cd mcp-server
   npm install
   ```

2. Build:
   ```bash
   npm run build
   ```

3. Test (optional):
   ```bash
   npm test
   ```

## Claude Desktop Integration

Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "pob": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/server.js"],
      "env": {
        "POB_PATH": "/absolute/path/to/PathOfBuilding"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| POB_PATH | Yes | — | Path to PathOfBuilding repo root |
| LUAJIT_PATH | No | "luajit" | Path to LuaJIT binary |
| POB_DEBUG | No | "0" | Enable debug assertions |
| POB_TIMING | No | "0" | Log operation timing |

## Available Tools

### Core
| Tool | Description | Mutates? |
|------|-------------|----------|
| load_build | Load a build from code, URL, or XML | Yes |
| get_stats | Get calculated stats | No |
| get_skill_breakdown | Detailed skill analysis | No |
| list_equipped_items | All items by slot | No |

### Items
| Tool | Description | Mutates? |
|------|-------------|----------|
| swap_item | Equip a new item | Yes |
| compare_items | Compare candidates (temporary) | No |
| unequip_item | Remove an item | Yes |
| get_item_in_slot | Inspect an equipped item | No |

### Passive Tree  
| Tool | Description | Mutates? |
|------|-------------|----------|
| get_passive_tree | List allocated passives | No |
| simulate_passive_change | Test node changes (temporary) | No |
| find_best_next_nodes | Rank reachable nodes | No |
| find_worst_allocated_nodes | Find least valuable nodes | No |
| evaluate_keystone | Test keystone toggle | No |

### Gems
| Tool | Description | Mutates? |
|------|-------------|----------|
| list_skill_groups | All socket groups | No |
| swap_gem | Test gem replacement (temporary) | No |
| compare_supports | Rank support candidates | No |
| find_optimal_links | Best support combination | No |
| evaluate_gem_levels | Gem level scaling curve | No |

### Config
| Tool | Description | Mutates? |
|------|-------------|----------|
| get_config | Read all config options | No |
| set_config | Change config options | Yes |
| simulate_scenario | Test combat presets (temporary) | No |
| compare_scenarios | Side-by-side scenarios | No |
| toggle_buffs | Test buff toggles (temporary) | No |

### Advisor
| Tool | Description | Mutates? |
|------|-------------|----------|
| diagnose_build | Identify weaknesses | No |
| suggest_upgrades | Prioritize gear slots | No |
| export_build | Export as code/XML/summary | No |
| snapshot_and_compare | Track cumulative changes | No |
| undo | Revert last mutation | Yes |
| reset_build | Full reset to original | Yes |
```

### 4.2 TROUBLESHOOTING.md

```markdown
# Troubleshooting

## "Lua engine crashed" / exit code non-zero

**Cause**: LuaJIT version mismatch or missing runtime files.
**Fix**: 
- Verify LuaJIT version: `luajit -v` (should be 2.1+)
- Ensure the `runtime/lua/` directory exists in the PoB repo
- Check POB_PATH points to repo root (not src/)

## "Data files failed to load" / empty tree/gem data

**Cause**: Path override functions returning wrong paths.
**Fix**:
- Verify POB_PATH is an absolute path
- Check that `src/Data/` directory exists with .lua files
- Enable debug: `POB_DEBUG=1` to see path resolution logs

## "Invalid build code" / zlib inflate errors

**Cause**: The build code may be truncated or corrupted.
**Fix**:
- Build codes should be long base64 strings (usually 500+ chars)
- Try the full code, not a URL — extract the code from pastebin first
- PoB uses raw deflate — our decoder tries both raw and standard inflate

## "Timeout" on tree/gem operations

**Cause**: Complex builds with many nodes take longer to simulate.
**Fix**:
- Reduce `count` parameter on find_best_next_nodes
- Use a simpler build for initial testing
- Check POB_TIMING=1 logs for per-operation timing

## Stat drift after withTemporaryChange

**Cause**: Snapshot/restore didn't fully capture state.
**Fix**:
- Enable POB_DEBUG=1 to log drift details
- Check if the drifting stats are config-dependent (config aliasing issue)
- File a bug with the drift log output

## "Serial lock timeout"

**Cause**: A previous operation is still running when a new one arrives.
**Fix**:
- This is expected for long operations (find_optimal_links)
- The second operation will wait and execute after the first completes
- If it never resolves, the Lua engine may be stuck — restart the server
```

---

## Step 5: MCP Server Manifest Polish

### 5.1 Tool descriptions with examples

Every tool definition should include:
- Clear description of what it does
- Whether it mutates build state
- Parameter examples with valid values
- Return type description

Example — enhance swap_item description:
```typescript
server.tool(
  'swap_item',
  `Equip a new item in a gear slot and show the stat impact (before/after comparison with deltas).

This PERMANENTLY changes the build state. Use "undo" to revert.

**Slot names**: "Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", 
"Amulet", "Ring 1", "Ring 2", "Ring 3", "Belt", "Flask 1"-"Flask 5", "Jewel 1"-"Jewel N"

**Item text format** (paste from PoB or trade site):
\`\`\`
Rarity: Rare
Doom Knuckle
Opal Ring
--------
25% increased Elemental Damage
--------
30% increased Critical Strike Chance
+380 to Accuracy Rating
\`\`\``,
  { /* ... params ... */ }
);
```

### 5.2 Annotate read-only vs mutating tools

Add a convention to tool names or descriptions:
- Read-only tools: description starts with "Get" / "List" / "Find" / "Analyze"
- Temporary mutation tools: description mentions "temporarily" and "restored after"
- Permanent mutation tools: description explicitly says "PERMANENTLY changes"

---

## Step 6: Test Suite

### 6.1 Test file structure

```
mcp-server/test/
  bridge-test.ts           — Phase 1: Lua bridge spawn, JSON-lines, build code decoding
  session-test.ts          — Phase 1.5: BuildSession lock, snapshot/restore, undo
  core-tools-test.ts       — Phase 2: load_build, get_stats, get_skill_breakdown, list_items
  item-tools-test.ts       — Phase 3: swap_item, compare_items, unequip_item
  tree-tools-test.ts       — Phase 4: get_tree, simulate_change, find_best/worst, keystone
  gem-tools-test.ts        — Phase 5: list_groups, swap_gem, compare_supports
  config-tools-test.ts     — Phase 6: get/set_config, simulate_scenario, toggle_buffs
  advisor-tools-test.ts    — Phase 7: diagnose, suggest_upgrades, export, snapshot
  state-integrity-test.ts  — Phase 8: snapshot/restore verification, undo stress test
  error-handling-test.ts   — Phase 8: bad inputs, crashes, timeouts
  concurrency-test.ts      — Phase 8: serial lock under concurrent requests
  fixtures/
    simple-build.xml       — Minimal valid build for fast tests
    complex-build.xml      — Full endgame build for thorough tests
```

### 6.2 Test runner setup

```json
// package.json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts"
  },
  "devDependencies": {
    "vitest": "^1.0.0"
  }
}
```

### 6.3 Key test cases by category

**Error handling tests:**
1. Bad base64 build code → clean error message
2. Corrupt zlib data → clean error message
3. Valid base64 but not a PoB build → clean error message
4. Empty string input → clean error message
5. Invalid slot name → lists valid slot names in error
6. Invalid gem name → clean error message
7. Lua engine killed mid-operation → auto-restart + reload build
8. Timeout on stuck calculation → error without crash

**State integrity tests:**
9. compare_items with 5 items → stats match exactly before and after
10. find_best_next_nodes full scan → stats match before and after
11. simulate_scenario → config matches before and after
12. 20 sequential swapItem + undo → final state matches original exactly
13. resetBuild after diverse changes → matches original exactly

**Concurrency tests:**
14. Fire 10 simultaneous getStats → all complete, no corruption
15. Fire 3 simultaneous swapItem → serial execution, correct final state
16. Fire compareItems during findBestNextNodes → second waits for first

**Regression tests:**
17. Load known build → verify specific stat values (e.g., CombinedDPS = X ± 1%)
18. Swap known item → verify DPS delta matches expected
19. Export build code → import back → verify stats match

---

## Step 7: Final Checklist

### Code quality
- [ ] All TypeScript strict mode errors resolved
- [ ] No `any` types except at Lua bridge boundary (incoming JSON)
- [ ] Error messages are user-friendly (no stack traces in MCP responses)
- [ ] All tools have proper parameter validation

### Robustness
- [ ] Lua engine crash recovery works (kill + restart + reload)
- [ ] Timeout protection on all bridge commands
- [ ] Serial lock prevents concurrent mutations
- [ ] withTemporaryChange always restores state (even on error)
- [ ] Frame pump convergence check prevents infinite loops

### Performance
- [ ] Single frame pump + stat read: <200ms
- [ ] load_build: <5s for typical builds
- [ ] find_best_next_nodes (50 candidates): <30s
- [ ] compare_items (5 items): <5s
- [ ] Frame pump skip optimization (optional): verified safe

### Documentation
- [ ] README.md with setup, Claude Desktop config, tool reference
- [ ] TROUBLESHOOTING.md with common issues and fixes
- [ ] All tool descriptions include examples and valid values
- [ ] Read-only vs mutating tools clearly labeled

### Tests
- [ ] At least one test per tool
- [ ] State integrity stress test (20 changes + undo)
- [ ] Error handling tests for all input validation
- [ ] Concurrency test for serial lock
- [ ] Regression test with known build stats

---

## Definition of Done
- [ ] All error paths produce user-friendly messages (no raw stack traces)
- [ ] Lua engine crash recovery works automatically
- [ ] State integrity verified: withTemporaryChange leaves zero drift
- [ ] Undo stack verified: 20 operations + undo all = original state
- [ ] Performance profiled: timing data for all key operations
- [ ] README.md complete with setup and tool reference
- [ ] TROUBLESHOOTING.md covers common failure modes
- [ ] Full test suite passes (unit, integration, error, concurrency)
- [ ] Server runs end-to-end with Claude Desktop
