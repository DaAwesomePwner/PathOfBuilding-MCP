# Phase 1.5: State Management Layer (BuildSession) — Implementation Plan

## Goal
Create a BuildSession class that wraps the Lua bridge and centralizes all PoB engine "gotcha" mitigations — serial execution, snapshot/restore, undo, and safe comparison patterns. Every MCP tool will call through this layer, never the raw bridge.

## Prerequisites
- Phase 1 complete: `lua-bridge.ts` operational, bridge.lua loading builds and returning stats.

---

## Step 1: Extend bridge.lua with State Manipulation Commands

Before building BuildSession in TypeScript, we need the Lua side to support the state mutations that BuildSession will orchestrate.

### 1.1 New Lua commands to add to bridge.lua

**`getItemInSlot`** — `{"cmd": "getItemInSlot", "slot": "Weapon 1"}`
- Look up `build.itemsTab.slots[slot]` to find the slot control (ItemsTab.lua line 33 defines baseSlots)
- Get the item via `build.itemsTab.items[slotControl.selItemId]`
- Return the item's raw text representation and parsed mod list
- If slot is empty, return `{ok: true, item: null}`

**`equipItem`** — `{"cmd": "equipItem", "slot": "Ring 1", "itemText": "..."}`
- Parse the item text: `build.itemsTab:CreateDisplayItemFromRaw(itemText)` (pattern from TestAttacks_spec.lua)
- Add to items list: `build.itemsTab:AddDisplayItem()`
- Assign to slot: set the slot's selected item ID
- Set `build.buildFlag = true`
- Pump frame: `runCallback("OnFrame")`
- Return new stats

**`unequipItem`** — `{"cmd": "unequipItem", "slot": "Ring 1"}`
- Clear the slot's selected item
- Set `build.buildFlag = true`
- Pump frame, return stats

**`getAllocatedNodes`** — `{"cmd": "getAllocatedNodes"}`
- Iterate `build.spec.allocNodes`
- Return list of `{id, name, type, stats}` for each allocated node

**`allocNode`** / **`deallocNode`** — `{"cmd": "allocNode", "nodeId": 12345}`
- Call `build.spec:AllocNode(nodeId)` or `build.spec:DeallocNode(nodeId)` (PassiveSpec.lua)
- Set `build.buildFlag = true`
- Pump frame, return stats

**`getReachableNodes`** — `{"cmd": "getReachableNodes"}`
- Find all unallocated nodes that are adjacent to currently allocated nodes
- For each node in `build.spec.nodes`, check if any of its linked nodes are in `build.spec.allocNodes`
- Return list with id, name, type, stats granted

**`getSocketGroups`** — `{"cmd": "getSocketGroups"}`
- Iterate `build.skillsTab.socketGroupList`
- For each group, return: label, slotName, enabled, list of gems (name, level, quality)
- Identify main skill group

**`setGem`** — `{"cmd": "setGem", "groupIndex": 0, "gemIndex": 0, "gemName": "...", "level": 20, "quality": 20}`
- Modify the gem in the specified socket group
- Set `build.buildFlag = true`, pump frame

**`getFullConfig`** — `{"cmd": "getFullConfig"}`
- Dump `build.configTab.input` as JSON

**`setConfig`** — `{"cmd": "setConfig", "options": {...}}`
- Set each key in `build.configTab.input`
- Call `build.configTab:BuildModList()` (line 154)
- Set `build.buildFlag = true`, pump frame

**`exportXML`** — `{"cmd": "exportXML"}`
- Call `build:SaveDB("exported")` or serialize the current build state to XML
- Return the XML string

**`getBuildInfo`** — `{"cmd": "getBuildInfo"}`
- Return: class, ascendancy, level, bandit, pantheon, main skill name, league/version

---

## Step 2: Create `src/build-session.ts`

### 2.1 Serial Execution Lock

```typescript
class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    return new Promise(resolve => {
      const tryAcquire = () => {
        if (!this.locked) {
          this.locked = true;
          resolve(() => {
            this.locked = false;
            if (this.queue.length > 0) {
              this.queue.shift()!();
            }
          });
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }
}
```

- Wrap every public method of BuildSession with the mutex:
  ```typescript
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.mutex.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
  ```

### 2.2 Build Loading Pipeline

