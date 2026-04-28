# Phase 7: Build Optimization Advisor Tools — Implementation Plan

## Goal
Add higher-level tools that combine multiple lower-level operations to provide upgrade advice, build diagnostics, export capabilities, and cumulative change tracking. These tools orchestrate calls to previous phases' tools through BuildSession.

## Prerequisites
- Phases 1–6 complete: All foundational tools operational (stats, items, tree, gems, config).
- BuildSession snapshot system, withTemporaryChange, and serial lock all proven reliable.

---

## Step 1: Implement Tool — `diagnose_build`

### 1.1 Design: Read-only analysis engine

This tool does NOT modify the build. It reads current state from multiple subsystems and applies heuristic checks to identify problems and opportunities.

### 1.2 Diagnostic checks to implement

**Defense diagnostics:**
```typescript
interface DiagnosticCheck {
  category: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  suggestion: string;
}

function runDefenseDiagnostics(stats: Stats, config: ConfigState): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  
  // Elemental resistances
  const resists = ['FireResist', 'ColdResist', 'LightningResist'];
  for (const res of resists) {
    if ((stats[res] ?? 0) < 75) {
      checks.push({
        category: 'defense',
        severity: 'critical',
        message: `${res} is ${stats[res]}% (uncapped)`,
        suggestion: 'Fix elemental resistances to 75% minimum before any other upgrades'
      });
    }
    // Check overcap
    const overcapKey = res + 'OverCap';
    if ((stats[overcapKey] ?? 0) > 50) {
      checks.push({
        category: 'defense',
        severity: 'info',
        message: `${res} overcapped by ${stats[overcapKey]}%`,
        suggestion: 'Consider trading some resistance for damage or other defenses'
      });
    }
  }
  
  // Chaos resistance
  if ((stats['ChaosResist'] ?? 0) < 0) {
    checks.push({
      category: 'defense',
      severity: 'warning',
      message: `Chaos resistance is negative (${stats['ChaosResist']}%)`,
      suggestion: 'Negative chaos res is dangerous in endgame — aim for 0% minimum'
    });
  }
  
  // Life/ES thresholds
  const life = stats['Life'] ?? 0;
  const es = stats['EnergyShield'] ?? 0;
  const totalEHP = stats['TotalEHP'] ?? 0;
  
  if (life < 4000 && es < 3000) {
    checks.push({
      category: 'defense',
      severity: 'critical',
      message: `Low effective HP pool: ${life} life, ${es} ES`,
      suggestion: 'Prioritize life on gear — aim for 5000+ life or 8000+ ES for endgame'
    });
  }
  
  // Spell suppression
  if ((stats['SpellSuppressionChance'] ?? 0) > 0 && (stats['SpellSuppressionChance'] ?? 0) < 100) {
    checks.push({
      category: 'defense',
      severity: 'warning',
      message: `Spell suppression at ${stats['SpellSuppressionChance']}% (not capped)`,
      suggestion: 'Spell suppression is most valuable at 100% — either cap it or respec out'
    });
  }
  
  return checks;
}
```

**Offense diagnostics:**
```typescript
function runOffenseDiagnostics(stats: Stats, gems: SkillGroup[], tree: PassiveTreeInfo): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  
  // Crit without Resolute Technique
  const critChance = stats['CritChance'] ?? 0;
  const hasRT = tree.keystones.some(k => k.name === 'Resolute Technique');
  
  if (critChance > 5 && critChance < 40 && !hasRT) {
    checks.push({
      category: 'offense',
      severity: 'warning',
      message: `Low crit chance (${critChance}%) without Resolute Technique`,
      suggestion: 'Either invest in crit (aim for 50%+) or take Resolute Technique to never miss'
    });
  }
  
  // Hit chance
  const hitChance = stats['HitChance'] ?? 100;
  if (hitChance < 95 && !hasRT) {
    checks.push({
      category: 'offense',
      severity: 'warning',
      message: `Low hit chance (${hitChance}%)`,
      suggestion: 'Add accuracy on gear/tree or take Resolute Technique'
    });
  }
  
  // Gem levels
  for (const group of gems) {
    if (!group.isMainGroup) continue;
    for (const gem of group.gems) {
      if (!gem.isSupport && gem.level < 20) {
        checks.push({
          category: 'offense',
          severity: 'info',
          message: `Main skill "${gem.name}" is only level ${gem.level}`,
          suggestion: 'Level 20 gems provide significant damage — prioritize leveling'
        });
      }
    }
  }
  
  return checks;
}
```

