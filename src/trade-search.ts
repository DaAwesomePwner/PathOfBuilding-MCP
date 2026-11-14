import { z } from 'zod';
import type { ToolRegistrar } from './tool-registry.js';
import { UserError } from './validation.js';

/** What the bridge's `tradeQuery` command returns (PoB's TradeQueryGenerator, 36-filter cap lifted). */
export interface TradeQueryRaw {
  queryJson: string;
  pobMessage: string | null;
  capLifted: boolean;
  itemCategory: string | null;
  currentItem: string | null;
  statWeights: { stat: string; label: string; weight: number }[];
  texts: { id: string; text: string }[];
  /** Requested ids whose stat PoB weighs through a pseudo "total" filter (fire res -> pseudo total fire res). */
  pseudoMap: { from: string; to: string }[];
  calcSeconds: number;
}

export interface TradeModsResult {
  itemCategory: string | null;
  total: number;
  /** `preferred`: a pseudo total PoB weighs that stat through (listed first); `preferredTradeId`: use it instead. */
  mods: { tradeId: string; text: string; type: 'Explicit' | 'Implicit' | 'Corrupted' | 'Pseudo'; preferred?: true; preferredTradeId?: string }[];
}

const MAX_FILTERS = 36; // PoB's MAX_FILTERS (TradeQueryGenerator.lua)
const DEFAULT_STAT_WEIGHTS = [{ stat: 'FullDPS', weight: 1 }, { stat: 'TotalEHP', weight: 0.5 }];
const TRADE_TYPES = ['securable', 'available', 'onlineleague', 'online', 'any'] as const;
const ELDRITCH = ['copyCurrent', 'keepRegular', 'keepRegularPresence', 'remove'] as const;
const INFLUENCES = ['shaper', 'elder', 'warlord', 'hunter', 'crusader', 'redeemer'] as const;
const CURRENCIES = ['chaos-equivalent', 'chaos', 'divine', 'alch', 'alt', 'chrome', 'exalted', 'blessed', 'chisel',
  'gcp', 'jewellers', 'scour', 'regret', 'fusing', 'chance', 'regal', 'vaal'] as const;
const ELDRITCH_SLOTS = new Set(['Body Armour', 'Helmet', 'Gloves', 'Boots']);
const TRADE_ID_RE =/^[a-z]+\.[a-z0-9_]+(?:\|[a-z0-9_]+)?$/;

const tradeId = z.string().max(80).describe('Trade stat id, e.g. "explicit.stat_3299347043" or "pseudo.pseudo_total_life" (find ids with search_trade_mods).');

export interface TradeSearchArgs {
  slot: string;
  league: string;
  realm?: 'pc' | 'xbox' | 'sony';
  statWeights?: { stat: string; weight: number }[];
  tradeType?: (typeof TRADE_TYPES)[number];
  includeCorrupted?: boolean;
  includeEldritch?: (typeof ELDRITCH)[number];
  includeScourge?: boolean;
  includeTalisman?: boolean;
  includeMirrored?: boolean;
  influences?: (typeof INFLUENCES)[number][];
  maxPrice?: { amount: number; currency?: (typeof CURRENCIES)[number] };
  maxLevel?: number;
  sockets?: number;
  links?: number;
  requiredMods?: { tradeId: string; min?: number }[];
  weightAdjustments?: { tradeId: string; weight: number }[];
  minWeightedSum?: number;
}

