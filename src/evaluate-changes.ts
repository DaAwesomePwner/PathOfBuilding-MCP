// evaluate_changes: many mixed what-if variants (passive nodes, items, gems,
// config) in one probe call, returned as a compact table ranked by one stat.
// Runs through BuildSession.probeNamed (src/probe.ts): nothing is applied to
// the build and nothing is pushed to undo.

import { z } from 'zod';
import { MAX_NODE_NAMES, type BuildSession, type NamedProbeVariant } from './build-session.js';
import type { Stats } from './lua-bridge.js';
import { MAX_FALLBACK_VARIANTS, MAX_PROBE_VARIANTS, type ProbeVariantResult } from './probe.js';
import type { ToolRegistrar } from './tool-registry.js';

export const DEFAULT_EVALUATE_STATS = [
  'CombinedDPS', 'TotalEHP', 'Life', 'EnergyShield', 'Mana',
  'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
];
export const MAX_EVALUATE_STATS = 50;
/** Per-variant input bounds. */
export const MAX_VARIANT_NODES = 50;
export const MAX_VARIANT_ITEMS = 10;
export const MAX_VARIANT_GEMS = 20;
export const MAX_VARIANT_CONFIG_KEYS = 50;
export const MAX_ITEM_TEXT = 10_000;
export const MAX_LABEL = 100;

export interface EvaluateChangesVariant extends NamedProbeVariant {
  label?: string;
}

export interface EvaluateChangesInput {
  variants: EvaluateChangesVariant[];
  stats?: string[];
  rankBy?: string;
  order?: 'desc' | 'asc';
}

export interface EvaluateChangesRow {
  index: number;
  label?: string;
  /** The variant's value of the rankBy stat. */
  value?: number | string | boolean | null;
  /** Variant minus base for every requested stat; null when either side is not a number. */
  delta?: Record<string, number | null>;
  pointsAdded?: number;
  pointsRemoved?: number;
  fallback?: true;
  error?: string;
  userError?: boolean;
}

export interface EvaluateChangesResult {
  rankBy: string;
  order: 'desc' | 'asc';
  base: Stats;
  evaluated: number;
  failed: number;
  fallbacks: number;
  results: EvaluateChangesRow[];
}

/** Numbers at 2 decimals (4 significant digits below 1), so the table stays short. */
export function roundStat(value: number): number {
  if (Number.isInteger(value) || !Number.isFinite(value)) return value;
  if (Math.abs(value) >= 1) return Math.round(value * 100) / 100;
  return Number(value.toPrecision(4));
}

function roundValue<T>(value: T): T {
  return (typeof value === 'number' ? roundStat(value) : value) as T;
}

function statDelta(base: unknown, after: unknown): number | null {
  return typeof base === 'number' && typeof after === 'number' ? after - base : null;
}

function requestedStats(input: EvaluateChangesInput, rankBy: string): string[] {
  const keys = [...new Set(input.stats && input.stats.length > 0 ? input.stats : DEFAULT_EVALUATE_STATS)];
  if (!keys.includes(rankBy)) keys.unshift(rankBy);
  return keys;
}

function toRow(index: number, label: string | undefined, r: ProbeVariantResult, base: Stats, keys: string[], rankBy: string): EvaluateChangesRow {
  const row: EvaluateChangesRow = { index, ...(label !== undefined ? { label } : {}) };
  if (r.error !== undefined) {
    return { ...row, error: r.error, userError: r.userError === true, ...(r.fallback ? { fallback: true as const } : {}) };
  }
  const delta: Record<string, number | null> = {};
  for (const key of keys) {
    const d = statDelta(base[key], r.stats[key]);
    delta[key] = d === null ? null : roundStat(d);
  }
  return {
    ...row,
    value: roundValue(r.stats[rankBy] ?? null),
    delta,
    ...(r.pointsAdded ? { pointsAdded: r.pointsAdded } : {}),
    ...(r.pointsRemoved ? { pointsRemoved: r.pointsRemoved } : {}),
    ...(r.fallback ? { fallback: true as const } : {}),
  };
}

/** Run every variant through the probe engine and rank them by the rankBy stat's change. */
export async function evaluateChanges(session: BuildSession, input: EvaluateChangesInput): Promise<EvaluateChangesResult> {
  const rankBy = input.rankBy ?? 'CombinedDPS';
  const order = input.order ?? 'desc';
  const keys = requestedStats(input, rankBy);
  const variants: NamedProbeVariant[] = input.variants.map(({ label: _label, ...variant }) => variant);
  const probed = await session.probeNamed({ stats: keys, variants });

  const rankDelta = (i: number): number | null => {
    const r = probed.results[i];
    return r.error === undefined ? statDelta(probed.base[rankBy], r.stats[rankBy]) : null;
  };
  const ok: number[] = [];
  const failedRows: number[] = [];
  probed.results.forEach((r, i) => (r.error === undefined ? ok : failedRows).push(i));
  const sign = order === 'desc' ? -1 : 1;
  ok.sort((a, b) => {
    const da = rankDelta(a);
    const db = rankDelta(b);
    if (da === null || db === null) return da === db ? a - b : da === null ? 1 : -1;
    return da === db ? a - b : sign * (da - db);
  });

  const base: Stats = {};
  for (const key of keys) base[key] = roundValue(probed.base[key] ?? null);
  return {
    rankBy,
    order,
    base,
    evaluated: ok.length,
    failed: failedRows.length,
    fallbacks: probed.results.filter((r) => r.fallback).length,
    results: [...ok, ...failedRows].map((i) => toRow(i, input.variants[i].label, probed.results[i], probed.base, keys, rankBy)),
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const nodeRef = z.union([z.number().int(), z.string().min(1)]);
const groupIndex = z.number().int().min(1);
const gemLevel = z.number().int().min(1).max(40);
const gemQuality = z.number().int().min(0).max(40);

const gemChange = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('set'),
    group: groupIndex,
    index: groupIndex,
    name: z.string().min(1).optional(),
    level: gemLevel.optional(),
    quality: gemQuality.optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({ op: z.literal('remove'), group: groupIndex, index: groupIndex }),
  z.object({
    op: z.literal('add'),
    group: groupIndex,
    name: z.string().min(1),
    level: gemLevel.optional(),
    quality: gemQuality.optional(),
    enabled: z.boolean().optional(),
    position: groupIndex.optional(),
  }),
  z.object({ op: z.literal('clear'), group: groupIndex }),
]);