**Quality-of-life diagnostics:**
```typescript
function runQoLDiagnostics(gems: SkillGroup[]): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const allGemNames = gems.flatMap(g => g.gems.map(gem => gem.name));
  
  // Check for movement skill
  const movementSkills = ['Flame Dash', 'Shield Charge', 'Whirling Blades', 'Leap Slam', 'Dash', 'Frostblink', 'Lightning Warp'];
  if (!movementSkills.some(ms => allGemNames.includes(ms))) {
    checks.push({
      category: 'qol',
      severity: 'warning',
      message: 'No movement skill found',
      suggestion: 'Add a movement skill for quality of life (Flame Dash is universally useful)'
    });
  }
  
  // Check for guard skill
  const guardSkills = ['Steelskin', 'Molten Shell', 'Immortal Call', 'Bone Armour', 'Arcane Cloak'];
  if (!guardSkills.some(gs => allGemNames.includes(gs))) {
    checks.push({
      category: 'qol',
      severity: 'info',
      message: 'No guard skill found',
      suggestion: 'Consider adding a guard skill (Molten Shell for armour builds, Steelskin otherwise)'
    });
  }
  
  return checks;
}
```

### 1.3 BuildSession method

```typescript
async diagnoseBuild(focus?: string): Promise<DiagnosticCheck[]> {
  return this.withLock(async () => {
    // Gather all data (read-only — no mutations)
    const stats = await this.bridge.send({ cmd: 'getStats' });
    const items = await this.bridge.send({ cmd: 'listEquippedItems' });
    const gems = await this.bridge.send({ cmd: 'getSocketGroups' });
    const tree = await this.getPassiveTree();
    const config = await this.bridge.send({ cmd: 'getConfig' });
    
    let checks: DiagnosticCheck[] = [];
    
    if (!focus || focus === 'defense') {
      checks.push(...runDefenseDiagnostics(stats, config));
    }
    if (!focus || focus === 'offense') {
      checks.push(...runOffenseDiagnostics(stats, gems.groups, tree));
    }
    if (!focus || focus === 'balance') {
      checks.push(...runDefenseDiagnostics(stats, config));
      checks.push(...runOffenseDiagnostics(stats, gems.groups, tree));
    }
    checks.push(...runQoLDiagnostics(gems.groups));
    
    // Sort by severity: critical > warning > info
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    checks.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
    
    return checks;
  });
}
```

### 1.4 MCP tool definition

```typescript
server.tool(
  'diagnose_build',
  `Run a comprehensive analysis of the current build to identify weaknesses, bottlenecks, and improvement opportunities. This is read-only — it does not modify the build.
  
Checks: uncapped resistances, low life/ES, crit investment efficiency, hit chance, gem levels, missing utility skills, and common build mistakes.`,
  {
    focus: {
      type: 'string',
      description: 'Focus area: "offense", "defense", "sustain", or "balance" (default: all)',
      optional: true
    }
  },
  async ({ focus }) => {
    const checks = await session.diagnoseBuild(focus);
    
    let text = '## Build Diagnosis\n\n';
    for (const check of checks) {
      const icon = check.severity === 'critical' ? 'CRITICAL' : check.severity === 'warning' ? 'WARNING' : 'INFO';
      text += `**[${icon}]** ${check.message}\n`;
      text += `  → ${check.suggestion}\n\n`;
    }
    
    if (checks.length === 0) {
      text += 'No issues found — build looks solid!\n';
    }
    
    return { content: [{ type: 'text', text }] };
  }
);
```

---

## Step 2: Implement Tool — `suggest_upgrades`

### 2.1 Algorithm: unequip each slot to measure current item value

