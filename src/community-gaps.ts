/**
 * community_gap_report: what at least `minShare` of a saved community sample
 * has that the loaded build lacks (gear, gems, passive tree, settings; shares
 * in src/community-gaps-shares.ts), each gap measured on the loaded build with
 * PoB's probe engine (BuildSession.probeNamed: nothing is applied, nothing is
 * pushed to undo or the crash journal) and ranked by PoB gain: one stat
 * (`rankBy`) or a weighted `objective`, as evaluate_changes ranks. Stale sample
 * snapshots are re-read first (freshSampleSnapshots: one temporary engine).
 */
import { z } from 'zod';
import type { BuildSession, NamedProbeVariant, SlotInfo } from './build-session.js';
import { freshSampleSnapshots } from './community-samples.js';
import {
  GAP_CATEGORIES,
  type GapCandidate,
  type GapCategory,
  type GapFilter,
  filterSample,
  type ItemCopy,
  mainGroupIndex,
  type SampleEntry,
  sampleShares,
  sampleSummary,
  activeSlot,
  type UncommonEntry,
} from './community-gaps-shares.js';
import { type BuildSnapshot, normalizeSnapshot, type RawSnapshot } from './compare-builds.js';
import type { EngineManager } from './engine-manager.js';
import { type EvaluateObjective, makeScorer, roundStat, validateObjectiveInput } from './evaluate-changes.js';
import type { Stats } from './lua-bridge.js';
import { PROBE_CHUNK, type ProbeGemChange, type ProbeVariantResult } from './probe.js';
import { SampleStore } from './sample-store.js';
import type { ToolRegistrar } from './tool-registry.js';
import { UserError } from './validation.js';

/** Probe variants per call, and of them variants that need a full recalculation (jewel sockets, skill-granting items). */
export const MAX_GAP_VARIANTS = 400;
export const MAX_GAP_FALLBACKS = 40;
export const DEFAULT_MIN_SHARE = 0.3;
export const DEFAULT_MAX_PER_CATEGORY = 10;
export const MAX_PER_CATEGORY = 30;
const MAX_UNCOMMON = 10;
const MAX_NOTE = 300;
const MAX_GEM_LEVEL = 20;
const MAX_SOCKETED_GEMS = 6;
const REPORT_STATS = ['CombinedDPS', 'TotalEHP', 'Life', 'EnergyShield'];
const DELTA_STATS = ['CombinedDPS', 'TotalEHP', 'Life'];
const BUDGET_NOTE = 'not measured: budget';
const AMBIGUOUS_RE = /matches \d+ nodes/;

/** Probe budget per call (tests lower it). */
export interface GapLimits {
  maxVariants?: number;
  maxFallbacks?: number;
}

export interface CommunityGapArgs {
  sample: string;
  categories?: GapCategory[];
  minShare?: number;
  rankBy?: string;
  objective?: EvaluateObjective;
  filter?: GapFilter;
  maxPerCategory?: number;
}

interface Probe {
  row: Row;
  variant: NamedProbeVariant;
  /** Jewel in a passive-tree socket: always a full recalculation. */
  predictedFallback: boolean;
  copy?: ItemCopy;
  slot?: string;
  replaces?: string;
  /** Flask slot turned on for the what-if. */
  activated?: boolean;
  result?: ProbeVariantResult;
  budget?: boolean;
}

interface Row {
  c: GapCandidate;
  probes: Probe[];
  /** Set when the row cannot be measured (before probing). */
  note?: string;
  /** Tree: retried by the sample's node id after an ambiguous name. */
  retried?: boolean;
}

const clip = (s: string): string => (s.length > MAX_NOTE ? `${s.slice(0, MAX_NOTE - 1)}…` : s);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------------------
// The loaded build: what the what-ifs need
// ---------------------------------------------------------------------------

interface LoadedContext {
  snapshot: BuildSnapshot;
  /** Items by their actual slot name. */
  bySlot: Map<string, string>;
  /** "Weapon 1" / "Weapon 2" as the build's weapon set in use names them. */
  weaponSlot: (slot: 'Weapon 1' | 'Weapon 2') => string;
  flaskSlots: SlotInfo[];
  /** First empty allocated passive-tree socket, by node id. */
  treeSocket?: string;
  /** First empty abyssal socket the build's items have. */
  abyssSocket?: string;
}

