# Phase 3: Item Comparison and Swap Tools — Implementation Plan

## Goal
Add MCP tools for equipping, unequipping, swapping, and comparing items — all using BuildSession's `withTemporaryChange()` for safe state restoration.

## Prerequisites
- Phase 2 complete: MCP server running with load_build, get_stats, get_skill_breakdown, list_equipped_items.
- BuildSession has working snapshot/restore for items.

---

## Step 1: Verify and Extend Lua-side Item Commands

### 1.1 Verify existing commands from Phase 1.5
These should already exist in bridge.lua from Phase 1.5:
- `getItemInSlot` — returns item text/mods for a slot
- `equipItem` — parses item text, equips to slot, pumps frame
- `unequipItem` — clears a slot, pumps frame

### 1.2 Understand PoB's item text format
PoB items use a multi-line text format (from Item.lua `ParseRaw` method at line 55):
```
Rarity: RARE
Doom Knuckle
Opal Ring
Crafted: true
Prefix: {range:0.5}IncreasedElementalDamage4
Prefix: {range:0.5}IncreasedCritChance3
Suffix: {range:0.5}IncreasedAccuracyRating4
Implicits: 1
{tags:jewellery_elemental,default}(15-25)% increased Elemental Damage
{tags:jewellery_caster,default}(25-30)% increased Critical Strike Chance
{tags:jewellery_attack,default}+(350-400) to Accuracy Rating
```

But the more common "copy-paste from trade" format is also supported:
```
Rarity: Rare
Doom Knuckle
Opal Ring
--------
Requirements:
Level: 80
--------
Implicits: 1
25% increased Elemental Damage
--------
30% increased Critical Strike Chance
+380 to Accuracy Rating
```

The `CreateDisplayItemFromRaw(rawText)` method (ItemsTab.lua) handles both formats.

### 1.3 Slot name validation
Valid slot names from ItemsTab.lua line 33 (`baseSlots`):
```lua
"Weapon 1", "Weapon 2",
"Helmet", "Body Armour", "Gloves", "Boots",
"Amulet", "Ring 1", "Ring 2", "Ring 3", "Belt",
"Graft 1", "Graft 2",
"Flask 1", "Flask 2", "Flask 3", "Flask 4", "Flask 5"
```
Plus dynamically-created jewel slots: `"Jewel 1"` through `"Jewel N"` (created based on allocated jewel socket nodes in the tree).

Add a `getValidSlots` command to bridge.lua that returns all currently valid slot names (including active jewel slots).

### 1.4 Enhance `equipItem` for slot assignment
The current `equipItem` needs to:
1. Call `build.itemsTab:CreateDisplayItemFromRaw(itemText)` to parse
2. Call `build.itemsTab:AddDisplayItem()` to add to item list
3. **Assign to the correct slot**: Set `build.itemsTab.slots[slot].selItemId` to the new item's ID
4. Set `build.buildFlag = true`
5. Pump frame

Key detail: After `AddDisplayItem()`, the new item gets an ID in `build.itemsTab.items`. We need to find the just-added item's ID and assign it to the slot.

---

## Step 2: Implement Tool — `swap_item`

### 2.1 BuildSession method

```typescript
async swapItem(slot: string, itemText: string): Promise<StatDiff> {
  return this.withLock(async () => {
    await this.pushUndo(); // Save undo point before mutation
    
    const statsBefore = await this.bridge.send({ cmd: 'getStats' });
    await this.bridge.send({ cmd: 'equipItem', slot, itemText });
    const statsAfter = await this.bridge.send({ cmd: 'getStats' });
    
    return {
      before: statsBefore,
      after: statsAfter,
      diff: computeDiff(statsBefore, statsAfter)
    };
  });
}
```

Note: `swap_item` is a **permanent mutation** (unlike `compare_items`). It changes the build state and pushes to the undo stack. The user can undo via `undoLastChange()`.

### 2.2 MCP tool definition

```typescript
server.tool(
  'swap_item',
  `Equip a new item in a slot and show the stat impact. This PERMANENTLY changes the build state (use undo to revert).
  
Valid slots: "Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Ring 3", "Belt", "Flask 1"-"Flask 5", "Jewel 1"-"Jewel N".

