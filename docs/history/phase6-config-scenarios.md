# Phase 6: Configuration and Scenario Tools — Implementation Plan

## Goal
Add MCP tools for modifying PoB's configuration options and simulating different combat scenarios. Must handle the config input aliasing constraint — `configTab.input` is a direct reference to the active config set's input table, so mutations happen in-place and must be deep-copied before modification.

## Prerequisites
- Phase 5 complete: Gem tools working, serial iteration patterns mature.
- BuildSession snapshot/restore for config proven reliable (from Phase 1.5).

---

## Step 1: Understand Config System Internals

### 1.1 Config structure (from ConfigTab.lua)
- `build.configTab.input` — dict of variable name → value (line 22)
- `build.configTab.configSets` — multiple named configurations (line 27)
- `build.configTab.activeConfigSetId` — current active set
- **ALIASING**: `configTab.input` points directly at the active config set's input table (ConfigTab.lua:983-985). Mutating `configTab.input.X = Y` mutates the config set in place.
- `build.configTab:BuildModList()` — rebuilds modifier list from config, sets `build.buildFlag = true` (line 154)

### 1.2 Config variable definitions (from Modules/ConfigOptions.lua)
Each variable has:
- `var` — variable name (e.g., `"enemyIsBoss"`, `"usePowerCharges"`, `"customMods"`)
- `type` — `"check"` (boolean), `"count"` (integer), `"list"` (dropdown), `"text"` (string)
- `label` — display text
- `section` — grouping (e.g., `"General"`, `"Skill Options"`, `"Map Modifiers"`)

### 1.3 Key config variables (most commonly useful)
From examining ConfigOptions.lua and test patterns (TestDefence_spec.lua):
```
enemyIsBoss         — "None", "Boss", "Shaper" (list)
usePowerCharges     — boolean
useFrenzyCharges    — boolean
useEnduranceCharges — boolean
conditionOnslaught  — boolean
conditionUnholy     — boolean
buffFlaskActive     — boolean (or specific flask config keys)
enemyPhysicalHit    — integer (for max hit calculations)
customMods          — text (newline-separated custom modifiers)
conditionLowLife    — boolean
conditionFullLife   — boolean
```

### 1.4 Lua-side commands needed

**`getConfig`** — `{"cmd": "getConfig"}`
- Iterate `build.configTab.input` and return all key-value pairs
- Also return metadata: for each key, look up the varData to get label, type, section
- Group by section for readability