async function loadedContext(session: BuildSession): Promise<LoadedContext> {
  const snapshot = normalizeSnapshot(await session.compareSnapshot<RawSnapshot>(['Life']));
  const slots = await session.getValidSlots();
  const usesSwap = snapshot.items.some((i) => i.swap && !i.inactive);
  const bySlot = new Map(snapshot.items.map((i) => [i.slot, i.name ?? i.base ?? '?']));
  const treeSockets = slots
    .filter((s) => /^Jewel \d+$/.test(s.slot) && s.allocated === true && !s.occupied)
    .sort((a, b) => Number(a.slot.slice(6)) - Number(b.slot.slice(6)));
  // Abyssal sockets of the weapon set not in use count for nothing.
  const inUse = (parent: string): boolean => !parent.startsWith('Weapon') || parent.includes(' Swap') === usesSwap;
  const abyss = slots.find((s) => s.parentSlot !== undefined && !s.occupied && inUse(s.parentSlot));
  return {
    snapshot,
    bySlot,
    weaponSlot: (slot) => (usesSwap ? `${slot} Swap` : slot),
    flaskSlots: slots.filter((s) => /^Flask [1-5]$/.test(s.slot)),
    ...(treeSockets[0] ? { treeSocket: treeSockets[0].slot } : {}),
    ...(abyss ? { abyssSocket: abyss.slot } : {}),
  };
}

// ---------------------------------------------------------------------------
// Variants per gap
// ---------------------------------------------------------------------------

function itemProbes(row: Row, ctx: LoadedContext, samples: Map<string, SampleEntry>): void {
  const { c } = row;
  const copies = c.copies ?? [];
  const add = (p: Omit<Probe, 'row'>): void => {
    row.probes.push({ row, ...p });
  };
  if (c.kind === 'item') {
    const slots = c.slot === 'Ring' ? ['Ring 1', 'Ring 2'] : [c.slot === 'Weapon 1' || c.slot === 'Weapon 2' ? ctx.weaponSlot(c.slot) : c.slot!];
    for (const copy of copies) {
      for (const slot of slots) {
        const items: NonNullable<NamedProbeVariant['items']> = [{ slot, itemText: copy.text }];
        if (c.slot === 'Weapon 1') {
          // Keep two-handers and off-hands coherent: the source build's off-hand comes along.
          const offSlot = ctx.weaponSlot('Weapon 2');
          const off = samples.get(copy.from.build)?.snapshot.items.find((i) => activeSlot(i) === 'Weapon 2' && typeof i.text === 'string');
          if (off) items.push({ slot: offSlot, itemText: off.text! });
          else if (ctx.bySlot.has(offSlot)) items.push({ slot: offSlot, unequip: true });
        }
        add({ variant: { items }, predictedFallback: false, copy, slot, ...(ctx.bySlot.has(slot) ? { replaces: ctx.bySlot.get(slot) } : {}) });
      }
    }
  } else if (c.kind === 'flask') {
    if (ctx.flaskSlots.length === 0) row.note = 'not measured: the build has no flask slots';
    for (const copy of copies) {
      for (const s of ctx.flaskSlots) {
        const activate = s.active === false;
        add({
          variant: { items: [{ slot: s.slot, itemText: copy.text }], ...(activate ? { flasks: [{ slot: s.slot, active: true }] } : {}) },
          predictedFallback: false,
          copy,
          slot: s.slot,
          ...(ctx.bySlot.has(s.slot) ? { replaces: ctx.bySlot.get(s.slot) } : {}),
          ...(activate ? { activated: true } : {}),
        });
      }
    }
  } else {
    const socket = ctx.treeSocket ?? (c.abyss ? ctx.abyssSocket : undefined);
    if (!socket) {
      row.note = c.abyss
        ? 'not measured: the build has no empty allocated passive-tree jewel socket or empty abyssal socket'
        : 'not measured: the build has no empty allocated passive-tree jewel socket';
      return;
    }
    for (const copy of copies) {
      add({ variant: { items: [{ slot: socket, itemText: copy.text }] }, predictedFallback: socket.startsWith('Jewel '), copy, slot: socket });
    }
  }
}

