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
  const megalomaniac = args.unique === 'Megalomaniac';
  /** A Megalomaniac filter's notable: "1 Added Passive Skill is <name>". */
  const notable = (text: string) => /^1 Added Passive Skill is (.+)$/.exec(text)?.[1];
  return {
    url: tradeSearchUrl(league, realm, query),
    league,
    realm,
    ...(args.unique !== undefined ? { unique: args.unique } : {}),
    slot: raw.slot !== undefined ? raw.slot : args.slot,
    itemCategory: raw.itemCategory,
    currentItem: raw.currentItem,
    ...(raw.flaskType !== undefined ? { flaskType: raw.flaskType } : {}),
    ...(raw.testBase !== undefined ? { testBase: raw.testBase } : {}),
    ...(raw.evaluatedActive ? {
      evaluatedActive: true,
      activeNote: 'The flask slot is inactive in the build (Path of Building would weigh every mod at 0 there), so the weights were ' +
        'computed with it active; the build is unchanged. set_flask_active turns it on.',
    } : {}),
    statWeights: raw.statWeights,
    minWeightedSum,
    pobDefaultMinWeightedSum: round(pobDefaultMin, 6),
    currentItemWeightedValue: round(pobDefaultMin * 2, 6),
    filterBudget: budget,
    capLifted: raw.capLifted,
    ...(raw.capLifted ? {} : {
      capWarning: 'This Path of Building version returned an already capped weight list (it applies its own filter limit), ' +
        'so droppedByCap only lists filters dropped after that and filters PoB dropped cannot come back.',
    }),
    filters: kept.map((f) => {
      const name = megalomaniac ? notable(f.text) : undefined;
      return { ...f, weight: round(f.weight), ...(name !== undefined ? { notable: name } : {}) };
    }),
    requiredMods: requiredMods.map((m) => ({ tradeId: m.tradeId, text: texts.get(m.tradeId) ?? m.tradeId, min: m.min ?? null })),
    droppedByCap: {
      count: dropped.length,
      top: dropped.slice(0, 5).map((f) => ({ tradeId: f.tradeId, text: f.text, weight: round(f.weight) })),
    },
    note: megalomaniac
      ? 'Megalomaniac: each filter is a cluster notable it can add, weight ~ stat-score gain of that notable allocated on the build ' +
        '(score = sum of statWeights x relative stat change x 1000), plus, when slot holds a jewel, what that jewel is worth (Path of ' +
        'Building measures from the build without it, so every weight includes it). Results are sorted by weighted sum, highest first, ' +
        'and must reach minWeightedSum (PoB\'s default: half the worth of the jewel in slot, 0 without one).'
      : 'weight ~ stat-score gain per 1 point of the mod (score = sum of statWeights x relative stat change x 1000); ' +
        'results are sorted by weighted sum, highest first, and must reach minWeightedSum. ' +
        'PoB scores stats already capped (e.g. resistances) as 0: add weightAdjustments for what the replaced item provided.',
    calcSeconds: round(raw.calcSeconds, 3),
  };
}
