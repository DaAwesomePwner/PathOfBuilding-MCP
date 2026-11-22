// find_optimal_links on the read-only probe engine (src/probe.ts, lua/probe.lua).
//
// Every evaluation is one probe variant that rebuilds the main socket group
// as [active skill, locked supports..., candidate supports...], each gem at
// its natural maximum level capped at 20 (20 for most; 3 for Empower and the
// like) and quality 20 (a `clear` op, then `add` ops: what
// replaceSocketGroup does), evaluated through PoB's own calculator in ~3-5 ms.
// The search:
//   1. every eligible support is scored on its own, in one call. Eligible:
//      every support PoB's own compatibility check lets support the active
//      skill once the locked supports have added their skill types (`probe`
//      with `supportsFor`, lua/probe.lua), minus the locked ones and Awakened
//      gems;
//   2. the `topN` best singles form the pool. When every combination of the
//      free slots from the pool fits EXHAUSTIVE_BUDGET it is searched
//      exhaustively; otherwise the best K singles are (K as large as the
//      budget allows), and then the best combination found is improved by
//      pairwise swaps (each member against each other pool support) until no
//      swap improves it or MAX_COMBINATIONS are evaluated.
// The build never changes; nothing is pushed to the undo stack or the journal.
// Callers hold the session lock.

import type { GemDataInfo, SkillGroupInfo } from './build-session.js';
import { MAX_PROBE_VARIANTS, type ProbeGemChange, type ProbeRequest, type ProbeResponse } from './probe.js';
import { toNumber } from './stat-values.js';
import { UserError } from './validation.js';

/** Default pool of best single supports the combination search draws from. */
export const DEFAULT_LINK_POOL = 25;
/** At most this many combinations are searched exhaustively (~4.5 ms each on a typical build). */
export const EXHAUSTIVE_BUDGET = 330;
/** At most this many combinations are evaluated in all (exhaustive part plus swap rounds). */
export const MAX_COMBINATIONS = 550;
/** Gems are added at their natural maximum level, at most this. */
const MAX_GEM_LEVEL = 20;
const GEM_QUALITY = 20;
const STAT = 'CombinedDPS';

export interface LinkSearchDeps {
  send<T>(command: object): Promise<T>;
  probe(request: ProbeRequest): Promise<ProbeResponse>;
}

export interface LinkSearchOptions {
  activeSkill: string;
  /** Support gem slots (the link count minus the active skill). */
  supportSlots: number;
  /** Supports that must be part of every combination. */
  constraints: string[];
  /** Pool of best single supports for the combination search (default DEFAULT_LINK_POOL). */
  topN?: number;
  /** Best combinations listed in topAlternatives (default 5). */
  topAlternatives?: number;
}

export interface OptimalLinksResult {
  activeSkill: string;
  lockedSupports: string[];
  bestCombination: string[];
  /** CombinedDPS with the main group set to the active skill, the locked supports and bestCombination. */
  bestDPS: number;
  /** CombinedDPS of the build as it is (the current main group). */
  baselineDPS: number;
  /** bestDPS - baselineDPS. */
  dpsDelta: number;
  /** The main socket group the combinations replace (1-based) and its gems now. */
  mainGroup: { index: number; gems: string[] };
  /** The main group as evaluated for bestDPS: the active skill, the locked supports, bestCombination, with levels. */
  bestGroup: Array<{ name: string; level: number; quality: number }>;
  /** The pool: the best single supports (active skill + locked supports + that one), best first. */
  singleSupportDPS: Array<{ name: string; dps: number }>;
  topAlternatives: Array<{ combo: string[]; dps: number }>;
  search: {
    /** "exhaustive": every combination of the pool; "exhaustive+swap": every combination of the best `exhaustiveOver` singles, then pairwise swaps with the rest of the pool. */
    method: 'exhaustive' | 'exhaustive+swap';
    supportsEvaluated: number;
    poolSize: number;
    exhaustiveOver: number;
    combinationsEvaluated: number;
    /** Supports the engine refused, or whose compatibility check failed (each with its error); they are left out of the search. */
    skipped?: Array<{ name: string; error: string }>;
  };
}