async function supportProbes(row: Row, ctx: LoadedContext, session: BuildSession): Promise<void> {
  const mi = mainGroupIndex(ctx.snapshot);
  const main = ctx.snapshot.groups[mi];
  if (!main) {
    row.note = 'not measured: the build has no main skill group';
    return;
  }
  let cap = MAX_GEM_LEVEL;
  try {
    const gem = await session.getGemByName(row.c.name);
    if (!gem) throw new UserError(`gem "${row.c.name}" not found`);
    cap = Math.min(MAX_GEM_LEVEL, gem.naturalMaxLevel ?? MAX_GEM_LEVEL);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    row.note = clip(e.message);
    return;
  }
  const level = Math.max(1, Math.min(row.c.gem?.level ?? MAX_GEM_LEVEL, cap));
  const quality = Math.max(0, Math.min(row.c.gem?.quality ?? 0, 40));
  const group = mi + 1;
  main.gems.forEach((g, j) => {
    if (!g.support) return;
    const op: ProbeGemChange = { op: 'set', group, index: j + 1, name: row.c.name, level, quality };
    row.probes.push({ row, variant: { gems: [op] }, predictedFallback: false, replaces: g.name });
  });
  if (main.gems.length < MAX_SOCKETED_GEMS) {
    row.probes.push({ row, variant: { gems: [{ op: 'add', group, name: row.c.name, level, quality }] }, predictedFallback: false });
  }
}

function treeVariant(c: GapCandidate, byId: boolean): NamedProbeVariant {
  const id = c.nodeIds?.[0];
  if (c.mastery) return { masteries: [{ node: byId && id !== undefined ? id : c.mastery.name, effect: c.mastery.effect }] };
  return { allocate: [byId && id !== undefined ? id : c.name] };
}

async function planRow(row: Row, ctx: LoadedContext, session: BuildSession, samples: Map<string, SampleEntry>): Promise<void> {
  const { c } = row;
  if (c.unmeasured) {
    row.note = c.unmeasured;
    return;
  }
  if (c.kind === 'item' || c.kind === 'flask' || c.kind === 'jewel') itemProbes(row, ctx, samples);
  else if (c.kind === 'support') await supportProbes(row, ctx, session);
  else if (c.kind === 'config') row.probes.push({ row, variant: { config: { [c.config!.key]: c.config!.value as string | number | boolean } }, predictedFallback: false });
  else row.probes.push({ row, variant: treeVariant(c, false), predictedFallback: false });
}

// ---------------------------------------------------------------------------
// Running the probes within the budget
// ---------------------------------------------------------------------------

class ProbeRunner {
  base?: Stats;
  variantsLeft: number;
  fallbacksLeft: number;

  constructor(
    private readonly session: BuildSession,
    private readonly stats: string[],
    limits: GapLimits,
  ) {
    this.variantsLeft = limits.maxVariants ?? MAX_GAP_VARIANTS;
    this.fallbacksLeft = limits.maxFallbacks ?? MAX_GAP_FALLBACKS;
  }

  /** Reserve whole rows (all their variants) in order while the variant budget lasts; the rest are budget-limited. */
  reserve(rows: Row[], fallbackCap = Number.POSITIVE_INFINITY): Probe[] {
    const out: Probe[] = [];
    let fallbacks = 0;
    for (const row of rows) {
      const n = row.probes.length;
      if (n === 0) continue;
      if (n > this.variantsLeft || fallbacks + n > fallbackCap) {
        for (const p of row.probes) p.budget = true;
        continue;
      }
      this.variantsLeft -= n;
      if (fallbackCap !== Number.POSITIVE_INFINITY) fallbacks += n;
      out.push(...row.probes);
    }
    return out;
  }

