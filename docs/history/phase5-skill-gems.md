# Phase 5: Skill Gem and Link Configuration Tools — Implementation Plan

## Goal
Add MCP tools for analyzing and modifying skill gem setups — listing socket groups, swapping individual gems, comparing support options, finding optimal link configurations, and evaluating gem level scaling.

## Prerequisites
- Phase 4 complete: Tree tools working, serial iteration patterns proven.
- BuildSession withTemporaryChange reliable for multi-iteration scans.

---

## Step 1: Extend Lua-side Gem Commands

### 1.1 Understand PoB's gem/skill structure

From SkillsTab.lua:
- `build.skillsTab.socketGroupList` — array of socket groups
- Each socket group has:
  - `label` — display name
  - `slotName` — equipment slot ("Body Armour", etc.)
  - `enabled` — boolean
  - `gemList` — table of gems in the group
  - `mainActiveSkillCalcs` — index of main active skill for DPS display
- Each gem in `gemList` has:
  - `gemData` — reference to gem definition (from Data/Gems.lua)
  - `gemData.grantedEffect.name` — gem name
  - `level`, `quality` — gem level/quality
  - `count` — instance count
  - `enabled` — whether active

Main skill group identified by `build.mainSocketGroup` (Build.lua).

### 1.2 New bridge.lua commands

**`getSocketGroups`** — `{"cmd": "getSocketGroups"}`
```lua
local groups = {}
for i, group in ipairs(build.skillsTab.socketGroupList) do
  local gems = {}
  for j, gemData in ipairs(group.gemList) do
    gems[j] = {
      name = gemData.gemData and gemData.gemData.grantedEffect 
             and gemData.gemData.grantedEffect.name or "Unknown",
      level = gemData.level,
      quality = gemData.quality,
      enabled = gemData.enabled ~= false,
      isSupport = gemData.gemData and gemData.gemData.grantedEffect 
                  and gemData.gemData.grantedEffect.support or false,
    }
  end
  groups[i] = {
    index = i,
    label = group.label or "",
    slotName = group.slotName or "",
    enabled = group.enabled ~= false,
    isMainGroup = (i == build.mainSocketGroup),
    gems = gems,
  }
end
return { ok = true, groups = groups }
```

**`setGem`** — `{"cmd": "setGem", "groupIndex": 1, "gemIndex": 1, "gemName": "Faster Attacks Support", "level": 20, "quality": 20}`
- Access `build.skillsTab.socketGroupList[groupIndex].gemList[gemIndex]`
- Look up the gem data: search `data.gems` for matching name
- Set the gem data reference, level, quality
- Call `build.skillsTab:ProcessSocketGroup(group)` to rebuild skill list
- Set `build.buildFlag = true`

**`setGemLevel`** — `{"cmd": "setGemLevel", "groupIndex": 1, "gemIndex": 1, "level": 21}`
- Simpler than setGem — only changes the level field
- Sets `build.buildFlag = true`

**`removeGem`** — `{"cmd": "removeGem", "groupIndex": 1, "gemIndex": 1}`
- Remove the gem from the group's gemList
- Process socket group, set buildFlag

**`addGem`** — `{"cmd": "addGem", "groupIndex": 1, "gemName": "...", "level": 20, "quality": 20}`
- Add a new gem entry to the group's gemList
- Look up gem data by name
- Process socket group, set buildFlag

**`getAvailableSupports`** — `{"cmd": "getAvailableSupports", "activeSkillTags": ["attack", "melee"]}`
- Search `data.gems` for all support gems
- Filter by tag compatibility with the active skill (support gems have tag requirements)
- Return list of support gem names with their tags

**`getGemByName`** — `{"cmd": "getGemByName", "name": "Multistrike Support"}`
- Look up gem in `data.gems` by name
- Return gem metadata: tags, max level, granted effect description

---

## Step 2: Implement Tool — `list_skill_groups`

### 2.1 MCP tool definition

```typescript
server.tool(
  'list_skill_groups',
  `List all skill groups (socket groups) in the build with their gems, levels, and which is the main skill.`,
  {},
  async () => {
    const groups = await session.listSkillGroups();
    
    const formatted = groups.map((g: any) => ({
      index: g.index,
      label: g.label,
      slot: g.slotName,
      enabled: g.enabled,
      isMainSkill: g.isMainGroup,
      activeGems: g.gems.filter((gem: any) => !gem.isSupport),
      supportGems: g.gems.filter((gem: any) => gem.isSupport),
    }));
    
    return { content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }] };
  }
);
```

