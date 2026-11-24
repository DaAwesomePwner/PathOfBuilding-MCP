/**
 * generate_trade_search / search_trade_mods registration. The pieces:
 * trade-search-schema (types, schema), trade-search-command (validation, bridge
 * command), trade-search-filters (adjustments, cap), trade-search-response (URL, response).
 */
import { z } from 'zod';
import type { ToolRegistrar } from './tool-registry.js';
import { isWickermanSlot, tradeQueryCommand, visceraRankArgs } from './trade-search-command.js';
import { buildTradeSearch, buildVisceraRanking } from './trade-search-response.js';
import { FLASK_TYPE_TEXT, FLASK_TYPES, JEWEL_TYPE_TEXT, JEWEL_TYPES, tradeSearchSchema, UNIQUES, type TradeSearchArgs } from './trade-search-schema.js';
import { UserError } from './validation.js';

export type { TradeModsResult, TradeQueryRaw, TradeSearchArgs } from './trade-search-schema.js';

/** Viscera parts generate_trade_search returns for a Wickerman slot (every part that fits is evaluated). */
const VISCERA_RESULTS = 10;

export function registerTradeTools(tools: ToolRegistrar): void {
  tools.engine<TradeSearchArgs>(
    'generate_trade_search',
    {
      description:
        'Build a pathofexile.com trade search for a gear or flask slot, an abyssal socket or an allocated passive-tree jewel socket that ranks items by a weighted sum of mods, using Path of Building\'s own ' +
        'trade query generator (each mod is simulated on the build to get its weight). Returns a ready-to-open URL sorted by weighted sum ' +
        '(highest first) plus the filters and weights so you can adjust them (weightAdjustments, requiredMods, minWeightedSum) and call again. ' +
        'Jewel sockets search jewels of `jewelType` (tree sockets; abyssal sockets search abyss jewels); an unallocated tree socket is refused (its weights would all be 0: allocate it first with allocate_nodes). ' +
        'Flask slots search flasks of `flaskType` (default: the equipped flask\'s kind; required for an empty slot); an inactive flask slot is evaluated active for the call (evaluatedActive: true; the build is unchanged). ' +
        'Tinctures (a tincture in a flask slot) and grafts (Graft 1/2, shown on 3.27 trees) have no trade category in PoB\'s data: their mods are weighed from PoB\'s tincture / graft mods that can roll on the base of the item in the slot, and the search is filtered by that base type (baseType); the slot must hold one. ' +
        'Wickerman slots (Head/Body/Arm/Leg, shown on 3.30 trees) hold Viscera parts, which have fixed implicits and no mods: there the result is no search but the Viscera parts that fit the slot, each measured in it and ranked by statWeights (candidates: name, score, stats, change, itemText; url null, as PoB\'s trade data has no Viscera category). ' +
        'A weapon slot of the weapon set the build does not use (e.g. "Weapon 1 Swap" while the first set is in use), or an abyssal socket on one, is refused: PoB ignores it, so every weight would be 0. ' +
        '`unique` searches for Watcher\'s Eye (aura mods, slot = an allocated tree socket not holding a cluster jewel), Pearl of Tsoatha (support gems, slot = a ring slot) or Megalomaniac (cluster notables weighed as passive nodes, slot optional) as PoB\'s "Other trades" rows do. ' +
        'Read-only: the build is unchanged. Takes a few seconds (longer on heavy builds). No network access.',
      inputSchema: tradeSearchSchema,
    },
    async (args, session) => {
      if (isWickermanSlot(args.slot)) {
        const { slot, statWeights } = visceraRankArgs(args);
        return buildVisceraRanking(args, await session.rankViscera(slot, statWeights, VISCERA_RESULTS));
      }
      const command = tradeQueryCommand(args);
      return buildTradeSearch(args, await session.generateTradeQuery(command));
    },
  );

  tools.engine<{
    slot?: string; query: string; limit?: number;
    jewelType?: (typeof JEWEL_TYPES)[number]; flaskType?: (typeof FLASK_TYPES)[number]; unique?: (typeof UNIQUES)[number];
  }>(
    'search_trade_mods',
    {
      description:
        'Find trade stat ids for mods that can appear on the item in a slot (explicit, implicit, corrupted) plus pseudo stats, by ' +
        'case-insensitive text match (grafts and tinctures: the mods that can roll on the base in the slot, all of them for an empty slot; Wickerman slots have none). ' +
        'Use the ids in generate_trade_search requiredMods / weightAdjustments. For single resistances and ' +
        'attributes PoB weighs the pseudo total: those pseudo ids are listed first (preferred: true) and the other entries name it in preferredTradeId. ' +
        'All/hybrid resistances and attributes are marked weightable: false (PoB counts them in the pseudo totals named in preferredTradeIds; ' +
        'weight those instead) but are valid in requiredMods. ' +
        'With `unique`, lists the pool that unique\'s search weighs instead: Watcher\'s Eye its mods (plus corrupted jewel implicits and pseudo stats), ' +
        'Megalomaniac the cluster notables it can add ("1 Added Passive Skill is ..."), Pearl of Tsoatha its support filters (one per support gem ' +
        'and skill-group slot, ids like "explicit.stat_4089743927|1|5", as its search returns them).',
      inputSchema: {
        slot: z.string().min(1).optional().describe('Slot as for generate_trade_search: gear or flask slot ("Helmet", "Ring 1"), an abyssal socket the item in its slot has or an allocated passive-tree jewel socket ("Jewel 26725"). Required unless `unique` is given (then optional and checked as for that unique\'s search).'),
        query: z.string().trim().min(1).max(100).describe('Text to look for, e.g. "life" or "fire resistance".'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum results (default 25).'),
        jewelType: z.enum(JEWEL_TYPES).optional().describe(`${JEWEL_TYPE_TEXT} Lists the mods of that jewel type, as generate_trade_search weighs them.`),
        flaskType: z.enum(FLASK_TYPES).optional().describe(`${FLASK_TYPE_TEXT} Every kind lists the same flask mods; an empty flask slot needs none here.`),
        unique: z.enum(UNIQUES).optional().describe('List the mod pool of this unique\'s weighted search (see generate_trade_search unique) instead of a slot\'s.'),
      },
    },
    async ({ slot, query, limit, jewelType, flaskType, unique }, session) => {
      if (slot === undefined && unique === undefined) throw new UserError('slot is required unless unique is given; see list_valid_slots');
      const result = await session.searchTradeMods(slot, query, limit ?? 25, jewelType, flaskType, unique);
      return { ...(unique !== undefined ? { unique } : {}), slot: slot ?? null, query, ...result, returned: result.mods.length };
    },
  );
}
