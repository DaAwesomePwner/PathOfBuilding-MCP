// Passive-tree searches (find_best_next_nodes, find_worst_allocated_nodes) on
// the read-only probe engine (src/probe.ts, lua/probe.lua).
//
// The engine lists the candidates (`probe` with `candidates`), then every
// candidate is one variant: `allocate: [id]` (the node together with its PoB
// path from the allocated tree) or `deallocate: [id]` (the node together with
// every node that depends on it). Variants go through PoB's own calculator;
// the few that need a full recalculation (cluster jewel nodes, jewel sockets
// holding a jewel, skill-granting nodes, and in find_worst_allocated_nodes
// nodes whose dependents include such a socket) are capped at
// MAX_SEARCH_FALLBACKS per search, in the order most likely to matter for the
// ranking, and the rest are reported as skipped:
//   * find_best_next_nodes: the cheapest paths first;
//   * find_worst_allocated_nodes: the calculator candidates are evaluated
//     first; a slow candidate's removal also removes every evaluated
//     candidate among its dependents (with their own dependents), so the
//     largest of their losses estimates how much it loses at least. The
//     lowest estimate per refunded point (or in total, for rankBy "total")
//     goes first, the larger refund on ties: a travel path to a socketed
//     jewel (little lost, many points back) before a node near the class
//     start whose removal takes most of the tree.
// The build never changes; nothing is pushed to the undo stack or the
// journal. Callers hold the session lock.

import type { Stats } from './lua-bridge.js';
import { MAX_PROBE_VARIANTS, type ProbeRequest, type ProbeResponse, type ProbeVariant, type ProbeVariantResult } from './probe.js';
import { toNumber } from './stat-values.js';

export type RankBy = 'perPoint' | 'total';
export const DEFAULT_MAX_POINTS = 3;
export const MAX_MAX_POINTS = 10;
/** Candidates needing a full recalculation (~0.1-0.3 s each) evaluated per search, so a search stays within a few seconds. */
export const MAX_SEARCH_FALLBACKS = 8;
/** Removed nodes listed per find_worst_allocated_nodes ranking (removedNodeCount has them all). */
const MAX_LISTED_NODES = 25;

export interface NodeRef {
  id: number;
  name: string;
}

export interface NodeRanking {
  nodeId: number;
  nodeName: string;
  nodeType: string;
  isKeystone: boolean;
  isNotable: boolean;
  targetStat: string;
  delta: number;
  /** find_best_next_nodes: points the node and its path cost, the gain per point, the path (tree side first, the node last). */
  pointsCost?: number;
  deltaPerPoint?: number;
  path?: NodeRef[];
  /** find_worst_allocated_nodes: loss of the stat, points refunded, loss per point, the nodes removed (the node first). */
  lossIfRemoved?: number;
  pointsRefunded?: number;
  lossPerPoint?: number;
  removedNodes?: NodeRef[];
  removedNodeCount?: number;
  tradeoffs?: string[];
  stats?: string[];
}

export interface SkippedNode {
  nodeId: number;
  nodeName: string;
  /** Points the node's variant would add (find_best_next_nodes) or refund (find_worst_allocated_nodes). */
  points: number;
  /** find_worst_allocated_nodes: the largest loss among the evaluated nodes its removal also removes (about the least it would lose). */
  minLossEstimate?: number;
  reason: string;
}

export interface TreeSearchResult {
  rankings: NodeRanking[];
  /** Candidates evaluated. */
  evaluated: number;
  /** Candidates not evaluated because they need a full recalculation each and the cap was reached. */
  skipped: SkippedNode[];
}

export interface TreeSearchDeps {
  send<T>(command: object): Promise<T>;
  probe(request: ProbeRequest): Promise<ProbeResponse>;
}

interface Candidate {
  id: number;
  name: string;
  type: string;
  stats: string[];
  /** allocate: the path, tree side first; deallocate: the node, then its dependents. */
  nodes: number[];
  points: number;
  fallback?: string;
}

async function listCandidates(
  deps: TreeSearchDeps,
  kind: 'allocate' | 'deallocate',
  maxPoints?: number,
): Promise<{ candidates: Candidate[]; refs: (ids: number[]) => NodeRef[] }> {
  const res = await deps.send<{ nodes: unknown; names: unknown }>({ cmd: 'probe', candidates: kind, maxPoints });
  // The engine's JSON encoder writes an empty list as {}.
  const candidates = (Array.isArray(res.nodes) ? res.nodes : []) as Candidate[];
  for (const c of candidates) {
    if (!Array.isArray(c.stats)) c.stats = [];
  }
  const names = new Map<number, string>();
  for (const n of (Array.isArray(res.names) ? res.names : []) as NodeRef[]) names.set(n.id, n.name);
  return { candidates, refs: (ids) => ids.map((id) => ({ id, name: names.get(id) ?? '' })) };
}

