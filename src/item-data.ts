/**
 * search_items / get_item_text / list_item_mods / build_item: Path of Building's own item
 * data (its unique list, item bases, affixes with their spawn weights, crafting bench mods)
 * through the bridge's read-only item commands (`itemSearch`, `itemText`, `itemMods`,
 * `itemBuild` in lua/bridge.lua). Item text comes from PoB's Item class (BuildRaw), so it
 * can go straight into swap_item, compare_items, evaluate_changes or apply_changes.
 * Nothing here changes the build: no undo entry, no crash-journal record.
 */
import { z } from 'zod';
import type { BuildSession } from './build-session.js';
import type { ToolRegistrar } from './tool-registry.js';
import { UserError } from './validation.js';

export interface ItemDataCommand {
  cmd: 'itemSearch' | 'itemText' | 'itemMods' | 'itemBuild';
  [key: string]: unknown;
}

export const ROLLS = ['max', 'min', 'avg'] as const;
export type Roll = (typeof ROLLS)[number];
export const INFLUENCES = ['Shaper', 'Elder', 'Crusader', 'Redeemer', 'Hunter', 'Warlord', 'Searing Exarch', 'Eater of Worlds'] as const;
export type Influence = (typeof INFLUENCES)[number];

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;
export const DEFAULT_MODS_LIMIT = 50;
export const MAX_MODS_LIMIT = 200;
export const DEFAULT_ITEM_LEVEL = 86;
export const MAX_ITEM_MODS = 12;
export const MAX_CRAFTED_MODS = 3;
export const MAX_IMPLICITS = 6;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const oneLine = (max: number) =>
  z.string().trim().min(1).max(max).refine((s) => !CONTROL.test(s), { message: 'must be one line with no control characters' });
/** A mod id or mod text; " / " (or a newline) separates the lines of a multi-line mod. */
const modSpec = z.string().trim().min(1).max(300);
const rollSchema = z.enum(ROLLS).optional()
  .describe('Where ranged values roll: "max" (default), "min" or "avg". A mod given with a rolled value ("+110 to maximum Life") keeps that value.');
const influencesSchema = z.array(z.enum(INFLUENCES)).max(2).optional()
  .describe('Influences of the item; they unlock influenced mods (PoB\'s spawn weights use them).');
const itemLevelSchema = z.number().int().min(1).max(100).optional().describe(`Item level (default ${DEFAULT_ITEM_LEVEL}): mods above it cannot roll.`);

export interface SearchItemsArgs {
  query?: string;
  kind?: 'unique' | 'base' | 'any';
  slot?: string;
  modQuery?: string;
  limit?: number;
}

export const searchItemsSchema = {
  query: z.string().trim().max(100).optional()
    .describe('Case-insensitive text in the item name; also matches the base name and item type ("vaal regalia", "kaom", "two handed sword").'),
  kind: z.enum(['unique', 'base', 'any']).optional().describe('Uniques, item bases or both (default "any").'),
  slot: oneLine(60).optional().describe('Only items for this slot ("Body Armour", "Ring 1", "Weapon 1", "Weapon 2") or of this item type ("Bow", "Jewel: Abyss").'),
  modQuery: z.string().trim().max(100).optional().describe('Only items with a mod line (uniques, any variant) or base implicit containing this text, e.g. "maximum power charges".'),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional().describe(`Maximum results (default ${DEFAULT_SEARCH_LIMIT}).`),
};

export interface ItemTextArgs {
  unique?: string;
  variant?: string | number;
  base?: string;
  roll?: Roll;
}

export const itemTextSchema = {
  unique: oneLine(100).optional().describe('Unique name ("Kaom\'s Heart"), or "Name, Base" when several uniques share the name.'),
  variant: z.union([oneLine(100), z.number().int().min(1).max(100)]).optional()
    .describe('Unique variant by name (or a unique part of it, e.g. "Current") or 1-based index; default: PoB\'s default (usually the current version).'),
  base: oneLine(100).optional().describe('Item base name for a plain normal item ("Vaal Regalia").'),
  roll: rollSchema,
};

export interface ListItemModsArgs {
  base: string;
  affix?: 'prefix' | 'suffix' | 'any';
  query?: string;
  itemLevel?: number;
  influences?: Influence[];
  includeCrafted?: boolean;
  limit?: number;
}

