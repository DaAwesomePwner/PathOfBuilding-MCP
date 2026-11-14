/** generate_trade_search: checks the bridge cannot do and the bridge's `tradeQuery` command. */
import { UserError } from './validation.js';
import { DEFAULT_STAT_WEIGHTS, ELDRITCH, ELDRITCH_SLOTS, TRADE_ID_RE, type TradeSearchArgs } from './trade-search-schema.js';

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
  // PoB only offers these options on their slots. Elsewhere a value that changes nothing there is accepted
  // (eldritch weights come only from "keep..."; talisman mods only from includeTalisman true); the rest
  // is refused instead of being dropped silently.
  if (args.includeEldritch?.startsWith('keep') && !ELDRITCH_SLOTS.has(args.slot)) {
    throw new UserError(`includeEldritch "${args.includeEldritch}" only applies to ${[...ELDRITCH_SLOTS].join(', ')}, not ${args.slot} ` +
      '(there "copyCurrent" and "remove" are accepted and change nothing)');
  }
  if (args.includeEldritch?.startsWith('keep') && (args.influences?.length ?? 0) > 0) {
    throw new UserError('includeEldritch "keep..." cannot be combined with influences: influenced items have no eldritch implicits, so PoB skips those weights');
  }
  if (args.includeTalisman === true && args.slot !== 'Amulet') {
    throw new UserError(`includeTalisman true only applies to Amulet, not ${args.slot} (false is accepted and changes nothing)`);
  }
  const currency = args.maxPrice?.currency ?? 'chaos-equivalent';
  return {
    cmd: 'tradeQuery',
    slot: args.slot,
    statWeights: weights,
    tradeIds: [...(args.requiredMods ?? []), ...(args.weightAdjustments ?? [])].map((m) => m.tradeId),
    // The bridge refuses weights on stats PoB leaves out of the weights; weight 0 adds no filter, so it is a no-op there.
    adjustmentIds: (args.weightAdjustments ?? []).filter((m) => m.weight !== 0).map((m) => m.tradeId),
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
