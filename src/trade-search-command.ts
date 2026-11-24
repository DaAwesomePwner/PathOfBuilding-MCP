/** generate_trade_search: checks the bridge cannot do and the bridge's `tradeQuery` command. */
import { UserError } from './validation.js';
import { DEFAULT_STAT_WEIGHTS, ELDRITCH, ELDRITCH_SLOTS, JEWEL_SLOT_RE, TRADE_ID_RE, type TradeSearchArgs } from './trade-search-schema.js';

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

/**
 * A special unique search (PoB's "Other trades" rows): options its popup does not offer are refused when they
 * would change the search (influences, socket / link filters, mirrored items, talisman or eldritch weights);
 * the slot, jewelType and flaskType are checked by the bridge.
 */
function checkUniqueOptions(args: TradeSearchArgs, unique: NonNullable<TradeSearchArgs['unique']>): void {
  if (args.slot === undefined && unique !== 'Megalomaniac') {
    throw new UserError(`slot is required for ${unique}: ${unique === 'Pearl of Tsoatha'
      ? 'a ring slot Path of Building shows ("Ring 1")'
      : 'an allocated passive-tree jewel socket that is not a cluster jewel socket ("Jewel <nodeId>", see list_valid_slots)'}`);
  }
  const refuse = (what: string) => {
    throw new UserError(`${what} does not apply to ${unique} searches (Path of Building's unique search does not offer it)`);
  };
  if ((args.influences?.length ?? 0) > 0) refuse('influences');
  if (args.sockets !== undefined) refuse('sockets');
  if (args.links !== undefined) refuse('links');
  if (args.includeMirrored === true) {
    throw new UserError(`includeMirrored true does not apply to ${unique} searches: Path of Building's unique searches always exclude ` +
      'mirrored items (false is accepted and changes nothing)');
  }
  if (args.includeTalisman === true) refuse('includeTalisman true');
  if (args.includeEldritch?.startsWith('keep')) refuse(`includeEldritch "${args.includeEldritch}"`);
}

/** Validates arguments the bridge cannot check and builds the bridge command. */
export function tradeQueryCommand(args: TradeSearchArgs): Record<string, unknown> {
  const league = validateLeague(args.league);
  if (args.unique !== undefined) checkUniqueOptions(args, args.unique);
  else if (args.slot === undefined) throw new UserError('slot is required (except for unique "Megalomaniac"); see list_valid_slots');
  const slot = args.slot ?? '';
  const weights = args.statWeights ?? DEFAULT_STAT_WEIGHTS;
  if (new Set(weights.map((w) => w.stat)).size !== weights.length) throw new UserError('statWeights lists a stat more than once');
  if (new Set(args.influences ?? []).size !== (args.influences ?? []).length) throw new UserError('influences lists an influence twice');
  checkTradeIds((args.requiredMods ?? []).map((m) => m.tradeId), 'requiredMods');
  checkTradeIds((args.weightAdjustments ?? []).map((m) => m.tradeId), 'weightAdjustments');
  const jewelSlot = JEWEL_SLOT_RE.test(slot);
  if (args.sockets !== undefined && /Flask/.test(slot)) throw new UserError('sockets is not available for flask slots');
  if (args.sockets !== undefined && jewelSlot) throw new UserError('sockets is not available for jewel sockets');
  if (args.links !== undefined && (jewelSlot || /Flask|Belt|Ring|Amulet/.test(slot))) throw new UserError(`links is not available for ${slot}`);
  // PoB's popup offers neither scourge mods nor influences for jewel sockets (jewels have neither); its unique
  // searches never weigh scourge mods, so any value changes nothing there.
  if (jewelSlot && args.unique === undefined && args.includeScourge === true) {
    throw new UserError(`includeScourge true does not apply to jewel sockets like ${slot} (false is accepted and changes nothing)`);
  }
  if (jewelSlot && (args.influences?.length ?? 0) > 0) throw new UserError(`influences do not apply to jewel sockets like ${slot}: jewels cannot be influenced`);
  // PoB only offers these options on their slots. Elsewhere a value that changes nothing there is accepted
  // (eldritch weights come only from "keep..."; talisman mods only from includeTalisman true); the rest
  // is refused instead of being dropped silently.
  if (args.includeEldritch?.startsWith('keep') && !ELDRITCH_SLOTS.has(slot)) {
    throw new UserError(`includeEldritch "${args.includeEldritch}" only applies to ${[...ELDRITCH_SLOTS].join(', ')}, not ${slot} ` +
      '(there "copyCurrent" and "remove" are accepted and change nothing)');
  }
  if (args.includeEldritch?.startsWith('keep') && (args.influences?.length ?? 0) > 0) {
    throw new UserError('includeEldritch "keep..." cannot be combined with influences: influenced items have no eldritch implicits, so PoB skips those weights');
  }
  if (args.includeTalisman === true && slot !== 'Amulet') {
    throw new UserError(`includeTalisman true only applies to Amulet, not ${slot} (false is accepted and changes nothing)`);
  }
  const currency = args.maxPrice?.currency ?? 'chaos-equivalent';
  return {
    cmd: 'tradeQuery',
    ...(args.slot !== undefined ? { slot: args.slot } : {}),
    // The bridge checks the slot against it and runs PoB's special search.
    ...(args.unique !== undefined ? { unique: args.unique } : {}),
    // The bridge checks it against the slot (tree socket / abyssal socket / other) and picks the default.
    ...(args.jewelType !== undefined ? { jewelType: args.jewelType } : {}),
    // The bridge checks it against the slot (flask slots only) and the item there.
    ...(args.flaskType !== undefined ? { flaskType: args.flaskType } : {}),
    statWeights: weights,
    tradeIds: [...(args.requiredMods ?? []), ...(args.weightAdjustments ?? [])].map((m) => m.tradeId),
    // The bridge refuses weights on stats PoB leaves out of the weights; weight 0 adds no filter, so it is a no-op there.
    adjustmentIds: (args.weightAdjustments ?? []).filter((m) => m.weight !== 0).map((m) => m.tradeId),
    options: {
      tradeType: args.tradeType ?? 'available',
      includeCorrupted: args.includeCorrupted,
      includeMirrored: args.unique !== undefined ? false : args.includeMirrored ?? true,
      includeScourge: !jewelSlot && (args.includeScourge ?? /^(Standard|Hardcore)$/.test(league)),
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
