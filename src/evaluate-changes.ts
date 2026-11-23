// evaluate_changes: many mixed what-if variants (passive nodes, items, gems,
// config) in one probe call, returned as a compact table ranked by one stat or
// by a weighted multi-stat objective, with optional hard constraints.
// Runs through BuildSession.probeNamed (src/probe.ts): nothing is applied to
// the build and nothing is pushed to undo.

import { z } from 'zod';
import { MAX_NODE_NAMES, type BuildSession, type NamedProbeVariant } from './build-session.js';
import type { Stats } from './lua-bridge.js';
import { MAX_FALLBACK_VARIANTS, MAX_PROBE_VARIANTS, type ProbeVariantResult } from './probe.js';
import type { ToolRegistrar } from './tool-registry.js';
import { UserError } from './validation.js';

export const DEFAULT_EVALUATE_STATS = [
  'CombinedDPS', 'TotalEHP', 'Life', 'EnergyShield', 'Mana',
  'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
];
export const MAX_EVALUATE_STATS = 50;
/** Most weighted stats in an objective / most constraints in one call. */
export const MAX_OBJECTIVE_WEIGHTS = 20;
export const MAX_CONSTRAINTS = 20;
/** Per-variant input bounds. */
export const MAX_VARIANT_NODES = 50;
export const MAX_VARIANT_ITEMS = 10;
export const MAX_VARIANT_GEMS = 20;
export const MAX_VARIANT_CONFIG_KEYS = 50;
export const MAX_VARIANT_MASTERIES = 20;
export const MAX_ITEM_TEXT = 10_000;
export const MAX_LABEL = 100;

export interface EvaluateChangesVariant extends NamedProbeVariant {
  label?: string;
}

export interface EvaluateObjective {
  weights: Record<string, number>;
  mode?: 'relative' | 'absolute';
}

/** A hard limit on the variant's resulting stat value (min / max) or on its change from the base (minDelta / maxDelta). */
export interface EvaluateConstraint {
  stat: string;
  min?: number;
  max?: number;
  minDelta?: number;
  maxDelta?: number;
}

export interface EvaluateChangesInput {
  variants: EvaluateChangesVariant[];
  stats?: string[];
  rankBy?: string;
  order?: 'desc' | 'asc';
  objective?: EvaluateObjective;
  constraints?: EvaluateConstraint[];
  onlyPassing?: boolean;
}