  /**
   * Probe in chunks no larger than the full-recalculation budget left, so the
   * call never passes it whatever the chunk holds; once it is used up the
   * remaining probes are budget-limited. A refused variant keeps its user
   * error; any other failure fails the call.
   */
  async run(probes: Probe[]): Promise<void> {
    for (let i = 0; i < probes.length; ) {
      if (this.fallbacksLeft <= 0) {
        for (const p of probes.slice(i)) p.budget = true;
        return;
      }
      const chunk = probes.slice(i, i + Math.min(PROBE_CHUNK, this.fallbacksLeft));
      const res = await this.session.probeNamed({ stats: this.stats, variants: chunk.map((p) => p.variant) });
      this.base ??= res.base;
      res.results.forEach((r, j) => {
        if (r.error !== undefined && !r.userError) throw new Error(`community_gap_report: evaluating "${chunk[j].row.c.name}" failed: ${r.error}`);
        chunk[j].result = r;
        if (r.fallback) this.fallbacksLeft--;
      });
      i += chunk.length;
    }
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface Ranking {
  rankBy?: string;
  score(stats: Stats): number | null;
}

function ranking(args: CommunityGapArgs, base: Stats): Ranking & { objective?: Record<string, unknown> } {
  if (args.objective) {
    const scorer = makeScorer(args.objective, base);
    return {
      objective: { weights: args.objective.weights, mode: args.objective.mode ?? 'relative', ...(scorer.ignored.length ? { ignored: scorer.ignored } : {}) },
      score: (stats) => scorer.score(stats).score,
    };
  }
  const rankBy = args.rankBy ?? 'CombinedDPS';
  return {
    rankBy,
    score: (stats) => (num(base[rankBy]) && num(stats[rankBy]) ? (stats[rankBy] as number) - (base[rankBy] as number) : null),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const isItemKind = (k: string): boolean => k === 'item' || k === 'flask' || k === 'jewel';

interface BuiltRow {
  out: Record<string, unknown>;
  category: GapCategory;
  measured: boolean;
  sortKey: number | null;
  share: number;
}

function buildRow(row: Row, rank: Ranking, base: Stats): BuiltRow {
  const { c } = row;
  const head: Record<string, unknown> = {
    kind: c.kind,
    name: c.name,
    ...(c.slot && c.kind === 'item' && c.slot !== 'Ring' ? { slot: c.slot } : {}),
    share: c.share,
    count: c.count,
  };
  if (c.config) {
    head.value = c.config.value;
    head.yours = c.config.yours;
    if (c.config.assumption) head.assumption = true;
  }
  const ok = row.probes.filter((p) => p.result && p.result.error === undefined);
  if (row.note !== undefined || ok.length === 0) {
    const refused = row.probes.find((p) => p.result?.error !== undefined);
    const note = row.note ?? (refused ? clip(refused.result!.error!) : BUDGET_NOTE);
    return { out: { ...head, measured: false, note }, category: c.category, measured: false, sortKey: null, share: c.share };
  }
  const scored = ok.map((p) => ({ p, v: rank.score(p.result!.stats) }));
  scored.sort((a, b) => (a.v === null ? 1 : b.v === null ? -1 : b.v - a.v));
  const best = scored[0];
  const stats = best.p.result!.stats;
  const out: Record<string, unknown> = { ...head, measured: true };
  if (best.v !== null) {
    out.delta = roundStat(best.v);
    if (rank.rankBy && num(base[rank.rankBy]) && base[rank.rankBy] !== 0) {
      out.pct = Math.round((best.v / Math.abs(base[rank.rankBy] as number)) * 10000) / 100;
    }
  }
  let sortKey = best.v;
  if (c.category === 'tree') {
    const points = best.p.result!.pointsAdded ?? 0;
    out.points = points;
    if (best.v !== null) {
      const per = points > 0 ? best.v / points : best.v;
      out.perPoint = roundStat(per);
      sortKey = per;
    }
  }
  const deltas: Record<string, number | null> = {};
  for (const k of DELTA_STATS) deltas[k] = num(base[k]) && num(stats[k]) ? roundStat((stats[k] as number) - (base[k] as number)) : null;
  out.deltas = deltas;
  if (isItemKind(c.kind)) {
    if (best.p.slot && c.kind !== 'item') out.slot = best.p.slot;
    else if (c.slot === 'Ring') out.slot = best.p.slot;
    out.best = {
      delta: best.v === null ? null : roundStat(best.v),
      from: best.p.copy!.from,
      ...(best.p.replaces !== undefined ? { replaces: best.p.replaces } : {}),
    };
    // Each copy's best slot, then the median over the copies.
    const perCopy = new Map<string, number>();
    for (const s of scored) {
      if (s.v === null) continue;
      const k = s.p.copy!.text;
      if (!perCopy.has(k) || perCopy.get(k)! < s.v) perCopy.set(k, s.v);
    }
    const m = median([...perCopy.values()]);
    if (m !== null) out.median = roundStat(m);
    if (best.p.activated) {
      out.note = `${best.p.slot} is not active in your build; measured with it turned on (set_flask_active, or flasks [{slot, active: true}] in apply_changes).`;
    }
  } else {
    if (c.kind === 'support') {
      out.best = { delta: best.v === null ? null : roundStat(best.v), ...(best.p.replaces !== undefined ? { replaces: best.p.replaces } : {}) };
    }
    out.apply = best.p.variant;
  }
  if (row.retried) out.note = `"${c.name}" names several nodes on your tree; measured on node ${c.nodeIds?.[0]}, the one the sample uses.`;
  return { out, category: c.category, measured: true, sortKey, share: c.share };
}

function rankRows(rows: BuiltRow[]): BuiltRow[] {
  return [...rows].sort((a, b) => {
    if (a.measured !== b.measured) return a.measured ? -1 : 1;
    if (a.measured) {
      if (a.sortKey === null || b.sortKey === null) {
        if (a.sortKey !== b.sortKey) return a.sortKey === null ? 1 : -1;
      } else if (a.sortKey !== b.sortKey) return b.sortKey - a.sortKey;
    }
    return b.share - a.share;
  });
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function checkArgs(args: CommunityGapArgs): { categories: Set<GapCategory>; minShare: number; maxPerCategory: number } {
  validateObjectiveInput({ variants: [], rankBy: args.rankBy, objective: args.objective });
  const minShare = args.minShare ?? DEFAULT_MIN_SHARE;
  if (!(minShare >= 0.05 && minShare <= 1)) throw new UserError('minShare must be between 0.05 and 1.');
  const maxPerCategory = args.maxPerCategory ?? DEFAULT_MAX_PER_CATEGORY;
  if (!Number.isInteger(maxPerCategory) || maxPerCategory < 1 || maxPerCategory > MAX_PER_CATEGORY) {
    throw new UserError(`maxPerCategory must be an integer from 1 to ${MAX_PER_CATEGORY}.`);
  }
  const categories = new Set<GapCategory>(args.categories && args.categories.length ? args.categories : GAP_CATEGORIES);
  for (const cat of categories) if (!GAP_CATEGORIES.includes(cat)) throw new UserError(`Unknown category "${cat}": use ${GAP_CATEGORIES.join(', ')}.`);
  if (args.filter?.minLevel !== undefined && !(Number.isInteger(args.filter.minLevel) && args.filter.minLevel >= 1 && args.filter.minLevel <= 100)) {
    throw new UserError('filter.minLevel must be an integer from 1 to 100.');
  }
  return { categories, minShare, maxPerCategory };
}

function cappedUncommon(list: UncommonEntry[] | undefined): Record<string, unknown> | undefined {
  if (!list) return undefined;
  const sorted = [...list].sort((a, b) => a.share - b.share || a.name.localeCompare(b.name));
  return sorted.length > MAX_UNCOMMON ? { list: sorted.slice(0, MAX_UNCOMMON), more: sorted.length - MAX_UNCOMMON } : { list: sorted };
}

/** The gap report (see the tool description). Call it inside engine.run(): the sample refresh may start a temporary engine. */
export async function communityGapReport(
  engine: EngineManager,
  store: SampleStore,
  session: BuildSession,
  args: CommunityGapArgs,
  limits: GapLimits = {},
): Promise<Record<string, unknown>> {
  const { categories, minShare, maxPerCategory } = checkArgs(args);
  if (!session.hasBuild()) throw new UserError('No build loaded — call load_build first (the gap report measures each gap on the loaded build).');

  const fresh = await freshSampleSnapshots(engine, store, args.sample);
  const used = filterSample(fresh.file.name, fresh.builds, args.filter);
  const ctx = await loadedContext(session);
  const configMeta = categories.has('settings') ? new Map((await session.getConfigMetadata()).map((m) => [m.var, m])) : new Map();
  const shares = sampleShares(ctx.snapshot, used, { categories, minShare, configMeta });
  const samples = new Map(used.map((b) => [b.id, b]));

  // Plan every gap, most shared first, so the budget goes to the most common gaps.
  const rows: Row[] = shares.candidates
    .map((c) => ({ c, probes: [] as Probe[] }))
    .sort((a, b) => b.c.share - a.c.share || GAP_CATEGORIES.indexOf(a.c.category) - GAP_CATEGORIES.indexOf(b.c.category) || a.c.name.localeCompare(b.c.name));
  for (const row of rows) await planRow(row, ctx, session, samples);

  const rankStats = args.objective ? Object.keys(args.objective.weights) : [args.rankBy ?? 'CombinedDPS'];
  const stats = [...new Set([...rankStats, ...REPORT_STATS])];
  const runner = new ProbeRunner(session, stats, limits);
  // Calculator variants first, then (with what the budget leaves) jewels in tree sockets, which each need a full recalculation.
  const fast = rows.filter((r) => r.probes.length && !r.probes.some((p) => p.predictedFallback));
  const slow = rows.filter((r) => r.probes.some((p) => p.predictedFallback));
  await runner.run(runner.reserve(fast));
  // Tree names several nodes share: measured again by the node id the sample uses.
  const retry: Row[] = [];
  for (const row of rows) {
    const r = row.probes[0]?.result;
    if (row.c.category === 'tree' && row.probes.length === 1 && r?.error && AMBIGUOUS_RE.test(r.error) && row.c.nodeIds?.length) {
      row.probes = [{ row, variant: treeVariant(row.c, true), predictedFallback: false }];
      row.retried = true;
      retry.push(row);
    }
  }
  await runner.run(runner.reserve(retry));
  await runner.run(runner.reserve(slow, runner.fallbacksLeft));
  for (const row of retry) {
    // A refused retry reports the retry's error; keep the ambiguity in the note.
    if (row.probes[0].result?.error) row.retried = false;
  }

  const base = runner.base ?? (await session.probe({ stats, variants: [] })).base;
  const rank = ranking(args, base);
  const built = rows.map((r) => buildRow(r, rank, base));

  const out: Record<string, unknown> = {
    sample: {
      name: fresh.file.name,
      size: fresh.file.builds.length,
      used: used.length,
      ...(args.filter && Object.keys(args.filter).length ? { filter: args.filter } : {}),
      mainSkillMatched: shares.mainSkillMatched,
      ...sampleSummary(used),
    },
    ...(rank.rankBy ? { rankBy: rank.rankBy } : { objective: rank.objective }),
    base: Object.fromEntries(stats.map((k) => [k, typeof base[k] === 'number' ? roundStat(base[k] as number) : (base[k] ?? null)])),
  };
  const more: Record<string, number> = {};
  for (const cat of GAP_CATEGORIES) {
    if (!categories.has(cat)) continue;
    const list = rankRows(built.filter((b) => b.category === cat));
    out[cat] = list.slice(0, maxPerCategory).map((b) => b.out);
    if (list.length > maxPerCategory) more[cat] = list.length - maxPerCategory;
  }
  if (Object.keys(more).length) out.more = more;
  const uncommon: Record<string, unknown> = {};
  for (const cat of ['gear', 'tree', 'gems'] as const) {
    const u = cappedUncommon(shares.uncommon[cat]);
    if (u) {
      uncommon[cat] = u.list;
      if (u.more) uncommon[`${cat}More`] = u.more;
    }
  }
  out.uncommon = uncommon;

  const notes = [...shares.notes];
  for (const d of fresh.dropped) notes.push(`Build ${d.id}${d.label ? ` (${d.label})` : ''} left out: ${clip(d.error)}`);
  const budgetRows = built.filter((b) => !b.measured && b.out.note === BUDGET_NOTE).length;
  if (budgetRows) {
    notes.push(
      `${budgetRows} gap(s) not measured: at most ${limits.maxVariants ?? MAX_GAP_VARIANTS} what-ifs (${limits.maxFallbacks ?? MAX_GAP_FALLBACKS} needing a full recalculation) per call; ` +
        'raise minShare or narrow categories to measure them.',
    );
  }
  out.notes = notes;
  return out;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCommunityGaps(tools: ToolRegistrar, engine: EngineManager, store: SampleStore = new SampleStore()): void {
  tools.engine<CommunityGapArgs>(
    'community_gap_report',
    {
      description:
        'Compare the loaded build with a saved community sample (add_sample_builds) and list what at least `minShare` (default 0.3) of the sample has that the loaded build lacks, ' +
        "each gap measured on the loaded build with Path of Building's own calculator and ranked by its gain. NOTHING IS APPLIED and nothing is pushed to undo. " +
        'Categories: `gear` (per slot by unique name or base type, rings pooled; flasks and jewels slot-agnostic, cluster jewels by base + small passive line), ' +
        '`gems` (supports of the main skill, share among the builds with the same main skill (`mainSkillMatched`); active skills outside the main group, listed unmeasured), ' +
        '`tree` (keystones, notables, mastery effects; ascendancy notables only from builds of your ascendancy; ranked per passive point), ' +
        '`settings` (bandit, pantheon and other config options: the most common value when it differs from yours; `assumption: true` for enemy / combat / effective-DPS options). ' +
        'Gear gaps try up to 5 sample copies in the slot (Weapon 1 brings its build\'s off-hand), flasks up to 3 copies in each flask slot, jewels in your first empty allocated tree socket (abyss jewels also an empty abyssal socket); ' +
        'supports replace each support of your main group (and are added when it has fewer than 6 gems) at the sample\'s usual level / quality. ' +
        'Ranking: `rankBy` (stat key, default CombinedDPS) or `objective` {weights, mode} as evaluate_changes (not both). `filter` {ascendancy, mainSkill, minLevel} narrows the sample first. ' +
        `At most ${MAX_GAP_VARIANTS} what-ifs (${MAX_GAP_FALLBACKS} full recalculations) per call; gaps past that are listed unmeasured (note "${BUDGET_NOTE}"). ` +
        'Stale sample builds (read with another PoB version) are read again first in a short-lived second engine. ' +
        'Returns { sample: {name, size, used, filter, mainSkillMatched, ascendancies, mainSkills, levelMedian}, rankBy | objective, base, gear, tree, gems, settings, more (rows cut by maxPerCategory), ' +
        'uncommon: {gear, tree, gems} (yours, used by < 10% of the sample), notes }. ' +
        'Each row: { kind, name, slot, share, count, measured, delta (rankBy change, or the objective score), pct, deltas {CombinedDPS, TotalEHP, Life}, points / perPoint (tree), ' +
        'best {delta, from {build, label, slot}, replaces}, median (gear), value / yours / assumption (settings), apply (the exact apply_changes variant: tree, gems, settings), note }; ' +
        'unmeasured rows (`measured: false`, `note` says why) come after the measured ones. Gear item text: list_samples {sample, build, slot} with best.from.',
      inputSchema: {
        sample: z.string().min(1).max(80).describe('Sample name (list_samples).'),
        categories: z.array(z.enum(['gear', 'gems', 'tree', 'settings'])).min(1).max(4).optional().describe('Default all four.'),
        minShare: z.number().min(0.05).max(1).optional().describe(`Smallest share of the sample a gap needs (default ${DEFAULT_MIN_SHARE}).`),
        rankBy: z.string().min(1).optional().describe('Stat key to rank by (default "CombinedDPS"); not with `objective`.'),
        objective: z
          .object({
            weights: z
              .record(z.string().min(1), z.number().finite())
              .describe('Stat key -> weight, e.g. {"CombinedDPS":1,"TotalEHP":0.5}.'),
            mode: z.enum(['relative', 'absolute']).optional(),
          })
          .optional()
          .describe('Rank by a weighted score (as evaluate_changes) instead of `rankBy`.'),
        filter: z
          .object({
            ascendancy: z.string().min(1).max(60).optional(),
            mainSkill: z.string().min(1).max(80).optional(),
            minLevel: z.number().int().min(1).max(100).optional(),
          })
          .optional()
          .describe('Use only the sample builds with this ascendancy / main skill (case-insensitive exact names) / at least this level.'),
        maxPerCategory: z.number().int().min(1).max(MAX_PER_CATEGORY).optional().describe(`Rows per category (default ${DEFAULT_MAX_PER_CATEGORY}).`),
      },
    },
    (args, session) => communityGapReport(engine, store, session, args),
  );
}
