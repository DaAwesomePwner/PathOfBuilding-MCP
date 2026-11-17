/** generate_trade_search: weight adjustments, the filter cap (adjusted filters pinned), min override, required mods. */
import { UserError } from './validation.js';
import { MAX_FILTERS, TRADE_COMPLEXITY, type TradeQueryRaw, type TradeSearchArgs } from './trade-search-schema.js';

export const round = (n: number, digits = 4) => Number(n.toPrecision(digits));

export type Filter = { tradeId: string; text: string; weight: number; source: 'pob' | 'adjusted' | 'added'; mappedFrom?: string };

type StatGroup = { type: string; value?: { min?: number }; filters: unknown[] };

export interface WeightedQuery {
  /** The trade query with the final weight group and required mods. */
  query: { query: { stats: StatGroup[] } };
  texts: Map<string, string>;
  kept: Filter[];
  dropped: Filter[];
  budget: number;
  pobDefaultMin: number;
  minWeightedSum: number;
}

/**
 * weightAdjustments keyed by the filter id they apply to. PoB merges single
 * resistances/attributes into a pseudo total filter, so e.g. explicit fire res
 * targets pseudo.pseudo_total_fire_resistance (else the stat counts twice).
 */
function adjustmentTargets(args: TradeSearchArgs, raw: TradeQueryRaw): Map<string, { weight: number; mappedFrom?: string }> {
  const toPseudo = new Map(raw.pseudoMap.map((m) => [m.from, m.to]));
  const out = new Map<string, { weight: number; mappedFrom?: string }>();
  for (const a of args.weightAdjustments ?? []) {
    const id = toPseudo.get(a.tradeId) ?? a.tradeId;
    if (out.has(id)) throw new UserError(`weightAdjustments set ${id} more than once (${a.tradeId} is weighed through ${id})`);
    out.set(id, id === a.tradeId ? { weight: a.weight } : { weight: a.weight, mappedFrom: a.tradeId });
  }
  return out;
}

/** The "and" filter id PoB (or the bridge, on PoB 2.68+) adds for a required influence. */
export const influenceTradeId = (influence: string) => `pseudo.pseudo_has_${influence}_influence`;

/**
 * How many weight filters fit next to the other filters, counted the way the PoB version counts:
 * PoB <= 2.67: 36 filters in all (2 base filters, each option filter, each influence / required mod);
 * PoB 2.68+: the trade site's complexity limit, with FinishQuery's costs (influences and required mods are "and" filters).
 */
function weightFilterBudget(args: TradeSearchArgs, raw: TradeQueryRaw): { budget: number; limit: string } {
  const optionFilters = (args.includeMirrored === false ? 1 : 0) + (args.maxPrice ? 1 : 0) + (args.maxLevel ? 1 : 0)
    + (args.sockets ? 1 : 0) + (args.links ? 1 : 0);
  // Distinct "and" ids: a required pseudo_has_<influence>_influence also named in influences is emitted once.
  const andFilters = new Set([...(args.influences ?? []).map(influenceTradeId), ...(args.requiredMods ?? []).map((m) => m.tradeId)]).size;
  if (raw.capModel === 'complexity') {
    const c = TRADE_COMPLEXITY;
    const left = c.limit - c.weightGroup - c.typeFilters - c.andGroup - c.optionFilter * optionFilters - c.statFilter * andFilters;
    return {
      budget: left < c.reserve ? 0 : Math.floor((left - c.reserve) / c.statFilter) + 1,
      limit: `the trade site's query complexity limit of ${c.limit}`,
    };
  }
  return { budget: MAX_FILTERS - 2 - optionFilters - andFilters, limit: `${MAX_FILTERS} filters` };
}

/** Applies weight adjustments, the filter cap (pinning adjusted filters), the min override and required mods. */
export function applyWeightFilters(args: TradeSearchArgs, raw: TradeQueryRaw): WeightedQuery {
  const texts = new Map(raw.texts.map((t) => [t.id, t.text]));
  const query = JSON.parse(raw.queryJson) as WeightedQuery['query'];
  const weightGroup = query.query.stats[0];
  const pobFilters = weightGroup.filters as { id: string; value: { weight: number } }[];
  const pobDefaultMin = Number(weightGroup.value?.min ?? 0);

  // PoB's order is its priority (mean stat gain); unpinned filters keep it.
  const adjustments = adjustmentTargets(args, raw);
  const pinned: Filter[] = [];
  const unpinned: Filter[] = [];
  for (const f of pobFilters) {
    const text = texts.get(f.id) ?? f.id;
    const adj = adjustments.get(f.id);
    if (!adj) unpinned.push({ tradeId: f.id, text, weight: f.value.weight, source: 'pob' });
    else if (adj.weight !== 0) pinned.push({ tradeId: f.id, text, ...adj, source: 'adjusted' });
  }
  for (const [id, adj] of adjustments) {
    if (adj.weight !== 0 && !pobFilters.some((f) => f.id === id)) pinned.push({ tradeId: id, text: texts.get(id) ?? id, ...adj, source: 'added' });
  }

  const requiredMods = args.requiredMods ?? [];
  const { budget, limit } = weightFilterBudget(args, raw);
  if (pinned.length > budget) {
    throw new UserError(`Too many weightAdjustments: ${pinned.length} filters are pinned but only ${budget} fit with the other filters (limit: ${limit}).`);
  }
  const kept = [...pinned, ...unpinned.slice(0, budget - pinned.length)].sort((a, b) => b.weight - a.weight);
  const dropped = unpinned.slice(budget - pinned.length);
  if (kept.length === 0) {
    throw new UserError(`Path of Building found no mods that raise the chosen stat weights for ${args.slot}; change statWeights or add weightAdjustments.`);
  }

  const minWeightedSum = args.minWeightedSum ?? round(pobDefaultMin, 6);
  weightGroup.filters = kept.map((f) => ({ id: f.tradeId, value: { weight: round(f.weight) } }));
  weightGroup.value = { min: minWeightedSum };
  if (requiredMods.length > 0) {
    // One "and" group: required mods join the influence filters when there are any; a required mod with the
    // same id as an influence filter replaces it (keeping its min), so each id is emitted once.
    const filters = requiredMods.map((m) => (m.min === undefined ? { id: m.tradeId } : { id: m.tradeId, value: { min: m.min } }));
    const andGroup = query.query.stats.find((g) => g.type === 'and');
    if (!andGroup) query.query.stats.push({ type: 'and', filters });
    else {
      const existing = andGroup.filters as { id?: string }[];
      for (const f of filters) {
        const at = existing.findIndex((e) => e.id === f.id);
        if (at >= 0) existing[at] = f;
        else existing.push(f);
      }
    }
  }
  return { query, texts, kept, dropped, budget, pobDefaultMin, minWeightedSum };
}
