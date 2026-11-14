/** generate_trade_search: the offline trade-site URL and the tool response. */
import { validateLeague } from './trade-search-command.js';
import { applyWeightFilters, round } from './trade-search-filters.js';
import type { TradeQueryRaw, TradeSearchArgs } from './trade-search-schema.js';

/** PoB's urlEncode (Modules/Common.lua): every byte outside [A-Za-z0-9_.~-] as %XX. */
function pobUrlEncode(text: string): string {
  let out = '';
  for (const byte of Buffer.from(text, 'utf8')) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.~-]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** TradeQuery.lua's browser URL: hostName .. "trade/search" [/realm] /league ?q=<query>. */
export function tradeSearchUrl(league: string, realm: string, query: unknown): string {
  const realmPart = realm === 'pc' ? '' : `/${realm}`;
  return `https://www.pathofexile.com/trade/search${realmPart}/${pobUrlEncode(league)}?q=${pobUrlEncode(JSON.stringify(query))}`;
}

/** The generate_trade_search response: URL, final filters and what the cap dropped. */
export function buildTradeSearch(args: TradeSearchArgs, raw: TradeQueryRaw): Record<string, unknown> {
  const league = validateLeague(args.league);
  const realm = args.realm ?? 'pc';
  const { query, texts, kept, dropped, budget, pobDefaultMin, minWeightedSum } = applyWeightFilters(args, raw);
  const requiredMods = args.requiredMods ?? [];
  return {
    url: tradeSearchUrl(league, realm, query),
    league,
    realm,
    slot: args.slot,
    itemCategory: raw.itemCategory,
    currentItem: raw.currentItem,
    statWeights: raw.statWeights,
    minWeightedSum,
    pobDefaultMinWeightedSum: round(pobDefaultMin, 6),
    currentItemWeightedValue: round(pobDefaultMin * 2, 6),
    filterBudget: budget,
    capLifted: raw.capLifted,
    ...(raw.capLifted ? {} : {
      capWarning: 'This Path of Building version returned an already capped weight list (its own 36-filter cap applied), ' +
        'so droppedByCap is incomplete and filters PoB dropped cannot come back.',
    }),
    filters: kept.map((f) => ({ ...f, weight: round(f.weight) })),
    requiredMods: requiredMods.map((m) => ({ tradeId: m.tradeId, text: texts.get(m.tradeId) ?? m.tradeId, min: m.min ?? null })),
    droppedByCap: {
      count: dropped.length,
      top: dropped.slice(0, 5).map((f) => ({ tradeId: f.tradeId, text: f.text, weight: round(f.weight) })),
    },
    note:
      'weight ~ stat-score gain per 1 point of the mod (score = sum of statWeights x relative stat change x 1000); ' +
      'results are sorted by weighted sum, highest first, and must reach minWeightedSum. ' +
      'PoB scores stats already capped (e.g. resistances) as 0: add weightAdjustments for what the replaced item provided.',
    calcSeconds: round(raw.calcSeconds, 3),
  };
}