const variantSchema = z.object({
  label: z.string().max(MAX_LABEL).optional().describe('Your name for the variant, echoed back.'),
  allocate: z.array(nodeRef).max(MAX_VARIANT_NODES).optional().describe('Passive nodes to allocate (names or ids), each with its path from the allocated tree.'),
  deallocate: z.array(nodeRef).max(MAX_VARIANT_NODES).optional().describe('Allocated passive nodes to remove (names or ids), each with the nodes depending on it.'),
  items: z
    .array(
      z.object({
        slot: z.string().min(1),
        itemText: z.string().min(1).max(MAX_ITEM_TEXT).optional(),
        unequip: z.literal(true).optional(),
      }),
    )
    .max(MAX_VARIANT_ITEMS)
    .optional()
    .describe('{ slot, itemText } (PoB "Copy item" text; Viscera items copied from the game, first line "Item Class: Viscera", need no Rarity line) equips as swap_item would; { slot, unequip: true } empties the slot.'),
  gems: z
    .array(gemChange)
    .max(MAX_VARIANT_GEMS)
    .optional()
    .describe(
      'Gem changes in order (group/index are 1-based, as in list_skill_groups / get_skill_breakdown; an index refers to the group as it is when that change applies): ' +
        '{op:"set",group,index,name?,level?,quality?,enabled?}, {op:"remove",group,index}, {op:"add",group,name,level?,quality?,enabled?,position?}, {op:"clear",group}.',
    ),
  config: z
    .record(z.string(), z.union([z.boolean(), z.number(), z.string()]))
    .refine((options) => Object.keys(options).length <= MAX_VARIANT_CONFIG_KEYS, {
      message: `at most ${MAX_VARIANT_CONFIG_KEYS} config keys per variant`,
    })
    .optional()
    .describe('Config options as set_config takes them (e.g. {"enemyIsBoss":"Pinnacle"}).'),
});

export function registerEvaluateChanges(tools: ToolRegistrar): void {
  tools.engine<EvaluateChangesInput>(
    'evaluate_changes',
    {
      description:
        `Try up to ${MAX_PROBE_VARIANTS} what-if variants of the build in one call and get a compact table ranked by one stat. ` +
        'Each variant may combine passive nodes to allocate/deallocate (names or ids), items to equip or unequip, gem changes and config options; ' +
        "they apply in the order config, gems, items, nodes. Every variant is evaluated through Path of Building's own calculator (a few ms each); " +
        `variants it cannot reproduce exactly (several node changes in one variant, jewel sockets, skill-granting nodes or items) are applied, recalculated and restored instead (~0.3-0.5 s each, at most ${MAX_FALLBACK_VARIANTS} per call) and marked \`fallback\`. ` +
        'NOTHING IS APPLIED TO THE BUILD and nothing is pushed to undo. To keep a winner, commit it with swap_item / unequip_item (items) or set_config (config); ' +
        'passive-tree and gem changes have no committing tool here, so make them in Path of Building. ' +
        'Returns `base` (the requested stats now), then `results` sorted by the change of `rankBy` (default CombinedDPS, `order` desc): ' +
        'each row has `index` (position in `variants`), `label`, `value` (the variant\'s rankBy stat), `delta` (change of every requested stat, null when not a number), ' +
        '`pointsAdded` / `pointsRemoved` for node changes, and `fallback`. A refused variant (unknown node or gem, item that does not fit, bad config) is listed after the others with its `error`; the call still succeeds. ' +
        'Numbers are rounded to 2 decimals (4 significant digits below 1). A node name resolves among the nodes the change can apply to (unallocated ones for allocate, allocated ones for deallocate); a name several of them share (e.g. "Strength") refuses that variant with the candidate ids, so pass ids for those. ' +
        `Per variant: at most ${MAX_VARIANT_NODES} nodes in each of allocate / deallocate, ${MAX_VARIANT_ITEMS} items, ${MAX_VARIANT_GEMS} gem changes, ${MAX_VARIANT_CONFIG_KEYS} config keys; at most ${MAX_NODE_NAMES} different node names per call.`,
      inputSchema: {
        variants: z.array(variantSchema).min(1).max(MAX_PROBE_VARIANTS).describe('The variants to evaluate, each on its own against the current build.'),
        stats: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_EVALUATE_STATS)
          .optional()
          .describe(`PoB output stat keys to report (default ${DEFAULT_EVALUATE_STATS.join(', ')}); unknown keys come back as null.`),
        rankBy: z.string().min(1).optional().describe('Stat key to rank by (default "CombinedDPS"); added to `stats` if missing.'),
        order: z.enum(['desc', 'asc']).optional().describe('"desc" (default): largest gain first; "asc": smallest first.'),
      },
    },
    (args, session) => evaluateChanges(session, args),
  );
}
