# Phase 4: Passive Tree Analysis Tools — Implementation Plan

## Goal
Add MCP tools for inspecting, simulating, and optimizing the passive skill tree. These tools must respect PoB's constraints: never reload the tree from scratch, skip jewel sockets in automated scans, and run all simulations serially with frame pumps.

## Prerequisites
- Phase 3 complete: Item tools working, withTemporaryChange proven reliable.
- BuildSession has working tree snapshot/restore.

---

## Step 1: Extend Lua-side Tree Commands

### 1.1 Required bridge.lua commands

**`getAllocatedNodes`** (may already exist from Phase 1.5)
- Iterate `build.spec.allocNodes` (PassiveSpec.lua — `self.allocNodes` is a dict keyed by node ID)
- For each node, return: `{ id, name, type, stats, isKeystone, isNotable, isAscendancy, ascendancyName }`
- Node types: check `node.type` — values include "Normal", "Keystone", "Notable", "Socket" (jewel), "Mastery"
- Stats: serialize `node.sd` (stat descriptions) as an array of strings

**`getReachableNodes`**
- Find all unallocated nodes adjacent to allocated nodes:
  ```lua
  local reachable = {}
  for id, node in pairs(build.spec.nodes) do
    if not build.spec.allocNodes[id] and not node.isAscendancy then
      for _, linkedId in ipairs(node.linked or {}) do
        if build.spec.allocNodes[linkedId] then
          reachable[id] = node
          break
        end
      end
    end
  end
  ```
- Return each with: `{ id, name, type, stats, isKeystone, isNotable, isJewelSocket }`
- Flag jewel sockets (`node.type == "Socket"`) so TypeScript can skip them

**`allocNode`** — `{"cmd": "allocNode", "nodeId": 12345}`
- Calls `build.spec:AllocNode(node)` where `node = build.spec.nodes[nodeId]`
- Sets `build.buildFlag = true`
- Does NOT pump frame (caller controls when to pump — batch operations need pump only at end)

**`deallocNode`** — `{"cmd": "deallocNode", "nodeId": 12345}`
- Calls `build.spec:DeallocNode(node)`
- Sets `build.buildFlag = true`

**`allocNodes`** / **`deallocNodes`** — batch versions
- Accept array of node IDs
- Process all allocations/deallocations
- Single `build.buildFlag = true` at end
- More efficient for multi-node operations

**`isTreeConnected`** — `{"cmd": "isTreeConnected"}`
- Validates that all allocated nodes form a connected graph from the class start node
- Must account for: ascendancy nodes connecting through ascendancy start, cluster jewels having sub-graphs
- Returns `{ connected: boolean, orphanedNodes: number[] }`

**`getPassiveTreeSummary`** — `{"cmd": "getPassiveTreeSummary"}`
- Returns: total points allocated, ascendancy points used, max available points (based on level + quest rewards)
- List of active keystones
- Counts by node type (normal, notable, keystone, jewel socket, mastery)

**`getNodeInfo`** — `{"cmd": "getNodeInfo", "nodeId": 12345}` or `{"cmd": "getNodeInfo", "name": "Resolute Technique"}`
- Look up by ID or by name (search `build.spec.nodes` for matching `node.dn` display name)
- Return full node data: stats, position, type, linked nodes, whether allocated

---

## Step 2: Implement Tool — `get_passive_tree`

### 2.1 BuildSession method

```typescript
async getPassiveTree(): Promise<PassiveTreeInfo> {
  return this.withLock(async () => {
    const [allocated, summary] = await Promise.all([
      this.bridge.send({ cmd: 'getAllocatedNodes' }),
      this.bridge.send({ cmd: 'getPassiveTreeSummary' }),
    ]);
    // Note: These two reads are safe to "parallelize" in the Promise.all 
    // because they're both read-only and the serial lock on bridge.send() 
    // will serialize them anyway. But they don't need frame pumps between them.
    
    return {
      allocatedNodes: allocated,
      totalPointsUsed: summary.totalPoints,
      ascendancyPointsUsed: summary.ascendancyPoints,
      keystones: allocated.filter((n: any) => n.isKeystone),
      summary
    };
  });
}
```

### 2.2 MCP tool definition

```typescript
server.tool(
  'get_passive_tree',
  'Get all allocated passive nodes, total points used, active keystones, and ascendancy choices.',
  {},
  async () => {
    const tree = await session.getPassiveTree();
    return { content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }] };
  }
);
```

---

## Step 3: Implement Tool — `simulate_passive_change`

### 3.1 BuildSession method