```typescript
class BuildSession {
  private bridge: LuaBridge;
  private mutex = new AsyncMutex();
  private originalXML: string | null = null;
  private buildInfo: BuildInfo | null = null;

  async loadBuild(source: string): Promise<BuildInfo> {
    return this.withLock(async () => {
      let xml: string;
      
      if (source.startsWith('http://') || source.startsWith('https://')) {
        // URL → fetch → extract build code → decode
        xml = await this.bridge.loadBuildFromURL(source);
      } else if (source.startsWith('<?xml') || source.startsWith('<PathOfBuilding')) {
        // Raw XML
        xml = source;
      } else {
        // Assume build code (base64 string)
        xml = decodeBuildCode(source);
      }
      
      this.originalXML = xml;
      const info = await this.bridge.loadBuildXML(xml);
      this.buildInfo = info;
      this.undoStack = [];
      this.snapshots.clear();
      return info;
    });
  }
}
```

### 2.3 Snapshot & Restore System

**Snapshot types** — each captures a specific part of build state via Lua bridge commands:

```typescript
interface ItemSnapshot {
  slot: string;
  itemText: string | null; // null if slot was empty
  itemId: number | null;
}

interface TreeSnapshot {
  allocatedNodeIds: number[];
}

interface ConfigSnapshot {
  input: Record<string, any>; // Deep copy of configTab.input
}

interface FullSnapshot {
  items: Map<string, ItemSnapshot>;
  tree: TreeSnapshot;
  config: ConfigSnapshot;
  stats: Stats;
}
```

**Implementation**:
```typescript
async snapshotSlot(slot: string): Promise<ItemSnapshot> {
  const item = await this.bridge.send({ cmd: 'getItemInSlot', slot });
  return { slot, itemText: item.rawText, itemId: item.id };
}

async restoreSlot(snapshot: ItemSnapshot): Promise<void> {
  if (snapshot.itemText) {
    await this.bridge.send({ cmd: 'equipItem', slot: snapshot.slot, itemText: snapshot.itemText });
  } else {
    await this.bridge.send({ cmd: 'unequipItem', slot: snapshot.slot });
  }
  // Frame pump happens inside the Lua command
}

async snapshotTree(): Promise<TreeSnapshot> {
  const nodes = await this.bridge.send({ cmd: 'getAllocatedNodes' });
  return { allocatedNodeIds: nodes.map((n: any) => n.id) };
}

async snapshotConfig(): Promise<ConfigSnapshot> {
  const config = await this.bridge.send({ cmd: 'getFullConfig' });
  // Deep copy — config input is aliased in PoB (ConfigTab.lua:983-985)
  return { input: JSON.parse(JSON.stringify(config)) };
}
```

**Restore tree** — compare current allocations with snapshot, deallocate extras, allocate missing:
```typescript
async restoreTree(snapshot: TreeSnapshot): Promise<void> {
  const current = await this.bridge.send({ cmd: 'getAllocatedNodes' });
  const currentIds = new Set(current.map((n: any) => n.id));
  const targetIds = new Set(snapshot.allocatedNodeIds);
  
  // Deallocate nodes not in target
  for (const id of currentIds) {
    if (!targetIds.has(id)) {
      await this.bridge.send({ cmd: 'deallocNode', nodeId: id });
    }
  }
  // Allocate nodes missing from current
  for (const id of targetIds) {
    if (!currentIds.has(id)) {
      await this.bridge.send({ cmd: 'allocNode', nodeId: id });
    }
  }
  // Single frame pump after all mutations
  await this.bridge.send({ cmd: 'getStats' }); // getStats always pumps
}
```

### 2.4 Safe Comparison Helper

```typescript
async withTemporaryChange<T>(
  changeFn: () => Promise<void>,
  readFn: () => Promise<T>
): Promise<T> {
  // Snapshot all relevant state before change
  const snapshot = await this.snapshotAll();
  try {
    await changeFn();
    // Frame pump is expected inside changeFn or readFn
    return await readFn();
  } finally {
    await this.restoreAll(snapshot);
  }
}
```

Usage pattern (for item comparison):
```typescript
const result = await session.withTemporaryChange(
  async () => {
    await bridge.send({ cmd: 'equipItem', slot: 'Ring 1', itemText: candidateItem });
  },
  async () => {
    return await bridge.send({ cmd: 'getStats' });
  }
);
```

### 2.5 Labeled Snapshots

```typescript
private snapshots = new Map<string, { stats: Stats; timestamp: number }>();

async takeSnapshot(label: string): Promise<void> {
  const stats = await this.getStats();
  this.snapshots.set(label, { stats, timestamp: Date.now() });
}

getSnapshot(label: string): Stats | null {
  return this.snapshots.get(label)?.stats ?? null;
}

diffSnapshots(labelA: string, labelB: string): StatDiff {
  const a = this.snapshots.get(labelA)?.stats;
  const b = this.snapshots.get(labelB)?.stats;
  if (!a || !b) throw new Error(`Snapshot not found: ${!a ? labelA : labelB}`);
  return computeDiff(a, b);
}
```