/**
 * Split the fallback candidates, already in priority order, into the first
 * MAX_SEARCH_FALLBACKS (evaluated) and the rest (reported as skipped).
 */
function capFallbacks(
  slow: Candidate[],
  which: string,
  estimate?: (c: Candidate) => number,
): { kept: Candidate[]; skipped: SkippedNode[] } {
  return {
    kept: slow.slice(0, MAX_SEARCH_FALLBACKS),
    skipped: slow.slice(MAX_SEARCH_FALLBACKS).map((c) => ({
      nodeId: c.id,
      nodeName: c.name,
      points: c.points,
      ...(estimate ? { minLossEstimate: estimate(c) } : {}),
      reason: `needs a full recalculation (${c.fallback}); at most ${MAX_SEARCH_FALLBACKS} such nodes, ${which}, are evaluated per call`,
    })),
  };
}

/**
 * Run one variant per candidate (calls of at most MAX_PROBE_VARIANTS). The
 * default stats are read, plus `optimizeFor` when it is not one of them.
 */
async function evaluate(
  deps: TreeSearchDeps,
  variants: ProbeVariant[],
  optimizeFor: string,
): Promise<{ base: Stats; results: ProbeVariantResult[] }> {
  const first = await deps.probe({ variants: [] }); // the base only: builds no calculator
  const stats = optimizeFor in first.base ? undefined : [...Object.keys(first.base), optimizeFor];
  let base = first.base;
  const results: ProbeVariantResult[] = [];
  for (let i = 0; i < variants.length; i += MAX_PROBE_VARIANTS) {
    const res = await deps.probe({ stats, variants: variants.slice(i, i + MAX_PROBE_VARIANTS) });
    base = res.base;
    results.push(...res.results);
  }
  return { base, results };
}

/** False for a variant refused as user input (unreachable node, ...): skipped. Any other error fails the search. */
function usable(tool: string, c: Candidate, r: ProbeVariantResult): boolean {
  if (r.error === undefined) return true;
  if (r.userError) return false;
  throw new Error(`${tool}: evaluating node ${c.id} (${c.name}) failed: ${r.error}`);
}

function perPoint(value: number, points: number): number {
  return points > 0 ? value / points : value;
}

function identifyTradeoffs(before: Stats, after: Stats, primaryStat: string): string[] {
  const tradeoffs: string[] = [];
  const defensiveKeys = ['TotalEHP', 'Life', 'EnergyShield', 'Armour', 'Evasion', 'Ward'];
  const offensiveKeys = ['CombinedDPS', 'TotalDPS', 'AverageDamage'];
  const isOffenseFocus = /DPS|Damage|Crit|Speed/i.test(primaryStat);
  const checkKeys = isOffenseFocus ? defensiveKeys : offensiveKeys;
  for (const key of checkKeys) {
    const delta = toNumber(after[key]) - toNumber(before[key]);
    if (delta < -0.5) {
      tradeoffs.push(`${key}: ${delta.toFixed(1)}`);
    }
  }
  return tradeoffs;
}

export interface BestNodesOptions {
  count: number;
  optimizeFor: string;
  includeJewelSockets: boolean;
  maxPoints: number;
  rankBy: RankBy;
}

/** Unallocated nodes whose path costs at most maxPoints, ranked by gain per point (or total gain). */
export async function findBestNextNodes(deps: TreeSearchDeps, opts: BestNodesOptions): Promise<TreeSearchResult> {
  const { candidates: all, refs } = await listCandidates(deps, 'allocate', opts.maxPoints);
  const candidates = all.filter((c) => opts.includeJewelSockets || c.type !== 'Socket');
  const slow = candidates.filter((c) => c.fallback !== undefined).sort((a, b) => a.points - b.points || a.id - b.id);
  const capped = capFallbacks(slow, 'those with the fewest points');
  const keptSlow = new Set(capped.kept);
  const kept = candidates.filter((c) => c.fallback === undefined || keptSlow.has(c));
  const skipped = capped.skipped;
  const { base, results } = await evaluate(deps, kept.map((c) => ({ allocate: [c.id] })), opts.optimizeFor);
  const baseValue = toNumber(base[opts.optimizeFor]);
  const rankings: NodeRanking[] = [];
  kept.forEach((c, i) => {
    const r = results[i];
    if (!usable('find_best_next_nodes', c, r)) return;
    const delta = toNumber(r.stats[opts.optimizeFor]) - baseValue;
    const points = r.pointsAdded ?? c.points;
    rankings.push({
      nodeId: c.id,
      nodeName: c.name,
      nodeType: c.type,
      isKeystone: c.type === 'Keystone',
      isNotable: c.type === 'Notable',
      targetStat: opts.optimizeFor,
      delta,
      pointsCost: points,
      deltaPerPoint: perPoint(delta, points),
      path: refs(c.nodes),
      tradeoffs: identifyTradeoffs(base, r.stats, opts.optimizeFor),
      stats: c.stats,
    });
  });
  const byTotal = (a: NodeRanking, b: NodeRanking): number =>
    b.delta - a.delta || (a.pointsCost ?? 0) - (b.pointsCost ?? 0) || a.nodeId - b.nodeId;
  rankings.sort(opts.rankBy === 'total' ? byTotal : (a, b) => (b.deltaPerPoint ?? 0) - (a.deltaPerPoint ?? 0) || byTotal(a, b));
  return { rankings: rankings.slice(0, opts.count), evaluated: kept.length, skipped };
}