```typescript
async suggestUpgrades(
  budget?: string,
  targetSlot?: string
): Promise<UpgradeSuggestion[]> {
  return this.withLock(async () => {
    const stats = await this.bridge.send({ cmd: 'getStats' });
    const items = await this.bridge.send({ cmd: 'listEquippedItems' });
    const gems = await this.bridge.send({ cmd: 'getSocketGroups' });
    
    // Determine build archetype from active skills
    const archetype = identifyArchetype(gems);
    
    const slots = targetSlot 
      ? [targetSlot] 
      : ['Weapon 1', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Belt'];
    
    const slotValues: Array<{
      slot: string;
      currentItem: any;
      dpsContribution: number;
      ehpContribution: number;
      priority: number;
      suggestedMods: string[];
    }> = [];
    
    // Measure each slot's contribution by temporarily unequipping
    for (const slot of slots) {
      const item = items[slot];
      if (!item) {
        // Empty slot — high priority upgrade
        slotValues.push({
          slot,
          currentItem: null,
          dpsContribution: 0,
          ehpContribution: 0,
          priority: 100, // Highest priority
          suggestedMods: getSuggestedMods(slot, archetype, budget),
        });
        continue;
      }
      
      const withoutStats = await this.withTemporaryChange(
        async () => {
          await this.bridge.send({ cmd: 'unequipItem', slot });
        },
        async () => {
          return await this.bridge.send({ cmd: 'getStats' });
        }
      );
      
      const dpsLoss = (stats.CombinedDPS ?? 0) - (withoutStats.CombinedDPS ?? 0);
      const ehpLoss = (stats.TotalEHP ?? 0) - (withoutStats.TotalEHP ?? 0);
      
      slotValues.push({
        slot,
        currentItem: item,
        dpsContribution: dpsLoss,
        ehpContribution: ehpLoss,
        priority: computeUpgradePriority(dpsLoss, ehpLoss, stats),
        suggestedMods: getSuggestedMods(slot, archetype, budget),
      });
    }
    
    // Sort by priority (lowest contribution = highest upgrade priority)
    slotValues.sort((a, b) => {
      // Empty slots first, then by lowest total contribution
      if (!a.currentItem) return -1;
      if (!b.currentItem) return 1;
      return (a.dpsContribution + a.ehpContribution) - (b.dpsContribution + b.ehpContribution);
    });
    
    return slotValues;
  });
}
```

### 2.2 Build archetype detection

```typescript
function identifyArchetype(gems: any): BuildArchetype {
  const mainGroup = gems.groups.find((g: any) => g.isMainGroup);
  if (!mainGroup) return 'generic';
  
  const activeGem = mainGroup.gems.find((g: any) => !g.isSupport);
  if (!activeGem) return 'generic';
  
  const supports = mainGroup.gems.filter((g: any) => g.isSupport).map((g: any) => g.name);
  
  // Check for archetype-defining supports/skills
  if (supports.includes('Archmage Support')) return 'archmage';
  if (supports.includes('Minion Damage Support') || activeGem.name.includes('Summon') || activeGem.name.includes('Raise')) return 'minion';
  if (supports.includes('Spell Totem Support') || supports.includes('Ballista Totem Support')) return 'totem';
  if (activeGem.tags?.includes('dot') || supports.includes('Deadly Ailments Support')) return 'dot';
  
  return 'generic';
}
```

### 2.3 Archetype-aware mod suggestions

```typescript
function getSuggestedMods(slot: string, archetype: string, budget?: string): string[] {
  const mods: string[] = [];
  
  // Universal mods
  if (['Helmet', 'Body Armour', 'Gloves', 'Boots', 'Belt'].includes(slot)) {
    mods.push('Maximum Life', 'Elemental Resistances');
  }
  
  // Archetype-specific
  switch (archetype) {
    case 'archmage':
      mods.push('Maximum Mana', 'Mana Regeneration', 'Mana Cost');
      if (slot === 'Amulet') mods.push('Non-Channelling Skills have -X to Total Mana Cost');
      break;
    case 'minion':
      mods.push('Minion Damage', 'Minion Attack/Cast Speed', 'Minion Life');
      if (slot === 'Helmet') mods.push('+Level to Minion Gems');
      break;
    case 'dot':
      mods.push('Damage over Time Multiplier', 'Chaos/Fire/Cold DoT Multiplier');
      break;
    default:
      if (slot === 'Weapon 1') mods.push('Physical DPS', 'Critical Strike Chance', 'Attack Speed');
      if (slot === 'Amulet') mods.push('Critical Strike Multiplier', '+Level to Skill Gems');
      break;
  }
  
  // Slot-specific
  if (slot === 'Boots') mods.push('Movement Speed');
  if (slot === 'Gloves' && archetype !== 'minion') mods.push('Attack Speed', 'Accuracy');
  
  return mods;
}
```

### 2.4 MCP tool definition

```typescript
server.tool(
  'suggest_upgrades',
  `Analyze current gear and suggest which slots to upgrade next. Measures each item's contribution by temporarily unequipping it. Provides archetype-aware mod suggestions.
  