**`computeDiff` helper**:
```typescript
function computeDiff(before: Stats, after: Stats): StatDiff {
  const diff: StatDiff = {};
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    const bVal = before[key] ?? 0;
    const aVal = after[key] ?? 0;
    if (bVal !== aVal) {
      diff[key] = { before: bVal, after: aVal, delta: aVal - bVal };
    }
  }
  return diff;
}
```

### 2.6 Undo Stack

```typescript
private undoStack: FullSnapshot[] = [];
private readonly MAX_UNDO = 20;

private async pushUndo(): Promise<void> {
  const snapshot = await this.snapshotAll();
  this.undoStack.push(snapshot);
  if (this.undoStack.length > this.MAX_UNDO) {
    this.undoStack.shift();
  }
}

async undoLastChange(): Promise<Stats> {
  const snapshot = this.undoStack.pop();
  if (!snapshot) throw new Error('Nothing to undo');
  await this.restoreAll(snapshot);
  return await this.getStats();
}
```

### 2.7 Reset

```typescript
async resetBuild(): Promise<BuildInfo> {
  if (!this.originalXML) throw new Error('No build loaded');
  return this.loadBuild(this.originalXML);
}
```

### 2.8 Build Metadata

```typescript
async getBuildInfo(): Promise<BuildInfo> {
  if (!this.buildInfo) throw new Error('No build loaded');
  return this.buildInfo;
}
```

Parse and cache after loading: class name (`build.className`), ascendancy (`build.ascendClassName`), level (`build.characterLevel`), main skill (first enabled socket group's active gem name).

---

## Step 3: Optimize Tree/Config Restore via Lua-side Batch Commands

The node-by-node restore approach from Step 2.3 could be slow for large tree diffs. Add batch Lua commands:

**`restoreTreeFromList`** — `{"cmd": "restoreTreeFromList", "nodeIds": [...]}`
- Calls `build.spec:ImportFromNodeList(...)` with the full node list
- Single frame pump at the end
- Much faster than individual alloc/dealloc calls

**`restoreConfig`** — `{"cmd": "restoreConfig", "input": {...}}`
- Overwrites `build.configTab.input` with the provided table
- Calls `build.configTab:BuildModList()`
- Single frame pump

These batch commands avoid multiple round-trips for restore operations.

---

## Step 4: Testing — `test/session-test.ts`

### Test cases:

1. **Load build**: Load a test build, verify `getBuildInfo()` returns correct class/ascendancy/level
2. **Get stats**: Verify stats contain expected keys with reasonable values
3. **Snapshot/restore item**:
   - Load build, record stats
   - Snapshot slot "Ring 1"
   - Equip a different ring
   - Verify stats changed
   - Restore snapshot
   - Verify stats match original exactly
4. **withTemporaryChange**:
   - Equip a different weapon inside withTemporaryChange
   - Verify the returned stats reflect the new weapon
   - After withTemporaryChange returns, verify current stats match pre-change values
5. **withTemporaryChange error safety**:
   - Throw an error inside changeFn
   - Verify restore still happens (finally block)
6. **Serial lock**:
   - Fire 5 concurrent `getStats()` calls
   - Verify all complete without error (serialized, not parallel)
   - Verify results are consistent
7. **Undo stack**:
   - Make 3 changes, undo each, verify state reverts correctly
8. **Reset build**:
   - Load build, make changes, reset
   - Verify all stats match original
9. **Labeled snapshots**:
   - Take snapshot "before"
   - Make changes
   - Take snapshot "after"
   - Diff them, verify deltas are correct

---

## Key Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| Snapshot stores serialized data, not Lua references | Lua output tables are replaced on recalc (CalcsTab.lua:420-451) — references go stale |
| Deep copy config snapshots in TypeScript | Config input is aliased to active config set (ConfigTab.lua:983-985) — must copy values, not reference |
| Batch restore commands in Lua | Avoid N round-trips for N-node tree restore; single IPC call + single frame pump |
| Undo stack stores full snapshots (not diffs) | Simpler implementation; optimize to lightweight diffs in Phase 8 if memory is a concern |
| All public methods go through withLock | PoB is a global singleton — concurrent mutations corrupt state |

---

## Definition of Done
- [ ] All Lua-side state manipulation commands implemented and tested
- [ ] BuildSession class with serial lock, snapshot/restore, withTemporaryChange, undo, reset
- [ ] Item swap round-trip: snapshot → change → verify change → restore → verify original
- [ ] Tree mutation round-trip: same pattern
- [ ] Config mutation round-trip: same pattern  
- [ ] Concurrent request serialization verified
- [ ] Undo stack works across multiple operations
- [ ] resetBuild fully restores original state
- [ ] All tests in `test/session-test.ts` pass
