#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  BuildSession,
  ComparisonResult,
  DEFAULT_MOD_SLOTS,
  computeDiff,
  EquippedItem,
  ItemModLine,
  PassiveTreeInfo,
  SCENARIO_NAMES,
  SkillGemInstance,
  StatDiffResult,
  TreeEditNode,
  TreeEditResult,
} from './build-session.js';
import { registerBuildEditTools } from './build-edit-tools.js';
import { registerEvaluateChanges } from './evaluate-changes.js';
import { createPathPrompt, registerEngineTools } from './engine-tools.js';
import { EngineManager } from './engine-manager.js';
import type { Stats } from './lua-bridge.js';
import { startTimer } from './timing.js';
import { registerTradeTools } from './trade-search.js';
import { registerStatWeights } from './stat-weights.js';
import { createToolRegistrar } from './tool-registry.js';
import { DEFAULT_LINK_POOL, EXHAUSTIVE_BUDGET, MAX_COMBINATIONS } from './link-search.js';
import { DEFAULT_MAX_POINTS, MAX_MAX_POINTS, MAX_SEARCH_FALLBACKS } from './tree-search.js';
import { UserError, validateBuildSource, validateItemText, validateSlot } from './validation.js';

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

/** The union of the PoB output keys of the given categories (all categories when none are given). */
function statKeysForCategories(categories?: string[]): string[] {
  const cats = categories && categories.length > 0 ? categories : ALL_CATEGORIES;
  const keys = new Set<string>();
  for (const cat of cats) for (const key of STAT_CATEGORIES[cat] ?? []) keys.add(key);
  return [...keys];
}

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

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------

// The engine (LuaJIT + PoB) is resolved and booted lazily/in the background so
// the MCP transport always comes up — even when PoB or LuaJIT cannot be found.
const engine = new EngineManager();

const server = new McpServer({
  name: 'pob-mcp',
  version: '0.1.0',
});

const tools = createToolRegistrar(server, engine);

registerEngineTools(tools, engine);
registerTradeTools(tools);
registerStatWeights(tools);
registerEvaluateChanges(tools);

tools.engine<{ source: string }>(
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
  async ({ source }, session) => {
    const stop = startTimer('tool.load_build');
    try {
      const cleaned = validateBuildSource(source);
      const info = await session.loadBuild(cleaned);
      return {
        status: 'loaded',
        class: info.class,
        ascendancy: info.ascendancy,
        level: info.level,
        mainSkill: info.mainSkill,
        ...(info.engineRestart ? { engineRestart: info.engineRestart } : {}),
      };
    } finally {
      stop();
    }
  },
);

tools.engine<{
  categories?: Array<'offense' | 'defense' | 'sustain' | 'charges' | 'attributes' | 'movement'>;
  stats?: string[];
}>(
  'get_stats',
  {
    description:
      'Get calculated stats for the currently loaded build, organized by category. Categories: offense, defense, sustain, charges, attributes, movement. Returns only non-zero stats. ' +
      'Pass `stats` instead to read exactly those Path of Building output keys (any key PoB calculates, e.g. ["CombinedDPS","Life","CritChance"]): the result is then `{ stats: { key: value } }` with null for a key PoB does not have, and `categories` is ignored.',
    inputSchema: {
      categories: z
        .array(z.enum(['offense', 'defense', 'sustain', 'charges', 'attributes', 'movement']))
        .optional()
        .describe('Optional category filter. Omit for all categories.'),
      stats: z
        .array(z.string().min(1))
        .min(1)
        .max(200)
        .optional()
        .describe('Exact PoB output stat keys to return (unknown keys come back as null).'),
    },
  },
  async ({ categories, stats: keys }, session) => {
    if (keys) {
      const { base } = await session.probe({ stats: [...new Set(keys)], variants: [] });
      return { stats: base };
    }
    // The bridge's default stat list covers only a few keys; read every key of the
    // requested categories through the probe's base read (no recalc, build untouched).
    const { base } = await session.probe({ stats: statKeysForCategories(categories), variants: [] });
    return categorizeStats(base as Stats, categories);
  },
);

tools.engine<{ skillIndex?: number }>(
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
  async ({ skillIndex }, session) => {
    return session.getSkillBreakdown(skillIndex);
  },
);

/** A mod line with only its true flags (`{ line, crafted: true }`), so `line` and flag checks keep working. */
function compactMod(mod: ItemModLine): Partial<ItemModLine> & { line: string } {
  const out: Partial<ItemModLine> & { line: string } = { line: mod.line };
  for (const flag of ['crafted', 'fractured', 'enchant', 'implicit'] as const) {
    if (mod[flag]) out[flag] = true;
  }
  return out;
}

/** An equipped item without its item text and false flags (detail: 'full' gives everything). */
function compactItem(item: EquippedItem, includeItemText: boolean): Record<string, unknown> {
  const { raw, implicits, explicits, enchants, corrupted, shaper, elder, ...rest } = item;
  return {
    ...rest,
    ...(corrupted ? { corrupted } : {}),
    ...(shaper ? { shaper } : {}),
    ...(elder ? { elder } : {}),
    implicits: implicits.map(compactMod),
    explicits: explicits.map(compactMod),
    enchants: enchants.map(compactMod),
    ...(includeItemText && raw !== undefined ? { raw } : {}),
  };
}