export const tradeSearchSchema = {
  slot: z.string().min(1).describe('Gear or flask slot, e.g. "Helmet", "Ring 1", "Weapon 1", "Flask 1" (jewel sockets are not supported).'),
  league: z.string().describe('Trade league name exactly as on the trade site, e.g. "Standard" or the current challenge league.'),
  realm: z.enum(['pc', 'xbox', 'sony']).optional().describe('Platform (default "pc").'),
  statWeights: z.array(z.object({ stat: z.string().min(1).max(64), weight: z.number().gt(0).lte(10) })).min(1).max(20).optional()
    .describe('What to optimise, as PoB stat names with multipliers (default FullDPS 1.0 + TotalEHP 0.5, like PoB). Unknown names list the valid ones.'),
  tradeType: z.enum(TRADE_TYPES).optional().describe('Listing status filter (default "available" = instant buyout and in-person).'),
  includeCorrupted: z.boolean().optional().describe('Weigh corrupted implicits (default: true unless the current item is corrupted).'),
  includeEldritch: z.enum(ELDRITCH).optional().describe('Body/helmet/gloves/boots only: eldritch implicit handling (default "copyCurrent" = no eldritch weights).'),
  includeScourge: z.boolean().optional().describe('Weigh scourge mods (default: true only in Standard/Hardcore).'),
  includeTalisman: z.boolean().optional().describe('Amulet only: weigh talisman implicits (default false).'),
  includeMirrored: z.boolean().optional().describe('Allow mirrored items (default true).'),
  influences: z.array(z.enum(INFLUENCES)).max(2).optional().describe('Up to two required influences.'),
  maxPrice: z.object({ amount: z.number().int().positive().max(1_000_000), currency: z.enum(CURRENCIES).optional() }).optional()
    .describe('Maximum price (currency default "chaos-equivalent").'),
  maxLevel: z.number().int().min(1).max(100).optional().describe('Maximum required level.'),
  sockets: z.number().int().min(1).max(6).optional().describe('Exact number of empty sockets (not for flasks).'),
  links: z.number().int().min(1).max(6).optional().describe('Exact number of links (armour and weapons only).'),
  requiredMods: z.array(z.object({ tradeId, min: z.number().optional() })).max(10).optional()
    .describe('Hard requirements: every listed mod must be present (with at least `min` when given).'),
  weightAdjustments: z.array(z.object({ tradeId, weight: z.number().min(-1000).max(1000) })).max(MAX_FILTERS).optional()
    .describe('Applied after PoB computes its weights: replaces a filter\'s weight, adds a missing filter, or removes it (weight 0). Adjusted/added filters are never dropped by the 36-filter cap. Use it e.g. to add resistance weight when PoB scores capped resists as 0 but the replaced item provided them. Single resistance/attribute ids apply to their pseudo total (e.g. pseudo.pseudo_total_fire_resistance), the filter PoB weighs them through.'),
  minWeightedSum: z.number().optional().describe('Override the minimum weighted sum (default: PoB\'s, half the current item\'s estimated weighted value).'),
};

export function validateLeague(raw: string): string {
  const league = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (league.length < 1 || league.length > 64 || /[\u0000-\u001f\u007f/]/.test(league) || /^[.\s]+$/.test(league)) {
    throw new UserError('league must be 1-64 characters, not only dots, with no "/" or control characters, e.g. "Standard"');
  }
  return league;
}

function checkTradeIds(ids: string[], what: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!TRADE_ID_RE.test(id)) throw new UserError(`Invalid trade stat id in ${what}: "${id}" (expected e.g. "explicit.stat_3299347043"; use search_trade_mods)`);
    if (seen.has(id)) throw new UserError(`Duplicate trade stat id in ${what}: ${id}`);
    seen.add(id);
  }
}

