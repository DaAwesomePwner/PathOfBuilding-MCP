/** generate_trade_search / search_trade_mods: argument and bridge result types, option lists, Zod schema. */
import { z } from 'zod';

/** What the bridge's `tradeQuery` command returns (PoB's TradeQueryGenerator, its filter cap lifted: 2.67's MAX_FILTERS, 2.68's complexity budget). */
export interface TradeQueryRaw {
  /** The full request JSON: {query: {filters, status, stats}, sort, engine}; stats[0] is the weight group, no empty groups. */
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
  /** Flask slots: the flask kind searched (flaskType, else the equipped flask's). */
  flaskType?: string;
  /** Grafts and tinctures (no trade category in PoB's data): the base type the search is filtered by. */
  baseType?: string;
  /** Grafts and tinctures: mod lines (numbers as #) PoB's mod processing found no trade stat for, so they are not weighed (an empty list may come as {}). */
  unmatchedMods?: string[] | Record<string, never>;
  /** Flask slots holding no flask of that kind: the blank base the mods were tried on. */
  testBase?: string;
  /** The flask slot is inactive in the build and was evaluated active for the call. */
  evaluatedActive?: true;
  /** A special unique search (`unique`): its name. */
  unique?: (typeof UNIQUES)[number];
  /** The slot the search ran against (null: a Megalomaniac search on a build without a usable socket). */
  slot?: string | null;
}

/** One Viscera part ranked for a Wickerman slot (BuildSession.rankViscera). */
export interface VisceraCandidate {
  name: string;
  baseName: string;
  /** (PoB's WeightedRatioOutputs of the build with the part - of the build as it is) x 1000; 0 = no change. */
  score: number;
  /** CombinedDPS / TotalEHP / Life with the part in the slot (compare_items' numbers for itemText). */
  stats: Record<string, number>;
  /** Those stats minus the build's. */
  change: Record<string, number>;
  /** PoB's text of the part, for compare_items / swap_item. */
  itemText: string;
}

export interface VisceraRanking {
  slot: string;
  currentItem: string | null;
  statWeights: { stat: string; label: string; weight: number }[];
  /** Parts that fit the slot (all were evaluated). */
  total: number;
  /** The best `limit` parts, highest score first. */
  candidates: VisceraCandidate[];
  /** Parts the probe could not evaluate. */
  errors: { name: string; error: string }[];
}

/** The Wickerman slots (3.30 trees), which hold Viscera parts. */
export const WICKERMAN_SLOTS = new Set(['Head', 'Body', 'Arm', 'Leg']);
/** Graft slots (3.27 trees). */
export const GRAFT_SLOT_RE = /^Graft \d$/;

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

export const MAX_FILTERS = 36; // PoB 2.67's MAX_FILTERS (TradeQueryGenerator.lua); the server's cap on every PoB version
export const DEFAULT_STAT_WEIGHTS = [{ stat: 'FullDPS', weight: 1 }, { stat: 'TotalEHP', weight: 0.5 }];
export const TRADE_TYPES = ['securable', 'available', 'onlineleague', 'online', 'any'] as const;
export const ELDRITCH = ['copyCurrent', 'keepRegular', 'keepRegularPresence', 'remove'] as const;
const INFLUENCES = ['shaper', 'elder', 'warlord', 'hunter', 'crusader', 'redeemer'] as const;
const CURRENCIES = ['chaos-equivalent', 'chaos', 'divine', 'alch', 'alt', 'chrome', 'exalted', 'blessed', 'chisel',
  'gcp', 'jewellers', 'scour', 'regret', 'fusing', 'chance', 'regal', 'vaal'] as const;