---

## Step 3: Implement Tool — `swap_gem`

### 3.1 BuildSession method

```typescript
async swapGem(
  skillGroupIndex: number,
  gemIndex: number,
  newGemName: string,
  level?: number,
  quality?: number
): Promise<StatDiff> {
  return this.withLock(async () => {
    const statsBefore = await this.bridge.send({ cmd: 'getStats' });
    
    const result = await this.withTemporaryChange(
      async () => {
        await this.bridge.send({
          cmd: 'setGem',
          groupIndex: skillGroupIndex,
          gemIndex: gemIndex,
          gemName: newGemName,
          level: level ?? 20,
          quality: quality ?? 20,
        });
      },
      async () => {
        return await this.bridge.send({ cmd: 'getStats' });
      }
    );
    
    return computeDiff(statsBefore, result);
  });
}
```

### 3.2 MCP tool definition

```typescript
server.tool(
  'swap_gem',
  'Temporarily swap a gem in a skill group and show the stat impact. The original gem is restored after evaluation.',
  {
    skillGroupIndex: { type: 'number', description: 'Index of the skill group (1-based, from list_skill_groups)' },
    gemIndex: { type: 'number', description: 'Index of the gem within the group (1-based)' },
    newGemName: { type: 'string', description: 'Name of the replacement gem (e.g., "Multistrike Support")' },
    level: { type: 'number', description: 'Gem level (default: 20)', optional: true },
    quality: { type: 'number', description: 'Gem quality (default: 20)', optional: true },
  },
  async ({ skillGroupIndex, gemIndex, newGemName, level, quality }) => {
    const diff = await session.swapGem(skillGroupIndex, gemIndex, newGemName, level, quality);
    return { content: [{ type: 'text', text: formatStatDiff(diff) }] };
  }
);
```

---

## Step 4: Implement Tool — `compare_supports`

### 4.1 Algorithm: find weakest support, then test candidates

```typescript
async compareSupports(
  skillGroupIndex: number,
  candidates: string[]
): Promise<SupportComparison> {
  return this.withLock(async () => {
    const groups = await this.bridge.send({ cmd: 'getSocketGroups' });
    const group = groups.groups[skillGroupIndex - 1]; // 1-based to 0-based
    if (!group) throw new Error(`Skill group ${skillGroupIndex} not found`);
    
    const supportGems = group.gems
      .map((g: any, i: number) => ({ ...g, index: i + 1 })) // 1-based
      .filter((g: any) => g.isSupport && g.enabled);
    
    const baselineStats = await this.bridge.send({ cmd: 'getStats' });
    const baselineDPS = baselineStats.CombinedDPS ?? 0;
    
    // Step 1: Find the weakest current support by simulating removal of each
    let weakestSupport: any = null;
    let weakestLoss = Infinity;
    
    for (const support of supportGems) {
      const withoutStats = await this.withTemporaryChange(
        async () => {
          await this.bridge.send({ cmd: 'removeGem', groupIndex: skillGroupIndex, gemIndex: support.index });
        },
        async () => {
          return await this.bridge.send({ cmd: 'getStats' });
        }
      );
      
      const loss = baselineDPS - (withoutStats.CombinedDPS ?? 0);
      if (loss < weakestLoss) {
        weakestLoss = loss;
        weakestSupport = support;
      }
    }
    
    // Step 2: Test each candidate in the weakest support's slot
    const candidateResults: Array<{ name: string; dps: number; dpsDelta: number }> = [];
    
    for (const candidateName of candidates) {
      const swapStats = await this.withTemporaryChange(
        async () => {
          await this.bridge.send({
            cmd: 'setGem',
            groupIndex: skillGroupIndex,
            gemIndex: weakestSupport.index,
            gemName: candidateName,
            level: 20,
            quality: 20,
          });
        },
        async () => {
          return await this.bridge.send({ cmd: 'getStats' });
        }
      );
      
      candidateResults.push({
        name: candidateName,
        dps: swapStats.CombinedDPS ?? 0,
        dpsDelta: (swapStats.CombinedDPS ?? 0) - baselineDPS,
      });
    }
    
    // Sort by DPS descending
    candidateResults.sort((a, b) => b.dps - a.dps);
    
    return {
      weakestCurrentSupport: { name: weakestSupport.name, dpsContribution: weakestLoss },
      slotTested: weakestSupport.index,
      candidates: candidateResults,
    };
  });
}
```