export const listItemModsSchema = {
  base: oneLine(100).describe('Item base name, e.g. "Vaal Regalia" (search_items with kind "base" finds them).'),
  affix: z.enum(['prefix', 'suffix', 'any']).optional().describe('Prefixes, suffixes or both (default "any").'),
  query: z.string().trim().max(100).optional().describe('Only mods whose text, id or affix name contains this, e.g. "maximum life".'),
  itemLevel: itemLevelSchema,
  influences: influencesSchema,
  includeCrafted: z.boolean().optional().describe('Also list crafting bench mods for this item class. PoB\'s bench data has no ids: a bench mod is named by its `text` (with ranges), which build_item `crafted` takes.'),
  limit: z.number().int().min(1).max(MAX_MODS_LIMIT).optional().describe(`Maximum mods listed (default ${DEFAULT_MODS_LIMIT}; the same cap applies to bench mods).`),
};

export interface BuildItemArgs {
  base: string;
  rarity?: 'normal' | 'magic' | 'rare';
  name?: string;
  itemLevel?: number;
  quality?: number;
  mods?: string[];
  crafted?: string[];
  implicits?: string[];
  influences?: Influence[];
  corrupted?: boolean;
  roll?: Roll;
}

export const buildItemSchema = {
  base: oneLine(100).describe('Item base name, e.g. "Vaal Regalia".'),
  rarity: z.enum(['normal', 'magic', 'rare']).optional()
    .describe('Default "rare" ("magic" for flasks, tinctures and charms, which cannot be rare). Magic: 1 prefix + 1 suffix; rare: 3 + 3 (jewels 2 + 2).'),
  name: oneLine(60).optional().describe('Rare item name (default "New Item").'),
  itemLevel: itemLevelSchema,
  quality: z.number().int().min(0).max(30).optional().describe('Quality (default PoB\'s 20 for armour and weapons).'),
  mods: z.array(modSpec).max(MAX_ITEM_MODS).optional()
    .describe('Prefixes and suffixes: mod ids from list_item_mods ("IncreasedLife7"), their text ("+(100-114) to maximum Life", takes `roll`) or a rolled line ("+110 to maximum Life": the tier whose range holds the value, at that value).'),
  crafted: z.array(modSpec).max(MAX_CRAFTED_MODS).optional()
    .describe('Crafting bench mods by their text from list_item_mods with includeCrafted ("+(16-20)% to Lightning Resistance", takes `roll`) or a rolled line ("+20% to Lightning Resistance"). They count as prefixes or suffixes.'),
  implicits: z.array(oneLine(200)).max(MAX_IMPLICITS).optional()
    .describe('Replace the base implicits with these modifier lines (e.g. eldritch or corruption implicits); not validated against the base. Lines PoB reads as item headers or flags ("Corrupted", "Shaper Item", "Quality: 30", ...) are refused: use corrupted / influences / quality.'),
  influences: influencesSchema,
  corrupted: z.boolean().optional().describe('Mark the item corrupted.'),
  roll: rollSchema,
};

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

export async function searchItems(session: BuildSession, args: SearchItemsArgs): Promise<unknown> {
  if (!hasText(args.query) && !hasText(args.slot) && !hasText(args.modQuery)) {
    throw new UserError('Give a query, a slot or a modQuery');
  }
  return session.readItemData({
    cmd: 'itemSearch',
    query: args.query?.trim() ?? '',
    kind: args.kind ?? 'any',
    slot: hasText(args.slot) ? args.slot.trim() : undefined,
    modQuery: hasText(args.modQuery) ? args.modQuery.trim() : undefined,
    limit: args.limit ?? DEFAULT_SEARCH_LIMIT,
  });
}

export async function getItemText(session: BuildSession, args: ItemTextArgs): Promise<unknown> {
  if (hasText(args.unique) === hasText(args.base)) throw new UserError('Give either unique or base (one of them)');
  if (args.variant !== undefined && !hasText(args.unique)) throw new UserError('variant is only for uniques');
  return session.readItemData({ cmd: 'itemText', unique: args.unique, variant: args.variant, base: args.base, roll: args.roll });
}

