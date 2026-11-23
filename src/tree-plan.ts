// Multi-point passive tree planning: plan_passive_points (spend N points, one
// step at a time) and the response shape of plan_respec (BuildSession.planRespec).
//
// plan_passive_points runs inside one passive-tree scope (BuildSession
// planPassivePoints: snapshot once, exact restore and a committed-state
// fingerprint check once at the end). A plan state is the tree with the
// state's steps allocated for real (allocNodes, PoB's paths, full recalc). From
// a state every candidate (an unallocated node, with its path, of at most
// min(maxPathCost, points left) points; with includeMasteries also each free
// effect of every reachable mastery) is one probe variant evaluated through
// PoB's calculator, as find_best_next_nodes evaluates them. Candidates are
// ranked by the objective's gain per point (fewest constraint violations
// first, then gain per point, gain, fewest points, id); only gains above
// noise count. beamWidth 1 (default) takes the best step every time (greedy);
// beamWidth b keeps the b best partial plans (by gain per point spent so far)
// and expands each with its b best steps, and the plan with the largest total
// gain wins. Every step's numbers are read from the real tree after the step
// (not the calculator's prediction), so the final stats are what applying the
// returned variant gives. Candidates needing a full recalculation (cluster
// jewel nodes, skill-granting nodes) are capped per expansion
// (MAX_SEARCH_FALLBACKS, fewest points first) and per plan
// (MAX_PLAN_FALLBACKS); a time budget (PLAN_TIME_BUDGET_MS) stops the search
// early. Both are reported. Callers hold the session lock.

import { z } from 'zod';
import {
  DEFAULT_EVALUATE_STATS,
  makeScorer,
  roundStat,
  validateObjectiveInput,
  violations,
  type EvaluateConstraint,
  type EvaluateObjective,
} from './evaluate-changes.js';
import type { Stats } from './lua-bridge.js';
import { MAX_PROBE_VARIANTS, type ProbeRequest, type ProbeResponse, type ProbeVariant, type ProbeVariantResult } from './probe.js';
import type { ToolRegistrar } from './tool-registry.js';
import { MAX_SEARCH_FALLBACKS } from './tree-search.js';
import { toNumber } from './stat-values.js';
import { UserError } from './validation.js';

export const MAX_PLAN_POINTS = 40;
export const DEFAULT_PLAN_PATH_COST = 3;
export const MAX_PLAN_PATH_COST = 6;
export const MAX_BEAM_WIDTH = 3;
/** Candidates needing a full recalculation evaluated per plan (each ~0.1-0.3 s). */
export const MAX_PLAN_FALLBACKS = 24;
/** The search stops expanding after this long and returns the best plan found so far. */
export const PLAN_TIME_BUDGET_MS = 45_000;
export const MAX_RESPEC_TARGET = 300;

export interface PlanDeps {
  send<T>(command: object): Promise<T>;
  probe(request: ProbeRequest): Promise<ProbeResponse>;
  /** Put the tree back exactly as the plan found it (beam search switches states). */
  resetTree(): Promise<void>;
  now?: () => number;
}

export interface PlanPointsOptions {
  points: number;
  optimizeFor?: string;
  objective?: EvaluateObjective;
  constraints?: EvaluateConstraint[];
  maxPathCost?: number;
  beamWidth?: number;
  includeMasteries?: boolean;
  excludeNodes?: Array<number | string>;
}

interface NodeRef {
  id: number;
  name: string;
}

interface Candidate {
  id: number;
  name: string;
  type: string;
  /** Path ids, tree side first, the node last. */
  nodes: number[];
  points: number;
  fallback?: string;
  mastery?: { effect: number; stats: string };
}

interface AddedNode {
  id: number;
  name: string;
  type: string;
  pointCost: 'passive' | 'ascendancy' | 'none';
}