Item text format: paste the item as shown in PoB or trade sites — include rarity, name, base type, and all mods.`,
  {
    slot: { type: 'string', description: 'Equipment slot name' },
    itemText: { type: 'string', description: 'Full item text in PoB format' }
  },
  async ({ slot, itemText }) => {
    const result = await session.swapItem(slot, itemText);
    return formatStatDiffResponse(result);
  }
);
```

### 2.3 Response formatting

```typescript
function formatStatDiffResponse(result: { before: Stats, after: Stats, diff: StatDiff }) {
  const lines: string[] = [];
  
  // Group diffs by category
  for (const [cat, keys] of Object.entries(STAT_CATEGORIES)) {
    const catDiffs = keys.filter(k => result.diff[k]);
    if (catDiffs.length === 0) continue;
    
    lines.push(`\n### ${cat.toUpperCase()}`);
    for (const key of catDiffs) {
      const d = result.diff[key];
      const sign = d.delta > 0 ? '+' : '';
      lines.push(`${key}: ${d.before} → ${d.after} (${sign}${d.delta})`);
    }
  }
  
  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
}
```

---

## Step 3: Implement Tool — `compare_items`

### 3.1 BuildSession method — strictly serial comparison

```typescript
async compareItems(slot: string, items: string[]): Promise<ComparisonResult> {
  return this.withLock(async () => {
    // Get baseline stats (current item)
    const baselineStats = await this.bridge.send({ cmd: 'getStats' });
    const currentItem = await this.bridge.send({ cmd: 'getItemInSlot', slot });
    
    const results: Array<{ itemText: string; stats: Stats; diff: StatDiff }> = [];
    
    // Test each candidate SEQUENTIALLY
    for (const candidateText of items) {
      const candidateResult = await this.withTemporaryChange(
        async () => {
          await this.bridge.send({ cmd: 'equipItem', slot, itemText: candidateText });
        },
        async () => {
          // Read stats IMMEDIATELY after frame pump — output tables go stale
          return await this.bridge.send({ cmd: 'getStats' });
        }
      );
      
      results.push({
        itemText: candidateText,
        stats: candidateResult,
        diff: computeDiff(baselineStats, candidateResult)
      });
    }
    
    return {
      baseline: { item: currentItem, stats: baselineStats },
      candidates: results,
      bestForDPS: findBest(results, 'CombinedDPS'),
      bestForEHP: findBest(results, 'TotalEHP'),
    };
  });
}
```

### 3.2 Critical: withTemporaryChange guarantees cleanup

Each candidate runs inside `withTemporaryChange()`:
1. **Snapshot** the current item in the slot
2. **Equip** the candidate
3. **Pump frame** (inside the equipItem command)
4. **Read stats** immediately (output tables are replaced on next recalc — CalcsTab.lua:420-451)
5. **Restore** the original item in a `finally` block
6. **Pump frame** again after restore

Even if step 2, 3, or 4 throws an error, the restore in step 5 still runs.

### 3.3 MCP tool definition

```typescript
server.tool(
  'compare_items',
  `Compare 2-5 candidate items in a slot against the currently equipped item. Shows stat diffs for each candidate and identifies the best for DPS and EHP.
  
Each comparison is done sequentially with full state restoration — the build returns to its original state after comparison.

Valid slots: "Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Ring 3", "Belt", "Flask 1"-"Flask 5".`,
  {
    slot: { type: 'string', description: 'Equipment slot to compare in' },
    items: { 
      type: 'array', 
      items: { type: 'string' },
      description: 'Array of 2-5 item texts to compare (PoB format)'
    }
  },
  async ({ slot, items }) => {
    if (items.length < 2 || items.length > 5) {
      return { content: [{ type: 'text', text: 'Provide 2-5 items to compare.' }], isError: true };
    }
    const result = await session.compareItems(slot, items);
    return formatComparisonResponse(result);
  }
);
```

### 3.4 Comparison response formatting

```typescript
function formatComparisonResponse(result: ComparisonResult) {
  const lines: string[] = ['## Item Comparison\n'];
  lines.push(`**Current item:** ${result.baseline.item?.name ?? '(empty)'}\n`);
  
  for (let i = 0; i < result.candidates.length; i++) {
    const c = result.candidates[i];
    lines.push(`### Candidate ${i + 1}`);
    // Show key stat deltas
    const dpsChange = c.diff['CombinedDPS'];
    const ehpChange = c.diff['TotalEHP'];
    if (dpsChange) lines.push(`  DPS: ${dpsChange.delta > 0 ? '+' : ''}${dpsChange.delta}`);
    if (ehpChange) lines.push(`  EHP: ${ehpChange.delta > 0 ? '+' : ''}${ehpChange.delta}`);
    // Add other significant changes
  }
  
  lines.push(`\n**Best for DPS:** Candidate ${result.bestForDPS + 1}`);
  lines.push(`**Best for EHP:** Candidate ${result.bestForEHP + 1}`);
  
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
```

---

## Step 4: Implement Tool — `unequip_item`

### 4.1 BuildSession method

```typescript
async unequipItem(slot: string): Promise<StatDiff> {
  return this.withLock(async () => {
    await this.pushUndo();
    
    const statsBefore = await this.bridge.send({ cmd: 'getStats' });
    await this.bridge.send({ cmd: 'unequipItem', slot });
    const statsAfter = await this.bridge.send({ cmd: 'getStats' });
    
    return {
      before: statsBefore,
      after: statsAfter,
      diff: computeDiff(statsBefore, statsAfter)
    };
  });
}
```

### 4.2 MCP tool definition

```typescript
server.tool(
  'unequip_item',
  'Remove the item from a slot and show the stat impact. This PERMANENTLY changes the build (use undo to revert).',
  {
    slot: { type: 'string', description: 'Equipment slot to clear' }
  },
  async ({ slot }) => {
    const result = await session.unequipItem(slot);
    return formatStatDiffResponse(result);
  }
);
```

---

## Step 5: Implement Tool — `get_item_in_slot`

### 5.1 MCP tool definition

```typescript
server.tool(
  'get_item_in_slot',
  'Get the full item text and parsed mods for whatever is equipped in a slot.',
  {
    slot: { type: 'string', description: 'Equipment slot to inspect' }
  },
  async ({ slot }) => {
    const item = await session.getItemInSlot(slot);
    if (!item) {
      return { content: [{ type: 'text', text: `Slot "${slot}" is empty.` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(item, null, 2) }] };
  }
);
```

---

## Step 6: Testing

### 6.1 Test cases
1. **swap_item**: Load build → swap weapon → verify DPS changed → undo → verify DPS restored
2. **compare_items with 3 candidates**: Verify all 3 produce different stat diffs, build state unchanged after
3. **compare_items state safety**: After comparison, verify current stats exactly match pre-comparison stats
4. **unequip_item**: Remove ring → verify defense stats dropped → undo → verify restored
5. **get_item_in_slot**: Verify each occupied slot returns item data, empty slots return null
6. **Invalid slot name**: Pass "Nonexistent Slot" → verify clean error
7. **Malformed item text**: Pass garbage item text → verify error doesn't crash engine
8. **compare_items with error mid-comparison**: Force an error on candidate 3 of 5 → verify build state still restored

### 6.2 State integrity assertion
After every compare_items test, add:
```typescript
const statsAfterComparison = await session.getStats();
assert.deepEqual(statsAfterComparison, statsBeforeComparison);
```

---

## Key Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Item text parsing fails for trade-site format | Test with multiple formats; PoB's ParseRaw handles many variants |
| Slot name mismatch between MCP tool and PoB internals | Use getValidSlots command; validate slot name before operations |
| compare_items leaves orphaned items in item list | Track item IDs created during comparison, clean up in restore |
| Large item mod lists overflow JSON response | Limit to essential mod text; truncate if over threshold |
| Weapon swap slots (Weapon 1 Swap, Weapon 2 Swap) | Document swap slots separately; they only active when weapon swap set is selected |

---

## Definition of Done
- [ ] `swap_item` equips items and returns accurate before/after stat diffs
- [ ] `compare_items` tests 2-5 candidates sequentially with full state restoration
- [ ] State after `compare_items` exactly matches state before (verified by assertion)
- [ ] `unequip_item` removes items and shows impact
- [ ] `get_item_in_slot` returns full item data or null for empty slots
- [ ] Undo works correctly after swap_item and unequip_item
- [ ] Error handling for invalid slots, malformed items, and mid-operation failures
- [ ] All tests pass