const detailSchema = z.enum(['summary', 'full']);

tools.engine<{ detail?: 'summary' | 'full'; includeItemText?: boolean }>(
  'list_equipped_items',
  {
    description:
      'List all currently equipped items by slot, including rarity, base type, mods (implicit/explicit/crafted/fractured/enchant), quality, item level, and sockets. ' +
      'An item in a slot Path of Building hides on this passive tree (Wickerman Head/Body/Arm/Leg off 3.30, Graft 1/2 off 3.27) is listed with hidden: true and a note: PoB still counts a hidden Wickerman item in its calculations but ignores a hidden graft; unequip_item removes either. ' +
      'By default each mod is `{ line }` plus only its true flags (e.g. `crafted: true`), false item flags are left out and the item text is not included; ' +
      '`includeItemText: true` adds each item\'s PoB text as `raw`; `detail: "full"` returns every field (all flags and `raw`).',
    inputSchema: {
      detail: detailSchema.optional().describe('"summary" (default) or "full" (every field, including the item text).'),
      includeItemText: z.boolean().optional().describe('Add each item\'s PoB "Copy item" text as `raw` (default false).'),
    },
  },
  async ({ detail, includeItemText }, session) => {
    const items = await session.listEquippedItems();
    if (detail === 'full') return { count: items.length, items };
    return { count: items.length, items: items.map((item) => compactItem(item, includeItemText === true)) };
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

tools.engine<Record<string, never>>(
  'list_valid_slots',
  {
    description:
      'List all currently valid equipment slot names (including any active jewel slots) along with whether each slot is occupied. Slots Path of Building hides on this passive tree are left out: the Wickerman slots (Head, Body, Arm, Leg) appear only on 3.30 trees, Graft 1/2 only on 3.27 trees.',
    inputSchema: {},
  },
  async (_args, session) => {
    const slots = await session.getValidSlots();
    return { count: slots.length, slots };
  },
);

tools.engine<{ slot: string }>(
  'get_item_in_slot',
  {
    description:
      'Get the full item text and parsed metadata for whatever is equipped in a slot. Returns null when the slot is empty.',
    inputSchema: {
      slot: z.string().min(1).describe('Equipment slot name (e.g. "Ring 1", "Body Armour").'),
    },
  },
  async ({ slot }, session) => {
    const item = await session.getItemInSlot(slot);
    if (!item) return { slot, empty: true, item: null };
    return { slot, empty: false, item };
  },
);

tools.engine<{ slot: string; itemText: string }>(
  'swap_item',
  {
    description:
      'Equip an item in a slot and return the before/after stat diff. PERMANENTLY mutates the build (use undo_last_change to revert). The replaced item stays in the build\'s item list, unequipped (as in PoB\'s UI), until undo_last_change, reset_build or a new load_build. An item that cannot go in the slot, a slot Path of Building hides on this passive tree (see list_valid_slots), or text Path of Building cannot parse, is refused without changing anything.',
    inputSchema: {
      slot: z.string().min(1).describe('Equipment slot name.'),
      itemText: z
        .string()
        .min(1)
        .describe('Full item text in PoB format (rarity, name, base, mods). Viscera items copied from the game (first line "Item Class: Viscera") need no Rarity line.'),
    },
  },
  async ({ slot, itemText }, session) => {
    validateSlot(slot);
    validateItemText(itemText);
    const result = await session.swapItemWithDiff(slot, itemText);
    return summarizeStatDiff(result);
  },
);

tools.engine<{ slot: string }>(
  'unequip_item',
  {
    description:
      'Remove the item from a slot and return the before/after stat diff. PERMANENTLY mutates the build (use undo_last_change to revert). Also works on a slot Path of Building hides on this passive tree (see list_equipped_items).',
    inputSchema: {
      slot: z.string().min(1).describe('Equipment slot name to clear.'),
    },
  },
  async ({ slot }, session) => {
    validateSlot(slot);
    const result = await session.unequipItemWithDiff(slot);
    return summarizeStatDiff(result);
  },
);

tools.engine<{ slot: string; items: string[] }>(
  'compare_items',
  {
    description:
      "Compare 2-5 candidate items in a slot against the currently equipped item. Each candidate is equipped as swap_item would (an off-hand or abyss jewels it cannot keep are emptied) and evaluated through Path of Building's own calculator without changing the build (a passive-tree jewel socket or a skill-granting item takes a full recalculation instead). A candidate that does not fit the slot or cannot be parsed gets an `error`; the others are still compared. Read-only: nothing is pushed to undo. A slot Path of Building hides on this passive tree (see list_valid_slots) is refused.",
    inputSchema: {
      slot: z.string().min(1).describe('Equipment slot to compare in.'),
      items: z
        .array(z.string().min(1))
        .min(2)
        .max(5)
        .describe('Array of 2-5 item texts to compare (PoB format). Viscera items copied from the game (first line "Item Class: Viscera") need no Rarity line.'),
    },
  },
  async ({ slot, items }, session) => {
    validateSlot(slot);
    // Per-item validation is deliberately not run here; compareItems
    // captures per-candidate failures into its results, which lets a
    // partially-bad batch still surface useful diffs for the good entries.
    const result = await session.compareItems(slot, items);
    return summarizeComparison(result);
  },
);

tools.engine<Record<string, never>>(
  'undo_last_change',
  {
    description:
      'Undo the most recent build mutation (swap_item, unequip_item, set_config, allocate_nodes, deallocate_nodes, apply_changes, create_socket_group, delete_socket_group, set_main_skill or convert_tree_to_latest). Returns the stats after undo.',
    inputSchema: {},
  },
  async (_args, session) => {
    const stats = await session.undoLastChange();
    return { status: 'reverted', stats };
  },
);

// ---------------------------------------------------------------------------
// Phase 4 tools: passive tree analysis
// ---------------------------------------------------------------------------

/** get_passive_tree's default: node stats only for keystones, notables and masteries (their chosen effect). */
function compactTree(tree: PassiveTreeInfo): unknown {
  const named = (n: { id: number; name: string; stats?: string[] }) => ({ id: n.id, name: n.name, stats: n.stats ?? [] });
  return {
    summary: tree.summary,
    keystones: tree.keystones.map(named),
    notables: tree.notables.map(named),
    allocatedNodes: tree.allocatedNodes.map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type,
      ...(n.ascendancyName ? { ascendancyName: n.ascendancyName } : {}),
      ...(n.isMastery || n.type === 'Mastery' ? { stats: n.stats ?? [] } : {}),
    })),
  };
}

