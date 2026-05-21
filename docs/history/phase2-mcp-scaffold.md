# Phase 2: MCP Server Scaffold with Core Stats Tools — Implementation Plan

## Goal
Create an MCP server using the `@modelcontextprotocol/sdk` package with four foundational tools: `load_build`, `get_stats`, `get_skill_breakdown`, and `list_equipped_items`. All tools go through BuildSession.

## Prerequisites
- Phase 1.5 complete: BuildSession operational with serial lock, snapshot/restore, and stats reading.

---

## Step 1: Install MCP Dependencies

### 1.1 Add to `mcp-server/package.json`
```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest"
  },
  "bin": {
    "pob-mcp": "./dist/server.js"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "dev": "tsx src/server.ts"
  }
}
```

### 1.2 MCP SDK imports
```typescript
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
```

---

## Step 2: Create `src/server.ts`

### 2.1 Server initialization

```typescript
const server = new McpServer({
  name: 'pob-mcp',
  version: '0.1.0',
});

const session = new BuildSession(REPO_ROOT, LUAJIT_PATH);
```

- `REPO_ROOT`: Resolve from `process.env.POB_PATH` or auto-detect by looking for `src/Launch.lua` relative to the MCP server location.
- `LUAJIT_PATH`: Resolve from `process.env.LUAJIT_PATH` or default to `'luajit'`.

### 2.2 Server startup

```typescript
async function main() {
  await session.start();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch(console.error);
```

**Important**: The MCP server communicates with Claude via stdio. But the Lua bridge also uses stdio. These must be separate processes with separate stdio pipes. The MCP server's stdin/stdout talk to Claude; the Lua bridge's stdin/stdout are internal child process pipes. This is already handled by `child_process.spawn()` in lua-bridge.ts.

---

## Step 3: Implement Tool — `load_build`

### 3.1 Tool definition

```typescript
server.tool(
  'load_build',
  'Load a Path of Building character build. Accepts a PoB build code (base64 encoded string), a pastebin.com URL, a pobb.in URL, or raw XML.',
  {
    source: {
      type: 'string',
      description: 'Build code (base64 string like "eNrtfW1z..."), pastebin URL, pobb.in URL, or raw XML starting with <?xml or <PathOfBuilding'
    }
  },
  async ({ source }) => {
    try {
      const info = await session.loadBuild(source);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'loaded',
            class: info.class,
            ascendancy: info.ascendancy,
            level: info.level,
            mainSkill: info.mainSkill,
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error loading build: ${error.message}` }],
        isError: true
      };
    }
  }
);
```

### 3.2 Input routing logic (already in BuildSession.loadBuild)
- URL detection: starts with `http://` or `https://`
- XML detection: starts with `<?xml` or `<PathOfBuilding`
- Otherwise: treat as base64 build code

---

## Step 4: Implement Tool — `get_stats`

### 4.1 Stat categories

Define the stat categories and which output keys map to each:

```typescript
const STAT_CATEGORIES = {
  offense: [
    'CombinedDPS', 'TotalDPS', 'CombinedAvg', 'Speed', 'HitSpeed',
    'CritChance', 'CritMultiplier', 'HitChance', 'Accuracy',
    'PhysicalDPS', 'ElementalDPS', 'ChaosDPS', 'BleedDPS',
    'PoisonDPS', 'IgniteDPS', 'TotalDotDPS', 'ImpaleDPS',
    'AverageDamage', 'ServerTriggerRate', 'ManaCost',
  ],
  defense: [
    'Life', 'EnergyShield', 'Ward', 'Mana', 'Evasion', 'Armour',
    'BlockChance', 'SpellBlockChance', 'AttackDodgeChance', 'SpellDodgeChance',
    'SpellSuppressionChance',
    'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
    'FireResistOverCap', 'ColdResistOverCap', 'LightningResistOverCap',
    'TotalEHP', 'PhysicalMaximumHitTaken', 'ElementalMaximumHitTaken',
  ],
  sustain: [
    'LifeRegen', 'LifeLeechRate', 'LifeRecoup',
    'EnergyShieldRegen', 'EnergyShieldLeechRate', 'EnergyShieldRecoup',
    'ManaRegen', 'ManaLeechRate', 'ManaRecoup',
  ],
  charges: [
    'EnduranceChargesMax', 'FrenzyChargesMax', 'PowerChargesMax',
    'EnduranceCharges', 'FrenzyCharges', 'PowerCharges',
  ],
  attributes: [
    'Str', 'Dex', 'Int',
  ],
};
```

### 4.2 Tool definition

```typescript
server.tool(
  'get_stats',
  'Get calculated stats for the currently loaded build. Returns offense, defense, sustain, charges, and attribute stats. Optionally filter by category.',
  {
    categories: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional filter: ["offense", "defense", "sustain", "charges", "attributes"]. Omit for all.',
      optional: true
    }
  },
  async ({ categories }) => {
    const stats = await session.getStats();
    const result: Record<string, any> = {};
    
    const cats = categories ?? Object.keys(STAT_CATEGORIES);
    for (const cat of cats) {
      const keys = STAT_CATEGORIES[cat];
      if (!keys) continue;
      result[cat] = {};
      for (const key of keys) {
        if (stats[key] !== undefined && stats[key] !== 0) {
          result[cat][key] = stats[key];
        }
      }
    }
    
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  }
);
```