Does NOT search trade sites — describes what ideal items look like.`,
  {
    budget: {
      type: 'string',
      description: 'Budget range: "low" (<50c), "medium" (1-5 div), "high" (5+ div)',
      optional: true
    },
    slot: {
      type: 'string',
      description: 'Focus on a specific slot (omit for all slots)',
      optional: true
    }
  },
  async ({ budget, slot }) => {
    const suggestions = await session.suggestUpgrades(budget, slot);
    
    let text = '## Upgrade Suggestions\n\n';
    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      text += `### ${i + 1}. ${s.slot}${!s.currentItem ? ' (EMPTY)' : ''}\n`;
      text += `Current contribution: ${s.dpsContribution.toLocaleString()} DPS, ${s.ehpContribution.toLocaleString()} EHP\n`;
      text += `Look for: ${s.suggestedMods.join(', ')}\n\n`;
    }
    
    return { content: [{ type: 'text', text }] };
  }
);
```

---

## Step 3: Implement Tool — `export_build`

### 3.1 Lua-side command needed

**`exportXML`** — `{"cmd": "exportXML"}`
- Serialize the current build state to XML
- Call `build:SaveDB("export")` or equivalent to produce XML string
- Return the XML as a string

### 3.2 BuildSession method

```typescript
async exportBuild(format: string = 'summary'): Promise<string> {
  return this.withLock(async () => {
    switch (format) {
      case 'xml': {
        const result = await this.bridge.send({ cmd: 'exportXML' });
        return result.xml;
      }
      case 'code': {
        // Get XML from Lua, then encode in TypeScript
        // (Lua's Deflate is stubbed — must encode in TS)
        const result = await this.bridge.send({ cmd: 'exportXML' });
        return encodeBuildCode(result.xml);
      }
      case 'summary': {
        const info = await this.getBuildInfo();
        const stats = await this.bridge.send({ cmd: 'getStats' });
        return formatBuildSummary(info, stats);
      }
      default:
        throw new Error(`Unknown format: "${format}". Valid: "xml", "code", "summary"`);
    }
  });
}

