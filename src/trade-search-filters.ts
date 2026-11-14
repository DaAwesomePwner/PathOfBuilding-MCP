/** generate_trade_search: weight adjustments, the 36-filter cap (adjusted filters pinned), min override, required mods. */
import { UserError } from './validation.js';
import { MAX_FILTERS, type TradeQueryRaw, type TradeSearchArgs } from './trade-search-schema.js';

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
  const extras = 2 + (args.includeMirrored === false ? 1 : 0) + (args.maxPrice ? 1 : 0) + (args.maxLevel ? 1 : 0)
    + (args.sockets ? 1 : 0) + (args.links ? 1 : 0) + (args.influences?.length ?? 0) + requiredMods.length;
  const budget = MAX_FILTERS - extras;
  if (pinned.length > budget) {
    throw new UserError(`Too many weightAdjustments: ${pinned.length} filters are pinned but only ${budget} fit with the other filters (limit ${MAX_FILTERS}).`);
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
    query.query.stats.push({
      type: 'and',
      filters: requiredMods.map((m) => (m.min === undefined ? { id: m.tradeId } : { id: m.tradeId, value: { min: m.min } })),
    });
  }
  return { query, texts, kept, dropped, budget, pobDefaultMin, minWeightedSum };
}