### 4.2 MCP tool definition

```typescript
server.tool(
  'compare_supports',
  `Compare candidate support gems for a skill group. First identifies the weakest current support, then tests each candidate as a replacement. All comparisons are temporary — the build is restored after.`,
  {
    skillGroupIndex: { type: 'number', description: 'Index of the skill group (1-based)' },
    candidates: {
      type: 'array',
      items: { type: 'string' },
      description: 'Support gem names to compare (e.g., ["Brutality Support", "Melee Physical Damage Support"])'
    },
  },
  async ({ skillGroupIndex, candidates }) => {
    const result = await session.compareSupports(skillGroupIndex, candidates);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);
```

---

## Step 5: Implement Tool — `find_optimal_links`

### 5.1 Heuristic algorithm (avoids combinatorial explosion)

```typescript
async findOptimalLinks(
  activeSkill: string,
  availableSlots: number,
  constraints?: string[]
): Promise<OptimalLinksResult> {
  return this.withLock(async () => {
    // Phase A: Get available supports compatible with the active skill
    const skillInfo = await this.bridge.send({ cmd: 'getGemByName', name: activeSkill });
    const allSupports = await this.bridge.send({ 
      cmd: 'getAvailableSupports', 
      activeSkillTags: skillInfo.tags 
    });
    
    const lockedSupports = constraints ?? [];
    const freeSlots = availableSlots - lockedSupports.length;
    
    // Phase B: Test each viable support individually to get single-support DPS values
    // Create a temporary skill group with just the active skill
    const singleResults: Array<{ name: string; dps: number }> = [];
    
    for (const support of allSupports) {
      if (lockedSupports.includes(support.name)) continue;
      
      // Simulate: active skill + this one support
      const dps = await this.withTemporaryChange(
        async () => {
          // Set up a minimal group: active skill + locked supports + this candidate
          // Implementation depends on how we configure temp skill groups
          await this.setupTempSkillGroup(activeSkill, [...lockedSupports, support.name]);
        },
        async () => {
          const stats = await this.bridge.send({ cmd: 'getStats' });
          return stats.CombinedDPS ?? 0;
        }
      );
      
      singleResults.push({ name: support.name, dps });
    }
    
    // Sort by single-support DPS
    singleResults.sort((a, b) => b.dps - a.dps);
    
    // Phase C: Start with top N supports, then iteratively optimize
    const topN = singleResults.slice(0, freeSlots);
    let bestCombo = topN.map(s => s.name);
    
    // Test the full combination
    let bestDPS = await this.testSupportCombination(activeSkill, [...lockedSupports, ...bestCombo]);
    
    // Phase D: Try swapping lower-ranked supports into the combo to check for synergies
    const alternatives: Array<{ combo: string[]; dps: number }> = [
      { combo: [...bestCombo], dps: bestDPS }
    ];
    
    for (let swapSlot = freeSlots - 1; swapSlot >= 0; swapSlot--) {
      // Try replacing the weakest slot with supports ranked below the cutoff
      for (let candidate = freeSlots; candidate < Math.min(singleResults.length, freeSlots + 10); candidate++) {
        const testCombo = [...bestCombo];
        testCombo[swapSlot] = singleResults[candidate].name;
        
        const testDPS = await this.testSupportCombination(activeSkill, [...lockedSupports, ...testCombo]);
        
        alternatives.push({ combo: [...testCombo], dps: testDPS });
        
        if (testDPS > bestDPS) {
          bestDPS = testDPS;
          bestCombo = [...testCombo];
        }
      }
    }
    
    // Sort alternatives by DPS
    alternatives.sort((a, b) => b.dps - a.dps);
    
    return {
      activeSkill,
      lockedSupports,
      bestCombination: bestCombo,
      bestDPS,
      topAlternatives: alternatives.slice(0, 5),
    };
  });
}
```

### 5.2 MCP tool definition