tools.engine<{ detail?: 'summary' | 'full' }>(
  'get_passive_tree',
  {
    description:
      'Return the passive tree state: point counts and class info (`summary`), active keystones and allocated notables with their stats, and every allocated node (`allocatedNodes`: id, name, type; allocated masteries also carry `stats`, their chosen effect). ' +
      '`detail: "full"` returns every allocated node with all its fields and stats.',
    inputSchema: {
      detail: detailSchema.optional().describe('"summary" (default) or "full" (every allocated node with its stats and flags).'),
    },
  },
  async ({ detail }, session) => {
    const tree = await session.getPassiveTree();
    return detail === 'full' ? tree : compactTree(tree);
  },
);

tools.engine<Record<string, never>>(
  'convert_tree_to_latest',
  {
    description:
      "Convert the build's active passive tree to Path of Building's latest tree version (keeping a ruthless/alternate tree sub-type, like PoB's own convert button), so node advice targets the current league. PERMANENTLY mutates the build (use undo_last_change to revert). Reports the old/new tree version, allocated node and point counts, `lostNodes` (allocated before, not after), `changedNodes` (still allocated but renamed on the new tree), `droppedMasteries` (selections the new tree no longer offers on that node), `droppedTattoos` (tattoos the new tree lacks) and key stat deltas. Each list is capped at 50 with a total count and an omitted count. A build already on the latest tree is left unchanged.",
    inputSchema: {},
  },
  async (_args, session) => {
    const result = await session.convertTreeToLatest();
    if (!result.converted) {
      return {
        status: 'already-latest',
        treeVersion: result.fromVersion,
        message: `The build is already on the latest tree (${result.fromVersion}); nothing was changed.`,
      };
    }
    const { before: _before, after: _after, diff, ...rest } = result;
    return {
      status: 'converted',
      ...rest,
      keyDeltas: keyDeltas(diff),
      undo: 'Call undo_last_change to return to the previous tree version.',
    };
  },
);

tools.engine<{ allocate?: Array<string | number>; deallocate?: Array<string | number> }>(
  'simulate_passive_change',
  {
    description:
      "Temporarily allocate or deallocate passive nodes and return the stat diff. Allocating a node also allocates its path from the allocated tree; deallocating a node also removes the nodes that depend on it. Validates that the resulting tree is connected. A request that allocates exactly one node (and deallocates none) on a connected tree is evaluated through Path of Building's own calculator without changing the build; every other request is applied, recalculated and the tree restored exactly. The whole request is checked first and refused with an error (nothing changes) if any node is unknown, cannot be allocated because no path from the allocated tree reaches it (e.g. another class's ascendancy), is a second option of the same choice node, or, for deallocation, is not allocated or is a class start. A node name resolves among the nodes the change can apply to (unallocated ones to allocate, allocated ones to deallocate); a name several of them share (e.g. \"Strength\") is refused with the candidate ids, so pass ids for those. At most 50 nodes in each list.",
    inputSchema: {
      allocate: z
        .array(z.union([z.string().min(1), z.number().int()]))
        .max(50)
        .optional()
        .describe('Node names (e.g. "Resolute Technique") or numeric node IDs to allocate.'),
      deallocate: z
        .array(z.union([z.string().min(1), z.number().int()]))
        .max(50)
        .optional()
        .describe('Node names or numeric node IDs to deallocate.'),
    },
  },
  async ({ allocate, deallocate }, session) => {
    const result = await session.simulatePassiveChange(allocate ?? [], deallocate ?? []);
    return {
      valid: result.valid,
      validationErrors: result.validationErrors,
      keyDeltas: keyDeltas(result.statDiff),
      statDiff: result.statDiff,
    };
  },
);

const nodeRefsSchema = z
  .array(z.union([z.string().min(1), z.number().int()]))
  .min(1)
  .max(50);