/** Validates arguments the bridge cannot check and builds the bridge command. */
export function tradeQueryCommand(args: TradeSearchArgs): Record<string, unknown> {
  const league = validateLeague(args.league);
  const weights = args.statWeights ?? DEFAULT_STAT_WEIGHTS;
  if (new Set(weights.map((w) => w.stat)).size !== weights.length) throw new UserError('statWeights lists a stat more than once');
  if (new Set(args.influences ?? []).size !== (args.influences ?? []).length) throw new UserError('influences lists an influence twice');
  checkTradeIds((args.requiredMods ?? []).map((m) => m.tradeId), 'requiredMods');
  checkTradeIds((args.weightAdjustments ?? []).map((m) => m.tradeId), 'weightAdjustments');
  if (args.sockets !== undefined && /Flask/.test(args.slot)) throw new UserError('sockets is not available for flask slots');
  if (args.links !== undefined && /Flask|Belt|Ring|Amulet/.test(args.slot)) throw new UserError(`links is not available for ${args.slot}`);
  // PoB only offers these options on their slots: refuse instead of dropping them silently.
  if (args.includeEldritch !== undefined && !ELDRITCH_SLOTS.has(args.slot)) {
    throw new UserError(`includeEldritch only applies to ${[...ELDRITCH_SLOTS].join(', ')}, not ${args.slot}`);
  }
  if (args.includeEldritch?.startsWith('keep') && (args.influences?.length ?? 0) > 0) {
    throw new UserError('includeEldritch "keep..." cannot be combined with influences: influenced items have no eldritch implicits, so PoB skips those weights');
  }
  if (args.includeTalisman !== undefined && args.slot !== 'Amulet') throw new UserError(`includeTalisman only applies to Amulet, not ${args.slot}`);
  const currency = args.maxPrice?.currency ?? 'chaos-equivalent';
  return {
    cmd: 'tradeQuery',
    slot: args.slot,
    statWeights: weights,
    tradeIds: [...(args.requiredMods ?? []), ...(args.weightAdjustments ?? [])].map((m) => m.tradeId),
    options: {
      tradeType: args.tradeType ?? 'available',
      includeCorrupted: args.includeCorrupted,
      includeMirrored: args.includeMirrored ?? true,
      includeScourge: args.includeScourge ?? /^(Standard|Hardcore)$/.test(league),
      includeTalisman: args.includeTalisman ?? false,
      eldritchIndex: ELDRITCH.indexOf(args.includeEldritch ?? 'copyCurrent') + 1,
      influences: args.influences ?? [],
      maxPrice: args.maxPrice?.amount,
      maxPriceType: currency === 'chaos-equivalent' ? undefined : currency,
      maxLevel: args.maxLevel,
      sockets: args.sockets,
      links: args.links,
    },
  };
}

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

const round = (n: number, digits = 4) => Number(n.toPrecision(digits));

type Filter = { tradeId: string; text: string; weight: number; source: 'pob' | 'adjusted' | 'added'; mappedFrom?: string };

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
export function buildTradeSearch(args: TradeSearchArgs, raw: TradeQueryRaw): Record<string, unknown> {
  const league = validateLeague(args.league);
  const realm = args.realm ?? 'pc';
  const texts = new Map(raw.texts.map((t) => [t.id, t.text]));
  const query = JSON.parse(raw.queryJson) as { query: { stats: { type: string; value?: { min?: number }; filters: unknown[] }[] } };
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

export function registerTradeTools(tools: ToolRegistrar): void {
  tools.engine<TradeSearchArgs>(
    'generate_trade_search',
    {
      description:
        'Build a pathofexile.com trade search for a gear slot that ranks items by a weighted sum of mods, using Path of Building\'s own ' +
        'trade query generator (each mod is simulated on the build to get its weight). Returns a ready-to-open URL sorted by weighted sum ' +
        '(highest first) plus the filters and weights so you can adjust them (weightAdjustments, requiredMods, minWeightedSum) and call again. ' +
        'Read-only: the build is unchanged. Takes a few seconds (longer on heavy builds). No network access.',
      inputSchema: tradeSearchSchema,
    },
    async (args, session) => {
      const command = tradeQueryCommand(args);
      return buildTradeSearch(args, await session.generateTradeQuery(command));
    },
  );

  tools.engine<{ slot: string; query: string; limit?: number }>(
    'search_trade_mods',
    {
      description:
        'Find trade stat ids for mods that can appear on the item in a slot (explicit, implicit, corrupted) plus pseudo stats, by ' +
        'case-insensitive text match. Use the ids in generate_trade_search requiredMods / weightAdjustments. For single resistances and ' +
        'attributes PoB weighs the pseudo total: those pseudo ids are listed first (preferred: true) and the other entries name it in preferredTradeId.',
      inputSchema: {
        slot: z.string().min(1).describe('Gear or flask slot, e.g. "Helmet" or "Ring 1".'),
        query: z.string().trim().min(1).max(100).describe('Text to look for, e.g. "life" or "fire resistance".'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum results (default 25).'),
      },
    },
    async ({ slot, query, limit }, session) => {
      const result = await session.searchTradeMods(slot, query, limit ?? 25);
      return { slot, query, ...result, returned: result.mods.length };
    },
  );
}
