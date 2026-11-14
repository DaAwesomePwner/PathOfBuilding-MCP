/** generate_trade_search / search_trade_mods: argument and bridge result types, option lists, Zod schema. */
import { z } from 'zod';

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
  /**
   * `preferred`: a pseudo total PoB weighs that stat through (listed first); `preferredTradeId`: use it instead.
   * `weightable: false`: PoB leaves the stat out of weighted searches (all/hybrid resistances and attributes, counted
   * by the pseudo totals in `preferredTradeIds`), so weightAdjustments refuse it; it still works in requiredMods.
   */
  mods: {
    tradeId: string; text: string; type: 'Explicit' | 'Implicit' | 'Corrupted' | 'Pseudo';
    preferred?: true; preferredTradeId?: string; weightable?: false; preferredTradeIds?: string[];
  }[];
}

export const MAX_FILTERS = 36; // PoB's MAX_FILTERS (TradeQueryGenerator.lua)
export const DEFAULT_STAT_WEIGHTS = [{ stat: 'FullDPS', weight: 1 }, { stat: 'TotalEHP', weight: 0.5 }];
export const TRADE_TYPES = ['securable', 'available', 'onlineleague', 'online', 'any'] as const;
export const ELDRITCH = ['copyCurrent', 'keepRegular', 'keepRegularPresence', 'remove'] as const;
const INFLUENCES = ['shaper', 'elder', 'warlord', 'hunter', 'crusader', 'redeemer'] as const;
const CURRENCIES = ['chaos-equivalent', 'chaos', 'divine', 'alch', 'alt', 'chrome', 'exalted', 'blessed', 'chisel',
  'gcp', 'jewellers', 'scour', 'regret', 'fusing', 'chance', 'regal', 'vaal'] as const;
export const ELDRITCH_SLOTS = new Set(['Body Armour', 'Helmet', 'Gloves', 'Boots']);
export const TRADE_ID_RE = /^[a-z]+\.[a-z0-9_]+(?:\|[a-z0-9_]+)?$/;

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
  includeEldritch: z.enum(ELDRITCH).optional().describe('Body/helmet/gloves/boots: eldritch implicit handling (default "copyCurrent" = no eldritch weights; "keep..." weighs them). Other slots accept only "copyCurrent" / "remove", which change nothing there.'),
  includeScourge: z.boolean().optional().describe('Weigh scourge mods (default: true only in Standard/Hardcore).'),
  includeTalisman: z.boolean().optional().describe('Amulet: weigh talisman implicits (default false). Other slots accept only false.'),
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
    .describe('Applied after PoB computes its weights: replaces a filter\'s weight, adds a missing filter, or removes it (weight 0). Adjusted/added filters are never dropped by the 36-filter cap. Use it e.g. to add resistance weight when PoB scores capped resists as 0 but the replaced item provided them. Single resistance/attribute ids apply to their pseudo total (e.g. pseudo.pseudo_total_fire_resistance), the filter PoB weighs them through. All/hybrid resistance and attribute ids are refused unless their weight is 0, which changes nothing (PoB leaves them out because the pseudo totals count them; adjust those totals instead).'),
  minWeightedSum: z.number().optional().describe('Override the minimum weighted sum (default: PoB\'s, half the current item\'s estimated weighted value).'),
};