export interface WorstNodesOptions {
  count: number;
  optimizeFor: string;
  rankBy: RankBy;
}

/** Allocated nodes ranked by the loss of removing each with its dependents, per refunded point (or in total). */
export async function findWorstAllocatedNodes(deps: TreeSearchDeps, opts: WorstNodesOptions): Promise<TreeSearchResult> {
  const { candidates, refs } = await listCandidates(deps, 'deallocate');
  const fast = candidates.filter((c) => c.fallback === undefined);
  const fastRun = await evaluate(deps, fast.map((c) => ({ deallocate: [c.id] })), opts.optimizeFor);
  const baseValue = toNumber(fastRun.base[opts.optimizeFor]);

  // Slow candidates, most promising first (see the header).
  const knownLoss = new Map<number, number>();
  fast.forEach((c, i) => {
    const r = fastRun.results[i];
    if (r.error === undefined) knownLoss.set(c.id, baseValue - toNumber(r.stats[opts.optimizeFor]));
  });
  const estimate = (c: Candidate): number => {
    let est = -Infinity;
    for (const id of c.nodes) {
      const loss = knownLoss.get(id);
      if (loss !== undefined && loss > est) est = loss;
    }
    return est === -Infinity ? 0 : est;
  };
  const estimates = new Map(candidates.filter((c) => c.fallback !== undefined).map((c) => [c, estimate(c)]));
  const key = (c: Candidate): number => (opts.rankBy === 'total' ? estimates.get(c)! : perPoint(estimates.get(c)!, c.points));
  const slow = [...estimates.keys()].sort((a, b) => key(a) - key(b) || b.points - a.points || a.id - b.id);
  const { kept: keptSlow, skipped } = capFallbacks(
    slow,
    `those whose evaluated dependents lose the least${opts.rankBy === 'total' ? '' : ' per refunded point'}`,
    (c) => estimates.get(c)!,
  );
  const slowRun = keptSlow.length > 0
    ? await evaluate(deps, keptSlow.map((c) => ({ deallocate: [c.id] })), opts.optimizeFor)
    : { base: fastRun.base, results: [] };
  const kept = [...fast, ...keptSlow];
  const results = [...fastRun.results, ...slowRun.results];

  const rankings: NodeRanking[] = [];
  kept.forEach((c, i) => {
    const r = results[i];
    if (!usable('find_worst_allocated_nodes', c, r)) return;
    const loss = baseValue - toNumber(r.stats[opts.optimizeFor]);
    const points = r.pointsRemoved ?? c.points;
    rankings.push({
      nodeId: c.id,
      nodeName: c.name,
      nodeType: c.type,
      isKeystone: c.type === 'Keystone',
      isNotable: c.type === 'Notable',
      targetStat: opts.optimizeFor,
      delta: -loss,
      lossIfRemoved: loss,
      pointsRefunded: points,
      lossPerPoint: perPoint(loss, points),
      removedNodes: refs(c.nodes.slice(0, MAX_LISTED_NODES)),
      removedNodeCount: c.nodes.length,
      stats: c.stats,
    });
  });
  const byTotal = (a: NodeRanking, b: NodeRanking): number =>
    (a.lossIfRemoved ?? 0) - (b.lossIfRemoved ?? 0) || (b.pointsRefunded ?? 0) - (a.pointsRefunded ?? 0) || a.nodeId - b.nodeId;
  rankings.sort(opts.rankBy === 'total' ? byTotal : (a, b) => (a.lossPerPoint ?? 0) - (b.lossPerPoint ?? 0) || byTotal(a, b));
  return { rankings: rankings.slice(0, opts.count), evaluated: kept.length, skipped };
}