```typescript
async simulatePassiveChange(
  allocate: (string | number)[] = [], 
  deallocate: (string | number)[] = []
): Promise<{ statDiff: StatDiff; valid: boolean; validationErrors: string[] }> {
  return this.withLock(async () => {
    // Resolve names to IDs if strings are passed
    const allocIds = await this.resolveNodeIds(allocate);
    const deallocIds = await this.resolveNodeIds(deallocate);
    
    const statsBefore = await this.bridge.send({ cmd: 'getStats' });
    
    const result = await this.withTemporaryChange(
      async () => {
        // Deallocate first (freeing points), then allocate
        if (deallocIds.length > 0) {
          await this.bridge.send({ cmd: 'deallocNodes', nodeIds: deallocIds });
        }
        if (allocIds.length > 0) {
          await this.bridge.send({ cmd: 'allocNodes', nodeIds: allocIds });
        }
        // Pump frame after all mutations
        await this.bridge.send({ cmd: 'getStats' }); // getStats always pumps
      },
      async () => {
        const statsAfter = await this.bridge.send({ cmd: 'getStats' });
        const validation = await this.bridge.send({ cmd: 'isTreeConnected' });
        return { statsAfter, validation };
      }
    );
    
    return {
      statDiff: computeDiff(statsBefore, result.statsAfter),
      valid: result.validation.connected,
      validationErrors: result.validation.connected ? [] : ['Tree is disconnected — orphaned nodes detected']
    };
  });
}

private async resolveNodeIds(refs: (string | number)[]): Promise<number[]> {
  const ids: number[] = [];
  for (const ref of refs) {
    if (typeof ref === 'number') {
      ids.push(ref);
    } else {
      // Look up by name
      const node = await this.bridge.send({ cmd: 'getNodeInfo', name: ref });
      if (!node) throw new Error(`Passive node not found: "${ref}"`);
      ids.push(node.id);
    }
  }
  return ids;
}
```

### 3.2 MCP tool definition

```typescript
server.tool(
  'simulate_passive_change',
  `Simulate allocating or deallocating passive nodes and show the stat impact. Changes are temporary — the tree is restored after simulation.
  
Accepts node names (e.g., "Resolute Technique", "Heart of Thunder") or node IDs. Validates that the resulting tree stays connected.`,
  {
    allocate: {
      type: 'array',
      items: { type: 'string' },
      description: 'Node names or IDs to allocate',
      optional: true
    },
    deallocate: {
      type: 'array',
      items: { type: 'string' },
      description: 'Node names or IDs to deallocate',
      optional: true
    }
  },
  async ({ allocate, deallocate }) => {
    const result = await session.simulatePassiveChange(allocate ?? [], deallocate ?? []);
    
    let text = '';
    if (!result.valid) {
      text += '⚠ WARNING: Resulting tree is disconnected!\n\n';
    }
    text += formatStatDiff(result.statDiff);
    
    return { content: [{ type: 'text', text }] };
  }
);
```

---

## Step 4: Implement Tool — `find_best_next_nodes`

### 4.1 BuildSession method — serial iteration with jewel socket skip

```typescript
async findBestNextNodes(
  count: number = 10,
  optimizeFor: string = 'CombinedDPS',
  includeJewelSockets: boolean = false
): Promise<NodeRanking[]> {
  return this.withLock(async () => {
    const reachable = await this.bridge.send({ cmd: 'getReachableNodes' });
    
    // Filter out jewel sockets unless explicitly requested
    let candidates = reachable.filter((n: any) => {
      if (!includeJewelSockets && n.isJewelSocket) return false;
      return true;
    });
    
    // Optional pre-filter: skip pure travel nodes (nodes with only +10 to a single attribute)
    // This optimization reduces iterations for large trees
    // candidates = candidates.filter(n => !isPureTravelNode(n));
    
    const baselineStats = await this.bridge.send({ cmd: 'getStats' });
    const baselineValue = baselineStats[optimizeFor] ?? 0;
    
    const rankings: NodeRanking[] = [];
    
    // STRICTLY SERIAL — one node at a time
    for (const node of candidates) {
      const nodeStats = await this.withTemporaryChange(
        async () => {
          await this.bridge.send({ cmd: 'allocNode', nodeId: node.id });
        },
        async () => {
          return await this.bridge.send({ cmd: 'getStats' });
        }
      );
      
      const targetValue = nodeStats[optimizeFor] ?? 0;
      const delta = targetValue - baselineValue;
      
      rankings.push({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        targetStat: optimizeFor,
        delta,
        tradeoffs: identifyTradeoffs(baselineStats, nodeStats, optimizeFor)
      });
    }
    
    // Sort by delta descending, return top N
    rankings.sort((a, b) => b.delta - a.delta);
    return rankings.slice(0, count);
  });
}
```