/** Passive and ascendancy points a set of nodes costs, as PoB's CountAllocNodes counts them (`pointCost`). */
function pointCounts(nodes: TreeEditNode[]): { points: number; ascendancyPoints: number } {
  return {
    points: nodes.filter((n) => n.pointCost === 'passive').length,
    ascendancyPoints: nodes.filter((n) => n.pointCost === 'ascendancy').length,
  };
}

function treeEditResponse(result: TreeEditResult, verb: 'allocated' | 'deallocated'): unknown {
  const node = (n: TreeEditNode) => ({ id: n.id, name: n.name, type: n.type, ...(n.ascendancyName ? { ascendancyName: n.ascendancyName } : {}) });
  const s = result.summary;
  const changed = verb === 'allocated' ? result.added : result.removed;
  const cost = pointCounts(changed);
  return {
    status: verb,
    ...(verb === 'allocated' ? { added: result.added.map(node) } : {}),
    ...(result.removed.length > 0 ? { removed: result.removed.map(node) } : {}),
    ...(verb === 'allocated'
      ? { pointsUsed: cost.points, ascendancyPointsUsed: cost.ascendancyPoints }
      : { pointsRefunded: cost.points, ascendancyPointsRefunded: cost.ascendancyPoints }),
    points: {
      used: s.totalPoints,
      max: s.maxNormalPoints,
      remaining: s.maxNormalPoints - s.totalPoints,
      ascendancyUsed: s.ascendancyPoints,
      ascendancyMax: s.maxAscendancyPoints,
    },
    ...(summarizeStatDiff(result) as object),
    undo: 'Call undo_last_change to revert this change.',
  };
}

tools.engine<{ nodes: Array<string | number> }>(
  'allocate_nodes',
  {
    description:
      "Allocate passive nodes in the build, each together with its shortest path from the allocated tree (as clicking it in PoB, simulate_passive_change and find_best_next_nodes do), and return the nodes added, the points used, the tree's point totals and the before/after stat diff. PERMANENTLY mutates the build (use undo_last_change to revert; export_build includes the change). " +
      'The whole request is checked first and refused with an error (nothing changes) if any node is unknown, already allocated, a mastery (choosing mastery effects is not supported yet), listed twice, cannot be allocated because no path from the allocated tree reaches it, or is a second option of the same choice node. ' +
      'A node name resolves among the unallocated nodes a path reaches; a name several of them share (e.g. "Strength") is refused with the candidate ids, so pass ids for those. `removed` lists any node the change deallocated (another option of a choice node). At most 50 nodes.',
    inputSchema: {
      nodes: nodeRefsSchema.describe('Node names (e.g. "Resolute Technique") or numeric node IDs to allocate.'),
    },
  },
  async ({ nodes }, session) => treeEditResponse(await session.allocateNodes(nodes), 'allocated'),
);

tools.engine<{ nodes: Array<string | number> }>(
  'deallocate_nodes',
  {
    description:
      "Deallocate passive nodes in the build, each together with every node that depends on it (as in PoB), and return the nodes removed, the points refunded, the tree's point totals and the before/after stat diff. PERMANENTLY mutates the build (use undo_last_change to revert; export_build includes the change). " +
      'The whole request is checked first and refused with an error (nothing changes) if any node is unknown, not allocated, a class start or listed twice. A node name resolves among the allocated nodes; a name several of them share is refused with the candidate ids. At most 50 nodes.',
    inputSchema: {
      nodes: nodeRefsSchema.describe('Node names or numeric node IDs to deallocate.'),
    },
  },
  async ({ nodes }, session) => treeEditResponse(await session.deallocateNodes(nodes), 'deallocated'),
);

registerBuildEditTools(tools, summarizeStatDiff);

const rankBySchema = z.enum(['perPoint', 'total']);

tools.engine<{
  count?: number;
  optimizeFor?: string;
  includeJewelSockets?: boolean;
  maxPoints?: number;
  rankBy?: 'perPoint' | 'total';
}>(
  'find_best_next_nodes',
  {
    description:
      "Rank unallocated passive nodes by how much allocating each one (together with its cheapest path from the allocated tree, as clicking it in PoB does) improves the chosen stat. Every node whose path costs at most `maxPoints` points is evaluated through Path of Building's own calculator (a few seconds; the build never changes); ascendancy nodes, masteries and class starts are skipped, jewel sockets unless `includeJewelSockets`. Each ranking gives `pointsCost`, `delta` (total change of the stat), `deltaPerPoint`, the `path` (node ids and names, tree side first, the node last) and `tradeoffs` (losses in the other kind of stat). `rankBy: \"perPoint\"` (default) ranks by delta per point, `\"total\"` by delta. Nodes that need a full recalculation (cluster jewel nodes, jewel sockets holding a jewel, skill-granting nodes) are capped at the " + MAX_SEARCH_FALLBACKS + " with the fewest points per call; any others are not ranked and are listed in `skipped` (with their points and the reason).",
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
      maxPoints: z
        .number()
        .int()
        .min(1)
        .max(MAX_MAX_POINTS)
        .optional()
        .describe(`Largest path cost in passive points to consider (default ${DEFAULT_MAX_POINTS}, max ${MAX_MAX_POINTS}); 1 = only nodes next to the allocated tree.`),
      rankBy: rankBySchema.optional().describe('"perPoint" (default): gain per point spent; "total": total gain.'),
    },
  },
  async ({ count, optimizeFor, includeJewelSockets, maxPoints, rankBy }, session) => {
    const target = optimizeFor ?? 'CombinedDPS';
    const result = await session.findBestNextNodes(
      count ?? 10,
      target,
      includeJewelSockets ?? false,
      maxPoints ?? DEFAULT_MAX_POINTS,
      rankBy ?? 'perPoint',
    );
    return {
      optimizeFor: target,
      maxPoints: maxPoints ?? DEFAULT_MAX_POINTS,
      rankBy: rankBy ?? 'perPoint',
      evaluated: result.evaluated,
      count: result.rankings.length,
      rankings: result.rankings,
      ...(result.skipped.length > 0 ? { skipped: result.skipped } : {}),
    };
  },
);