function encodeBuildCode(xml: string): string {
  // XML → zlib raw deflate → base64 (URL-safe)
  const compressed = deflateRawSync(Buffer.from(xml, 'utf-8'));
  return compressed.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function formatBuildSummary(info: BuildInfo, stats: Stats): string {
  return [
    `${info.class} / ${info.ascendancy} (Level ${info.level})`,
    `Main Skill: ${info.mainSkill}`,
    '',
    `DPS: ${(stats.CombinedDPS ?? 0).toLocaleString()}`,
    `Life: ${(stats.Life ?? 0).toLocaleString()}`,
    `Energy Shield: ${(stats.EnergyShield ?? 0).toLocaleString()}`,
    `EHP: ${(stats.TotalEHP ?? 0).toLocaleString()}`,
    '',
    `Fire Res: ${stats.FireResist ?? 0}%`,
    `Cold Res: ${stats.ColdResist ?? 0}%`,
    `Lightning Res: ${stats.LightningResist ?? 0}%`,
    `Chaos Res: ${stats.ChaosResist ?? 0}%`,
  ].join('\n');
}
```

### 3.3 MCP tool definition

```typescript
server.tool(
  'export_build',
  `Export the current build state (including any modifications made during this session).
  
Formats:
- "summary" — human-readable stat summary (default)
- "xml" — raw Path of Building XML
- "code" — encoded build code that can be imported into PoB desktop`,
  {
    format: {
      type: 'string',
      description: 'Export format: "xml", "code", or "summary" (default: "summary")',
      optional: true
    }
  },
  async ({ format }) => {
    const result = await session.exportBuild(format ?? 'summary');
    return { content: [{ type: 'text', text: result }] };
  }
);
```

---

## Step 4: Implement Tool — `snapshot_and_compare`

### 4.1 MCP tool definition

```typescript
server.tool(
  'snapshot_and_compare',
  `Take a labeled snapshot of current stats, or compare against a previous snapshot. Use this to track cumulative impact of multiple changes.
  
Example workflow:
1. snapshot_and_compare({action: "take", label: "before upgrades"})
2. Make several changes (swap items, adjust tree, etc.)
3. snapshot_and_compare({action: "compare", labelA: "before upgrades", labelB: "current"})`,
  {
    action: {
      type: 'string',
      description: '"take" to save a snapshot, "compare" to diff two snapshots, "list" to see all snapshots'
    },
    label: {
      type: 'string',
      description: 'Label for the snapshot (used with "take")',
      optional: true
    },
    labelA: {
      type: 'string',
      description: 'First snapshot label for comparison',
      optional: true
    },
    labelB: {
      type: 'string',
      description: 'Second snapshot label (or "current" for live stats)',
      optional: true
    }
  },
  async ({ action, label, labelA, labelB }) => {
    switch (action) {
      case 'take': {
        if (!label) return { content: [{ type: 'text', text: 'Label required for "take" action' }], isError: true };
        await session.takeSnapshot(label);
        return { content: [{ type: 'text', text: `Snapshot "${label}" saved.` }] };
      }
      case 'compare': {
        if (!labelA || !labelB) {
          return { content: [{ type: 'text', text: 'Both labelA and labelB required for comparison' }], isError: true };
        }
        
        // If labelB is "current", take a live snapshot
        if (labelB === 'current') {
          await session.takeSnapshot('__current');
          labelB = '__current';
        }
        
        const diff = session.diffSnapshots(labelA, labelB);
        return { content: [{ type: 'text', text: formatStatDiff(diff) }] };
      }
      case 'list': {
        const labels = session.listSnapshots();
        return { content: [{ type: 'text', text: `Snapshots: ${labels.join(', ')}` }] };
      }
      default:
        return { content: [{ type: 'text', text: `Unknown action: "${action}"` }], isError: true };
    }
  }
);
```

---

## Step 5: Add an `undo` Tool

While undo is a BuildSession capability from Phase 1.5, it needs a user-facing MCP tool:

```typescript
server.tool(
  'undo',
  'Undo the last permanent change (item swap, config change, tree modification). Returns the stat diff from the undo.',
  {},
  async () => {
    try {
      const stats = await session.undoLastChange();
      return { content: [{ type: 'text', text: `Undo successful.\n\nCurrent stats:\n${JSON.stringify(stats, null, 2)}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: e.message }], isError: true };
    }
  }
);
```

---

## Step 6: Add a `reset_build` Tool

```typescript
server.tool(
  'reset_build',
  'Reset the build to its original state (as it was when first loaded). All changes are reverted.',
  {},
  async () => {
    const info = await session.resetBuild();
    return {
      content: [{
        type: 'text',
        text: `Build reset to original state.\n${info.class} / ${info.ascendancy} (Level ${info.level})`
      }]
    };
  }
);
```

---

## Step 7: Testing

### Test cases:
1. **diagnose_build**: Load a build with known issues (uncapped res, low life), verify diagnostics catch them
2. **diagnose_build — clean build**: Load a well-optimized build, verify no critical issues
3. **suggest_upgrades**: Load build, verify slot ranking makes sense (weakest item = highest priority)
4. **suggest_upgrades — archetype detection**: Load a minion build, verify "Minion Damage" suggested on relevant slots
5. **export_build — summary**: Verify human-readable output contains class, DPS, life
6. **export_build — code round-trip**: Export as code → decode → verify XML matches
7. **export_build — xml**: Verify valid XML returned
8. **snapshot_and_compare**: Take snapshot → swap item → compare with "current" → verify diff matches expected
9. **undo**: Make 3 changes → undo all 3 → verify stats match original
10. **reset_build**: Make changes → reset → verify exact match with original load

### Integration test:
```typescript
// Full workflow: load → diagnose → snapshot → make improvements → compare
await session.loadBuild(testBuildCode);
const diagnosis = await session.diagnoseBuild();
await session.takeSnapshot('before');
// Apply suggested improvements...
await session.takeSnapshot('after');
const improvement = session.diffSnapshots('before', 'after');
// Verify DPS improved without defensive regression
```

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| diagnose_build is pure read-only | No risk of state corruption; can run at any time |
| suggest_upgrades uses unequip-to-measure | Direct measurement of item value via the calc engine — more accurate than heuristic mod scoring |
| Build code encoding in TypeScript | Lua Deflate is stubbed (HeadlessWrapper line 94) — must use Node.js zlib |
| Archetype detection from active skill + supports | Determines which stats matter for upgrade suggestions — e.g., mana for Archmage, minion damage for summoners |
| Snapshot labels in memory (not persisted) | Snapshots are session-scoped; persisting across sessions would require storing full stat blocks |

---

## Definition of Done
- [ ] `diagnose_build` identifies common build problems with severity ratings
- [ ] `suggest_upgrades` ranks slots by upgrade priority with archetype-aware mod suggestions
- [ ] `export_build` produces valid XML, importable build codes, and human-readable summaries
- [ ] `snapshot_and_compare` enables cumulative change tracking across multiple modifications
- [ ] `undo` reverts the last permanent change
- [ ] `reset_build` fully restores original build state
- [ ] Build code round-trip (export → import) produces matching builds
- [ ] All tests pass
