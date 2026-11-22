// Passive-tree searches (find_best_next_nodes, find_worst_allocated_nodes) on
// the read-only probe engine (src/probe.ts, lua/probe.lua).
//
// The engine lists the candidates (`probe` with `candidates`), then every
// candidate is one variant: `allocate: [id]` (the node together with its PoB
// path from the allocated tree) or `deallocate: [id]` (the node together with
// every node that depends on it). Variants go through PoB's own calculator;
// the few that need a full recalculation (cluster jewel nodes, jewel sockets
// holding a jewel, skill-granting nodes) are capped at MAX_SEARCH_FALLBACKS
// per search, cheapest first, and the rest are reported as skipped. The
// build never changes; nothing is pushed to the undo stack or the journal.
// Callers hold the session lock.

import type { Stats } from './lua-bridge.js';
import { MAX_PROBE_VARIANTS, type ProbeRequest, type ProbeResponse, type ProbeVariant, type ProbeVariantResult } from './probe.js';
import { toNumber } from './stat-values.js';

export type RankBy = 'perPoint' | 'total';
export const DEFAULT_MAX_POINTS = 3;
export const MAX_MAX_POINTS = 10;
/** Candidates needing a full recalculation (~0.2-0.5 s each) evaluated per search, so a search stays within a few seconds. */
export const MAX_SEARCH_FALLBACKS = 6;
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

/** Keep every calculator candidate and the MAX_SEARCH_FALLBACKS cheapest fallback ones. */
function capFallbacks(candidates: Candidate[]): { kept: Candidate[]; skipped: SkippedNode[] } {
  const slow = candidates.filter((c) => c.fallback !== undefined).sort((a, b) => a.points - b.points || a.id - b.id);
  const dropped = new Set(slow.slice(MAX_SEARCH_FALLBACKS));
  return {
    kept: candidates.filter((c) => !dropped.has(c)),
    skipped: [...dropped].map((c) => ({
      nodeId: c.id,
      nodeName: c.name,
      reason: `needs a full recalculation (${c.fallback}); at most ${MAX_SEARCH_FALLBACKS} such nodes, the cheapest, are evaluated per call`,
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
  const { candidates, refs } = await listCandidates(deps, 'allocate', opts.maxPoints);
  const { kept, skipped } = capFallbacks(candidates.filter((c) => opts.includeJewelSockets || c.type !== 'Socket'));
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
  const { kept, skipped } = capFallbacks(candidates);
  const { base, results } = await evaluate(deps, kept.map((c) => ({ deallocate: [c.id] })), opts.optimizeFor);
  const baseValue = toNumber(base[opts.optimizeFor]);
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