tools.engine<{ count?: number; optimizeFor?: string; rankBy?: 'perPoint' | 'total' }>(
  'find_worst_allocated_nodes',
  {
    description:
      "Find the least valuable allocated passive nodes: each allocated node (normal, notable, keystone, or empty jewel socket; not ascendancy nodes, masteries or class starts) is removed together with every node that depends on it (as deallocating it in PoB does) and evaluated through Path of Building's own calculator (a few seconds; the build never changes). Each ranking gives `lossIfRemoved` (drop of the stat), `pointsRefunded`, `lossPerPoint`, and `removedNodes` (ids and names, the node first; at most 25 listed, `removedNodeCount` has the total). `rankBy: \"perPoint\"` (default) lists the lowest loss per refunded point first, `\"total\"` the lowest total loss. Jewel sockets holding a jewel are never candidates themselves. Nodes whose removal needs a full recalculation (cluster jewel nodes, skill-granting nodes, and nodes whose dependents include a jewel socket holding a jewel) are evaluated after the others and capped at " + MAX_SEARCH_FALLBACKS + " per call, picked by a heuristic: alternately the lowest `minLossEstimate` per refunded point (in total for `rankBy: \"total\"`; the largest loss among the evaluated nodes their removal also removes, an estimate, not a bound) and, for nodes with no evaluated dependent (no estimate), the largest refund. Any others are not ranked and are listed in `skipped` with their points, estimate (when there is one) and reason, so a skipped node can still be among the least valuable.",
    inputSchema: {
      count: z.number().int().positive().max(50).optional().describe('Top-N to return (default 10).'),
      optimizeFor: z
        .string()
        .optional()
        .describe('Stat key to evaluate value by (default "CombinedDPS").'),
      rankBy: rankBySchema.optional().describe('"perPoint" (default): loss per refunded point; "total": total loss.'),
    },
  },
  async ({ count, optimizeFor, rankBy }, session) => {
    const target = optimizeFor ?? 'CombinedDPS';
    const result = await session.findWorstAllocatedNodes(count ?? 10, target, rankBy ?? 'perPoint');
    return {
      optimizeFor: target,
      rankBy: rankBy ?? 'perPoint',
      evaluated: result.evaluated,
      count: result.rankings.length,
      rankings: result.rankings,
      ...(result.skipped.length > 0 ? { skipped: result.skipped } : {}),
    };
  },
);

tools.engine<{ keystone: string }>(
  'evaluate_keystone',
  {
    description:
      "Toggle a keystone (add it with its path from the allocated tree if not allocated; remove it with the nodes depending on it if allocated) and return the full stat diff, evaluated through Path of Building's own calculator without changing the build. A keystone no path reaches is an error.",
    inputSchema: {
      keystone: z
        .string()
        .min(1)
        .describe('Keystone name (e.g. "Resolute Technique", "Chaos Inoculation", "Mind Over Matter").'),
    },
  },
  async ({ keystone }, session) => {
    const result = await session.evaluateKeystone(keystone);
    return {
      keystone: result.keystone,
      currentlyAllocated: result.currentlyAllocated,
      action: result.action,
      nodeStats: result.nodeStats,
      keyDeltas: keyDeltas(result.statDiff),
      statDiff: result.statDiff,
    };
  },
);

// ---------------------------------------------------------------------------
// Phase 5 tools: skill gems
// ---------------------------------------------------------------------------

/** A gem with its index, name, level and quality, plus disabled / count / error only when they apply. */
function compactGem(gem: SkillGemInstance): Record<string, unknown> {
  return {
    index: gem.index,
    name: gem.name,
    level: gem.level,
    quality: gem.quality,
    ...(gem.enabled ? {} : { enabled: false }),
    ...(gem.count !== undefined && gem.count !== 1 ? { count: gem.count } : {}),
    ...(gem.errMsg ? { errMsg: gem.errMsg } : {}),
  };
}