export interface PlanStep {
  step: number;
  node: { id: number; name: string; type: string };
  mastery?: { effect: number; stats: string };
  /** The nodes the step allocated, in the order they joined the tree (the node last). */
  path: NodeRef[];
  points: number;
  pointsUsed: number;
  gain: number;
  gainPerPoint: number;
  /** The focus stats (optimizeFor / weighted / constrained) after the step. */
  after: Record<string, unknown>;
  violates?: string[];
  fallback?: true;
}

export interface PlanPointsResult {
  optimizeFor?: string;
  objective?: { mode: 'relative' | 'absolute'; ignored?: string[] };
  points: number;
  pointsUsed: number;
  maxPathCost: number;
  beamWidth: number;
  steps: PlanStep[];
  /** Total objective gain: the optimizeFor stat's change, or the objective score. */
  gain: number;
  before: Stats;
  after: Stats;
  delta: Record<string, number | null>;
  violates?: string[];
  /** Every node the plan allocates, in the order they join the tree (masteries included). */
  nodeIds: number[];
  applyChanges: { allocate: number[]; masteries?: Array<{ node: number; effect: number }> };
  allocateNodes: { nodes: number[]; masteries?: Array<{ node: number; effect: number }> };
  stoppedEarly?: string;
  evaluated: number;
  skippedSlow?: number;
  truncated?: string[];
  timeMs: number;
}

/** Reject bad options (the tool schema checks the same bounds; direct callers get them too). */
export function validatePlanOptions(opts: PlanPointsOptions): void {
  if (!Number.isInteger(opts.points) || opts.points < 1 || opts.points > MAX_PLAN_POINTS) {
    throw new UserError(`points must be an integer from 1 to ${MAX_PLAN_POINTS}`);
  }
  if (opts.objective !== undefined && opts.optimizeFor !== undefined) {
    throw new UserError('Pass either `optimizeFor` or `objective`, not both.');
  }
  validateObjectiveInput({ variants: [], objective: opts.objective, constraints: opts.constraints });
  const cost = opts.maxPathCost ?? DEFAULT_PLAN_PATH_COST;
  if (!Number.isInteger(cost) || cost < 1 || cost > MAX_PLAN_PATH_COST) throw new UserError(`maxPathCost must be an integer from 1 to ${MAX_PLAN_PATH_COST}`);
  const beam = opts.beamWidth ?? 1;
  if (!Number.isInteger(beam) || beam < 1 || beam > MAX_BEAM_WIDTH) throw new UserError(`beamWidth must be an integer from 1 to ${MAX_BEAM_WIDTH}`);
}

const array = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function unique(keys: string[]): string[] {
  return [...new Set(keys)];
}

interface State {
  key: string;
  parent?: State;
  /** The candidate this state's last step allocates. */
  cand?: Candidate;
  /** Set once the state was put on the tree. */
  stats?: Stats;
  ids: number[];
  masteries: Array<{ node: number; effect: number }>;
  points: number;
  steps: PlanStep[];
  /** Ranking estimate before materializing: the calculator's prediction. */
  predicted: number;
  done?: string;
}

interface Ranked {
  cand: Candidate;
  result: ProbeVariantResult;
  gain: number;
  perPoint: number;
  points: number;
  violates: string[];
}