---

## Step 5: Implement Tool — `get_skill_breakdown`

### 5.1 Lua-side support needed
Add a `getSkillBreakdown` command to bridge.lua that:
- Accesses `build.skillsTab.socketGroupList[index]`
- For the selected skill group, reads:
  - Active gem name, level, quality
  - Each support gem: name, level, quality, enabled
  - DPS contribution from `build.calcsTab.mainOutput` for this skill
  - Mana cost, cast/attack rate, damage effectiveness
- If no index given, use the main skill (identified by `build.mainSocketGroup`)

### 5.2 Tool definition

```typescript
server.tool(
  'get_skill_breakdown',
  'Get detailed breakdown of a skill group including active skill, support gems, DPS contribution, mana cost, and cast/attack speed.',
  {
    skillIndex: {
      type: 'number',
      description: 'Index of the skill group (0-based). Omit to use the main skill.',
      optional: true
    }
  },
  async ({ skillIndex }) => {
    const breakdown = await session.getSkillBreakdown(skillIndex);
    return {
      content: [{ type: 'text', text: JSON.stringify(breakdown, null, 2) }]
    };
  }
);
```

### 5.3 BuildSession method

```typescript
async getSkillBreakdown(skillIndex?: number): Promise<SkillBreakdown> {
  return this.withLock(async () => {
    return await this.bridge.send({ 
      cmd: 'getSkillBreakdown', 
      index: skillIndex 
    });
  });
}
```

---

## Step 6: Implement Tool — `list_equipped_items`

### 6.1 Lua-side support needed
Add a `listEquippedItems` command to bridge.lua that:
- Iterates `build.itemsTab.orderedSlots`
- For each slot that has an item equipped:
  - Read item rarity, base type, name
  - Read item mods (implicit, explicit, crafted, fractured, enchant) with local/global classification
  - Read quality, level requirement
  - Read sockets/links (if applicable)
- Return organized by slot name

### 6.2 Tool definition

```typescript
server.tool(
  'list_equipped_items',
  'List all currently equipped items by slot, with their mods and properties. Slot names: "Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Belt", "Flask 1"-"Flask 5".',
  {},
  async () => {
    const items = await session.listEquippedItems();
    return {
      content: [{ type: 'text', text: JSON.stringify(items, null, 2) }]
    };
  }
);
```

---

## Step 7: Create README.md

### 7.1 Contents
- Project description: MCP server for Path of Building analysis
- Prerequisites: Node.js 18+, LuaJIT, PoB repo clone
- Setup steps:
  1. `cd mcp-server && npm install`
  2. `npm run build`
  3. Set environment variables: `POB_PATH`, `LUAJIT_PATH` (optional)
- Claude Desktop registration:
  ```json
  {
    "mcpServers": {
      "pob": {
        "command": "node",
        "args": ["/path/to/mcp-server/dist/server.js"],
        "env": {
          "POB_PATH": "/path/to/PathOfBuilding"
        }
      }
    }
  }
  ```
- Tool list with brief descriptions
- Known limitations (single build at a time, no trade API)

---

## Step 8: Manual Testing

### 8.1 Test with MCP Inspector
- Use `@modelcontextprotocol/inspector` to test tools interactively
- Verify each tool with a known build code

### 8.2 Test sequence
1. Start server: `npm run dev`
2. Call `load_build` with a known build code
3. Call `get_stats` — verify offense/defense numbers look reasonable
4. Call `get_skill_breakdown` — verify main skill details
5. Call `list_equipped_items` — verify all slots reported
6. Call `get_stats` with category filter `["defense"]` — verify only defense stats returned
7. Call `load_build` with a pastebin URL — verify URL fetching works
8. Call `load_build` with invalid input — verify clean error message

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| MCP stdio transport | Standard for Claude Desktop integration; Lua bridge uses separate child process pipes |
| Stat categories as curated key lists | Raw output table has hundreds of keys; curated lists surface the most useful stats |
| Non-zero filter on stats | Avoids cluttering output with irrelevant zero-value stats |
| Environment variables for paths | Flexible deployment; no hardcoded paths |
| `isError: true` on tool failures | MCP convention for error reporting; Claude handles these gracefully |

---

## Definition of Done
- [ ] MCP server starts and accepts stdio connections
- [ ] `load_build` handles build codes, pastebin URLs, pobb.in URLs, and raw XML
- [ ] `get_stats` returns categorized stats with optional filtering
- [ ] `get_skill_breakdown` returns detailed skill/gem information
- [ ] `list_equipped_items` returns all equipped items with mods
- [ ] README.md documents setup and Claude Desktop registration
- [ ] Manual testing passes with at least 2 different builds