export const ELDRITCH_SLOTS = new Set(['Body Armour', 'Helmet', 'Gloves', 'Boots']);
export const JEWEL_TYPES = ['base', 'abyss', 'any'] as const;
/** The special uniques of PoB's trade tab ("Other trades"), searched with the generator's options.special. */
export const UNIQUES = ["Watcher's Eye", 'Megalomaniac', 'Pearl of Tsoatha'] as const;
export const UNIQUE_TEXT = 'Search for one of the uniques Path of Building\'s trade tab searches by weight ("Other trades"), as it does: ' +
  '"Watcher\'s Eye" weighs its aura mods (and corrupted jewel implicits unless includeCorrupted is false) with `slot` = an allocated ' +
  'passive-tree jewel socket not holding a cluster jewel; "Pearl of Tsoatha" weighs each support gem it can grant per skill-group ' +
  'slot, tried on a Prismatic Ring in `slot` = a ring slot Path of Building shows; "Megalomaniac" weighs each cluster notable it can add ' +
  'as a passive node (weight = stat-score gain of the notable; `slot` is optional: such a socket, whose jewel counts as replaced, by ' +
  'default Path of Building\'s own pick, the lowest allocated socket node id, skipping sockets that hold a cluster jewel; none when no ' +
  'socket is allocated). The search requires ' +
  'the unique by name and always excludes mirrored items (as PoB). Not with influences, sockets, links, jewelType (Watcher\'s Eye: ' +
  'only "any"), flaskType, includeMirrored true, includeTalisman true or includeEldritch "keep...".';
/** "tincture" searches the tincture in the slot (the bridge refuses it when there is none: slotChecks.tinctureTradeRefusal). */
export const FLASK_TYPES = ['life', 'mana', 'hybrid', 'utility', 'tincture'] as const;
export const FLASK_TYPE_TEXT = 'Flask slots only: which flask to search for, "life", "mana", "hybrid", "utility" or "tincture" (default: the kind of the ' +
  'flask equipped there; needed for an empty slot). Every kind is weighed from Path of Building\'s flask mod list and searched in the ' +
  'trade site\'s "flask" category (PoB has no life/mana sub-category), so results may include other kinds of flask; the kind decides ' +
  'the flask the mods are tried on (the equipped one, else a blank base of that kind, reported as testBase, with a default minimum ' +
  'weighted sum of 0). "tincture" (the default when a tincture is equipped) weighs PoB\'s tincture mods that can roll on the tincture in the ' +
  'slot and filters the search by its base type (PoB has no tincture trade category); it needs a tincture in the slot.';
/** Passive-tree jewel sockets ("Jewel <nodeId>") and abyssal sockets ("<slot> Abyssal Socket N"). */
export const JEWEL_SLOT_RE = /^Jewel \d+$|Abyssal Socket \d+$/;
/** Up to two `|` suffixes: option stats (one) and Pearl of Tsoatha's support filters (`explicit.stat_4089743927|<slot>|<support>`). */
export const TRADE_ID_RE = /^[a-z]+\.[a-z0-9_]+(?:\|[a-z0-9_]+){0,2}$/;

export const JEWEL_TYPE_TEXT = 'Passive-tree jewel sockets: which jewels to search and weigh, "base" (regular jewels), "abyss" (abyss jewels) or "any" (both; ' +
  'PoB\'s trade popup offers only Base / Abyss, its query generator also takes Any). Default "abyss" when an abyss jewel is socketed there, ' +
  'else "base". Abyssal sockets accept only "abyss"; other slots take none.';

const tradeId = z.string().max(80).describe('Trade stat id, e.g. "explicit.stat_3299347043" or "pseudo.pseudo_total_life" (find ids with search_trade_mods).');

export interface TradeSearchArgs {
  /** Required except for a Megalomaniac search (`unique`). */
  slot?: string;
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
  jewelType?: (typeof JEWEL_TYPES)[number];
  flaskType?: (typeof FLASK_TYPES)[number];
  unique?: (typeof UNIQUES)[number];
  requiredMods?: { tradeId: string; min?: number }[];
  weightAdjustments?: { tradeId: string; weight: number }[];
  minWeightedSum?: number;
}