export interface EvaluateChangesRow {
  index: number;
  label?: string;
  /** Weighted objective score (only with `objective`). */
  score?: number;
  /** Weighted stats this row's value is not a number for; they added nothing to `score`. */
  unscored?: string[];
  /** Constraints the variant breaks, e.g. "FireResist 72 < 75" (only when there are any). */
  violates?: string[];
  /** The variant's value of the rankBy stat (not with `objective`). */
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
  /** The stat the rows are ranked by; absent when ranked by an `objective`. */
  rankBy?: string;
  order: 'desc' | 'asc';
  /** Present with `objective`: the mode, and the weighted stats ignored for every row (non-numeric base, or base 0 in relative mode). */
  objective?: { mode: 'relative' | 'absolute'; ignored?: string[] };
  base: Stats;
  evaluated: number;
  failed: number;
  fallbacks: number;
  /** Present with `constraints`: the evaluated variants that break one (dropped from `results` with onlyPassing). */
  violating?: number;
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

function requestedStats(input: EvaluateChangesInput, rankBy: string | undefined): string[] {
  const keys = [...new Set(input.stats && input.stats.length > 0 ? input.stats : DEFAULT_EVALUATE_STATS)];
  if (rankBy !== undefined && !keys.includes(rankBy)) keys.unshift(rankBy);
  // A weighted or constrained stat that is already listed is not added again (nor counted twice).
  const added: string[] = [];
  for (const key of [...Object.keys(input.objective?.weights ?? {}), ...(input.constraints ?? []).map((c) => c.stat)]) {
    if (!keys.includes(key)) {
      keys.push(key);
      added.push(key);
    }
  }
  if (added.length > 0 && keys.length > MAX_EVALUATE_STATS) {
    throw new UserError(
      `Too many stats: ${keys.length - added.length} requested plus ${added.length} more used by the objective / constraints (${added.slice(0, 5).join(', ')}${added.length > 5 ? ', ...' : ''}); at most ${MAX_EVALUATE_STATS} in all.`,
    );
  }
  return keys;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Reject bad objective / constraint input (the tool schema checks the same bounds; direct callers get them too). */
export function validateObjectiveInput(input: EvaluateChangesInput): void {
  const { objective, constraints } = input;
  if (objective !== undefined) {
    if (input.rankBy !== undefined) throw new UserError('Pass either `objective` or `rankBy`, not both: with an objective the rows are ranked by its score.');
    const entries = Object.entries(objective.weights ?? {});
    if (entries.length === 0) throw new UserError('objective.weights needs at least one stat.');
    if (entries.length > MAX_OBJECTIVE_WEIGHTS) throw new UserError(`objective.weights has ${entries.length} stats (at most ${MAX_OBJECTIVE_WEIGHTS}).`);
    for (const [stat, weight] of entries) {
      if (stat.length === 0) throw new UserError('objective.weights has an empty stat key.');
      if (!finite(weight)) throw new UserError(`objective.weights.${stat} must be a finite number.`);
    }
    if (entries.every(([, w]) => w === 0)) throw new UserError('objective.weights are all 0, so every variant would score 0.');
    if (objective.mode !== undefined && objective.mode !== 'relative' && objective.mode !== 'absolute') {
      throw new UserError('objective.mode must be "relative" or "absolute".');
    }
  }
  if (constraints !== undefined) {
    if (constraints.length > MAX_CONSTRAINTS) throw new UserError(`${constraints.length} constraints (at most ${MAX_CONSTRAINTS}).`);
    constraints.forEach((c, i) => {
      const where = `constraints[${i}]${c.stat ? ` (${c.stat})` : ''}`;
      if (typeof c.stat !== 'string' || c.stat.length === 0) throw new UserError(`${where}: stat is required.`);
      const bounds = [c.min, c.max, c.minDelta, c.maxDelta];
      if (bounds.every((b) => b === undefined)) throw new UserError(`${where}: give at least one of min, max, minDelta, maxDelta.`);
      if (bounds.some((b) => b !== undefined && !finite(b))) throw new UserError(`${where}: min / max / minDelta / maxDelta must be finite numbers.`);
      if (c.min !== undefined && c.max !== undefined && c.min > c.max) throw new UserError(`${where}: min ${c.min} is above max ${c.max}.`);
      if (c.minDelta !== undefined && c.maxDelta !== undefined && c.minDelta > c.maxDelta) {
        throw new UserError(`${where}: minDelta ${c.minDelta} is above maxDelta ${c.maxDelta}.`);
      }
    });
  }
  if (input.onlyPassing && (constraints === undefined || constraints.length === 0)) {
    throw new UserError('onlyPassing needs `constraints` to filter by.');
  }
}

const NOT_A_NUMBER = 'n/a (not a number)';

/** A broken value for a violation text: rounded like every number, but with enough digits that it never reads equal to the bound it breaks (74.996 vs 75, not "75 < 75"). */
function showBroken(value: number | null, bound: number): string {
  if (value === null) return NOT_A_NUMBER;
  const rounded = roundStat(value);
  return String(rounded === bound ? Number(value.toPrecision(12)) : rounded);
}

/** Why the variant breaks each constraint ("FireResist 72 < 75"); a stat that is not a number breaks every bound. */
export function violations(constraints: EvaluateConstraint[], base: Stats, after: Stats): string[] {
  const out: string[] = [];
  for (const c of constraints) {
    const value = finite(after[c.stat]) ? (after[c.stat] as number) : null;
    const delta = statDelta(base[c.stat], after[c.stat]);
    if (c.min !== undefined && !(value !== null && value >= c.min)) out.push(`${c.stat} ${showBroken(value, c.min)} < ${c.min}`);
    if (c.max !== undefined && !(value !== null && value <= c.max)) out.push(`${c.stat} ${showBroken(value, c.max)} > ${c.max}`);
    if (c.minDelta !== undefined && !(delta !== null && delta >= c.minDelta)) out.push(`${c.stat} change ${showBroken(delta, c.minDelta)} < ${c.minDelta}`);
    if (c.maxDelta !== undefined && !(delta !== null && delta <= c.maxDelta)) out.push(`${c.stat} change ${showBroken(delta, c.maxDelta)} > ${c.maxDelta}`);
  }
  return out;
}

export interface Scorer {
  /** Weighted stats that add nothing for any row. */
  ignored: string[];
  score(after: Stats): { score: number; unscored: string[] };
}

/** score = sum of weight * change: delta / |base| (relative; a base that is 0 or not a number counts for nothing) or the raw delta (absolute). */
export function makeScorer(objective: EvaluateObjective, base: Stats): Scorer {
  const mode = objective.mode ?? 'relative';
  const entries = Object.entries(objective.weights);
  const ignored = entries.filter(([stat]) => !finite(base[stat]) || (mode === 'relative' && base[stat] === 0)).map(([stat]) => stat);
  return {
    ignored,
    score(after) {
      let score = 0;
      const unscored: string[] = [];
      for (const [stat, weight] of entries) {
        if (ignored.includes(stat)) continue;
        const b = base[stat] as number;
        const v = after[stat];
        if (!finite(v)) {
          unscored.push(stat);
          continue;
        }
        score += weight * (mode === 'relative' ? (v - b) / Math.abs(b) : v - b);
      }
      return { score, unscored };
    },
  };
}

function toRow(
  index: number,
  label: string | undefined,
  r: ProbeVariantResult,
  base: Stats,
  keys: string[],
  rankBy: string | undefined,
  extra: { score?: { score: number; unscored: string[] }; violates: string[] },
): EvaluateChangesRow {
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
    ...(extra.score ? { score: roundStat(extra.score.score) } : {}),
    ...(extra.score && extra.score.unscored.length > 0 ? { unscored: extra.score.unscored } : {}),
    ...(extra.violates.length > 0 ? { violates: extra.violates } : {}),
    ...(rankBy !== undefined ? { value: roundValue(r.stats[rankBy] ?? null) } : {}),
    delta,
    ...(r.pointsAdded ? { pointsAdded: r.pointsAdded } : {}),
    ...(r.pointsRemoved ? { pointsRemoved: r.pointsRemoved } : {}),
    ...(r.fallback ? { fallback: true as const } : {}),
  };
}

/**
 * Run every variant through the probe engine and rank them: by the rankBy stat's change, or by the objective's
 * score. With constraints, variants that pass come first, then the violating ones (each group ranked the same
 * way), then the refused ones.
 */
export async function evaluateChanges(session: BuildSession, input: EvaluateChangesInput): Promise<EvaluateChangesResult> {
  validateObjectiveInput(input);
  const rankBy = input.objective ? undefined : (input.rankBy ?? 'CombinedDPS');
  const order = input.order ?? 'desc';
  const keys = requestedStats(input, rankBy);
  const variants: NamedProbeVariant[] = input.variants.map(({ label: _label, ...variant }) => variant);
  const probed = await session.probeNamed({ stats: keys, variants });
  const constraints = input.constraints ?? [];
  const scorer = input.objective ? makeScorer(input.objective, probed.base) : undefined;

  const ok: number[] = [];
  const failedRows: number[] = [];
  probed.results.forEach((r, i) => (r.error === undefined ? ok : failedRows).push(i));
  const scores = new Map<number, { score: number; unscored: string[] }>();
  const broken = new Map<number, string[]>();
  for (const i of ok) {
    if (scorer) scores.set(i, scorer.score(probed.results[i].stats));
    broken.set(i, constraints.length > 0 ? violations(constraints, probed.base, probed.results[i].stats) : []);
  }
  const rankKey = (i: number): number | null => {
    if (scorer) return scores.get(i)!.score;
    return statDelta(probed.base[rankBy!], probed.results[i].stats[rankBy!]);
  };
  const sign = order === 'desc' ? -1 : 1;
  ok.sort((a, b) => {
    const va = broken.get(a)!.length > 0 ? 1 : 0;
    const vb = broken.get(b)!.length > 0 ? 1 : 0;
    if (va !== vb) return va - vb;
    const da = rankKey(a);
    const db = rankKey(b);
    if (da === null || db === null) return da === db ? a - b : da === null ? 1 : -1;
    return da === db ? a - b : sign * (da - db);
  });
  const violating = ok.filter((i) => broken.get(i)!.length > 0).length;
  const shown = input.onlyPassing ? ok.filter((i) => broken.get(i)!.length === 0) : ok;

  const base: Stats = {};
  for (const key of keys) base[key] = roundValue(probed.base[key] ?? null);
  return {
    ...(rankBy !== undefined ? { rankBy } : {}),
    order,
    ...(scorer ? { objective: { mode: input.objective!.mode ?? 'relative', ...(scorer.ignored.length > 0 ? { ignored: scorer.ignored } : {}) } } : {}),
    base,
    evaluated: ok.length,
    failed: failedRows.length,
    fallbacks: probed.results.filter((r) => r.fallback).length,
    ...(constraints.length > 0 ? { violating } : {}),
    results: [...shown, ...failedRows].map((i) =>
      toRow(i, input.variants[i].label, probed.results[i], probed.base, keys, rankBy, { score: scores.get(i), violates: broken.get(i) ?? [] }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const nodeRef = z.union([z.number().int(), z.string().min(1)]);
const groupIndex = z.number().int().min(1);
export const gemLevel = z.number().int().min(1).max(40);
export const gemQuality = z.number().int().min(0).max(40);

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

/** A mastery and the effect to choose on it (variants, allocate_nodes). */
export const masteryChoiceSchema = z.object({
  node: nodeRef.describe(
    'Mastery node id, or its name: a name picks the allocated mastery of that name that has `effect` already, else the only allocated one (an effect switch), else the only one a path reaches; anything else is refused with the ids (pass an id to allocate a second mastery of a name).',
  ),
  effect: z
    .union([z.number().int(), z.string().min(1).max(MAX_LABEL * 3)])
    .describe('Effect id (get_passive_tree `masteries` lists them), or its text: the whole effect, one of its lines, or a part only one of its effects has.'),
});

export const masteriesSchema = z
  .array(masteryChoiceSchema)
  .max(MAX_VARIANT_MASTERIES)
  .describe(
    'Masteries to allocate (with their path from the allocated tree) with the given effect, or allocated masteries to switch to another effect. ' +
      'Each effect can be chosen on one mastery only; a mastery the same change removes (it depends on a deallocated node) is refused. List effect ids with get_passive_tree `masteries`.',
  );

export const mainSkillSchema = z
  .object({
    group: groupIndex.describe('1-based socket group index from list_skill_groups.'),
    activeSkill: groupIndex.optional().describe("1-based active skill within the group (default: the group's current choice)."),
  })
  .describe(
    'The main skill to use, as set_main_skill sets it (applied after every other change of the variant; group indices as list_skill_groups shows them now). Refused with an item or node change that may add or remove item- or passive-granted skill groups: make that change first.',
  );

export const variantSchema = z.object({
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
  masteries: masteriesSchema.optional(),
  mainSkill: mainSkillSchema.optional(),
});

export function registerEvaluateChanges(tools: ToolRegistrar): void {
  tools.engine<EvaluateChangesInput>(
    'evaluate_changes',
    {
      description:
        `Try up to ${MAX_PROBE_VARIANTS} what-if variants of the build in one call and get a compact table ranked by one stat. ` +
        'Each variant may combine passive nodes to allocate/deallocate (names or ids), mastery effects (`masteries` [{node, effect}]: allocate a mastery with that effect, or switch an allocated mastery to it), items to equip or unequip, gem changes, config options, and `mainSkill` {group, activeSkill?} (the stats are computed with that socket group as the main skill, e.g. "what does this tree do for my other skill?"); ' +
        "they apply in the order config, gems, items, nodes and masteries, main skill. Every variant is evaluated through Path of Building's own calculator (a few ms each); " +
        `variants it cannot reproduce exactly (several node or mastery changes in one variant, jewel sockets, skill-granting nodes or items) are applied, recalculated and restored instead (~0.3-0.5 s each, at most ${MAX_FALLBACK_VARIANTS} per call) and marked \`fallback\`. ` +
        'NOTHING IS APPLIED TO THE BUILD and nothing is pushed to undo. To keep a winner, pass the same variant to apply_changes (one undoable step). ' +
        'Returns `base` (the requested stats now), then `results` sorted by the change of `rankBy` (default CombinedDPS, `order` desc): ' +
        'each row has `index` (position in `variants`), `label`, `value` (the variant\'s rankBy stat), `delta` (change of every requested stat, null when not a number), ' +
        '`pointsAdded` / `pointsRemoved` for node changes, and `fallback`. A refused variant (unknown node or gem, item that does not fit, bad config) is listed after the others with its `error`; the call still succeeds. ' +
        'Numbers are rounded to 2 decimals (4 significant digits below 1). A node name resolves among the nodes the change can apply to (unallocated ones for allocate, allocated ones for deallocate); a name several of them share (e.g. "Strength") refuses that variant with the candidate ids, so pass ids for those. ' +
        `Per variant: at most ${MAX_VARIANT_NODES} nodes in each of allocate / deallocate, ${MAX_VARIANT_MASTERIES} masteries, ${MAX_VARIANT_ITEMS} items, ${MAX_VARIANT_GEMS} gem changes, ${MAX_VARIANT_CONFIG_KEYS} config keys; at most ${MAX_NODE_NAMES} different node names per call. ` +
        'Optional `objective` {weights:{stat:weight}, mode:"relative"|"absolute"} ranks by `score` = sum of weight x change instead of `rankBy` (give one, not both; rows then have `score` and no `value`). ' +
        'Relative (default): delta/|base|, so a tiny base dominates the score; prefer "absolute" (raw delta) or small weights for those. A stat whose base is 0 or not a number counts for nothing and is listed in `objective.ignored`; a row whose own value is not a number lists it in `unscored`. Negative weights penalise. ' +
        'Optional `constraints` [{stat, min?, max?, minDelta?, maxDelta?}] limit the variant\'s resulting value (or change): rows that break one list `violates` (e.g. "FireResist 72 < 75"; a non-number stat breaks it), come after the passing rows, and are counted in `violating`; `onlyPassing` drops them. Weighted and constrained stats are added to `stats`.',
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
        objective: z
          .object({
            weights: z
              .record(z.string().min(1), z.number().finite())
              .refine((w) => Object.keys(w).length >= 1 && Object.keys(w).length <= MAX_OBJECTIVE_WEIGHTS, { message: `1 to ${MAX_OBJECTIVE_WEIGHTS} weighted stats` })
              .describe('Stat key -> weight (negative penalises), e.g. {"CombinedDPS":1,"TotalEHP":0.5}.'),
            mode: z.enum(['relative', 'absolute']).optional().describe('"relative" (default): weight x delta/|base|, so stats of different scale compare; "absolute": weight x raw delta.'),
          })
          .optional()
          .describe('Rank by a weighted score instead of `rankBy`.'),
        constraints: z
          .array(
            z.object({
              stat: z.string().min(1),
              min: z.number().finite().optional().describe('Smallest allowed resulting value.'),
              max: z.number().finite().optional().describe('Largest allowed resulting value.'),
              minDelta: z.number().finite().optional().describe('Smallest allowed change from the base.'),
              maxDelta: z.number().finite().optional().describe('Largest allowed change from the base.'),
            }),
          )
          .max(MAX_CONSTRAINTS)
          .optional()
          .describe('Hard limits (at least one of min / max / minDelta / maxDelta each); a variant that breaks one is ranked after those that pass.'),
        onlyPassing: z.boolean().optional().describe('With `constraints`: leave the violating variants out of `results` (they are still counted in `violating`).'),
      },
    },
    (args, session) => evaluateChanges(session, args),
  );
}