```typescript
server.tool(
  'find_optimal_links',
  `Find the optimal support gem combination for an active skill. Uses a heuristic approach: tests each support individually, then optimizes the combination. May take 30-60+ seconds.`,
  {
    activeSkill: { type: 'string', description: 'Name of the active skill gem' },
    availableSlots: { type: 'number', description: 'Number of support slots (e.g., 5 for a 6-link)' },
    constraints: {
      type: 'array',
      items: { type: 'string' },
      description: 'Support gems that must be included (e.g., ["Archmage Support"])',
      optional: true
    },
  },
  async ({ activeSkill, availableSlots, constraints }) => {
    const result = await session.findOptimalLinks(activeSkill, availableSlots, constraints);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);
```

---

## Step 6: Implement Tool — `evaluate_gem_levels`

### 6.1 BuildSession method

```typescript
async evaluateGemLevels(
  skillGroupIndex: number,
  gemIndex: number
): Promise<GemLevelScaling[]> {
  return this.withLock(async () => {
    const groups = await this.bridge.send({ cmd: 'getSocketGroups' });
    const gem = groups.groups[skillGroupIndex - 1]?.gems[gemIndex - 1];
    if (!gem) throw new Error('Gem not found');
    
    const currentLevel = gem.level;
    const maxLevel = 21; // Corrupted max
    const results: GemLevelScaling[] = [];
    
    // Test each level from current to max
    for (let level = currentLevel; level <= maxLevel; level++) {
      const stats = await this.withTemporaryChange(
        async () => {
          await this.bridge.send({
            cmd: 'setGemLevel',
            groupIndex: skillGroupIndex,
            gemIndex: gemIndex,
            level
          });
        },
        async () => {
          return await this.bridge.send({ cmd: 'getStats' });
        }
      );
      
      results.push({
        level,
        dps: stats.CombinedDPS ?? 0,
        // Include other relevant stats based on gem type
      });
    }
    
    return results;
  });
}
```

### 6.2 MCP tool definition

```typescript
server.tool(
  'evaluate_gem_levels',
  'Show how DPS scales with gem level for a specific gem. Tests each level from current through 21.',
  {
    skillGroupIndex: { type: 'number', description: 'Skill group index (1-based)' },
    gemIndex: { type: 'number', description: 'Gem index within group (1-based)' },
  },
  async ({ skillGroupIndex, gemIndex }) => {
    const scaling = await session.evaluateGemLevels(skillGroupIndex, gemIndex);
    return { content: [{ type: 'text', text: JSON.stringify(scaling, null, 2) }] };
  }
);
```

---

## Step 7: Testing

### Test cases:
1. **list_skill_groups**: Load build, verify groups returned with active + support gems
2. **swap_gem**: Swap a support gem, verify DPS changes, build restored
3. **compare_supports**: Test 3 candidates, verify ranking, build unchanged after
4. **find_optimal_links**: Find best 5L for a known skill, verify result includes expected supports
5. **evaluate_gem_levels**: Check scaling curve, verify monotonically increasing DPS (for most gems)
6. **Invalid gem name**: Pass nonexistent gem name, verify clean error
7. **Invalid group index**: Pass out-of-range index, verify error

---

## Performance Notes

| Operation | Expected time | Iterations |
|-----------|--------------|------------|
| swap_gem | <1s | 2 frame pumps |
| compare_supports (5 candidates) | 5-10s | ~10+5 iterations (find weakest + test candidates) |
| find_optimal_links (5L, ~30 viable supports) | 30-90s | ~30 individual + ~50 combination tests |
| evaluate_gem_levels | 2-4s | ~5-10 levels |

For `find_optimal_links`, consider:
- Filtering supports by tag compatibility reduces viable count significantly
- Capping individual test phase at top 20 supports
- Capping swap optimization phase at top 5 alternatives per slot

---

## Definition of Done
- [ ] `list_skill_groups` returns all groups with gem details
- [ ] `swap_gem` temporarily swaps gems and shows stat diff
- [ ] `compare_supports` identifies weakest support and ranks candidates
- [ ] `find_optimal_links` uses heuristic to find best support combination
- [ ] `evaluate_gem_levels` shows DPS scaling per gem level
- [ ] All operations leave build state unchanged
- [ ] Error handling for invalid gem names, group indices
- [ ] All tests pass