export const tradeSearchSchema = {
  slot: z.string().min(1).optional().describe('Gear or flask slot ("Helmet", "Ring 1", "Weapon 1", "Flask 1"), an abyssal socket the item in its slot has ("Belt Abyssal Socket 1"), an allocated passive-tree jewel socket ("Jewel 26725"), a graft slot holding a graft ("Graft 1", 3.27 trees) or a Wickerman slot ("Head", 3.30 trees: ranks Viscera parts instead); see list_valid_slots. Required, except for unique "Megalomaniac".'),
  league: z.string().describe('Trade league name exactly as on the trade site, e.g. "Standard" or the current challenge league.'),
  realm: z.enum(['pc', 'xbox', 'sony']).optional().describe('Platform (default "pc").'),
  statWeights: z.array(z.object({ stat: z.string().min(1).max(64), weight: z.number().gt(0).lte(10) })).min(1).max(20).optional()
    .describe('What to optimise, as PoB stat names with multipliers (default FullDPS 1.0 + TotalEHP 0.5, like PoB). Unknown names list the valid ones.'),
  tradeType: z.enum(TRADE_TYPES).optional().describe('Listing status filter (default "available" = instant buyout and in-person).'),
  includeCorrupted: z.boolean().optional().describe('Weigh corrupted implicits (default: true unless the current item is corrupted).'),
  includeEldritch: z.enum(ELDRITCH).optional().describe('Body/helmet/gloves/boots: eldritch implicit handling (default "copyCurrent" = no eldritch weights; "keep..." weighs them). Other slots accept only "copyCurrent" / "remove", which change nothing there.'),
  includeScourge: z.boolean().optional().describe('Weigh scourge mods (default: true only in Standard/Hardcore; never for jewel sockets, which accept only false).'),
  includeTalisman: z.boolean().optional().describe('Amulet: weigh talisman implicits (default false). Other slots accept only false.'),
  includeMirrored: z.boolean().optional().describe('Allow mirrored items (default true; unique searches always exclude them and accept only false).'),
  influences: z.array(z.enum(INFLUENCES)).max(2).optional().describe('Up to two required influences (PoB 2.68+ no longer weighs mods on an influenced copy of the item; the influence is still required).'),
  maxPrice: z.object({ amount: z.number().int().positive().max(1_000_000), currency: z.enum(CURRENCIES).optional() }).optional()
    .describe('Maximum price (currency default "chaos-equivalent").'),
  maxLevel: z.number().int().min(1).max(100).optional().describe('Maximum required level.'),
  sockets: z.number().int().min(1).max(6).optional().describe('Exact number of empty sockets (not for flasks or jewel sockets).'),
  links: z.number().int().min(1).max(6).optional().describe('Exact number of links (armour and weapons only).'),
  jewelType: z.enum(JEWEL_TYPES).optional().describe(JEWEL_TYPE_TEXT),
  flaskType: z.enum(FLASK_TYPES).optional().describe(FLASK_TYPE_TEXT),
  unique: z.enum(UNIQUES).optional().describe(UNIQUE_TEXT),
  requiredMods: z.array(z.object({ tradeId, min: z.number().optional() })).max(10).optional()
    .describe('Hard requirements: every listed mod must be present (with at least `min` when given).'),
  weightAdjustments: z.array(z.object({ tradeId, weight: z.number().min(-1000).max(1000) })).max(MAX_FILTERS).optional()
    .describe('Applied after PoB computes its weights: replaces a filter\'s weight, adds a missing filter, or removes it (weight 0). Adjusted/added filters are never dropped by the 36-filter cap. Use it e.g. to add resistance weight when PoB scores capped resists as 0 but the replaced item provided them. Single resistance/attribute ids apply to their pseudo total (e.g. pseudo.pseudo_total_fire_resistance), the filter PoB weighs them through. All/hybrid resistance and attribute ids are refused unless their weight is 0, which changes nothing (PoB leaves them out because the pseudo totals count them; adjust those totals instead).'),
  minWeightedSum: z.number().optional().describe('Override the minimum weighted sum (default: PoB\'s, half the current item\'s estimated weighted value).'),
};