### 4.2 Tradeoff detection

```typescript
function identifyTradeoffs(
  before: Stats, after: Stats, primaryStat: string
): string[] {
  const tradeoffs: string[] = [];
  
  // Check if gaining primary stat comes at a defensive cost (or vice versa)
  const defensiveKeys = ['TotalEHP', 'Life', 'EnergyShield', 'Armour', 'Evasion'];
  const offensiveKeys = ['CombinedDPS', 'CritChance'];
  
  const checkKeys = primaryStat.includes('DPS') || primaryStat.includes('Crit')
    ? defensiveKeys  // If optimizing offense, flag defensive losses
    : offensiveKeys; // If optimizing defense, flag offensive losses
  
  for (const key of checkKeys) {
    const delta = (after[key] ?? 0) - (before[key] ?? 0);
    if (delta < 0) {
      tradeoffs.push(`${key}: ${delta}`);
    }
  }
  
  return tradeoffs;
}
```

### 4.3 Performance considerations
- Each candidate requires 2 frame pumps (alloc + restore)
- With 50 reachable nodes, that's 100 frame pumps
- Estimate ~50-100ms per frame pump → 5-10 seconds for 50 nodes
- If >30 seconds: report progress, consider batching results
- Add timeout per iteration (30s) and total timeout (120s)

### 4.4 MCP tool definition

```typescript
server.tool(
  'find_best_next_nodes',
  `Find the best unallocated passive nodes to take next, ranked by stat improvement.
  
Iterates all reachable (adjacent to allocated) nodes, simulates allocating each, and ranks by the specified stat. Skips jewel sockets by default (they can corrupt jewel radius state).

This operation may take 5-30 seconds depending on tree size.`,
  {
    count: { type: 'number', description: 'How many top candidates to return (default: 10)', optional: true },
    optimizeFor: { type: 'string', description: 'Stat to optimize: "CombinedDPS", "TotalEHP", "Life", "EnergyShield", "ManaRegen", etc. Default: "CombinedDPS"', optional: true },
    includeJewelSockets: { type: 'boolean', description: 'Include jewel sockets in scan (default: false — jewel radii are global state)', optional: true }
  },
  async ({ count, optimizeFor, includeJewelSockets }) => {
    const rankings = await session.findBestNextNodes(count ?? 10, optimizeFor ?? 'CombinedDPS', includeJewelSockets ?? false);
    return { content: [{ type: 'text', text: JSON.stringify(rankings, null, 2) }] };
  }
);
```

---

## Step 5: Implement Tool — `find_worst_allocated_nodes`

### 5.1 BuildSession method

```typescript
async findWorstAllocatedNodes(
  count: number = 10,
  optimizeFor: string = 'CombinedDPS'
): Promise<NodeRanking[]> {
  return this.withLock(async () => {
    const allocated = await this.bridge.send({ cmd: 'getAllocatedNodes' });
    const baselineStats = await this.bridge.send({ cmd: 'getStats' });
    const baselineValue = baselineStats[optimizeFor] ?? 0;
    
    // Filter: only test non-keystone, non-ascendancy nodes
    // Also skip nodes whose removal disconnects the tree
    const testable = allocated.filter((n: any) => 
      !n.isKeystone && !n.isAscendancy && n.type !== 'Socket'
    );
    
    const rankings: NodeRanking[] = [];
    
    for (const node of testable) {
      // Check if removal keeps tree connected
      const connectionCheck = await this.withTemporaryChange(
        async () => {
          await this.bridge.send({ cmd: 'deallocNode', nodeId: node.id });
        },
        async () => {
          const connected = await this.bridge.send({ cmd: 'isTreeConnected' });
          if (!connected.connected) return null; // Skip — can't remove without disconnecting
          return await this.bridge.send({ cmd: 'getStats' });
        }
      );
      
      if (!connectionCheck) continue; // Removal disconnects tree
      
      const targetValue = connectionCheck[optimizeFor] ?? 0;
      const loss = baselineValue - targetValue; // Positive = removing this node loses value
      
      rankings.push({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        targetStat: optimizeFor,
        delta: -loss, // Negative delta = you lose this much by removing
        lossIfRemoved: loss,
      });
    }
    
    // Sort by loss ascending — least valuable nodes first
    rankings.sort((a, b) => a.lossIfRemoved - b.lossIfRemoved);
    return rankings.slice(0, count);
  });
}
```

### 5.2 MCP tool definition

```typescript
server.tool(
  'find_worst_allocated_nodes',
  `Find the least valuable currently-allocated passive nodes. Simulates removing each non-keystone node (only if removal keeps the tree connected) and ranks by how little value they provide.