tools.engine<{ detail?: 'summary' | 'full' }>(
  'list_skill_groups',
  {
    description:
      'List every socket group (skill setup) with active gems, support gems, slot, label, and which group is the main skill. ' +
      'Each gem has its `index` in the group (the 1-based index swap_gem and evaluate_changes take), name, level and quality, plus `enabled: false` / `count` / `errMsg` only when they apply; ' +
      '`detail: "full"` returns every gem field (gem and skill ids, color, isSupport).',
    inputSchema: {
      detail: detailSchema.optional().describe('"summary" (default) or "full" (every gem field).'),
    },
  },
  async ({ detail }, session) => {
    const groups = await session.listSkillGroups();
    const gems = (list: SkillGemInstance[]) => (detail === 'full' ? list : list.map(compactGem));
    const formatted = groups.map((g) => ({
      index: g.index,
      label: g.label,
      slot: g.slotName,
      enabled: g.enabled,
      isMainSkill: g.isMainGroup,
      activeGems: gems(g.gems.filter((gem) => !gem.isSupport)),
      supportGems: gems(g.gems.filter((gem) => gem.isSupport)),
    }));
    return { count: formatted.length, groups: formatted };
  },
);

tools.engine<{ name: string }>(
  'lookup_gem',
  {
    description:
      'Look up gem metadata by name (active or support). Returns tags, color, requirements, max level, and whether it is a support / vaal / awakened gem.',
    inputSchema: {
      name: z.string().min(1).describe('Gem name. Fuzzy abbreviations supported (e.g. "Mlts" → Multistrike).'),
    },
  },
  async ({ name }, session) => {
    return session.getGemByName(name);
  },
);

tools.engine<{ activeSkillTags?: string[]; includeAwakened?: boolean }>(
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
  async ({ activeSkillTags, includeAwakened }, session) => {
    const supports = await session.getAvailableSupports(activeSkillTags, includeAwakened ?? false);
    return { count: supports.length, supports };
  },
);

tools.engine<{ skillGroupIndex: number; gemIndex: number; newGemName: string; level?: number; quality?: number }>(
  'swap_gem',
  {
    description:
      "Swap a single gem in a skill group (as PoB does: the new gem keeps the old one's level and quality unless given) and return the stat diff, evaluated through Path of Building's own calculator in milliseconds; the build never changes and nothing is pushed to undo. An unknown gem or bad index is an error.",
    inputSchema: {
      skillGroupIndex: z.number().int().positive().describe('1-based index from list_skill_groups.'),
      gemIndex: z.number().int().positive().describe('1-based index of the gem within the group.'),
      newGemName: z.string().min(1).describe('Replacement gem name.'),
      level: z.number().int().min(1).max(40).optional().describe('Gem level (default keeps current).'),
      quality: z.number().int().min(0).max(40).optional().describe('Gem quality (default keeps current).'),
    },
  },
  async ({ skillGroupIndex, gemIndex, newGemName, level, quality }, session) => {
    const result = await session.swapGemWithDiff(skillGroupIndex, gemIndex, newGemName, level, quality);
    return summarizeStatDiff(result);
  },
);

tools.engine<{ skillGroupIndex: number; candidates: string[] }>(
  'compare_supports',
  {
    description:
      "Identify the weakest enabled support in a skill group (the smallest CombinedDPS loss when removed) and rank candidate replacements (each at level 20 / quality 20 in its place) by resulting DPS, evaluated through Path of Building's own calculator in milliseconds; the build never changes. A candidate PoB refuses (e.g. an unknown gem name) is listed with its `error` and null `dps` / `dpsDelta`, after the others.",
    inputSchema: {
      skillGroupIndex: z.number().int().positive().describe('1-based index of the skill group.'),
      candidates: z
        .array(z.string().min(1))
        .min(1)
        .max(10)
        .describe('1-10 candidate support gem names (e.g. ["Brutality","Melee Physical Damage"]).'),
    },
  },
  async ({ skillGroupIndex, candidates }, session) => {
    return session.compareSupports(skillGroupIndex, candidates);
  },
);

tools.engine<{ skillGroupIndex: number; gemIndex: number; levels?: number[] }>(
  'evaluate_gem_levels',
  {
    description:
      "Show how DPS scales with gem level for a specific gem, evaluated through Path of Building's own calculator in milliseconds (the build never changes). Default tests the current level -1 through +4 (capped at 24); pass `levels` to override. A level PoB refuses has its `error` and null `dps` / `dpsDelta`.",
    inputSchema: {
      skillGroupIndex: z.number().int().positive().describe('1-based skill group index.'),
      gemIndex: z.number().int().positive().describe('1-based gem index within the group.'),
      levels: z
        .array(z.number().int().min(1).max(40))
        .optional()
        .describe('Explicit list of levels to test.'),
    },
  },
  async ({ skillGroupIndex, gemIndex, levels }, session) => {
    const scaling = await session.evaluateGemLevels(skillGroupIndex, gemIndex, levels);
    return { count: scaling.length, scaling };
  },
);