/** n choose k, as a float (only compared against small budgets). */
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** Every k-subset of [0, n) in lexicographic order. */
function* combinations(n: number, k: number): Generator<number[]> {
  const idx = Array.from({ length: k }, (_, i) => i);
  if (k > n) return;
  while (true) {
    yield [...idx];
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

async function gemByName(deps: LinkSearchDeps, name: string, what: string): Promise<GemDataInfo> {
  try {
    const res = await deps.send<{ gem: GemDataInfo }>({ cmd: 'getGemByName', name });
    if (!res.gem) throw new UserError(`${what} not found: "${name}"`);
    return res.gem;
  } catch (error) {
    if (error instanceof UserError) throw new UserError(`${what} "${name}": ${error.message}`);
    throw error;
  }
}

export async function findOptimalLinks(deps: LinkSearchDeps, opts: LinkSearchOptions): Promise<OptimalLinksResult> {
  if (opts.supportSlots < 0) throw new UserError('availableSlots must be >= 1');
  const active = await gemByName(deps, opts.activeSkill, 'Active skill');
  if (active.isSupport) throw new UserError(`"${opts.activeSkill}" is a support gem, not an active skill`);
  const levelOf = new Map<string, number>([[active.name, Math.min(MAX_GEM_LEVEL, active.naturalMaxLevel ?? MAX_GEM_LEVEL)]]);
  const locked: string[] = [];
  for (const name of opts.constraints) {
    const gem = await gemByName(deps, name, 'Locked support');
    if (gem.name === active.name) throw new UserError(`Locked support "${name}" is the active skill itself`);
    if (!gem.isSupport) throw new UserError(`Locked support "${name}" (${gem.name}) is an active skill gem, not a support`);
    if (locked.includes(gem.name)) throw new UserError(`Locked support "${name}" (${gem.name}) is listed more than once`);
    locked.push(gem.name);
    levelOf.set(gem.name, Math.min(MAX_GEM_LEVEL, gem.naturalMaxLevel ?? MAX_GEM_LEVEL));
  }
  const gemSpec = (name: string): { name: string; level: number; quality: number } =>
    ({ name, level: levelOf.get(name) ?? MAX_GEM_LEVEL, quality: GEM_QUALITY });

  const groups = (await deps.send<{ groups: SkillGroupInfo[] }>({ cmd: 'getSocketGroups' })).groups ?? [];
  let mainIndex = groups.findIndex((g) => g.isMainGroup);
  if (mainIndex < 0) mainIndex = 0;
  const main = groups[mainIndex];
  if (!main) throw new UserError('The build has no skill groups');
  if (main.source) {
    throw new UserError(`The main skill group (${mainIndex + 1}) is granted by an item or the passive tree; its gems cannot be replaced`);
  }
  const group = mainIndex + 1;

  const variant = (supports: string[]): { gems: ProbeGemChange[] } => ({
    gems: [
      { op: 'clear', group },
      ...[active.name, ...locked, ...supports].map((name): ProbeGemChange => ({ op: 'add', group, ...gemSpec(name) })),
    ],
  });

  let baselineDPS = 0;
  /** DPS per combination (null: refused as input); internal errors fail the search. */
  async function evaluate(combos: string[][]): Promise<Array<{ dps: number | null; error?: string }>> {
    const out: Array<{ dps: number | null; error?: string }> = [];
    for (let i = 0; i < combos.length; i += MAX_PROBE_VARIANTS) {
      const chunk = combos.slice(i, i + MAX_PROBE_VARIANTS);
      const res = await deps.probe({ stats: [STAT], variants: chunk.map(variant) });
      baselineDPS = toNumber(res.base[STAT]);
      res.results.forEach((r, j) => {
        if (r.error === undefined) out.push({ dps: toNumber(r.stats[STAT]) });
        else if (r.userError) out.push({ dps: null, error: r.error });
        else throw new Error(`find_optimal_links: evaluating [${chunk[j].join(', ')}] failed: ${r.error}`);
      });
    }
    return out;
  }

  const currentGems = main.gems.map((g) => g.name);
  const base = {
    activeSkill: opts.activeSkill,
    lockedSupports: opts.constraints,
    mainGroup: { index: group, gems: currentGems },
  };
  const freeSlots = Math.max(0, opts.supportSlots - locked.length);
  if (freeSlots === 0) {
    const [r] = await evaluate([[]]);
    if (r.dps === null) throw new UserError(r.error ?? 'the combination was refused');
    return {
      ...base,
      bestCombination: [],
      bestDPS: r.dps,
      baselineDPS,
      dpsDelta: r.dps - baselineDPS,
      bestGroup: [active.name, ...locked].map(gemSpec),
      singleSupportDPS: [],
      topAlternatives: [{ combo: [], dps: r.dps }],
      search: { method: 'exhaustive', supportsEvaluated: 0, poolSize: 0, exhaustiveOver: 0, combinationsEvaluated: 1 },
    };
  }

  // 1. Every eligible support on its own.
  const listed = await deps.send<{ supports: unknown; errors: unknown }>({
    cmd: 'probe',
    supportsFor: { active: active.name, locked },
  });
  // The engine's JSON encoder writes an empty list as {}.
  const supports = (Array.isArray(listed.supports) ? listed.supports : []) as Array<{ name: string; naturalMaxLevel?: number; isAwakened: boolean }>;
  const lockedSet = new Set(locked);
  const eligible: string[] = [];
  for (const s of supports) {
    if (s.isAwakened || lockedSet.has(s.name) || s.name === active.name) continue;
    eligible.push(s.name);
    levelOf.set(s.name, Math.min(MAX_GEM_LEVEL, s.naturalMaxLevel ?? MAX_GEM_LEVEL));
  }
  const singleRes = await evaluate(eligible.map((name) => [name]));
  const skipped: Array<{ name: string; error: string }> = [];
  for (const e of (Array.isArray(listed.errors) ? listed.errors : []) as Array<{ name: string; error: string }>) {
    skipped.push({ name: e.name, error: `PoB's support check failed: ${e.error}` });
  }
  const singles: Array<{ name: string; dps: number }> = [];
  eligible.forEach((name, i) => {
    const r = singleRes[i];
    if (r.dps === null) skipped.push({ name, error: r.error ?? 'refused' });
    else singles.push({ name, dps: r.dps });
  });
  singles.sort((a, b) => b.dps - a.dps || a.name.localeCompare(b.name));
  if (singles.length === 0) throw new UserError(`No support gem could be evaluated with "${active.name}"`);

  // 2. Combinations of the pool.
  const pool = singles.slice(0, Math.max(opts.topN ?? DEFAULT_LINK_POOL, freeSlots)).map((s) => s.name);
  const k = Math.min(freeSlots, pool.length);
  let exhaustiveOver = pool.length;
  while (exhaustiveOver > k && choose(exhaustiveOver, k) > EXHAUSTIVE_BUDGET) exhaustiveOver--;

  const rank = new Map(pool.map((name, i) => [name, i]));
  const keyOf = (combo: string[]): string => [...combo].sort((a, b) => rank.get(a)! - rank.get(b)!).join('|');
  const seen = new Map<string, number>();
  let best: { combo: string[]; dps: number } | null = null;
  let evaluated = 0;
  async function run(combos: string[][]): Promise<boolean> {
    const fresh = combos.filter((c) => !seen.has(keyOf(c)));
    if (fresh.length === 0) return false;
    const res = await evaluate(fresh);
    evaluated += fresh.length;
    let improved = false;
    fresh.forEach((combo, i) => {
      const dps = res[i].dps;
      if (dps === null) {
        seen.set(keyOf(combo), -Infinity);
        return;
      }
      seen.set(keyOf(combo), dps);
      if (best === null || dps > best.dps) {
        best = { combo: [...combo].sort((a, b) => rank.get(a)! - rank.get(b)!), dps };
        improved = true;
      }
    });
    return improved;
  }

  const core: string[][] = [];
  for (const idx of combinations(exhaustiveOver, k)) core.push(idx.map((i) => pool[i]));
  await run(core);
  const method: OptimalLinksResult['search']['method'] = exhaustiveOver < pool.length ? 'exhaustive+swap' : 'exhaustive';
  if (method === 'exhaustive+swap') {
    // Pairwise swaps: each member of the best combination against each pool support outside it.
    while (best !== null && evaluated < MAX_COMBINATIONS) {
      const current: string[] = (best as { combo: string[] }).combo;
      const swaps: string[][] = [];
      for (let slot = 0; slot < current.length; slot++) {
        for (const candidate of pool) {
          if (current.includes(candidate)) continue;
          const combo = [...current];
          combo[slot] = candidate;
          if (!seen.has(keyOf(combo))) swaps.push(combo);
        }
      }
      if (!(await run(swaps.slice(0, MAX_COMBINATIONS - evaluated)))) break;
    }
  }
  if (best === null) throw new UserError(`No combination of supports could be evaluated with "${active.name}"`);
  const winner = best as { combo: string[]; dps: number };

  const topAlternatives = [...seen.entries()]
    .filter(([, dps]) => dps !== -Infinity)
    .sort((a, b) => b[1] - a[1])
    .slice(0, opts.topAlternatives ?? 5)
    .map(([key, dps]) => ({ combo: key.split('|'), dps }));

  return {
    ...base,
    bestCombination: winner.combo,
    bestDPS: winner.dps,
    baselineDPS,
    dpsDelta: winner.dps - baselineDPS,
    bestGroup: [active.name, ...locked, ...winner.combo].map(gemSpec),
    singleSupportDPS: singles.slice(0, pool.length),
    topAlternatives,
    search: {
      method,
      supportsEvaluated: eligible.length,
      poolSize: pool.length,
      exhaustiveOver,
      combinationsEvaluated: evaluated,
      ...(skipped.length > 0 ? { skipped } : {}),
    },
  };
}