export async function listItemMods(session: BuildSession, args: ListItemModsArgs): Promise<unknown> {
  return session.readItemData({
    cmd: 'itemMods',
    base: args.base,
    affix: args.affix ?? 'any',
    query: hasText(args.query) ? args.query.trim() : undefined,
    itemLevel: args.itemLevel ?? DEFAULT_ITEM_LEVEL,
    influences: args.influences ?? [],
    includeCrafted: args.includeCrafted === true,
    limit: args.limit ?? DEFAULT_MODS_LIMIT,
  });
}

function checkUnique(list: string[] | undefined, what: string): void {
  if (!list) return;
  const seen = new Set<string>();
  for (const entry of list) {
    const key = entry.trim().toLowerCase();
    if (seen.has(key)) throw new UserError(`${what} lists "${entry.trim()}" twice`);
    seen.add(key);
  }
}

export async function buildItem(session: BuildSession, args: BuildItemArgs): Promise<unknown> {
  checkUnique(args.mods, 'mods');
  checkUnique(args.crafted, 'crafted');
  checkUnique(args.influences, 'influences');
  return session.readItemData({
    cmd: 'itemBuild',
    base: args.base,
    rarity: args.rarity,
    name: args.name,
    itemLevel: args.itemLevel ?? DEFAULT_ITEM_LEVEL,
    quality: args.quality,
    mods: args.mods ?? [],
    crafted: args.crafted ?? [],
    implicits: args.implicits,
    influences: args.influences ?? [],
    corrupted: args.corrupted === true,
    roll: args.roll,
  });
}

const TEXT_USE = 'The returned `text` is Path of Building\'s own item text: pass it to swap_item, compare_items, evaluate_changes (items) or apply_changes as-is.';

export function registerItemDataTools(tools: ToolRegistrar): void {
  tools.engine<SearchItemsArgs>(
    'search_items',
    {
      description:
        'Search Path of Building\'s unique items and item bases by name, base or item type (case-insensitive), optionally only those for a slot ' +
        'or with a mod text. Each result: kind (unique/base), name, base, type, slot, levelReq, variant names (uniques), implicits and the first mod lines ' +
        '(with ranges; `modsMore` counts the rest). Exact names rank first. Use get_item_text for the full item text. Read-only.',
      inputSchema: searchItemsSchema,
    },
    (args, session) => searchItems(session, args),
  );

  tools.engine<ItemTextArgs>(
    'get_item_text',
    {
      description:
        'Full item text for a unique (a chosen variant; ranged mods at `roll`, default "max") or for a plain normal item base, built by Path of Building ' +
        '(PoB\'s quality default, 20 for armour and weapons, as when adding the item from its item list). Also returns the rolled implicit and mod lines, ' +
        `the variant names and levelReq. ${TEXT_USE} Read-only.`,
      inputSchema: itemTextSchema,
    },
    (args, session) => getItemText(session, args),
  );

  tools.engine<ListItemModsArgs>(
    'list_item_mods',
    {
      description:
        'Prefixes and suffixes that can roll on an item base per Path of Building\'s spawn weights (the same filter as its crafting dropdowns; delve mods ' +
        'left out), at an item level (default 86) and with influences: id, type, tier (1 = best of `tiers` in its family, item level ignored), level, group ' +
        '(one mod per group on an item), weight, affix name and text with ranges; prefixLimit / suffixLimit for a rare item. `includeCrafted` adds ' +
        'crafting bench mods. Not covered: essences, eldritch implicits, fossils/harvest/veiled mods. Use the ids or texts in build_item. Read-only.',
      inputSchema: listItemModsSchema,
    },
    (args, session) => listItemMods(session, args),
  );

  tools.engine<BuildItemArgs>(
    'build_item',
    {
      description:
        'Build a normal, magic or rare item on a base with Path of Building\'s crafting (Item:Craft / BuildRaw), checking that every mod can roll on the ' +
        'base at the item level with its influences (or is a bench craft for the item class), the prefix/suffix limits of the rarity (crafted mods count) ' +
        'and one mod per mod group (each mod checked with the tags the other chosen mods add, as PoB\'s crafting dropdowns do); anything else is refused, ' +
        'and PoB\'s parse of the result must match the request (name, implicits, mods, influences, corruption, item level, quality). Returns `text`, the rolled lines, each affix with its tier, and warnings (e.g. a line PoB ' +
        `does not model). ${TEXT_USE} Read-only: the build is unchanged until you equip the item.`,
      inputSchema: buildItemSchema,
    },
    (args, session) => buildItem(session, args),
  );
}
