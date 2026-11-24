/**
 * generate_trade_search / search_trade_mods registration. The pieces:
 * trade-search-schema (types, schema), trade-search-command (validation, bridge
 * command), trade-search-filters (adjustments, cap), trade-search-response (URL, response).
 */
import { z } from 'zod';
import type { ToolRegistrar } from './tool-registry.js';
import { tradeQueryCommand } from './trade-search-command.js';
import { buildTradeSearch } from './trade-search-response.js';
import { FLASK_TYPE_TEXT, FLASK_TYPES, JEWEL_TYPE_TEXT, JEWEL_TYPES, tradeSearchSchema, UNIQUES, type TradeSearchArgs } from './trade-search-schema.js';
import { UserError } from './validation.js';

export type { TradeModsResult, TradeQueryRaw, TradeSearchArgs } from './trade-search-schema.js';

export function registerTradeTools(tools: ToolRegistrar): void {
  tools.engine<TradeSearchArgs>(
    'generate_trade_search',
    {
      description:
        'Build a pathofexile.com trade search for a gear or flask slot, an abyssal socket or an allocated passive-tree jewel socket that ranks items by a weighted sum of mods, using Path of Building\'s own ' +
        'trade query generator (each mod is simulated on the build to get its weight). Returns a ready-to-open URL sorted by weighted sum ' +
        '(highest first) plus the filters and weights so you can adjust them (weightAdjustments, requiredMods, minWeightedSum) and call again. ' +
        'Jewel sockets search jewels of `jewelType` (tree sockets; abyssal sockets search abyss jewels); an unallocated tree socket is refused (its weights would all be 0: allocate it first with allocate_nodes). ' +
        'Flask slots search flasks of `flaskType` (default: the equipped flask\'s kind; required for an empty slot); an inactive flask slot is evaluated active for the call (evaluatedActive: true; the build is unchanged); tinctures are refused (no tincture category in PoB\'s generator). ' +
        'A weapon slot of the weapon set the build does not use (e.g. "Weapon 1 Swap" while the first set is in use), or an abyssal socket on one, is refused: PoB ignores it, so every weight would be 0. ' +
        '`unique` searches for Watcher\'s Eye (aura mods, slot = an allocated non-cluster tree socket), Pearl of Tsoatha (support gems, slot = a ring slot) or Megalomaniac (cluster notables weighed as passive nodes, slot optional) as PoB\'s "Other trades" rows do. ' +
        'Read-only: the build is unchanged. Takes a few seconds (longer on heavy builds). No network access.',
      inputSchema: tradeSearchSchema,
    },
    async (args, session) => {
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
        'case-insensitive text match. Use the ids in generate_trade_search requiredMods / weightAdjustments. For single resistances and ' +
        'attributes PoB weighs the pseudo total: those pseudo ids are listed first (preferred: true) and the other entries name it in preferredTradeId. ' +
        'All/hybrid resistances and attributes are marked weightable: false (PoB counts them in the pseudo totals named in preferredTradeIds; ' +
        'weight those instead) but are valid in requiredMods. ' +
        'With `unique`, lists the pool that unique\'s search weighs instead: Watcher\'s Eye its mods (plus corrupted jewel implicits and pseudo stats), ' +
        'Megalomaniac the cluster notables it can add ("1 Added Passive Skill is ..."); Pearl of Tsoatha is refused (Path of Building has no mod list for it: ' +
        'its search weighs one filter per support gem and skill-group slot, generated per search).',
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