export async function planPassivePoints(deps: PlanDeps, opts: PlanPointsOptions): Promise<PlanPointsResult> {
  validatePlanOptions(opts);
  const now = deps.now ?? Date.now;
  const started = now();
  const maxPathCost = opts.maxPathCost ?? DEFAULT_PLAN_PATH_COST;
  const beamWidth = opts.beamWidth ?? 1;
  const constraints = opts.constraints ?? [];
  const optimizeFor = opts.objective ? undefined : (opts.optimizeFor ?? 'CombinedDPS');
  const focus = unique([
    ...(optimizeFor ? [optimizeFor] : Object.keys(opts.objective!.weights)),
    ...constraints.map((c) => c.stat),
  ]);
  const keys = unique([...focus, ...DEFAULT_EVALUATE_STATS]);
  const excludedIds = new Set<number>();
  const excludedNames = new Set<string>();
  for (const ref of opts.excludeNodes ?? []) {
    if (typeof ref === 'number') excludedIds.add(ref);
    else excludedNames.add(ref.toLowerCase());
  }

  const readBase = async (): Promise<Stats> => (await deps.probe({ stats: keys, variants: [] })).base;
  const startStats = await readBase();
  const scorer = opts.objective ? makeScorer(opts.objective, startStats) : undefined;
  const value = (s: Stats): number => (scorer ? scorer.score(s).score : toNumber(s[optimizeFor!]));
  const startValue = value(startStats);
  const noise = (v: number): number => (scorer ? 1e-12 : 1e-9 * Math.max(1, Math.abs(v)));
  const focusOf = (s: Stats): Record<string, unknown> =>
    Object.fromEntries(focus.map((k) => [k, typeof s[k] === 'number' ? roundStat(s[k] as number) : (s[k] ?? null)]));

  let fallbackBudget = MAX_PLAN_FALLBACKS;
  let evaluated = 0;
  let skippedSlow = 0;
  const truncated = new Set<string>();
  const names = new Map<number, string>();

  // The tree's current state (the root is what the scope started with).
  const root: State = { key: '', ids: [], masteries: [], points: 0, steps: [], predicted: startValue, stats: startStats };
  let applied: State = root;

  const allocate = async (ids: number[], masteries: Array<{ node: number; effect: number }>): Promise<AddedNode[]> => {
    const res = await deps.send<{ added?: unknown }>({
      cmd: 'allocNodes',
      nodeIds: ids,
      ...(masteries.length > 0 ? { masteries } : {}),
    });
    return array<AddedNode>(res.added);
  };

  /** Put `s` on the tree (from its parent when the tree is there, else from the start) and read its stats. */
  const materialize = async (s: State): Promise<void> => {
    if (applied === s) return;
    const cand = s.cand!;
    const parent = s.parent!;
    const candIds = cand.mastery ? [] : [cand.id];
    const candMastery = cand.mastery ? [{ node: cand.id, effect: cand.mastery.effect }] : [];
    let added: AddedNode[];
    if (applied === parent) {
      added = await allocate(candIds, candMastery);
    } else {
      await deps.resetTree();
      applied = root;
      const all = await allocate([...parent.ids, ...candIds], [...parent.masteries, ...candMastery]);
      const before = new Set(parent.ids);
      added = all.filter((n) => !before.has(n.id));
    }
    applied = s;
    for (const n of added) names.set(n.id, n.name ?? '');
    s.ids = [...parent.ids, ...added.map((n) => n.id)];
    s.masteries = [...parent.masteries, ...candMastery];
    const points = added.filter((n) => n.pointCost === 'passive').length;
    s.points = parent.points + points;
    s.stats = await readBase();
    const gain = value(s.stats) - value(parent.stats!);
    const broken = constraints.length > 0 ? violations(constraints, startStats, s.stats) : [];
    s.steps = [
      ...parent.steps,
      {
        step: parent.steps.length + 1,
        node: { id: cand.id, name: cand.name, type: cand.type },
        ...(cand.mastery ? { mastery: cand.mastery } : {}),
        path: added.map((n) => ({ id: n.id, name: n.name ?? '' })),
        points,
        pointsUsed: s.points,
        gain: roundStat(gain),
        gainPerPoint: roundStat(points > 0 ? gain / points : gain),
        after: focusOf(s.stats),
        ...(broken.length > 0 ? { violates: broken } : {}),
        ...(cand.fallback ? { fallback: true as const } : {}),
      },
    ];
  };

  const listCandidates = async (maxPoints: number): Promise<Candidate[]> => {
    const res = await deps.send<{ nodes: unknown; names: unknown; masteries?: unknown }>({
      cmd: 'probe',
      candidates: 'allocate',
      maxPoints,
      ...(opts.includeMasteries ? { includeMasteries: true } : {}),
    });
    for (const n of array<NodeRef>(res.names)) names.set(n.id, n.name);
    const isExcluded = (ids: number[]): boolean =>
      ids.some((id) => excludedIds.has(id) || excludedNames.has((names.get(id) ?? '').toLowerCase()));
    const out: Candidate[] = [];
    for (const c of array<Candidate>(res.nodes)) {
      const nodes = array<number>(c.nodes);
      if (c.type === 'Socket' || isExcluded(nodes)) continue;
      out.push({ id: c.id, name: c.name, type: c.type, nodes, points: c.points, ...(c.fallback ? { fallback: c.fallback } : {}) });
    }
    for (const m of array<Candidate & { effects: unknown }>(res.masteries)) {
      const nodes = array<number>(m.nodes);
      if (isExcluded(nodes)) continue;
      for (const e of array<{ effect: number; stats: string }>(m.effects)) {
        out.push({ id: m.id, name: m.name, type: m.type, nodes, points: m.points, mastery: { effect: e.effect, stats: e.stats } });
      }
    }
    return out;
  };

  const variantOf = (c: Candidate): ProbeVariant => (c.mastery ? { masteries: [{ node: c.id, effect: c.mastery.effect }] } : { allocate: [c.id] });

  /** Every candidate from the state on the tree, ranked (improving ones only). */
  const rankFrom = async (s: State, maxPoints: number): Promise<Ranked[]> => {
    const all = await listCandidates(maxPoints);
    const slow = all.filter((c) => c.fallback !== undefined).sort((a, b) => a.points - b.points || a.id - b.id);
    const slowCap = Math.max(0, Math.min(MAX_SEARCH_FALLBACKS, fallbackBudget));
    const keptSlow = new Set(slow.slice(0, slowCap));
    if (slow.length > slowCap) {
      skippedSlow += slow.length - slowCap;
      truncated.add(
        `candidates needing a full recalculation (cluster jewel or skill-granting nodes) were capped at ${MAX_SEARCH_FALLBACKS} per step and ${MAX_PLAN_FALLBACKS} per plan, fewest points first; ${'`skippedSlow`'} counts the others`,
      );
    }
    const kept = all.filter((c) => c.fallback === undefined || keptSlow.has(c));
    const results: ProbeVariantResult[] = [];
    for (let i = 0; i < kept.length; i += MAX_PROBE_VARIANTS) {
      const res = await deps.probe({ stats: keys, variants: kept.slice(i, i + MAX_PROBE_VARIANTS).map(variantOf) });
      results.push(...res.results);
    }
    evaluated += kept.length;
    fallbackBudget -= results.filter((r) => r.fallback).length;
    const current = value(s.stats!);
    const ranked: Ranked[] = [];
    kept.forEach((cand, i) => {
      const r = results[i];
      if (r.error !== undefined) {
        if (r.userError) return; // refused as input (e.g. an effect taken meanwhile): not a candidate
        throw new Error(`plan_passive_points: evaluating node ${cand.id} (${cand.name}) failed: ${r.error}`);
      }
      const gain = value(r.stats) - current;
      if (!(gain > noise(current))) return;
      const points = r.pointsAdded ?? cand.points;
      ranked.push({
        cand,
        result: r,
        gain,
        perPoint: points > 0 ? gain / points : gain,
        points,
        violates: constraints.length > 0 ? violations(constraints, startStats, r.stats) : [],
      });
    });
    ranked.sort(
      (a, b) =>
        a.violates.length - b.violates.length ||
        b.perPoint - a.perPoint ||
        b.gain - a.gain ||
        a.points - b.points ||
        a.cand.id - b.cand.id ||
        (a.cand.mastery?.effect ?? 0) - (b.cand.mastery?.effect ?? 0),
    );
    return ranked;
  };

  const stateKey = (parent: State, c: Candidate): string => {
    const ids = new Set([...parent.ids, ...c.nodes]);
    const ms = [...parent.masteries.map((m) => `${m.node}:${m.effect}`), ...(c.mastery ? [`${c.id}:${c.mastery.effect}`] : [])];
    return [...[...ids].sort((a, b) => a - b), '|', ...ms.sort()].join(',');
  };

  let beams: State[] = [root];
  const finished: State[] = [];
  while (beams.length > 0) {
    if (now() - started > PLAN_TIME_BUDGET_MS) {
      truncated.add(`the search stopped after ${PLAN_TIME_BUDGET_MS / 1000} s; the plan holds the steps found by then`);
      for (const s of beams) s.done ??= 'time budget';
      finished.push(...beams);
      break;
    }
    const children: State[] = [];
    for (const s of beams) {
      await materialize(s);
      const left = opts.points - s.points;
      if (left <= 0) {
        finished.push(s);
        continue;
      }
      const ranked = await rankFrom(s, Math.min(maxPathCost, left));
      const currentBroken = constraints.length > 0 ? violations(constraints, startStats, s.stats!).length : 0;
      // A step keeps the constraints satisfied when one can; once broken, the fewest violations first.
      const usable = currentBroken === 0 ? ranked.filter((r) => r.violates.length === 0) : ranked;
      if (usable.length === 0) {
        s.done =
          ranked.length === 0
            ? `no candidate of at most ${Math.min(maxPathCost, left)} points improves ${optimizeFor ?? 'the objective'}`
            : 'every improving candidate breaks a constraint';
        finished.push(s);
        continue;
      }
      for (const r of usable.slice(0, beamWidth)) {
        const predicted = value(r.result.stats);
        children.push({ key: stateKey(s, r.cand), parent: s, cand: r.cand, ids: s.ids, masteries: s.masteries, points: s.points + r.points, steps: s.steps, predicted });
      }
    }
    // Keep the beamWidth best distinct partial plans by predicted gain per point spent.
    const perPoint = (c: State): number => (c.predicted - startValue) / Math.max(1, c.points);
    const seen = new Set<string>();
    beams = children
      .sort((a, b) => perPoint(b) - perPoint(a) || b.predicted - a.predicted || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)))
      .slice(0, beamWidth);
  }

  // The plan with the largest total gain (fewest points, then the earliest found, on ties).
  let best = finished[0] ?? root;
  for (const s of finished) {
    const gs = value(s.stats ?? startStats);
    const gb = value(best.stats ?? startStats);
    if (gs > gb + noise(gb) || (Math.abs(gs - gb) <= noise(gb) && s.points < best.points)) best = s;
  }
  const endStats = best.stats ?? startStats;
  const delta: Record<string, number | null> = {};
  for (const k of keys) {
    const a = startStats[k];
    const b = endStats[k];
    delta[k] = typeof a === 'number' && typeof b === 'number' ? roundStat(b - a) : null;
  }
  const masteryIds = new Set(best.masteries.map((m) => m.node));
  const allocateIds = best.ids.filter((id) => !masteryIds.has(id));
  const masteries = best.masteries.length > 0 ? { masteries: best.masteries } : {};
  const finalBroken = constraints.length > 0 ? violations(constraints, startStats, endStats) : [];
  const round = (s: Stats): Stats =>
    Object.fromEntries(keys.map((k) => [k, typeof s[k] === 'number' ? roundStat(s[k] as number) : (s[k] ?? null)]));
  return {
    ...(optimizeFor ? { optimizeFor } : {}),
    ...(scorer ? { objective: { mode: opts.objective!.mode ?? 'relative', ...(scorer.ignored.length > 0 ? { ignored: scorer.ignored } : {}) } } : {}),
    points: opts.points,
    pointsUsed: best.points,
    maxPathCost,
    beamWidth,
    steps: best.steps,
    gain: roundStat(value(endStats) - startValue),
    before: round(startStats),
    after: round(endStats),
    delta,
    ...(finalBroken.length > 0 ? { violates: finalBroken } : {}),
    nodeIds: best.ids,
    applyChanges: { allocate: allocateIds, ...masteries },
    allocateNodes: { nodes: allocateIds, ...masteries },
    ...(best.done && best.done !== 'time budget' ? { stoppedEarly: best.done } : {}),
    evaluated,
    ...(skippedSlow > 0 ? { skippedSlow } : {}),
    ...(truncated.size > 0 ? { truncated: [...truncated] } : {}),
    timeMs: now() - started,
  };
}