tools.engine<{ activeSkill: string; availableSlots: number; constraints?: string[]; topN?: number }>(
  'find_optimal_links',
  {
    description:
      "Find the best support gem combination for an active skill in the main skill group (its gems are replaced by the active skill, the locked `constraints` and the candidates, each at its natural maximum level capped at 20, e.g. 3 for Empower, and quality 20), evaluated through Path of Building's own calculator; the build never changes. Every support PoB's own compatibility check lets support the skill (after the locked supports add their skill types; Awakened gems left out) is scored alone, then combinations of the best `topN` are searched: exhaustively when they fit the budget (" + EXHAUSTIVE_BUDGET + " combinations), otherwise exhaustively over the best singles the budget allows and then improved by pairwise swaps with the rest of the pool (at most " + MAX_COMBINATIONS + " combinations in all). About 1-3 seconds for a 6-link. Returns `bestCombination`, `bestDPS`, `baselineDPS` (the build as it is) and `dpsDelta`, `bestGroup` (the evaluated group with levels), the `mainGroup` replaced, `singleSupportDPS` (the pool), `topAlternatives`, and `search` (method, supports and combinations evaluated, skipped supports).",
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
        .describe('Support gems that MUST be included (each a support gem, listed once, not the active skill).'),
      topN: z.number().int().min(5).max(40).optional().describe(`Number of best single supports the combination search draws from (default ${DEFAULT_LINK_POOL}).`),
    },
  },
  async ({ activeSkill, availableSlots, constraints, topN }, session) => {
    return session.findOptimalLinks(
      activeSkill,
      availableSlots - 1, // active skill consumes one slot; remaining are supports
      constraints ?? [],
      { topN },
    );
  },
);

// ---------------------------------------------------------------------------
// Phase 6 tools: configuration and combat scenarios
// ---------------------------------------------------------------------------

tools.engine<Record<string, never>>(
  'get_config',
  {
    description:
      "Return all of PoB's config / scenario options organized by section, with each option's type, label, current value, and (for list options) valid choices. Common keys: enemyIsBoss, usePowerCharges, useFrenzyCharges, useEnduranceCharges, buffOnslaught, customMods.",
    inputSchema: {},
  },
  async (_args, session) => {
    return session.getConfigOrganized();
  },
);

tools.engine<{ options: Record<string, boolean | number | string> }>(
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
  async ({ options }, session) => {
    const result = await session.setConfigWithUndo(options);
    return summarizeStatDiff(result);
  },
);

tools.plain<Record<string, never>>(
  'list_scenarios',
  {
    description:
      'List the named combat scenarios understood by `simulate_scenario` and `compare_scenarios`. Each entry returns the underlying config option overrides applied.',
    inputSchema: {},
  },
  async () => {
    const scenarios = BuildSession.listScenarios();
    return { count: scenarios.length, scenarios };
  },
);

tools.engine<{ scenario: string }>(
  'simulate_scenario',
  {
    description:
      "Apply a named combat scenario preset (e.g. 'mapping', 'pinnacle_boss') as set_config would and return the stat diff vs the current config, evaluated through Path of Building's own calculator in milliseconds; the build never changes.",
    inputSchema: {
      scenario: z
        .enum(SCENARIO_NAMES)
        .describe('Scenario preset name (see `list_scenarios`).'),
    },
  },
  async ({ scenario }, session) => {
    const result = await session.simulateScenario(scenario);
    const diffSummary = summarizeStatDiff({ before: result.before, after: result.after, diff: result.diff });
    return {
      scenario: result.scenario,
      description: result.description,
      appliedOptions: result.options,
      ...(diffSummary as Record<string, unknown>),
    };
  },
);

tools.engine<{ scenarios: string[] }>(
  'compare_scenarios',
  {
    description:
      "Compare 2-6 named scenarios side-by-side, each applied on its own to the current config and evaluated through Path of Building's own calculator in one call (milliseconds; the build never changes). Returns baseline stats plus one entry per scenario with its key deltas and stats; a scenario PoB refuses has an `error` instead.",
    inputSchema: {
      scenarios: z
        .array(z.enum(SCENARIO_NAMES))
        .min(2)
        .max(6)
        .describe('Scenario preset names (e.g. ["mapping","pinnacle_boss","uber_boss"]).'),
    },
  },
  async ({ scenarios }, session) => {
    const result = await session.compareScenarios(scenarios);
    const rows = result.scenarios.map((s) =>
      s.after && s.diff
        ? { scenario: s.scenario, description: s.description, keyDeltas: keyDeltas(s.diff), keyStats: keyStats(s.after) }
        : { scenario: s.scenario, description: s.description, error: s.error ?? 'refused' },
    );
    return { baseline: keyStats(result.baseline), scenarios: rows };
  },
);

tools.engine<{ buffs: Record<string, boolean | number | string> }>(
  'toggle_buffs',
  {
    description:
      "Toggle individual buffs / charges (as config options) and return the stat impact, evaluated through Path of Building's own calculator in milliseconds; the build never changes. Friendly aliases: powerCharges, frenzyCharges, enduranceCharges, onslaught, fortify, flasks, unholyMight; raw PoB config keys also accepted.",
    inputSchema: {
      buffs: z
        .record(z.string(), z.union([z.boolean(), z.number(), z.string()]))
        .describe('Map of buff name → desired value (e.g. {"powerCharges":true,"onslaught":false}).'),
    },
  },
  async ({ buffs }, session) => {
    const result = await session.toggleBuffs(buffs);
    return summarizeStatDiff(result);
  },
);

// ---------------------------------------------------------------------------
// Phase 7: Optimization advisor
// ---------------------------------------------------------------------------

