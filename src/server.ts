#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BuildSession, ComparisonResult, DiagnosticCheck, StatDiffResult, UpgradeSuggestion } from './build-session.js';
import { LuaBridge, Stats } from './lua-bridge.js';
import { LuaJITNotFoundError, PoBInstallNotFoundError, ResolvedPaths, resolvePaths } from './paths.js';
import { startTimer } from './timing.js';
import { UserError, validateBuildSource, validateItemText, validateSlot } from './validation.js';

// ---------------------------------------------------------------------------
// Path / config resolution
// ---------------------------------------------------------------------------

function resolvePathsOrExit(): ResolvedPaths {
  try {
    return resolvePaths();
  } catch (e) {
    if (e instanceof PoBInstallNotFoundError || e instanceof LuaJITNotFoundError) {
      process.stderr.write(`pob-mcp-server: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}

const PATHS = resolvePathsOrExit();

// ---------------------------------------------------------------------------
// Stat categories
// ---------------------------------------------------------------------------

const STAT_CATEGORIES: Record<string, string[]> = {
  offense: [
    'CombinedDPS', 'TotalDPS', 'CombinedAvg', 'AverageDamage', 'Speed', 'HitSpeed',
    'CritChance', 'CritMultiplier', 'HitChance', 'Accuracy',
    'PhysicalDPS', 'ElementalDPS', 'ChaosDPS', 'BleedDPS',
    'PoisonDPS', 'IgniteDPS', 'TotalDot', 'TotalDotDPS', 'ImpaleDPS',
    'WithBleedDPS', 'WithPoisonDPS', 'WithIgniteDPS',
    'ServerTriggerRate', 'ManaCost', 'FullDPS',
  ],
  defense: [
    'Life', 'EnergyShield', 'Ward', 'Mana', 'Evasion', 'Armour',
    'BlockChance', 'SpellBlockChance', 'AttackDodgeChance', 'SpellDodgeChance',
    'SpellSuppressionChance',
    'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
    'FireResistOverCap', 'ColdResistOverCap', 'LightningResistOverCap', 'ChaosResistOverCap',
    'TotalEHP', 'PhysicalMaximumHitTaken', 'ElementalMaximumHitTaken',
  ],
  sustain: [
    'LifeRegen', 'NetLifeRegen', 'LifeLeechGainRate', 'LifeLeechRate', 'LifeRecoup',
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
  movement: [
    'EffectiveMovementSpeedMod', 'MovementSpeedMod',
  ],
};

const ALL_CATEGORIES = Object.keys(STAT_CATEGORIES);

function categorizeStats(stats: Stats, categories?: string[]): Record<string, Record<string, unknown>> {
  const cats = categories && categories.length > 0 ? categories : ALL_CATEGORIES;
  const result: Record<string, Record<string, unknown>> = {};
  for (const cat of cats) {
    const keys = STAT_CATEGORIES[cat];
    if (!keys) continue;
    const bucket: Record<string, unknown> = {};
    for (const key of keys) {
      const value = stats[key];
      if (value === undefined || value === null) continue;
      if (typeof value === 'number' && value === 0) continue;
      bucket[key] = value;
    }
    result[cat] = bucket;
  }
  return result;
}

function textResponse(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

const KEY_STAT_KEYS = ['CombinedDPS', 'Life', 'EnergyShield', 'TotalEHP'] as const;
type KeyStatKey = (typeof KEY_STAT_KEYS)[number];

function keyDeltas(diff: Record<string, { delta: number } | undefined>): Record<KeyStatKey, number> {
  return {
    CombinedDPS: diff.CombinedDPS?.delta ?? 0,
    Life: diff.Life?.delta ?? 0,
    EnergyShield: diff.EnergyShield?.delta ?? 0,
    TotalEHP: diff.TotalEHP?.delta ?? 0,
  };
}

function keyStats(stats: Stats): Record<KeyStatKey, number> {
  return {
    CombinedDPS: Number(stats.CombinedDPS ?? 0),
    Life: Number(stats.Life ?? 0),
    EnergyShield: Number(stats.EnergyShield ?? 0),
    TotalEHP: Number(stats.TotalEHP ?? 0),
  };
}

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
  // Errors thrown from Lua arrive as plain Error (no UserError flag survives
  // the JSON boundary), so fall back to keyword sniffing to surface obvious
  // user-input messages verbatim. "failed" is deliberately omitted — it shows
  // up in genuine internal errors ("LoadModule() error", "SaveDB ... failed").
  if (
    /\b(not found|invalid|must be|missing|unknown|empty|too short|out of range|unrecognised|unrecognized|not allowed)\b/i.test(message) &&
    message.length < 240
  ) {
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    };
  }
  // For unknown internal errors, hint at recovery without leaking stack traces.
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
// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------

const bridge = new LuaBridge(PATHS, 60_000);
const session = new BuildSession(bridge);

const server = new McpServer({
  name: 'pob-mcp',
  version: '0.1.0',
});

server.registerTool(
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
      return textResponse({
        status: 'loaded',
        class: info.class,
        ascendancy: info.ascendancy,
        level: info.level,
        mainSkill: info.mainSkill,
      });
    } catch (error) {
      return errorResponse(error);
    } finally {
      stop();
    }
  },
);

server.registerTool(
  'get_stats',
  {
    description:
      'Get calculated stats for the currently loaded build, organized by category. Categories: offense, defense, sustain, charges, attributes, movement. Returns only non-zero stats.',
    inputSchema: {
      categories: z
        .array(z.enum(['offense', 'defense', 'sustain', 'charges', 'attributes', 'movement']))
        .optional()
        .describe('Optional category filter. Omit for all categories.'),
    },
  },
  async ({ categories }) => {
    try {
      const stats = await session.getStats();
      return textResponse(categorizeStats(stats, categories));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'get_skill_breakdown',
  {
    description:
      'Get detailed breakdown of a skill group: active gem, support gems (with levels and qualities), and DPS stats when it is the main skill group.',
    inputSchema: {
      skillIndex: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('1-based index of the socket group. Omit to use the main skill group.'),
    },
  },
  async ({ skillIndex }) => {
    try {
      const breakdown = await session.getSkillBreakdown(skillIndex);
      return textResponse(breakdown);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'list_equipped_items',
  {
    description:
      'List all currently equipped items by slot, including rarity, base type, mods (implicit/explicit/crafted/fractured/enchant), quality, item level, and sockets.',
    inputSchema: {},
  },
  async () => {
    try {
      const items = await session.listEquippedItems();
      return textResponse({ count: items.length, items });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Phase 3 tools: item swap / compare
// ---------------------------------------------------------------------------

function summarizeStatDiff(result: StatDiffResult): unknown {
  const summary: Record<string, Record<string, { before: unknown; after: unknown; delta: number }>> = {};
  for (const [cat, keys] of Object.entries(STAT_CATEGORIES)) {
    const bucket: Record<string, { before: unknown; after: unknown; delta: number }> = {};
    for (const key of keys) {
      const d = result.diff[key];
      if (d) bucket[key] = d;
    }
    if (Object.keys(bucket).length > 0) summary[cat] = bucket;
  }
  return {
    diff: summary,
    keyDeltas: keyDeltas(result.diff),
  };
}

function summarizeComparison(result: ComparisonResult): unknown {
  return {
    baseline: {
      slot: result.baseline.item.slot,
      itemId: result.baseline.item.itemId,
      hasItem: result.baseline.item.itemText !== null,
      keyStats: keyStats(result.baseline.stats),
    },
    candidates: result.candidates.map((c) => ({
      index: c.index,
      error: c.error,
      keyDeltas: c.error ? null : keyDeltas(c.diff),
      stats: c.stats,
      diff: c.diff,
    })),
    bestForDPS: result.bestForDPS,
    bestForEHP: result.bestForEHP,
    bestForLife: result.bestForLife,
  };
}

server.registerTool(
  'list_valid_slots',
  {
    description:
      'List all currently valid equipment slot names (including any active jewel slots) along with whether each slot is occupied.',
    inputSchema: {},
  },
  async () => {
    try {
      const slots = await session.getValidSlots();
      return textResponse({ count: slots.length, slots });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'get_item_in_slot',
  {
    description:
      'Get the full item text and parsed metadata for whatever is equipped in a slot. Returns null when the slot is empty.',
    inputSchema: {
      slot: z.string().min(1).describe('Equipment slot name (e.g. "Ring 1", "Body Armour").'),
    },
  },
  async ({ slot }) => {
    try {
      const item = await session.getItemInSlot(slot);
      if (!item) return textResponse({ slot, empty: true, item: null });
      return textResponse({ slot, empty: false, item });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'swap_item',
  {
    description:
      'Equip an item in a slot and return the before/after stat diff. PERMANENTLY mutates the build (use undo_last_change to revert).',
    inputSchema: {
      slot: z.string().min(1).describe('Equipment slot name.'),
      itemText: z
        .string()
        .min(1)
        .describe('Full item text in PoB format (rarity, name, base, mods).'),
    },
  },
  async ({ slot, itemText }) => {
    try {
      validateSlot(slot);
      validateItemText(itemText);
      const result = await session.swapItemWithDiff(slot, itemText);
      return textResponse(summarizeStatDiff(result));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'unequip_item',
  {
    description:
      'Remove the item from a slot and return the before/after stat diff. PERMANENTLY mutates the build (use undo_last_change to revert).',
    inputSchema: {
      slot: z.string().min(1).describe('Equipment slot name to clear.'),
    },
  },
  async ({ slot }) => {
    try {
      validateSlot(slot);
      const result = await session.unequipItemWithDiff(slot);
      return textResponse(summarizeStatDiff(result));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'compare_items',
  {
    description:
      'Compare 2-5 candidate items in a slot against the currently equipped item. Each candidate is tested sequentially with full state restoration; the build returns to its original state when finished.',
    inputSchema: {
      slot: z.string().min(1).describe('Equipment slot to compare in.'),
      items: z
        .array(z.string().min(1))
        .min(2)
        .max(5)
        .describe('Array of 2-5 item texts to compare (PoB format).'),
    },
  },
  async ({ slot, items }) => {
    try {
      validateSlot(slot);
      // Per-item validation is deliberately not run here; compareItems
      // captures per-candidate failures into its results, which lets a
      // partially-bad batch still surface useful diffs for the good entries.
      const result = await session.compareItems(slot, items);
      return textResponse(summarizeComparison(result));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'undo_last_change',
  {
    description:
      'Undo the most recent build mutation (swap_item, unequip_item, allocate_node, etc.). Returns the stats after undo.',
    inputSchema: {},
  },
  async () => {
    try {
      const stats = await session.undoLastChange();
      return textResponse({ status: 'reverted', stats });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Phase 4 tools: passive tree analysis
// ---------------------------------------------------------------------------

server.registerTool(
  'get_passive_tree',
  {
    description:
      'Return the full passive tree state: all allocated nodes with stats, active keystones, allocated notables, point counts, and class info.',
    inputSchema: {},
  },
  async () => {
    try {
      const tree = await session.getPassiveTree();
      return textResponse(tree);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'simulate_passive_change',
  {
    description:
      'Temporarily allocate or deallocate passive nodes and return the stat diff. Always restores the original tree afterward. Validates that the resulting tree is connected.',
    inputSchema: {
      allocate: z
        .array(z.union([z.string(), z.number().int()]))
        .optional()
        .describe('Node names (e.g. "Resolute Technique") or numeric node IDs to allocate.'),
      deallocate: z
        .array(z.union([z.string(), z.number().int()]))
        .optional()
        .describe('Node names or numeric node IDs to deallocate.'),
    },
  },
  async ({ allocate, deallocate }) => {
    try {
      const result = await session.simulatePassiveChange(allocate ?? [], deallocate ?? []);
      return textResponse({
        valid: result.valid,
        validationErrors: result.validationErrors,
        keyDeltas: keyDeltas(result.statDiff),
        statDiff: result.statDiff,
      });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'find_best_next_nodes',
  {
    description:
      'Iterate every reachable unallocated node, simulate allocating each, and rank by improvement of the chosen stat. Skips jewel sockets by default. Build is restored after the scan. May take 10-60s on large trees.',
    inputSchema: {
      count: z.number().int().positive().max(50).optional().describe('Top-N to return (default 10).'),
      optimizeFor: z
        .string()
        .optional()
        .describe('Stat key to optimize (default "CombinedDPS"). Examples: "Life", "TotalEHP", "ManaRegen".'),
      includeJewelSockets: z
        .boolean()
        .optional()
        .describe('Include jewel sockets (default false — they have global radius effects).'),
    },
  },
  async ({ count, optimizeFor, includeJewelSockets }) => {
    try {
      const rankings = await session.findBestNextNodes(
        count ?? 10,
        optimizeFor ?? 'CombinedDPS',
        includeJewelSockets ?? false,
      );
      return textResponse({ optimizeFor: optimizeFor ?? 'CombinedDPS', count: rankings.length, rankings });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'find_worst_allocated_nodes',
  {
    description:
      'Find the least valuable currently-allocated nodes by simulating their removal. Skips keystones, ascendancy nodes, jewel sockets, masteries, and any node whose removal disconnects the tree.',
    inputSchema: {
      count: z.number().int().positive().max(50).optional().describe('Top-N to return (default 10).'),
      optimizeFor: z
        .string()
        .optional()
        .describe('Stat key to evaluate value by (default "CombinedDPS").'),
    },
  },
  async ({ count, optimizeFor }) => {
    try {
      const rankings = await session.findWorstAllocatedNodes(count ?? 10, optimizeFor ?? 'CombinedDPS');
      return textResponse({ optimizeFor: optimizeFor ?? 'CombinedDPS', count: rankings.length, rankings });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'evaluate_keystone',
  {
    description:
      'Toggle a keystone (add if not allocated, remove if allocated) and return the full stat diff. Tree is restored afterward.',
    inputSchema: {
      keystone: z
        .string()
        .min(1)
        .describe('Keystone name (e.g. "Resolute Technique", "Chaos Inoculation", "Mind Over Matter").'),
    },
  },
  async ({ keystone }) => {
    try {
      const result = await session.evaluateKeystone(keystone);
      return textResponse({
        keystone: result.keystone,
        currentlyAllocated: result.currentlyAllocated,
        action: result.action,
        nodeStats: result.nodeStats,
        keyDeltas: keyDeltas(result.statDiff),
        statDiff: result.statDiff,
      });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Phase 5 tools: skill gems
// ---------------------------------------------------------------------------

server.registerTool(
  'list_skill_groups',
  {
    description:
      'List every socket group (skill setup) with active gems, support gems, slot, label, and which group is the main skill.',
    inputSchema: {},
  },
  async () => {
    try {
      const groups = await session.listSkillGroups();
      const formatted = groups.map((g) => ({
        index: g.index,
        label: g.label,
        slot: g.slotName,
        enabled: g.enabled,
        isMainSkill: g.isMainGroup,
        activeGems: g.gems.filter((gem) => !gem.isSupport),
        supportGems: g.gems.filter((gem) => gem.isSupport),
      }));
      return textResponse({ count: formatted.length, groups: formatted });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'lookup_gem',
  {
    description:
      'Look up gem metadata by name (active or support). Returns tags, color, requirements, max level, and whether it is a support / vaal / awakened gem.',
    inputSchema: {
      name: z.string().min(1).describe('Gem name. Fuzzy abbreviations supported (e.g. "Mlts" → Multistrike).'),
    },
  },
  async ({ name }) => {
    try {
      const gem = await session.getGemByName(name);
      return textResponse(gem);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'list_available_supports',
  {
    description:
      'List all support gems known to PoB. Optionally filter by tag overlap with an active skill (coarse — does not replicate full PoB CanSupport logic).',
    inputSchema: {
      activeSkillTags: z
        .array(z.string().min(1))
        .optional()
        .describe('Tags to require on the support (e.g. ["spell","cold"]). Support must share at least one tag.'),
      includeAwakened: z.boolean().optional().describe('Include Awakened variants (default false).'),
    },
  },
  async ({ activeSkillTags, includeAwakened }) => {
    try {
      const supports = await session.getAvailableSupports(activeSkillTags, includeAwakened ?? false);
      return textResponse({ count: supports.length, supports });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'swap_gem',
  {
    description:
      'Temporarily swap a single gem in a skill group and return the stat diff. The original gem is restored after the call. Does NOT push undo (no permanent mutation).',
    inputSchema: {
      skillGroupIndex: z.number().int().positive().describe('1-based index from list_skill_groups.'),
      gemIndex: z.number().int().positive().describe('1-based index of the gem within the group.'),
      newGemName: z.string().min(1).describe('Replacement gem name.'),
      level: z.number().int().min(1).max(40).optional().describe('Gem level (default keeps current).'),
      quality: z.number().int().min(0).max(40).optional().describe('Gem quality (default keeps current).'),
    },
  },
  async ({ skillGroupIndex, gemIndex, newGemName, level, quality }) => {
    try {
      const result = await session.swapGemWithDiff(skillGroupIndex, gemIndex, newGemName, level, quality);
      return textResponse(summarizeStatDiff(result));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'compare_supports',
  {
    description:
      'Identify the weakest enabled support in a skill group (by simulating its removal) and rank candidate replacements by resulting DPS. Build is restored after.',
    inputSchema: {
      skillGroupIndex: z.number().int().positive().describe('1-based index of the skill group.'),
      candidates: z
        .array(z.string().min(1))
        .min(1)
        .max(10)
        .describe('1-10 candidate support gem names (e.g. ["Brutality","Melee Physical Damage"]).'),
    },
  },
  async ({ skillGroupIndex, candidates }) => {
    try {
      const result = await session.compareSupports(skillGroupIndex, candidates);
      return textResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'evaluate_gem_levels',
  {
    description:
      'Show how DPS scales with gem level for a specific gem. Default tests the current level ±1 through +4 (capped at 24); pass `levels` to override.',
    inputSchema: {
      skillGroupIndex: z.number().int().positive().describe('1-based skill group index.'),
      gemIndex: z.number().int().positive().describe('1-based gem index within the group.'),
      levels: z
        .array(z.number().int().min(1).max(40))
        .optional()
        .describe('Explicit list of levels to test.'),
    },
  },
  async ({ skillGroupIndex, gemIndex, levels }) => {
    try {
      const scaling = await session.evaluateGemLevels(skillGroupIndex, gemIndex, levels);
      return textResponse({ count: scaling.length, scaling });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'find_optimal_links',
  {
    description:
      'Find an optimal support gem combination for an active skill. Heuristic: rank supports individually, take top N, then try swap-with-next to detect synergies. The MAIN skill group is mutated and restored. May take 30-90 seconds.',
    inputSchema: {
      activeSkill: z.string().min(1).describe('Active skill gem name (e.g. "Vortex").'),
      availableSlots: z
        .number()
        .int()
        .min(1)
        .max(7)
        .describe('Total gem slots including the active skill (e.g. 6 for a 6-link).'),
      constraints: z
        .array(z.string().min(1))
        .optional()
        .describe('Support gems that MUST be included.'),
      topN: z.number().int().min(5).max(40).optional().describe('Pool size for single-support phase (default 25).'),
    },
  },
  async ({ activeSkill, availableSlots, constraints, topN }) => {
    try {
      const result = await session.findOptimalLinks(
        activeSkill,
        availableSlots - 1, // active skill consumes one slot; remaining are supports
        constraints ?? [],
        { topN },
      );
      return textResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Phase 6 tools: configuration and combat scenarios
// ---------------------------------------------------------------------------

server.registerTool(
  'get_config',
  {
    description:
      "Return all of PoB's config / scenario options organized by section, with each option's type, label, current value, and (for list options) valid choices. Common keys: enemyIsBoss, usePowerCharges, useFrenzyCharges, useEnduranceCharges, conditionOnslaught, customMods.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await session.getConfigOrganized();
      return textResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'set_config',
  {
    description:
      'PERMANENTLY apply config changes (with undo). Returns a categorized stat diff. Pair with `undo_last_change` to revert. Pass raw PoB config keys (e.g. {"enemyIsBoss":"Pinnacle","usePowerCharges":true}).',
    inputSchema: {
      options: z
        .record(z.string(), z.union([z.boolean(), z.number(), z.string()]))
        .describe('Map of config key → value (boolean / number / string).'),
    },
  },
  async ({ options }) => {
    try {
      const result = await session.setConfigWithUndo(options);
      return textResponse(summarizeStatDiff(result));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'list_scenarios',
  {
    description:
      'List the named combat scenarios understood by `simulate_scenario` and `compare_scenarios`. Each entry returns the underlying config option overrides applied.',
    inputSchema: {},
  },
  async () => {
    try {
      const scenarios = BuildSession.listScenarios();
      return textResponse({ count: scenarios.length, scenarios });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'simulate_scenario',
  {
    description:
      "Temporarily apply a named combat scenario preset (e.g. 'mapping', 'pinnacle_boss') and return the stat diff vs the current config. Build state is fully restored after.",
    inputSchema: {
      scenario: z
        .string()
        .min(1)
        .describe('Scenario preset name (see `list_scenarios`).'),
    },
  },
  async ({ scenario }) => {
    try {
      const result = await session.simulateScenario(scenario);
      const diffSummary = summarizeStatDiff({ before: result.before, after: result.after, diff: result.diff });
      return textResponse({
        scenario: result.scenario,
        description: result.description,
        appliedOptions: result.options,
        ...(diffSummary as Record<string, unknown>),
      });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'compare_scenarios',
  {
    description:
      'Compare 2-6 named scenarios side-by-side. Each scenario is simulated independently with config restore between them. Returns baseline stats plus one entry per scenario with its diff.',
    inputSchema: {
      scenarios: z
        .array(z.string().min(1))
        .min(2)
        .max(6)
        .describe('Scenario preset names (e.g. ["mapping","pinnacle_boss","uber_boss"]).'),
    },
  },
  async ({ scenarios }) => {
    try {
      const result = await session.compareScenarios(scenarios);
      const rows = result.scenarios.map((s) => ({
        scenario: s.scenario,
        description: s.description,
        keyDeltas: keyDeltas(s.diff),
        keyStats: keyStats(s.after),
      }));
      return textResponse({ baseline: keyStats(result.baseline), scenarios: rows });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'toggle_buffs',
  {
    description:
      'Temporarily toggle individual buffs / charges and return the stat impact. Build state is restored after. Friendly aliases: powerCharges, frenzyCharges, enduranceCharges, onslaught, fortify, flasks, unholyMight; raw PoB config keys also accepted.',
    inputSchema: {
      buffs: z
        .record(z.string(), z.union([z.boolean(), z.number(), z.string()]))
        .describe('Map of buff name → desired value (e.g. {"powerCharges":true,"onslaught":false}).'),
    },
  },
  async ({ buffs }) => {
    try {
      const result = await session.toggleBuffs(buffs);
      return textResponse(summarizeStatDiff(result));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Phase 7: Optimization advisor
// ---------------------------------------------------------------------------

function formatDiagnostics(checks: DiagnosticCheck[]): string {
  if (checks.length === 0) return 'No issues found — build looks solid!';
  const lines: string[] = ['## Build Diagnosis', ''];
  for (const c of checks) {
    const tag = c.severity === 'critical' ? '[CRITICAL]' : c.severity === 'warning' ? '[WARNING]' : '[INFO]';
    lines.push(`${tag} (${c.category}) ${c.message}`);
    lines.push(`  -> ${c.suggestion}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function formatUpgrades(suggestions: UpgradeSuggestion[]): string {
  const lines: string[] = ['## Upgrade Suggestions (lowest contribution first)', ''];
  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    lines.push(`${i + 1}. ${s.slot}${s.empty ? ' (EMPTY)' : ''}`);
    if (s.currentItemName) lines.push(`   Current: ${s.currentItemName}`);
    lines.push(
      `   Contribution: ${Math.round(s.dpsContribution).toLocaleString()} DPS, ${Math.round(s.ehpContribution).toLocaleString()} EHP (priority ${s.priority}/100)`,
    );
    if (s.suggestedMods.length > 0) lines.push(`   Look for: ${s.suggestedMods.join(', ')}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

server.registerTool(
  'diagnose_build',
  {
    description:
      'Run a comprehensive read-only analysis of the current build. Identifies uncapped resistances, low EHP, crit/hit-chance issues, sub-level-20 main gems, missing movement/guard skills, etc. Pass `focus` to narrow to defense, offense, qol, or balance.',
    inputSchema: {
      focus: z
        .enum(['defense', 'offense', 'qol', 'balance'])
        .optional()
        .describe('Limit checks to a specific category. Defaults to all.'),
    },
  },
  async ({ focus }) => {
    try {
      const checks = await session.diagnoseBuild(focus);
      return {
        content: [
          { type: 'text', text: formatDiagnostics(checks) },
          { type: 'text', text: JSON.stringify({ checks }, null, 2) },
        ],
      };
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'suggest_upgrades',
  {
    description:
      'Rank equipment slots by upgrade priority. Each slot is briefly unequipped to measure its current DPS/EHP contribution; lowest contributors are flagged for replacement. Provides archetype-aware mod suggestions. Build state is fully restored after the scan.',
    inputSchema: {
      slot: z.string().optional().describe('Focus on a specific slot (e.g. "Body Armour"). Omit for all slots.'),
      budget: z.enum(['low', 'medium', 'high']).optional().describe('Budget tier to bias suggestions.'),
    },
  },
  async ({ slot, budget }) => {
    try {
      const suggestions = await session.suggestUpgrades(slot, budget);
      return {
        content: [
          { type: 'text', text: formatUpgrades(suggestions) },
          { type: 'text', text: JSON.stringify({ suggestions }, null, 2) },
        ],
      };
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'export_build',
  {
    description:
      'Export the current build state. Format "summary" returns a human-readable stat summary (default), "xml" returns raw PoB XML, and "code" returns a base64-deflated PoB import code.',
    inputSchema: {
      format: z.enum(['summary', 'xml', 'code']).optional().describe('Export format. Defaults to "summary".'),
    },
  },
  async ({ format }) => {
    try {
      const text = await session.exportBuild(format ?? 'summary');
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'snapshot_and_compare',
  {
    description:
      'Take a labeled snapshot of current stats, list saved snapshots, or diff two snapshots. Use to track cumulative impact of multiple changes. Snapshots are session-scoped and store stats only (not items/tree).',
    inputSchema: {
      action: z.enum(['take', 'compare', 'list']).describe('"take" saves a snapshot; "compare" diffs two; "list" shows labels.'),
      label: z.string().optional().describe('Label for "take".'),
      labelA: z.string().optional().describe('First snapshot label for "compare".'),
      labelB: z.string().optional().describe('Second snapshot label for "compare". Use "current" for live stats.'),
    },
  },
  async ({ action, label, labelA, labelB }) => {
    try {
      switch (action) {
        case 'take': {
          if (!label) return errorResponse(new UserError('label required for action "take"'));
          const stats = await session.takeSnapshot(label);
          return textResponse({ status: 'saved', label, stats });
        }
        case 'list': {
          return textResponse({ snapshots: session.listSnapshotLabels() });
        }
        case 'compare': {
          if (!labelA || !labelB) return errorResponse(new UserError('labelA and labelB required for action "compare"'));
          let bLabel = labelB;
          if (labelB === 'current') {
            bLabel = '__current_compare__';
            await session.takeSnapshot(bLabel);
          }
          const diff = session.diffSnapshots(labelA, bLabel);
          return textResponse({ from: labelA, to: labelB, diff });
        }
      }
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'reset_build',
  {
    description:
      'Reset the build to its original state (as it was when first loaded). All session mutations (item swaps, tree changes, gem swaps, config changes) are reverted.',
    inputSchema: {},
  },
  async () => {
    try {
      const info = await session.resetBuild();
      return textResponse({
        status: 'reset',
        class: info.class,
        ascendancy: info.ascendancy,
        level: info.level,
        mainSkill: info.mainSkill,
      });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Pre-warm the Lua bridge so the first tool call is fast. Must complete
  // before MCP transport accepts requests — start()'s early-exit only checks
  // that the subprocess is alive, not that init has finished, so a concurrent
  // tool call would race with spawnProcess's end-of-init replay.
  await bridge.start();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await bridge.shutdown();
    } catch {
      bridge.killProcess();
    }
    process.exit(reason === 'error' ? 1 : 0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Stdin EOF means the MCP client disconnected. On Windows there is no
  // reliable SIGTERM from a parent on pipe close, so without this the lua
  // subprocess leaks and keeps the parent's stdout pipe open — orphaning
  // the whole process tree from the spawner's point of view.
  process.stdin.on('end', () => void shutdown('stdin-eof'));
  process.stdin.on('close', () => void shutdown('stdin-close'));
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('pob-mcp failed to start:', error);
  bridge.killProcess();
  process.exit(1);
});
