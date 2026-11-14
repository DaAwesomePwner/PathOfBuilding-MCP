/**
 * generate_trade_search / search_trade_mods registration. The pieces:
 * trade-search-schema (types, schema), trade-search-command (validation, bridge
 * command), trade-search-filters (adjustments, cap), trade-search-response (URL, response).
 */
import { z } from 'zod';
import type { ToolRegistrar } from './tool-registry.js';
import { tradeQueryCommand } from './trade-search-command.js';
import { buildTradeSearch } from './trade-search-response.js';
import { tradeSearchSchema, type TradeSearchArgs } from './trade-search-schema.js';

export type { TradeModsResult, TradeQueryRaw, TradeSearchArgs } from './trade-search-schema.js';

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
        'attributes PoB weighs the pseudo total: those pseudo ids are listed first (preferred: true) and the other entries name it in preferredTradeId. ' +
        'All/hybrid resistances and attributes are marked weightable: false (PoB counts them in the pseudo totals named in preferredTradeIds; ' +
        'weight those instead) but are valid in requiredMods.',
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