tools.engine<{ focus?: 'defense' | 'offense' | 'qol' | 'balance' }>(
  'diagnose_build',
  {
    description:
      'Run a comprehensive read-only analysis of the current build. Identifies uncapped resistances, low EHP, crit/hit-chance issues, sub-level-20 main gems, missing movement/guard skills, etc. Pass `focus` to narrow to defense, offense, qol, or balance. Returns `checks` (severity, category, message, suggestion), most severe first; an empty list means no issues were found.',
    inputSchema: {
      focus: z
        .enum(['defense', 'offense', 'qol', 'balance'])
        .optional()
        .describe('Limit checks to a specific category. Defaults to all.'),
    },
  },
  async ({ focus }, session) => {
    const checks = await session.diagnoseBuild(focus);
    return { checks };
  },
);

tools.engine<{ slot?: string; modSlots?: number }>(
  'suggest_upgrades',
  {
    description:
      "Rank equipment slots by upgrade priority. Each equipped slot's DPS/EHP contribution is measured by emptying it as unequip_item would, through Path of Building's own calculator without changing the build; lowest contributors are flagged for replacement. " +
      `The first modSlots slots (default ${DEFAULT_MOD_SLOTS}; the given slot when \`slot\` is set) get suggestedMods: the mods Path of Building's own weighted trade query generator weighs highest for that slot on this build ({mod, weight}: weight = stat-score gain per 1 point of the mod, FullDPS 1 + TotalEHP 0.5; listed by a typical roll's gain), about 0.5-1 s a slot. ` +
      'A slot that cannot be measured is listed last with an `error`. Returns `suggestions` (highest priority first; empty slots come first): slot, currentItemName, empty, dpsContribution, ehpContribution, priority (0-100), suggestedMods / modsError; ' +
      'list_equipped_items / get_item_in_slot give the items themselves, generate_trade_search the full weighted search, stat_weights the worth of any mod line.',
    inputSchema: {
      slot: z.string().optional().describe('Focus on a specific slot (e.g. "Body Armour"). Omit for all slots.'),
      modSlots: z.number().int().min(0).max(10).optional()
        .describe(`How many of the highest-priority slots get suggestedMods (default ${DEFAULT_MOD_SLOTS}, 0 for none, 10 for all; each takes about 0.5-1 s).`),
    },
  },
  async ({ slot, modSlots }, session) => {
    const suggestions = await session.suggestUpgrades(slot, { modSlots });
    const withMods = suggestions.filter((s) => s.suggestedMods !== undefined || s.modsError !== undefined).length;
    return {
      suggestions: suggestions.map(({ currentItem: _item, ...rest }) => rest),
      ...(withMods < suggestions.length
        ? { modsNote: `suggestedMods computed for the first ${withMods} slot(s) only; pass slot, or a larger modSlots, for the others.` }
        : {}),
    };
  },
);

tools.engine<{ format?: 'summary' | 'xml' | 'code' }>(
  'export_build',
  {
    description:
      'Export the current build state. Format "summary" returns a human-readable stat summary (default), "xml" returns raw PoB XML, and "code" returns a base64-deflated PoB import code.',
    inputSchema: {
      format: z.enum(['summary', 'xml', 'code']).optional().describe('Export format. Defaults to "summary".'),
    },
  },
  async ({ format }, session) => {
    const text = await session.exportBuild(format ?? 'summary');
    return { content: [{ type: 'text', text }] };
  },
);

tools.engine<{ action: 'take' | 'compare' | 'list'; label?: string; labelA?: string; labelB?: string }>(
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
  async ({ action, label, labelA, labelB }, session) => {
    switch (action) {
      case 'take': {
        if (!label) throw new UserError('label required for action "take"');
        const stats = await session.takeSnapshot(label);
        return { status: 'saved', label, stats };
      }
      case 'list': {
        return { snapshots: session.listSnapshotLabels() };
      }
      case 'compare': {
        if (!labelA || !labelB) throw new UserError('labelA and labelB required for action "compare"');
        if (labelB === 'current') {
          // Diff against live stats directly: nothing is stored, so nothing can leak into "list".
          const current = await session.getStats();
          const a = session.getSnapshot(labelA);
          if (!a) throw new UserError(`Snapshot not found: ${labelA}`);
          return { from: labelA, to: labelB, diff: computeDiff(a, current) };
        }
        const diff = session.diffSnapshots(labelA, labelB);
        return { from: labelA, to: labelB, diff };
      }
    }
  },
);

tools.engine<Record<string, never>>(
  'reset_build',
  {
    description:
      'Reset the build to its original state (as it was when first loaded). All session mutations (item swaps, tree changes, gem swaps, config changes) are reverted.',
    inputSchema: {},
  },
  async (_args, session) => {
    const info = await session.resetBuild();
    return {
      status: 'reset',
      class: info.class,
      ascendancy: info.ascendancy,
      level: info.level,
      mainSkill: info.mainSkill,
      ...(info.engineRestart ? { engineRestart: info.engineRestart } : {}),
    };
  },
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Connect the MCP transport FIRST so the client always sees a working server
  // (with configure_pob_path / get_engine_info), even when PoB or LuaJIT can't
  // be found. Engine-backed tools await the background boot via
  // engine.ensureReady(), so no tool call can race the end-of-init replay.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  engine.setPathPrompt(createPathPrompt(server, engine));
  setImmediate(() => engine.init());

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await Promise.race([engine.shutdown(), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    } catch {
      // fall through to the hard kill
    }
    engine.killProcess();
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
  engine.killProcess();
  process.exit(1);
});