Useful for identifying dead travel nodes or inefficient pathing.`,
  {
    count: { type: 'number', description: 'How many worst nodes to return (default: 10)', optional: true },
    optimizeFor: { type: 'string', description: 'Stat to evaluate value by (default: "CombinedDPS")', optional: true }
  },
  async ({ count, optimizeFor }) => {
    const rankings = await session.findWorstAllocatedNodes(count ?? 10, optimizeFor ?? 'CombinedDPS');
    return { content: [{ type: 'text', text: JSON.stringify(rankings, null, 2) }] };
  }
);
```

---

## Step 6: Implement Tool — `evaluate_keystone`

### 6.1 BuildSession method

```typescript
async evaluateKeystone(keystoneName: string): Promise<KeystoneEvaluation> {
  return this.withLock(async () => {
    const node = await this.bridge.send({ cmd: 'getNodeInfo', name: keystoneName });
    if (!node) throw new Error(`Keystone not found: "${keystoneName}"`);
    if (!node.isKeystone) throw new Error(`"${keystoneName}" is not a keystone`);
    
    const isAllocated = node.isAllocated;
    const baselineStats = await this.bridge.send({ cmd: 'getStats' });
    
    const result = await this.withTemporaryChange(
      async () => {
        if (isAllocated) {
          await this.bridge.send({ cmd: 'deallocNode', nodeId: node.id });
        } else {
          // May need to allocate travel nodes to reach it
          // For simplicity, just allocate the keystone directly
          // (PoB allows direct keystone allocation via anointments/items)
          await this.bridge.send({ cmd: 'allocNode', nodeId: node.id });
        }
      },
      async () => {
        return await this.bridge.send({ cmd: 'getStats' });
      }
    );
    
    return {
      keystone: keystoneName,
      currentlyAllocated: isAllocated,
      action: isAllocated ? 'removed' : 'added',
      statDiff: computeDiff(baselineStats, result),
      nodeStats: node.stats
    };
  });
}
```

### 6.2 MCP tool definition

```typescript
server.tool(
  'evaluate_keystone',
  'Simulate toggling a keystone passive (add if not taken, remove if taken) and show the full stat impact.',
  {
    keystone: { type: 'string', description: 'Keystone name (e.g., "Resolute Technique", "Chaos Inoculation", "Mind Over Matter")' }
  },
  async ({ keystone }) => {
    const result = await session.evaluateKeystone(keystone);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);
```

---

## Step 7: Testing

### Test cases:
1. **get_passive_tree**: Load build, verify allocated nodes list is non-empty, point count matches level
2. **simulate_passive_change — allocate**: Allocate a notable, verify DPS increases, tree restored after
3. **simulate_passive_change — deallocate**: Remove a node, verify stats drop, tree restored
4. **simulate_passive_change — disconnected tree**: Try to remove a critical path node, verify validation error
5. **find_best_next_nodes**: Run scan, verify top node has positive DPS delta, verify build state unchanged after
6. **find_best_next_nodes — jewel socket skip**: Verify jewel sockets excluded by default
7. **find_worst_allocated_nodes**: Run scan, verify worst node has small loss value, build state unchanged
8. **evaluate_keystone**: Toggle a keystone, verify large stat swings (keystones are major tradeoffs)
9. **Performance**: Time `find_best_next_nodes` on a full build, log per-iteration and total time

---

## Key Constraints (from PoB architecture)

| Constraint | How we handle it |
|-----------|-----------------|
| Never reload tree from scratch | All tools mutate in place via AllocNode/DeallocNode — never call ImportFromNodeList during simulations |
| Tree loading deferred after items (Build.lua:632-657) | We never trigger a full tree reload; only point-wise mutations |
| Jewel radii are global (TreeTab.lua:543-546) | Skip jewel sockets in find_best/find_worst scans by default |
| Connected tree validation | isTreeConnected checks graph connectivity from class start; accounts for ascendancy sub-graph |
| Serial execution | All scans run inside withLock(); each iteration is sequential with frame pumps |
| Output tables replaced on recalc | Stats read immediately after frame pump inside withTemporaryChange |

---

## Definition of Done
- [ ] `get_passive_tree` returns all allocated nodes with metadata
- [ ] `simulate_passive_change` shows stat diffs and validates tree connectivity
- [ ] `find_best_next_nodes` ranks reachable nodes by chosen stat, skipping jewel sockets
- [ ] `find_worst_allocated_nodes` identifies least valuable allocated nodes
- [ ] `evaluate_keystone` simulates toggling keystones with full stat diff
- [ ] All simulations leave build state unchanged (verified by assertion)
- [ ] Performance is acceptable (<30s for typical tree scans)
- [ ] All tests pass