// ---------------------------------------------------------------------------
// plan_respec
// ---------------------------------------------------------------------------

export interface RespecNode {
  id: number;
  name: string;
  type: string;
  ascendancyName?: string;
  pointCost: 'passive' | 'ascendancy' | 'none';
}

export interface PassivePoints {
  totalPoints: number;
  ascendancyPoints: number;
  maxNormalPoints: number;
  maxAscendancyPoints: number;
}

/** What BuildSession.planRespec measured inside its tree scope. */
export interface RespecRaw {
  target: number[];
  removed: RespecNode[];
  added: RespecNode[];
  /** deallocate (in order) then allocate (in order) reproduces the change. */
  deallocate: number[];
  allocate: number[];
  /** Nodes PoB's paths re-added after a removal even with them kept (the variant then lists them twice); empty normally. */
  readded: number[];
  before: Stats;
  after: Stats;
  pointsBefore: PassivePoints;
  pointsAfter: PassivePoints;
}

/** Most nodes listed in each of removed / added (the counts have them all). */
const MAX_LISTED_RESPEC_NODES = 100;
/** evaluate_changes / apply_changes take at most this many nodes per list. */
const VARIANT_NODE_CAP = 50;

export function respecResponse(raw: RespecRaw, keys: string[]): Record<string, unknown> {
  const node = (n: RespecNode) => ({ id: n.id, name: n.name, type: n.type, ...(n.ascendancyName ? { ascendancyName: n.ascendancyName } : {}) });
  const count = (list: RespecNode[], cost: 'passive' | 'ascendancy'): number => list.filter((n) => n.pointCost === cost).length;
  const delta: Record<string, number | null> = {};
  const round = (s: Stats): Stats =>
    Object.fromEntries(keys.map((k) => [k, typeof s[k] === 'number' ? roundStat(s[k] as number) : (s[k] ?? null)]));
  for (const k of keys) {
    const a = raw.before[k];
    const b = raw.after[k];
    delta[k] = typeof a === 'number' && typeof b === 'number' ? roundStat(b - a) : null;
  }
  const unchanged = raw.removed.length === 0 && raw.added.length === 0;
  const pb = raw.pointsBefore;
  const pa = raw.pointsAfter;
  const notes: string[] = [];
  if (pa.totalPoints > pa.maxNormalPoints) notes.push(`the target needs ${pa.totalPoints} passive points; the build has ${pa.maxNormalPoints}`);
  if (raw.deallocate.length > VARIANT_NODE_CAP || raw.allocate.length > VARIANT_NODE_CAP) {
    notes.push(`a list has more than ${VARIANT_NODE_CAP} nodes, more than apply_changes takes in one call: apply \`deallocateNodes\` with deallocate_nodes, then \`allocateNodes\` with allocate_nodes in calls of at most ${VARIANT_NODE_CAP} nodes, in order`);
  }
  if (raw.readded.length > 0) notes.push(`nodes ${raw.readded.join(', ')} are removed and allocated again by the variant (evaluate_changes refuses it); apply the two lists with deallocate_nodes then allocate_nodes`);
  return {
    unchanged,
    targetCount: raw.target.length,
    removedCount: raw.removed.length,
    removed: raw.removed.slice(0, MAX_LISTED_RESPEC_NODES).map(node),
    addedCount: raw.added.length,
    added: raw.added.slice(0, MAX_LISTED_RESPEC_NODES).map(node),
    points: {
      before: pb.totalPoints,
      after: pa.totalPoints,
      net: pa.totalPoints - pb.totalPoints,
      refunded: count(raw.removed, 'passive'),
      spent: count(raw.added, 'passive'),
      max: pa.maxNormalPoints,
      remaining: pa.maxNormalPoints - pa.totalPoints,
      ascendancyBefore: pb.ascendancyPoints,
      ascendancyAfter: pa.ascendancyPoints,
    },
    before: round(raw.before),
    after: round(raw.after),
    delta,
    ...(unchanged
      ? {}
      : {
          applyChanges: {
            ...(raw.deallocate.length > 0 ? { deallocate: raw.deallocate } : {}),
            ...(raw.allocate.length > 0 ? { allocate: raw.allocate } : {}),
          },
          deallocateNodes: { nodes: raw.deallocate },
          allocateNodes: { nodes: raw.allocate },
        }),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const nodeRef = z.union([z.number().int(), z.string().min(1)]);

const objectiveSchema = z
  .object({
    weights: z
      .record(z.string().min(1), z.number().finite())
      .refine((w) => Object.keys(w).length >= 1 && Object.keys(w).length <= 20, { message: '1 to 20 weighted stats' })
      .describe('Stat key -> weight (negative penalises), e.g. {"CombinedDPS":1,"TotalEHP":0.5}.'),
    mode: z.enum(['relative', 'absolute']).optional().describe('"relative" (default): weight x delta/|start value|; "absolute": weight x raw delta.'),
  })
  .describe('Plan for a weighted score (as evaluate_changes `objective`) instead of one stat; changes are measured from the build as it is now.');

const constraintsSchema = z
  .array(
    z.object({
      stat: z.string().min(1),
      min: z.number().finite().optional().describe('Smallest allowed value after a step.'),
      max: z.number().finite().optional().describe('Largest allowed value after a step.'),
      minDelta: z.number().finite().optional().describe('Smallest allowed change from the build as it is now.'),
      maxDelta: z.number().finite().optional().describe('Largest allowed change from the build as it is now.'),
    }),
  )
  .max(20)
  .describe('Limits every step keeps when it can (as evaluate_changes `constraints`; deltas from the build as it is now).');

const statsSchema = z.array(z.string().min(1)).min(1).max(30);

export interface PlanPointsArgs extends PlanPointsOptions {}

export interface PlanRespecArgs {
  target: Array<number | string>;
  keepAscendancy?: boolean;
  stats?: string[];
}

export function registerTreePlanTools(tools: ToolRegistrar): void {
  tools.engine<PlanPointsArgs>(
    'plan_passive_points',
    {
      description:
        `Plan how to spend several passive points (1-${MAX_PLAN_POINTS}): repeatedly picks the unallocated node (with its PoB path from the tree, at most \`maxPathCost\` points per step) that gains the most \`optimizeFor\` stat (default CombinedDPS) or \`objective\` score per point, allocates it on a temporary copy of the tree, and searches again from there, until the points are spent or nothing improves. ` +
        "Every candidate is evaluated through Path of Building's own calculator (as find_best_next_nodes), and each step's numbers are read from the recalculated tree, so `after` is what applying the plan gives. NOTHING IS APPLIED and nothing is pushed to undo. " +
        'Returns `steps` in order (node, `path` = the nodes the step allocates in join order, `points`, cumulative `pointsUsed`, `gain`, `gainPerPoint`, the focus stats `after` the step), `gain` (total), `before` / `after` / `delta` of the key stats, `nodeIds` (join order), and ready-to-use arguments: `applyChanges` (one undoable apply_changes variant) and `allocateNodes` (allocate_nodes). ' +
        '`constraints` (as evaluate_changes) are kept by every step when possible (`violates` lists any broken); `beamWidth` 2-3 keeps several partial plans (slower, sometimes better than greedy); `includeMasteries` also considers each free effect of reachable masteries; `excludeNodes` (ids or names) are never allocated, nor paths through them. Jewel sockets, ascendancy nodes and class starts are skipped. ' +
        `Nodes needing a full recalculation are capped (\`skippedSlow\`), and the search stops after ${PLAN_TIME_BUDGET_MS / 1000} s (\`truncated\`); \`stoppedEarly\` says why fewer points were used.`,
      inputSchema: {
        points: z.number().int().min(1).max(MAX_PLAN_POINTS).describe('Passive points to spend.'),
        optimizeFor: z.string().min(1).optional().describe('Stat key to maximize (default "CombinedDPS"); not with `objective`.'),
        objective: objectiveSchema.optional(),
        constraints: constraintsSchema.optional(),
        maxPathCost: z
          .number()
          .int()
          .min(1)
          .max(MAX_PLAN_PATH_COST)
          .optional()
          .describe(`Largest path cost of one step in points (default ${DEFAULT_PLAN_PATH_COST}): a notable that far away is reachable in one step.`),
        beamWidth: z.number().int().min(1).max(MAX_BEAM_WIDTH).optional().describe('1 (default): greedy; 2-3: keep that many partial plans (that many times slower).'),
        includeMasteries: z.boolean().optional().describe('Also consider allocating reachable masteries with each effect no other mastery has (default false).'),
        excludeNodes: z.array(nodeRef).max(100).optional().describe('Node ids or names (every node of that name) never to allocate.'),
      },
    },
    (args, session) => session.planPassivePoints(args),
  );

  tools.engine<PlanRespecArgs>(
    'plan_respec',
    {
      description:
        'Plan a respec from the current passive tree to a target node set: `target` (ids or names; a name must be unique) is what should be allocated afterwards. Allocated nodes not in the target are removed (with PoB\'s dependents) unless they are class starts, ascendancy nodes (with `keepAscendancy`, default true) or needed to connect kept nodes; unallocated target nodes are then allocated with PoB\'s shortest paths, nearest first. ' +
        "The change is applied to a temporary copy of the tree and recalculated by Path of Building, then the tree is restored exactly: NOTHING IS APPLIED and nothing is pushed to undo. " +
        'Returns `removed` / `added` (net; counts in `removedCount` / `addedCount`), `points` (before, after, net, refunded, spent, max, remaining, ascendancy), `before` / `after` / `delta` of the key stats, and ready-to-use arguments: `applyChanges` (one undoable apply_changes variant: `deallocate` then `allocate`, in order), or `deallocateNodes` then `allocateNodes`. A target equal to the current tree gives `unchanged: true`. ' +
        'Refused (nothing computed) when a target node is unknown, a name several nodes share, no path reaches it (another class\'s ascendancy), an unallocated mastery (allocate it afterwards with allocate_nodes `masteries`), or two options of one choice.',
      inputSchema: {
        target: z.array(nodeRef).min(1).max(MAX_RESPEC_TARGET).describe('Node ids or unique names that should be allocated after the respec (allocated masteries keep their effect).'),
        keepAscendancy: z.boolean().optional().describe('Keep every allocated ascendancy node (default true); false removes those not in `target`.'),
        stats: statsSchema.optional().describe(`Stat keys to report (default ${DEFAULT_EVALUATE_STATS.join(', ')}).`),
      },
    },
    async (args, session) => {
      const keys = args.stats && args.stats.length > 0 ? unique(args.stats) : DEFAULT_EVALUATE_STATS;
      const raw = await session.planRespec(args.target, args.keepAscendancy ?? true, keys);
      return respecResponse(raw, keys);
    },
  );
}