**`setConfig`** — `{"cmd": "setConfig", "options": {"enemyIsBoss": "Shaper", "usePowerCharges": true}}`
- For each key-value pair: `build.configTab.input[key] = value`
- Call `build.configTab:BuildModList()` to rebuild mods
- Set `build.buildFlag = true`
- Pump frame
- Return updated stats
- **Does NOT snapshot/restore** — this is a permanent mutation (undo via BuildSession's undo stack)

**`snapshotConfig`** — `{"cmd": "snapshotConfig"}`
- Deep-copy `build.configTab.input` into a Lua table
- Return the copy as JSON
- Used by BuildSession for snapshot/restore

**`restoreConfig`** — `{"cmd": "restoreConfig", "input": {...}}`
- Clear `build.configTab.input` and repopulate from the provided table
- Call `build.configTab:BuildModList()`
- Pump frame

**`getConfigMetadata`** — `{"cmd": "getConfigMetadata"}`
- Return the full list of available config variables with their types, labels, sections, and valid values (for list types)
- Sourced from `build.configTab.varControls` or the ConfigOptions module

---

## Step 2: Implement Tool — `get_config`

### 2.1 BuildSession method

```typescript
async getConfig(): Promise<ConfigState> {
  return this.withLock(async () => {
    const [config, metadata] = await Promise.all([
      this.bridge.send({ cmd: 'getConfig' }),
      this.bridge.send({ cmd: 'getConfigMetadata' }),
    ]);
    
    // Merge: for each active config key, attach its metadata
    const organized: Record<string, ConfigEntry[]> = {};
    for (const entry of metadata) {
      const section = entry.section || 'Other';
      if (!organized[section]) organized[section] = [];
      organized[section].push({
        key: entry.var,
        label: entry.label,
        type: entry.type,
        value: config[entry.var] ?? null,
        validValues: entry.list ?? undefined,
      });
    }
    
    return organized;
  });
}
```

### 2.2 MCP tool definition

```typescript
server.tool(
  'get_config',
  `Get all configuration options and their current values, organized by section.
  
Common config keys:
- enemyIsBoss: "None", "Boss", "Shaper" — enemy tier for DPS calculations
- usePowerCharges / useFrenzyCharges / useEnduranceCharges: boolean — charge generation
- conditionOnslaught: boolean — onslaught buff active
- buffFlaskActive: boolean — flask effects active
- customMods: text — custom modifiers (newline-separated)`,
  {},
  async () => {
    const config = await session.getConfig();
    return { content: [{ type: 'text', text: JSON.stringify(config, null, 2) }] };
  }
);
```

---

## Step 3: Implement Tool — `set_config`

### 3.1 BuildSession method

```typescript
async setConfig(options: Record<string, any>): Promise<{ statDiff: StatDiff; newStats: Stats }> {
  return this.withLock(async () => {
    await this.pushUndo(); // Permanent mutation — save undo point
    
    const statsBefore = await this.bridge.send({ cmd: 'getStats' });
    await this.bridge.send({ cmd: 'setConfig', options });
    const statsAfter = await this.bridge.send({ cmd: 'getStats' });
    
    return {
      statDiff: computeDiff(statsBefore, statsAfter),
      newStats: statsAfter,
    };
  });
}
```

### 3.2 MCP tool definition

```typescript
server.tool(
  'set_config',
  `Set configuration options and show the stat impact. This PERMANENTLY changes the config (use undo to revert).
  
Example: {"enemyIsBoss": "Shaper", "usePowerCharges": true}`,
  {
    options: {
      type: 'object',
      description: 'Key-value pairs of config options to set',
      additionalProperties: true
    }
  },
  async ({ options }) => {
    const result = await session.setConfig(options);
    return { content: [{ type: 'text', text: formatStatDiff(result.statDiff) }] };
  }
);
```

---

## Step 4: Implement Tool — `simulate_scenario`

### 4.1 Scenario presets

Define preset scenarios that map to specific config key combinations:

```typescript
const SCENARIO_PRESETS: Record<string, Record<string, any>> = {
  mapping: {
    enemyIsBoss: 'Boss',        // Standard map boss
    usePowerCharges: true,
    useFrenzyCharges: true,
    useEnduranceCharges: true,
    conditionOnslaught: true,
    buffFlaskActive: true,
  },
  pinnacle_boss: {
    enemyIsBoss: 'Shaper',      // Uber boss tier
    usePowerCharges: true,
    useFrenzyCharges: false,    // Can't sustain in boss fights
    useEnduranceCharges: true,
    conditionOnslaught: false,
    buffFlaskActive: false,     // No sustained flask uptime
  },
  breach: {
    enemyIsBoss: 'None',        // Trash mobs
    usePowerCharges: true,
    useFrenzyCharges: true,
    useEnduranceCharges: true,
    conditionOnslaught: true,
    buffFlaskActive: true,
  },
  maven: {
    enemyIsBoss: 'Shaper',
    usePowerCharges: true,
    useFrenzyCharges: false,
    useEnduranceCharges: true,
    buffFlaskActive: false,
  },
  delirium: {
    enemyIsBoss: 'None',
    usePowerCharges: true,
    useFrenzyCharges: true,
    useEnduranceCharges: true,
    conditionOnslaught: true,
    buffFlaskActive: true,
  },
};
```

### 4.2 BuildSession method

```typescript
async simulateScenario(scenario: string): Promise<{ scenario: string; stats: Stats; diff: StatDiff }> {
  return this.withLock(async () => {
    const preset = SCENARIO_PRESETS[scenario];
    if (!preset) throw new Error(`Unknown scenario: "${scenario}". Valid: ${Object.keys(SCENARIO_PRESETS).join(', ')}`);
    
    const baselineStats = await this.bridge.send({ cmd: 'getStats' });
    
    // Use withTemporaryChange — scenario simulation does NOT permanently mutate config
    const scenarioStats = await this.withTemporaryChange(
      async () => {
        await this.bridge.send({ cmd: 'setConfig', options: preset });
      },
      async () => {
        return await this.bridge.send({ cmd: 'getStats' });
      }
    );
    
    return {
      scenario,
      stats: scenarioStats,
      diff: computeDiff(baselineStats, scenarioStats),
    };
  });
}
```

### 4.3 MCP tool definition

```typescript
server.tool(
  'simulate_scenario',
  `Simulate a combat scenario by temporarily applying a config preset. The build returns to its original config after simulation.
  
Available scenarios:
- "mapping" — standard map boss, flasks up, all charges, onslaught
- "pinnacle_boss" — Shaper/Uber tier, no flask uptime, limited charges
- "breach" — trash mobs, full buffs
- "maven" — Maven witness fight
- "delirium" — Delirium mirror, full buffs`,
  {
    scenario: { type: 'string', description: 'Scenario preset name' }
  },
  async ({ scenario }) => {
    const result = await session.simulateScenario(scenario);
    
    let text = `## Scenario: ${result.scenario}\n\n`;
    text += `### Key Stats\n`;
    text += `DPS: ${result.stats.CombinedDPS?.toLocaleString() ?? 'N/A'}\n`;
    text += `EHP: ${result.stats.TotalEHP?.toLocaleString() ?? 'N/A'}\n\n`;
    text += `### Changes from current config\n`;
    text += formatStatDiff(result.diff);
    
    return { content: [{ type: 'text', text }] };
  }
);
```

---

## Step 5: Implement Tool — `compare_scenarios`

### 5.1 BuildSession method

```typescript
async compareScenarios(scenarios: string[]): Promise<ScenarioComparison> {
  return this.withLock(async () => {
    const baselineStats = await this.bridge.send({ cmd: 'getStats' });
    const results: Array<{ scenario: string; stats: Stats; diff: StatDiff }> = [];
    
    // SEQUENTIAL — each scenario with its own snapshot/restore cycle
    for (const scenario of scenarios) {
      const preset = SCENARIO_PRESETS[scenario];
      if (!preset) throw new Error(`Unknown scenario: "${scenario}"`);
      
      const scenarioStats = await this.withTemporaryChange(
        async () => {
          await this.bridge.send({ cmd: 'setConfig', options: preset });
        },
        async () => {
          return await this.bridge.send({ cmd: 'getStats' });
        }
      );
      
      results.push({
        scenario,
        stats: scenarioStats,
        diff: computeDiff(baselineStats, scenarioStats),
      });
    }
    
    return { baseline: baselineStats, scenarios: results };
  });
}
```

### 5.2 MCP tool definition

```typescript
server.tool(
  'compare_scenarios',
  'Compare stats across multiple combat scenarios side-by-side. Each scenario is simulated independently with config restore between them.',
  {
    scenarios: {
      type: 'array',
      items: { type: 'string' },
      description: 'Scenario names to compare (e.g., ["mapping", "pinnacle_boss"])'
    }
  },
  async ({ scenarios }) => {
    const result = await session.compareScenarios(scenarios);
    
    // Build side-by-side comparison table
    let text = '## Scenario Comparison\n\n';
    text += `| Stat | Current | ${result.scenarios.map(s => s.scenario).join(' | ')} |\n`;
    text += `|------|---------|${result.scenarios.map(() => '---').join('|')}|\n`;
    
    const keyStats = ['CombinedDPS', 'TotalEHP', 'Life', 'EnergyShield'];
    for (const stat of keyStats) {
      const baseline = result.baseline[stat] ?? 0;
      const values = result.scenarios.map(s => {
        const val = s.stats[stat] ?? 0;
        const delta = val - baseline;
        return delta !== 0 ? `${val.toLocaleString()} (${delta > 0 ? '+' : ''}${delta.toLocaleString()})` : val.toLocaleString();
      });
      text += `| ${stat} | ${baseline.toLocaleString()} | ${values.join(' | ')} |\n`;
    }
    
    return { content: [{ type: 'text', text }] };
  }
);
```

---

## Step 6: Implement Tool — `toggle_buffs`

### 6.1 BuildSession method

```typescript
async toggleBuffs(buffs: Record<string, boolean>): Promise<StatDiff> {
  return this.withLock(async () => {
    const baselineStats = await this.bridge.send({ cmd: 'getStats' });
    
    // Map friendly buff names to PoB config keys
    const BUFF_KEY_MAP: Record<string, string> = {
      flasksActive: 'buffFlaskActive',
      powerCharges: 'usePowerCharges',
      frenzyCharges: 'useFrenzyCharges',
      enduranceCharges: 'useEnduranceCharges',
      onslaught: 'conditionOnslaught',
      fortify: 'conditionFortify',
      unholy: 'conditionUnholy',
    };
    
    const configOptions: Record<string, any> = {};
    for (const [buff, value] of Object.entries(buffs)) {
      const key = BUFF_KEY_MAP[buff] ?? buff; // Allow raw config keys too
      configOptions[key] = value;
    }
    
    // Temporary change — toggle buffs for preview, then restore
    const afterStats = await this.withTemporaryChange(
      async () => {
        await this.bridge.send({ cmd: 'setConfig', options: configOptions });
      },
      async () => {
        return await this.bridge.send({ cmd: 'getStats' });
      }
    );
    
    return computeDiff(baselineStats, afterStats);
  });
}
```

### 6.2 MCP tool definition

```typescript
server.tool(
  'toggle_buffs',
  `Toggle specific buffs on/off temporarily and show the stat impact. Config is restored after.
  
Available buffs: "flasksActive", "powerCharges", "frenzyCharges", "enduranceCharges", "onslaught", "fortify", "unholy". You can also pass raw PoB config keys.`,
  {
    buffs: {
      type: 'object',
      description: 'Buff name → true/false (e.g., {"flasksActive": true, "powerCharges": false})',
      additionalProperties: { type: 'boolean' }
    }
  },
  async ({ buffs }) => {
    const diff = await session.toggleBuffs(buffs);
    return { content: [{ type: 'text', text: formatStatDiff(diff) }] };
  }
);
```

---

## Step 7: Testing

### Test cases:
1. **get_config**: Load build, verify config returns with sections and types
2. **set_config**: Change `enemyIsBoss` to `"Shaper"`, verify DPS dropped (boss has higher defenses)
3. **set_config undo**: Set config → undo → verify original config restored
4. **simulate_scenario — mapping**: Verify stats with full buffs are higher than default
5. **simulate_scenario — pinnacle_boss**: Verify DPS lower than mapping (boss resistances)
6. **simulate_scenario restore**: After simulation, verify config unchanged
7. **compare_scenarios**: Compare "mapping" vs "pinnacle_boss", verify side-by-side table
8. **toggle_buffs**: Enable power charges, verify crit chance increased
9. **toggle_buffs restore**: After toggle, verify config unchanged
10. **Config aliasing safety**: Snapshot config → set config → restore → verify exact match with snapshot
11. **Invalid scenario name**: Pass unknown scenario, verify clean error

### Critical aliasing test:
```typescript
// This test verifies the config aliasing constraint is handled correctly
const configBefore = await session.getConfig();
await session.simulateScenario('pinnacle_boss');
const configAfter = await session.getConfig();
assert.deepEqual(configBefore, configAfter); // Must match exactly
```

---

## Key Constraints

| Constraint | How we handle it |
|-----------|-----------------|
| Config input aliased to active config set | Deep-copy in snapshotConfig (TypeScript JSON.parse(JSON.stringify(...))); Lua-side restoreConfig overwrites entire input table |
| BuildModList must be called after config changes | Every setConfig command calls BuildModList + sets buildFlag |
| Frame pump required after config change | setConfig command pumps frame before returning |
| Scenario simulation must be temporary | Uses withTemporaryChange with config snapshot/restore in finally block |
| Serial execution | All tools go through withLock; config mutations are never concurrent |

---

## Definition of Done
- [ ] `get_config` returns all config options organized by section with types and current values
- [ ] `set_config` permanently changes config with stat diff and undo support
- [ ] `simulate_scenario` temporarily applies preset configs and returns stats
- [ ] `compare_scenarios` produces side-by-side comparison across multiple scenarios
- [ ] `toggle_buffs` temporarily toggles individual buffs and shows impact
- [ ] Config aliasing is handled correctly — snapshot/restore preserves exact state
- [ ] All scenario/buff simulations leave config unchanged after completion
- [ ] All tests pass
