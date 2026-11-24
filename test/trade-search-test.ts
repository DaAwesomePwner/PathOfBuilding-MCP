/**
 * generate_trade_search / search_trade_mods: URL shape, weighted query, weight
 * adjustments surviving the filter cap, required mods, min override, input
 * errors, the bridge's copy of PoB's pseudoMap / ignoredStats still matching
 * the installed TradeQueryGenerator.lua, the build left unchanged, then jewel
 * sockets (tree sockets by jewelType, abyssal sockets the item has) and refusals,
 * flask slots, weapon swap slots, the special uniques (Watcher's Eye, Pearl of
 * Tsoatha, Megalomaniac), the faults around a flask slot's activation, and
 * grafts and tinctures (weighed from PoB's own mod lists, filtered by base type).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BuildSession } from '../src/build-session.js';
import { EngineCommandError, LuaBridge } from '../src/lua-bridge.js';
import { tradeQueryCommand } from '../src/trade-search-command.js';
import { buildTradeSearch } from '../src/trade-search-response.js';
import { setupTestEnv, type TestEnv } from './_skip.js';

type TestPaths = TestEnv['paths'];

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'src', 'server.ts');
const bridgePath = path.resolve(testDir, '..', 'lua', 'bridge.lua');
const LEAGUE = 'Settlers of Kalguur';
const SEARCH_PREFIX = 'https://www.pathofexile.com/trade/search/Settlers%20of%20Kalguur?q=';
const STANDARD_PREFIX = 'https://www.pathofexile.com/trade/search/Standard?q=';
const STYGIAN_VISE = `Rarity: RARE
Test Vise
Stygian Vise
Item Level: 80
Implicits: 1
Has 1 Abyssal Socket
+80 to maximum Life`;
const ABYSS_EYE = `Rarity: RARE
Test Eye
Murderous Eye Jewel
Item Level: 80
Implicits: 0
+40 to maximum Life
+10% to Fire Resistance`;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface ToolResp { content?: Array<{ type: string; text: string }>; isError?: boolean }
interface Filter { tradeId: string; text: string; weight: number; source: string; mappedFrom?: string }
interface Search {
  url: string; filters: Filter[]; minWeightedSum: number; pobDefaultMinWeightedSum: number; itemCategory: string;
  droppedByCap: { count: number }; statWeights: { stat: string; weight: number }[]; calcSeconds: number;
  filterBudget: number; capLifted: boolean; currentItem: string | null;
}
interface Query {
  query: {
    stats: { type: string; value?: { min?: number }; filters: { id: string; value?: { weight?: number; min?: number } }[] }[];
    status: { option: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filters: Record<string, any>;
  };
  sort: Record<string, string>;
}
const FIRE_RES_EXPLICIT = 'explicit.stat_3372524247';
const FIRE_RES_PSEUDO = 'pseudo.pseudo_total_fire_resistance';
const ALL_ELE_RES = 'explicit.stat_2901986750';
const ALL_ATTRIBUTES = 'explicit.stat_1379411836';
interface TradeMod {
  tradeId: string; text: string; type: string; preferred?: boolean; preferredTradeId?: string; weightable?: boolean; preferredTradeIds?: string[];
}

/** The `local <name> = { ... }` table literal that starts after `from` in Lua source (braces balanced, none in strings). */
function luaTable(source: string, name: string, from = 0): string {
  const start = source.indexOf(`local ${name} = {`, from);
  assert(start >= 0, `local ${name} table not found`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`local ${name} table is not closed`);
}
/** `["<digits>"] = "<string>"` entries of a Lua table literal, sorted by key. */
function luaStringEntries(table: string): [string, string][] {
  return [...table.matchAll(/\["(\d+)"\]\s*=\s*"([^"]*)"/g)].map((m): [string, string] => [m[1], m[2]]).sort();
}
/** `["<digits>"] =` keys of a Lua table literal, sorted. */
function luaKeys(table: string): string[] {
  return [...table.matchAll(/\["(\d+)"\]\s*=/g)].map((m) => m[1]).sort();
}
/** FinishQuery's element lists for PoB's hybrid resistance / attribute hashes; the bridge repeats them. */
const IGNORED_ELEMENT_LINES = [
  'local resElements = { "fire", "cold", "lightning", "chaos" }',
  'local attributeElements = { "dexterity", "strength", "intelligence" }',
];
/** FinishQuery's hybrid stat names, each hashed straight into ignoredStats; the bridge repeats them. */
const IGNORED_FORMAT_CALLS = [
  'string.format("%s_and_%s_damage_resistance_%%", elem1, elem2)',
  'string.format("base_%s_and_%s", elem1, elem2)',
  'string.format("additional_%s_and_%s", elem1, elem2)',
];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The source of a Lua function, from its `function`/`local function` line to the next top-level one. */
function luaFunctionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert(start >= 0, `${header} not found`);
  const next = source.slice(start + header.length).search(/\r?\n(local )?function /);
  return next < 0 ? source.slice(start) : source.slice(start, start + header.length + next);
}
/** Read-only: the installed PoB's TradeQueryGenerator.lua (installed layout or source clone). */
function pobGeneratorSource(pobPath: string): string {
  const file = [path.join(pobPath, 'Classes', 'TradeQueryGenerator.lua'), path.join(pobPath, 'src', 'Classes', 'TradeQueryGenerator.lua')]
    .find((f) => existsSync(f));
  assert(file, `TradeQueryGenerator.lua not found under ${pobPath}`);
  return readFileSync(file, 'utf8');
}

let client: Client;
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResp> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as ToolResp;
}
const text = (r: ToolResp) => r.content?.[0]?.text ?? '';
async function ok<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await call(name, args);
  assert(!r.isError, `${name} failed: ${text(r)}`);
  return JSON.parse(text(r)) as T;
}
async function userError(name: string, args: Record<string, unknown>, expect: RegExp): Promise<void> {
  const r = await call(name, args);
  assert(r.isError, `${name} ${JSON.stringify(args).slice(0, 120)} should fail`);
  assert(!text(r).startsWith('Internal error'), `expected a user error, got: ${text(r)}`);
  assert(expect.test(text(r)), `error text ${JSON.stringify(text(r))} should match ${expect}`);
}
function decodeQuery(url: string, prefix = SEARCH_PREFIX): Query {
  assert(url.startsWith(prefix), `url should start with ${prefix}: ${url.slice(0, 120)}`);
  const q = JSON.parse(decodeURIComponent(url.slice(prefix.length))) as Query;
  assert(q.query.stats[0]?.type === 'weight', 'first stat group should be the weight group');
  assert(q.query.stats.slice(1).every((g) => g.filters.length > 0), `no empty stat groups: ${JSON.stringify(q.query.stats.map((g) => g.type))}`);
  assert(q.query.stats.filter((g) => g.type === 'and').length <= 1, 'at most one "and" group');
  return q;
}
const search = (args: Record<string, unknown>) => ok<Search>('generate_trade_search', { slot: 'Helmet', league: LEAGUE, ...args });
/** In Standard, where gear searches include scourge mods by default (jewel searches never do). */
const jewelSearch = (args: Record<string, unknown>) => ok<Search>('generate_trade_search', { league: 'Standard', ...args });

async function keyState(): Promise<string> {
  const stats = await ok<Record<string, Record<string, number>>>('get_stats');
  const exported = await call('export_build', { format: 'xml' });
  assert(!exported.isError, `export_build failed: ${text(exported)}`);
  const xml = text(exported);
  return JSON.stringify([stats.defense?.Life, stats.offense?.CombinedDPS, stats.defense?.TotalEHP, xml]);
}

interface FlaskSearch extends Search { flaskType?: string; testBase?: string; evaluatedActive?: boolean; activeNote?: string }
type SlotRow = { slot: string; active?: boolean };

/**
 * Flask slots (OccVortex: Flask 1 Eternal Life, Flask 2 Granite, Flask 3
 * Silver, Flask 4 Quicksilver, Flask 5 Divine Mana): every kind is weighed
 * from PoB's flask mod list in the "flask" category; flaskType picks the flask
 * the mods are tried on; an inactive slot is evaluated active (build, slot
 * state and export unchanged); a tincture search without a tincture in the
 * slot and misplaced flaskType are refused.
 */
async function test12Flasks(category: (s: Search) => string, weighted: (s: Search) => number): Promise<void> {
  log('Test 12: flask slots (kinds, flaskType, inactive slot, tinctures)');
  const flaskSearch = (args: Record<string, unknown>) => ok<FlaskSearch>('generate_trade_search', { league: 'Standard', ...args });
  for (const [slot, kind] of [['Flask 1', 'life'], ['Flask 5', 'mana'], ['Flask 4', 'utility']] as const) {
    const s = await flaskSearch({ slot });
    assert(s.flaskType === kind && s.itemCategory === 'Flask' && category(s) === 'flask' && s.testBase === undefined,
      `${slot}: ${kind} flask in the flask category: ${JSON.stringify({ ...s, url: undefined, filters: undefined })}`);
    assert(s.evaluatedActive === undefined && weighted(s) > 0, `${slot}: active slot, weighted mods (${weighted(s)})`);
    assert((await flaskSearch({ slot, flaskType: kind })).url === s.url, `${slot}: flaskType ${kind} is the default`);
  }
  // Another kind than the equipped one: the mods are tried on a blank flask of that kind.
  const asUtility = await flaskSearch({ slot: 'Flask 1', flaskType: 'utility' });
  assert(asUtility.flaskType === 'utility' && asUtility.testBase === 'Quicksilver Flask' && asUtility.currentItem !== null
    && asUtility.minWeightedSum === 0 && category(asUtility) === 'flask', `flaskType utility on a life flask: ${JSON.stringify({ ...asUtility, url: undefined, filters: undefined })}`);
  const mods = await ok<{ itemCategory: string; mods: TradeMod[] }>('search_trade_mods', { slot: 'Flask 1', query: 'during effect', flaskType: 'mana' });
  assert(mods.itemCategory === 'Flask' && mods.mods.length > 0, 'search_trade_mods with flaskType');

  // An inactive slot: PoB weighs every mod at 0 there, so it is evaluated active; nothing changes.
  const on = await flaskSearch({ slot: 'Flask 2' });
  const off = await call('set_flask_active', { slot: 'Flask 2', active: false });
  assert(!off.isError, `set_flask_active: ${text(off)}`);
  const inactiveState = await keyState();
  const inactive = await flaskSearch({ slot: 'Flask 2' });
  assert(inactive.evaluatedActive === true && /inactive/.test(inactive.activeNote ?? '') && weighted(inactive) > 0,
    `inactive flask slot evaluated active: ${JSON.stringify({ ...inactive, url: undefined })}`);
  assert(JSON.stringify(inactive.filters) === JSON.stringify(on.filters), 'an inactive slot gets the weights of the active slot');
  assert((await keyState()) === inactiveState, 'the inactive flask search changed the build or its export');
  const rows = await ok<{ slots: SlotRow[] }>('list_valid_slots');
  assert(rows.slots.find((r) => r.slot === 'Flask 2')?.active === false, 'Flask 2 is still inactive');
  assert(!(await call('set_flask_active', { slot: 'Flask 2', active: true })).isError, 'Flask 2 back on');

  // An empty slot needs flaskType (search_trade_mods does not: every kind has the same mods).
  assert(!(await call('unequip_item', { slot: 'Flask 4' })).isError, 'unequip Flask 4');
  await userError('generate_trade_search', { slot: 'Flask 4', league: 'Standard' }, /the slot is empty, so pass flaskType/);
  const emptyLife = await flaskSearch({ slot: 'Flask 4', flaskType: 'life' });
  assert(emptyLife.testBase === 'Divine Life Flask' && emptyLife.currentItem === null && weighted(emptyLife) > 0, `empty slot, flaskType life: ${emptyLife.testBase}`);
  const hybrid = await flaskSearch({ slot: 'Flask 4', flaskType: 'hybrid' });
  assert(hybrid.flaskType === 'hybrid' && /Hybrid Flask$/.test(hybrid.testBase ?? ''), `hybrid stand-in: ${hybrid.testBase}`);
  assert((await ok<{ mods: TradeMod[] }>('search_trade_mods', { slot: 'Flask 4', query: 'duration' })).mods.length > 0, 'mods for an empty flask slot');

  // A tincture search weighs the tincture in the slot (test 19): one asked for over a flask or an empty slot is refused.
  await userError('generate_trade_search', { slot: 'Flask 1', league: 'Standard', flaskType: 'tincture' },
    /tincture trade search for Flask 1: the slot holds a flask, not a tincture.*no tincture category.*equip the tincture/);
  await userError('generate_trade_search', { slot: 'Flask 4', league: 'Standard', flaskType: 'tincture' }, /Flask 4: the slot is empty\..*equip the tincture/);
  const tinctureMods = await ok<{ itemCategory: string; total: number }>('search_trade_mods', { slot: 'Flask 4', query: 'melee', flaskType: 'tincture' });
  assert(tinctureMods.itemCategory === 'Tincture' && tinctureMods.total > 0, `every tincture mod for an empty slot: ${JSON.stringify(tinctureMods).slice(0, 200)}`);
  const tincture = await ok<{ text: string }>('get_item_text', { base: 'Oakbranch Tincture' });
  assert(!(await call('swap_item', { slot: 'Flask 4', itemText: tincture.text })).isError, 'tincture into Flask 4');
  const oakMods = await ok<{ itemCategory: string; mods: TradeMod[] }>('search_trade_mods', { slot: 'Flask 4', query: 'melee weapon' });
  assert(oakMods.itemCategory === 'Tincture' && oakMods.mods.length > 0, 'the tincture\'s mods by default');
  assert((await flaskSearch({ slot: 'Flask 4', flaskType: 'utility' })).testBase === 'Quicksilver Flask', 'a flask search over a tincture with flaskType');
  // flaskType is for flask slots only.
  await userError('generate_trade_search', { slot: 'Helmet', league: 'Standard', flaskType: 'life' }, /flaskType only applies to flask slots/);
  await userError('search_trade_mods', { slot: 'Ring 1', query: 'life', flaskType: 'mana' }, /flaskType only applies to flask slots/);
  await userError('generate_trade_search', { slot: 'Flask 1', league: 'Standard', jewelType: 'base' }, /jewelType only applies to jewel sockets/);
  log('PASS');
}

interface CustomSearch extends Search { baseType?: string; baseTypeNote?: string; flaskType?: string; evaluatedActive?: boolean }
const GRAFT = 'Rarity: NORMAL\nBattering Uulgraft\nItem Level: 80\nImplicits: 1\n8% reduced Enemy Stun Threshold';

/**
 * Grafts (3.27 trees): no trade category in PoB's data, so the graft mods that
 * can roll on the equipped graft's base go through PoB's own ProcessMod and
 * the search filters by that base type; refusals (empty slot, hidden slot,
 * sockets / links / influences); search_trade_mods lists graft mods; the
 * build and its export are unchanged.
 */
async function test18Grafts(xml: string): Promise<void> {
  log('Test 18: graft slots (3.27 tree)');
  await userError('generate_trade_search', { slot: 'Graft 1', league: 'Standard' }, /Graft slots only on 3\.27 passive trees.*no tree conversion/);
  await ok('load_build', { source: xml.replace(/treeVersion="3_13"/g, 'treeVersion="3_27"') });
  await userError('generate_trade_search', { slot: 'Graft 1', league: 'Standard' }, /Graft 1: the slot is empty.*equip the graft/);
  const allGraftMods = await ok<{ itemCategory: string; total: number }>('search_trade_mods', { slot: 'Graft 1', query: 'damage' });
  assert(!(await call('swap_item', { slot: 'Graft 1', itemText: GRAFT })).isError, 'graft into Graft 1');
  const before = await keyState();
  const graft = await ok<CustomSearch>('generate_trade_search', { slot: 'Graft 1', league: 'Standard' });
  const q = decodeQuery(graft.url, STANDARD_PREFIX);
  const query = q.query as unknown as { type?: string; filters: { type_filters: { filters: Record<string, { option: string }> } } };
  assert(graft.itemCategory === 'Graft' && graft.baseType === 'Battering Uulgraft' && query.type === 'Battering Uulgraft'
    && query.filters.type_filters.filters.category === undefined && query.filters.type_filters.filters.rarity.option === 'nonunique'
    && /no graft category/.test(graft.baseTypeNote ?? ''), `graft search filtered by base type: ${JSON.stringify({ ...graft, url: undefined })}`);
  assert(graft.filters.length > 0 && graft.filters.every((f) => f.weight > 0), `weighted graft mods: ${JSON.stringify(graft.filters)}`);
  // Uul-Netol's mods only: the base's spawn tags decide (no Xoph fire mods on an Uulgraft).
  const mods = await ok<{ itemCategory: string; total: number; mods: TradeMod[] }>('search_trade_mods', { slot: 'Graft 1', query: 'damage', limit: 100 });
  assert(mods.itemCategory === 'Graft' && mods.total > 0 && mods.total < allGraftMods.total && !mods.mods.some((m) => m.type === 'Explicit' && /Fire Damage/.test(m.text)),
    `graft mods of the base (${mods.total}) vs every graft mod (${allGraftMods.total}): ${mods.mods.map((m) => `${m.type}: ${m.text}`).join(' | ')}`);
  const life = await ok<CustomSearch>('generate_trade_search', { slot: 'Graft 1', league: 'Standard', statWeights: [{ stat: 'Life', weight: 1 }] });
  assert(life.filters.some((f) => /maximum Life/.test(f.text)), `Life weights a life graft mod: ${JSON.stringify(life.filters)}`);
  for (const [opt, value] of [['sockets', 2], ['links', 2], ['influences', ['shaper']]] as const) {
    await userError('generate_trade_search', { slot: 'Graft 1', league: 'Standard', [opt]: value }, /not apply to graft slots like Graft 1/);
  }
  assert((await keyState()) === before, 'graft searches changed the build');
  log('PASS');
}

/**
 * Tinctures: PoB's tincture mods on a melee build (blank Duelist with a foil and
 * a Rosethorn Tincture in an inactive slot, evaluated active), filtered by the
 * tincture's base type; suggest_upgrades gets suggestedMods for it.
 */
async function test19Tinctures(): Promise<void> {
  log('Test 19: tinctures on a melee build');
  await ok('new_build', { className: 'Duelist', level: 90 });
  const foil = await ok<{ text: string }>('get_item_text', { base: 'Jewelled Foil' });
  const rosethorn = await ok<{ text: string }>('get_item_text', { base: 'Rosethorn Tincture' });
  assert(!(await call('swap_item', { slot: 'Weapon 1', itemText: foil.text })).isError, 'foil');
  assert(!(await call('swap_item', { slot: 'Flask 1', itemText: rosethorn.text })).isError, 'tincture into Flask 1');
  const before = await keyState();
  const t = await ok<CustomSearch>('generate_trade_search', { slot: 'Flask 1', league: 'Standard' });
  const query = decodeQuery(t.url, STANDARD_PREFIX).query as unknown as { type?: string; filters: { type_filters: { filters: Record<string, unknown> } } };
  assert(t.itemCategory === 'Tincture' && t.flaskType === 'tincture' && t.baseType === 'Rosethorn Tincture' && query.type === 'Rosethorn Tincture'
    && query.filters.type_filters.filters.category === undefined && t.evaluatedActive === true,
  `tincture search: ${JSON.stringify({ ...t, url: undefined })}`);
  assert(t.filters.some((f) => /Melee Weapon Attack Speed/.test(f.text)) && t.filters.every((f) => f.weight > 0), `tincture mods weighed: ${JSON.stringify(t.filters)}`);
  assert((await ok<CustomSearch>('generate_trade_search', { slot: 'Flask 1', league: 'Standard', flaskType: 'tincture' })).url === t.url, 'flaskType tincture is the default');
  const up = await ok<{ suggestions: { slot: string; suggestedMods?: { mod: string }[]; modsError?: string }[] }>('suggest_upgrades', { slot: 'Flask 1' });
  const row = up.suggestions.find((s) => s.slot === 'Flask 1');
  assert(row && row.modsError === undefined && (row.suggestedMods?.length ?? 0) > 0, `suggest_upgrades tincture row: ${JSON.stringify(row)}`);
  assert((await keyState()) === before, 'tincture searches changed the build');
  log('PASS');
}

/** A weapon slot of the set the build does not use is refused (PoB weighs every mod at 0); compare_items notes it. */
async function test13WeaponSwap(): Promise<void> {
  log('Test 13: weapon swap slots of the set not in use');
  const before = await keyState();
  await userError('generate_trade_search', { slot: 'Weapon 1 Swap', league: 'Standard' }, /weapon set 2, which the build does not use.*weighs every mod at 0/);
  await userError('generate_trade_search', { slot: 'Weapon 2 Swap Abyssal Socket 1', league: 'Standard' }, /weapon set 2, which the build does not use/);
  // Listing mods does not depend on weights.
  assert((await ok<{ mods: TradeMod[] }>('search_trade_mods', { slot: 'Weapon 1 Swap', query: 'life' })).mods.length > 0, 'search_trade_mods on a swap slot');
  const wand = 'Rarity: RARE\nSwap Wand\nImbued Wand\nItem Level: 80\n+30 to maximum Life';
  const cmp = await ok<{ note?: string; candidates: { error: string | null }[] }>('compare_items', { slot: 'Weapon 1 Swap', items: [wand, wand] });
  assert(/weapon set 2, which the build does not use/.test(cmp.note ?? '') && cmp.candidates.every((c) => c.error === null),
    `compare_items into an unused swap slot: ${JSON.stringify(cmp).slice(0, 300)}`);
  const inUse = await ok<{ note?: string }>('compare_items', { slot: 'Weapon 1', items: [wand, wand] });
  assert(inUse.note === undefined, 'no note for the weapon set in use');
  assert((await keyState()) === before, 'refusals and compare_items changed the build');
  log('PASS');
}

interface UniqueSearch extends Search { unique?: string; slot: string | null; filters: (Filter & { notable?: string })[] }
const PEARL_PREFIX = 'explicit.stat_4089743927|';
/** Voices: a Large Cluster Jewel (for the "holds a cluster jewel" refusal). */
const VOICES = `Rarity: UNIQUE
Voices
Large Cluster Jewel
Variant: Adds 1 Small Passive Skill
Variant: Adds 3 Small Passive Skills
Variant: Adds 5 Small Passive Skills
Variant: Adds 7 Small Passive Skills
Selected Variant: 1
Implicits: 0
Adds 3 Jewel Socket Passive Skills
{variant:1}Adds 1 Small Passive Skill which grants nothing
{variant:2}Adds 3 Small Passive Skills which grant nothing
{variant:3}Adds 5 Small Passive Skills which grant nothing
{variant:4}Adds 7 Small Passive Skills which grant nothing`;

/**
 * Special uniques (PoB's "Other trades" rows): Watcher's Eye in an allocated
 * socket (aura mods, unique name filter, no mirrored items), Pearl of Tsoatha
 * in a shown ring slot (one filter per support gem and skill-group slot), the
 * slot and option refusals, the mod pools of search_trade_mods, Megalomaniac
 * refused on the fixture's 3.13 tree (PoB's search fails on notables it lacks);
 * the build and its export unchanged.
 */
async function test15Uniques(): Promise<void> {
  log('Test 15: special uniques (Watcher\'s Eye, Pearl of Tsoatha, Megalomaniac refusals)');
  const before = await keyState();
  const uniqueSearch = (args: Record<string, unknown>) => ok<UniqueSearch>('generate_trade_search', { league: 'Standard', ...args });
  const WE = "Watcher's Eye";
  const we = await uniqueSearch({ unique: WE, slot: 'Jewel 36634' });
  const weQuery = decodeQuery(we.url, STANDARD_PREFIX) as Query & { query: { name?: string; type?: string } };
  assert(weQuery.query.name === WE && we.unique === WE && we.slot === 'Jewel 36634' && we.itemCategory === 'AnyJewel', `unique name filter: ${weQuery.query.name}`);
  assert(weQuery.query.filters.type_filters.filters.category.option === 'jewel' && weQuery.query.filters.type_filters.filters.rarity.option === 'unique',
    `jewel category, unique rarity: ${JSON.stringify(weQuery.query.filters.type_filters)}`);
  assert(weQuery.query.filters.misc_filters?.filters?.mirrored === false && we.filterBudget === 33, 'unique searches exclude mirrored items (one filter less)');
  const auraMods = we.filters.filter((f) => /while affected by/.test(f.text) && f.weight > 0);
  assert(auraMods.length > 0, `Watcher's Eye aura mods weighed: ${JSON.stringify(we.filters.map((f) => f.text))}`);
  // Corrupted jewel implicits are weighed unless includeCorrupted is false (as PoB's popup).
  const noCorrupt = await uniqueSearch({ unique: WE, slot: 'Jewel 36634', includeCorrupted: false });
  assert(we.filters.some((f) => f.tradeId.startsWith('implicit.')) && noCorrupt.filters.every((f) => !f.tradeId.startsWith('implicit.')),
    'includeCorrupted false leaves out the corrupted implicits');
  // Options that change nothing are accepted.
  for (const extra of [{ includeMirrored: false }, { jewelType: 'any' }, { includeScourge: true }, { includeEldritch: 'remove' }, { includeTalisman: false }]) {
    assert((await uniqueSearch({ unique: WE, slot: 'Jewel 36634', ...extra })).url === we.url, `${JSON.stringify(extra)} changes nothing`);
  }
  // Ids from the Watcher's Eye pool work as required mods.
  const pool = await ok<{ unique: string; itemCategory: string; mods: TradeMod[] }>('search_trade_mods', { unique: WE, query: 'while affected by Clarity' });
  assert(pool.unique === WE && pool.itemCategory === 'AnyJewel' && pool.mods.length >= 3 && pool.mods.every((m) => /Clarity/.test(m.text)),
    `Watcher's Eye pool: ${JSON.stringify(pool.mods.map((m) => m.text))}`);
  const required = await uniqueSearch({ unique: WE, slot: 'Jewel 36634', requiredMods: [{ tradeId: pool.mods[0].tradeId }] });
  assert(decodeQuery(required.url, STANDARD_PREFIX).query.stats.some((g) => g.type === 'and' && g.filters.some((f) => f.id === pool.mods[0].tradeId)),
    'a Watcher\'s Eye mod as a required mod');

  // Slot refusals.
  await userError('generate_trade_search', { league: 'Standard', unique: WE }, /slot is required for Watcher's Eye/);
  await userError('generate_trade_search', { league: 'Standard', unique: WE, slot: 'Jewel 61834' }, /Jewel 61834 is not allocated.*Allocate node 61834 first/);
  await userError('generate_trade_search', { league: 'Standard', unique: WE, slot: 'Helmet' }, /need slot = an allocated passive-tree jewel socket not holding a cluster jewel/);
  await userError('generate_trade_search', { league: 'Standard', unique: WE, slot: 'Belt Abyssal Socket 1' }, /need slot = an allocated passive-tree jewel socket/);
  // Option refusals.
  for (const [extra, expect] of [
    [{ influences: ['shaper'] }, /influences does not apply to Watcher's Eye searches/],
    [{ sockets: 1 }, /sockets does not apply to Watcher's Eye searches/],
    [{ links: 2 }, /links does not apply/],
    [{ includeMirrored: true }, /always exclude mirrored items/],
    [{ includeTalisman: true }, /includeTalisman true does not apply/],
    [{ includeEldritch: 'keepRegular' }, /includeEldritch "keepRegular" does not apply/],
    [{ jewelType: 'base' }, /jewelType does not apply to Watcher's Eye searches.*"any" is accepted/],
    [{ flaskType: 'life' }, /flaskType does not apply to Watcher's Eye searches/],
  ] as [Record<string, unknown>, RegExp][]) {
    await userError('generate_trade_search', { league: 'Standard', unique: WE, slot: 'Jewel 36634', ...extra }, expect);
  }

  // Pearl of Tsoatha: a ring slot PoB shows, tried on a Prismatic Ring.
  const pearl = await uniqueSearch({ unique: 'Pearl of Tsoatha', slot: 'Ring 1' });
  const pearlQuery = decodeQuery(pearl.url, STANDARD_PREFIX) as Query & { query: { name?: string } };
  assert(pearlQuery.query.name === 'Pearl of Tsoatha' && pearl.itemCategory === 'Ring' && pearl.currentItem !== null, `Pearl name filter: ${pearlQuery.query.name}`);
  assert(pearl.filters.length > 0 && pearl.filters.every((f) => f.tradeId.startsWith(PEARL_PREFIX) && f.weight > 0 && /Supported by/.test(f.text)),
    `Pearl support filters: ${JSON.stringify(pearl.filters.slice(0, 3))}`);
  // Its filter ids (two "|" suffixes) go back in weightAdjustments (replace, drop with 0) and requiredMods.
  assert(pearl.filters.length >= 2, `two Pearl filters to adjust: ${pearl.filters.length}`);
  const [firstPearl, secondPearl] = pearl.filters;
  const adjusted = await uniqueSearch({
    unique: 'Pearl of Tsoatha', slot: 'Ring 1',
    weightAdjustments: [{ tradeId: firstPearl.tradeId, weight: 0 }, { tradeId: secondPearl.tradeId, weight: 7 }],
  });
  assert(!adjusted.filters.some((f) => f.tradeId === firstPearl.tradeId), `weight 0 drops ${firstPearl.tradeId}`);
  const replaced = adjusted.filters.find((f) => f.tradeId === secondPearl.tradeId);
  assert(replaced?.source === 'adjusted' && replaced.weight === 7 && replaced.text === secondPearl.text, `adjusted Pearl filter: ${JSON.stringify(replaced)}`);
  const pearlRequired = await uniqueSearch({ unique: 'Pearl of Tsoatha', slot: 'Ring 1', requiredMods: [{ tradeId: secondPearl.tradeId }] });
  assert(decodeQuery(pearlRequired.url, STANDARD_PREFIX).query.stats.some((g) => g.type === 'and' && g.filters.some((f) => f.id === secondPearl.tradeId)),
    'a Pearl filter as a required mod');
  // list_valid_slots lists Ring 3 regardless; PoB's Pearl popup offers only the ring slots it shows.
  await userError('generate_trade_search', { league: 'Standard', unique: 'Pearl of Tsoatha', slot: 'Ring 3' }, /a ring slot Path of Building shows \(Ring 1, Ring 2\).*Ring 3 is hidden/);
  await userError('generate_trade_search', { league: 'Standard', unique: 'Pearl of Tsoatha', slot: 'Amulet' }, /a ring slot Path of Building shows/);
  await userError('generate_trade_search', { league: 'Standard', unique: 'Pearl of Tsoatha' }, /slot is required for Pearl of Tsoatha/);
  await userError('generate_trade_search', { league: 'Standard', unique: 'Pearl of Tsoatha', slot: 'Ring 1', sockets: 1 }, /sockets does not apply to Pearl/);
  // search_trade_mods lists Pearl's pool: the same ids its search returns.
  const pearlPool = await ok<{ itemCategory: string; total: number; mods: TradeMod[] }>('search_trade_mods', { unique: 'Pearl of Tsoatha', query: 'supported by', limit: 100 });
  assert(pearlPool.itemCategory === 'Ring' && pearlPool.total > 100 && pearlPool.mods.every((m) => m.tradeId.startsWith(PEARL_PREFIX) && /Supported by/.test(m.text)),
    `Pearl pool: ${pearlPool.total} ${JSON.stringify(pearlPool.mods.slice(0, 2))}`);
  const named = await ok<{ mods: TradeMod[] }>('search_trade_mods', { unique: 'Pearl of Tsoatha', query: firstPearl.text, limit: 5 });
  assert(named.mods.some((m) => m.tradeId === firstPearl.tradeId), `the pool holds the search's ids: ${firstPearl.tradeId}`);
  await userError('search_trade_mods', { unique: 'Pearl of Tsoatha', slot: 'Amulet', query: 'support' }, /a ring slot Path of Building shows/);

  // Megalomaniac: PoB's search fails on notables the 3.13 tree lacks; its pool is listed.
  await userError('generate_trade_search', { league: 'Standard', unique: 'Megalomaniac' },
    /cannot weigh Megalomaniac on this build's passive tree \(version 3\.13\).*convert_tree_to_latest/);
  const notables = await ok<{ mods: TradeMod[]; total: number }>('search_trade_mods', { unique: 'Megalomaniac', query: 'added passive skill is', limit: 100 });
  assert(notables.total > 100 && notables.mods.every((m) => /^1 Added Passive Skill is /.test(m.text)), `Megalomaniac notables: ${notables.total}`);
  await userError('search_trade_mods', { query: 'life' }, /slot is required unless unique is given/);
  await userError('generate_trade_search', { league: 'Standard' }, /slot is required \(except for unique "Megalomaniac"\)/);

  // A socket holding a cluster jewel is refused (PoB would weigh against the build without its passives).
  assert(!(await call('allocate_nodes', { nodes: [2491] })).isError, 'allocate the large cluster socket 2491');
  assert(!(await call('swap_item', { slot: 'Jewel 2491', itemText: VOICES })).isError, 'Voices into Jewel 2491');
  await userError('generate_trade_search', { league: 'Standard', unique: WE, slot: 'Jewel 2491' }, /Jewel 2491 holds a cluster jewel \(Voices\)/);
  assert(!(await call('undo_last_change')).isError && !(await call('undo_last_change')).isError, 'undo the cluster jewel and the allocation');
  assert((await keyState()) === before, 'special unique searches and refusals changed the build or its export');
  log('PASS');
}

/**
 * Megalomaniac on the latest tree (its own engine: the build is converted):
 * cluster notables weighed as passive nodes; PoB's default socket (the lowest
 * allocated one: Jewel 36634, holding a jewel, whose worth then shifts every
 * weight compared with an empty socket); the export unchanged by searches; a
 * default socket holding a cluster jewel skipped (refused when it is the only
 * one); no allocated socket at all is PoB's nil slot.
 */
async function test16Megalomaniac(paths: TestPaths, xml: string): Promise<void> {
  log('Test 16: Megalomaniac on the latest tree');
  const bridge = new LuaBridge(paths, 120_000);
  try {
    const session = new BuildSession(bridge);
    await session.loadBuild(xml);
    await session.convertTreeToLatest();
    const before = await session.exportXML();
    const megaSearch = async (slot?: string) => {
      const args = { league: 'Standard', unique: 'Megalomaniac' as const, ...(slot ? { slot } : {}) };
      return buildTradeSearch(args, await session.generateTradeQuery(tradeQueryCommand(args))) as unknown as UniqueSearch;
    };
    const mega = await megaSearch();
    const q = decodeQuery(mega.url, STANDARD_PREFIX) as Query & { query: { name?: string; type?: string } };
    assert(q.query.name === 'Megalomaniac' && q.query.type === 'Medium Cluster Jewel' && q.query.filters.type_filters === undefined,
      `name and base filters: ${JSON.stringify({ name: q.query.name, type: q.query.type })}`);
    assert(mega.unique === 'Megalomaniac' && mega.slot === 'Jewel 36634' && mega.currentItem !== null && mega.minWeightedSum > 0,
      `PoB's default socket, the lowest allocated one: ${mega.slot} ${mega.currentItem} min ${mega.minWeightedSum}`);
    assert(mega.filters.length >= 10 && mega.filters.every((f) => f.weight > 0 && f.notable !== undefined && f.text === `1 Added Passive Skill is ${f.notable}`),
      `notables weighed: ${JSON.stringify(mega.filters.slice(0, 3))}`);
    assert((await session.exportXML()) === before, 'Megalomaniac searches changed the export');

    // An empty socket: pure notable gains and min 0; the jewel in 36634 shifts every weight by its worth.
    await session.allocateNodes([26725]);
    const empty = await megaSearch('Jewel 26725');
    assert(empty.currentItem === null && empty.minWeightedSum === 0, `empty socket: ${empty.currentItem} min ${empty.minWeightedSum}`);
    const shifts = empty.filters.slice(0, 5).map((f) => mega.filters.find((h) => h.tradeId === f.tradeId)!.weight - f.weight);
    assert(shifts.every((d) => d > 0 && Math.abs(d - shifts[0]) <= Math.max(0.05, shifts[0] * 0.02)), `every weight shifts by the jewel's worth: ${shifts}`);
    assert((await megaSearch()).slot === 'Jewel 26725', 'the default follows the lowest allocated socket');

    // A default socket holding a cluster jewel is skipped (an explicit one is refused).
    await session.allocateNodes([2491]);
    await session.swapItemWithDiff('Jewel 2491', VOICES);
    assert((await megaSearch()).slot === 'Jewel 26725', 'the default skips Jewel 2491 holding a cluster jewel');
    await rejectsWith(megaSearch('Jewel 2491'), /Jewel 2491 holds a cluster jewel \(Voices\)/);

    // A build whose only allocated socket holds a cluster jewel: the default refuses.
    await session.newBuild({ className: 'Witch' });
    await session.allocateNodes([2491]);
    await session.swapItemWithDiff('Jewel 2491', VOICES);
    await rejectsWith(megaSearch(), /every allocated passive-tree jewel socket holds a cluster jewel/);
    // No allocated socket at all: PoB's nil slot.
    await session.newBuild({ className: 'Witch' });
    const blank = await megaSearch();
    assert(blank.slot === null && blank.currentItem === null && blank.minWeightedSum === 0 && blank.filters.length > 0
      && blank.filters.every((f) => f.weight > 0 && f.notable !== undefined),
      `no socket: PoB's nil slot, notables weighed against the whole build: ${JSON.stringify({ ...blank, url: undefined }).slice(0, 300)}`);
  } finally {
    await bridge.dispose();
  }
  log('PASS');
}

async function rejectsWith(p: Promise<unknown>, expect: RegExp): Promise<void> {
  try {
    await p;
  } catch (e) {
    assert(expect.test((e as Error).message), `error ${JSON.stringify((e as Error).message)} should match ${expect}`);
    return;
  }
  throw new Error(`expected a rejection matching ${expect}`);
}

const MIRROR_PREFIX = 'pob-mcp-nospecial-';
const STALE_MIRROR_MS = 60 * 60 * 1000;

/**
 * Removes a mirror made by test17 without ever following a link: each link
 * (junction / symlink) is removed itself, folders are emptied entry by entry.
 * Returns false (and leaves the rest in place) when a link cannot be removed.
 */
function removeMirror(dir: string): boolean {
  for (const name of readdirSync(dir)) {
    const entry = path.join(dir, name);
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) {
      try {
        unlinkSync(entry);
      } catch {
        try { rmdirSync(entry); } catch { return false; }
      }
    } else if (stat.isDirectory()) {
      if (!removeMirror(entry)) return false;
    } else {
      unlinkSync(entry);
    }
  }
  rmdirSync(dir);
  return true;
}

/**
 * Feature detection: a temporary mirror of the PoB install (small folders
 * copied, the large data folders linked, nothing written into the install)
 * whose TradeQueryGenerator.lua lacks the special searches. Each unique is a
 * user error naming the missing search; a normal search still works. Mirrors
 * a killed earlier run left behind (over an hour old) are swept first.
 */
async function test17FeatureDetection(paths: TestPaths, xml: string): Promise<void> {
  log('Test 17: a trade generator without the special unique searches');
  // Only mirrors older than an hour: other worktrees may be running this test right now, and a live
  // bridge's working directory cannot be removed on Windows (EBUSY).
  for (const name of readdirSync(os.tmpdir())) {
    if (!name.startsWith(MIRROR_PREFIX)) continue;
    const stale = path.join(os.tmpdir(), name);
    try {
      const stat = lstatSync(stale);
      if (!stat.isDirectory() || Date.now() - stat.mtimeMs < STALE_MIRROR_MS) continue;
      if (!removeMirror(stale)) console.error(`left ${stale} in place: a link could not be removed safely`);
    } catch (e) {
      console.error(`left ${stale} in place: ${(e as Error).message}`);
    }
  }
  const mirror = mkdtempSync(path.join(os.tmpdir(), MIRROR_PREFIX));
  // Mirrors `from` into `to`, descending along `into` (the folders holding the generator, copied with links
  // dereferenced); other folders are linked, files copied.
  const build = (from: string, to: string, into: string[]): void => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory() && entry.name === into[0]) {
        if (into.length === 1) cpSync(src, dst, { recursive: true, dereference: true });
        else build(src, dst, into.slice(1));
      } else if (entry.isDirectory()) {
        symlinkSync(src, dst, 'junction');
      } else if (entry.isFile()) {
        copyFileSync(src, dst);
      }
    }
  };
  try {
    const into = existsSync(path.join(paths.pobPath, 'src', 'Classes', 'TradeQueryGenerator.lua')) ? ['src', 'Classes'] : ['Classes'];
    build(paths.pobPath, mirror, into);
    const genFile = path.join(mirror, ...into, 'TradeQueryGenerator.lua');
    let source = readFileSync(genFile, 'utf8');
    for (const [from, to] of [
      ['if options.special.itemName == "Watcher\'s Eye" then', 'if false then'],
      ['if options.special.itemName == "Pearl of Tsoatha" then', 'if false then'],
      ['function TradeQueryGeneratorClass:GeneratePassiveNodeWeights(', 'function TradeQueryGeneratorClass:GeneratePassiveNodeWeightsGone('],
    ]) {
      assert(source.includes(from), `the installed generator no longer has: ${from}`);
      source = source.replace(from, to);
    }
    // A new file in the mirror: never a write through a link into the install.
    unlinkSync(genFile);
    writeFileSync(genFile, source, { flag: 'wx' });

    const bridge = new LuaBridge({ ...paths, pobPath: mirror }, 120_000);
    try {
      const session = new BuildSession(bridge);
      await session.loadBuild(xml);
      const before = await session.exportXML();
      for (const [unique, slot] of [["Watcher's Eye", 'Jewel 36634'], ['Pearl of Tsoatha', 'Ring 1'], ['Megalomaniac', undefined]] as const) {
        const args = { league: 'Standard', unique, ...(slot ? { slot } : {}) };
        await rejectsWith(session.generateTradeQuery(tradeQueryCommand(args)),
          new RegExp(`This Path of Building version's trade query generator has no ${unique} search; update Path of Building`));
      }
      assert((await session.generateTradeQuery(tradeQueryCommand({ slot: 'Helmet', league: 'Standard' }))).capLifted === true, 'a normal search still works');
      assert((await session.exportXML()) === before, 'refused unique searches changed the export');
    } finally {
      await bridge.dispose();
    }
  } finally {
    // A cleanup failure never masks the test's own error.
    try {
      if (!removeMirror(mirror)) console.error(`left ${mirror} in place: a link could not be removed safely`);
    } catch (e) {
      console.error(`left ${mirror} in place: ${(e as Error).message}`);
    }
  }
  log('PASS');
}

/**
 * Faults while an inactive flask slot is activated for a trade search
 * (bridge test faults): an error there leaves the slot's flags and the export
 * as they were and stays the search's own error; a restore whose by-value
 * check differs is an internal error naming reset_build, and suggest_upgrades
 * fails the call on it instead of keeping it as a per-slot modsError.
 */
async function test14FlaskFaults(paths: TestPaths, xml: string): Promise<void> {
  log('Test 14: faults while a flask slot is activated for a trade search');
  const query = (slot: string) => tradeQueryCommand({ slot, league: 'Standard' });
  const rejection = async (p: Promise<unknown>): Promise<Error> => {
    try {
      await p;
    } catch (e) {
      return e as Error;
    }
    throw new Error('expected a rejection');
  };
  const flaskActive = async (session: BuildSession, slot: string) => (await session.listEquippedItems()).find((i) => i.slot === slot)?.active;

  const failing = new LuaBridge(paths, 120_000, { testFaults: 'tradeFlaskFailsActivated' });
  try {
    const session = new BuildSession(failing);
    await session.loadBuild(xml);
    assert((await session.generateTradeQuery(query('Flask 1'))).evaluatedActive === undefined, 'an active slot never reaches the fault');
    await session.setFlaskActive('Flask 2', false);
    const before = await session.exportXML();
    const e = await rejection(session.generateTradeQuery(query('Flask 2')));
    assert(e instanceof EngineCommandError && /test fault: trade search failed with the flask slot activated/.test(e.message)
      && !/reset_build/.test(e.message), `the search's own error: ${e.constructor.name}: ${e.message}`);
    assert((await flaskActive(session, 'Flask 2')) === false, 'Flask 2 is inactive again');
    assert((await session.exportXML()) === before, 'export unchanged after the failed activated search');
  } finally {
    await failing.dispose();
  }

  // The activation itself fails (after the flags are set): the protected path still puts everything back.
  const activation = new LuaBridge(paths, 120_000, { testFaults: 'tradeFlaskActivationFails' });
  try {
    const session = new BuildSession(activation);
    await session.loadBuild(xml);
    await session.setFlaskActive('Flask 2', false);
    const before = await session.exportXML();
    const e = await rejection(session.generateTradeQuery(query('Flask 2')));
    assert(e instanceof EngineCommandError && /test fault: activating the flask slot for the trade search failed/.test(e.message)
      && !/reset_build/.test(e.message), `the activation's own error: ${e.constructor.name}: ${e.message}`);
    assert((await flaskActive(session, 'Flask 2')) === false, 'Flask 2 is inactive again after the failed activation');
    assert((await session.exportXML()) === before, 'export unchanged after the failed activation');
    // The generator and the popup stubs were put back: searches keep working on that engine.
    assert((await session.generateTradeQuery(query('Helmet'))).capLifted === true, 'a search after the failed activation');
  } finally {
    await activation.dispose();
  }

  const inexact = new LuaBridge(paths, 120_000, { testFaults: 'tradeFlaskRestoreInexact' });
  try {
    const session = new BuildSession(inexact);
    await session.loadBuild(xml);
    await session.setFlaskActive('Flask 2', false);
    const e = await rejection(session.generateTradeQuery(query('Flask 2')));
    assert(e instanceof EngineCommandError && /left the build different from the committed one.*tradeFlaskRestoreInexact.*call reset_build/.test(e.message),
      `inexact restore: ${e.constructor.name}: ${e.message}`);
    const viaSuggest = await rejection(session.suggestUpgrades('Flask 2'));
    assert(viaSuggest instanceof EngineCommandError && /call reset_build/.test(viaSuggest.message),
      `suggest_upgrades fails the call instead of a modsError: ${viaSuggest.constructor.name}: ${viaSuggest.message}`);
    // By default the inactive slot is not queried, so the call succeeds.
    assert((await session.suggestUpgrades()).every((s) => s.slot !== 'Flask 2' || s.suggestedMods === undefined), 'default suggest_upgrades');
  } finally {
    await inexact.dispose();
  }
  log('PASS');
}

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-trade-'));
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverPath],
    env: { ...process.env, POB_PATH: paths.pobPath, LUAJIT_PATH: paths.luajitPath, POB_MCP_CONFIG_DIR: configDir } as Record<string, string>,
    stderr: 'ignore',
  });
  client = new Client({ name: 'pob-mcp-trade-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    await ok('load_build', { source: readFileSync(fixturePath, 'utf8') });
    const before = await keyState();

    log('Test 1: default search for Helmet');
    const base = await search({});
    const q = decodeQuery(base.url);
    const weights = q.query.stats[0];
    assert(weights.type === 'weight', 'first stat group should be the weight group');
    // PoB 2.68 always emits empty "and"/"not" groups; the bridge drops them so every version gives one shape.
    assert(q.query.stats.length === 1, `only the weight group without required mods: ${JSON.stringify(q.query.stats.map((g) => g.type))}`);
    assert(q.sort['statgroup.0'] === 'desc', 'sorted by weighted sum, highest first');
    assert(weights.filters.length > 0 && weights.filters.length <= 36, `filters: ${weights.filters.length}`);
    assert(weights.filters.every((f) => typeof f.value?.weight === 'number' && f.value.weight !== 0), 'every filter has a weight');
    assert(weights.filters.filter((f) => f.value!.weight! > 0).length >= weights.filters.length / 2, 'weights are mostly positive');
    assert(base.filters.every((f) => f.source === 'pob' && f.text.length > 0), 'PoB filters carry text');
    assert(weights.value?.min === base.minWeightedSum && base.minWeightedSum === base.pobDefaultMinWeightedSum, 'default min is PoB\'s');
    assert(base.statWeights.map((w) => w.stat).join() === 'FullDPS,TotalEHP', 'PoB default stat weights');
    assert(base.capLifted === true, 'PoB\'s 36-filter cap should be lifted so the full weight list comes back');
    assert(base.filterBudget === 34 && weights.filters.length === 34 && base.droppedByCap.count > 0, 'the cap is hit: budget full, some dropped');
    assert(q.query.status.option === 'available' && q.query.filters.type_filters.filters.category.option === 'armour.helmet', 'defaults');
    log(`PASS: ${weights.filters.length} filters, ${base.droppedByCap.count} dropped by cap, ${base.calcSeconds}s`);

    log('Test 2: realm xbox, Ring 1');
    const xbox = await ok<Search>('generate_trade_search', { slot: 'Ring 1', league: LEAGUE, realm: 'xbox' });
    decodeQuery(xbox.url, 'https://www.pathofexile.com/trade/search/xbox/Settlers%20of%20Kalguur?q=');
    log('PASS');

    log('Test 3: statWeights change the weights');
    const life = await search({ statWeights: [{ stat: 'Life', weight: 1 }] });
    assert(JSON.stringify(life.filters) !== JSON.stringify(base.filters), 'Life-only weights should differ from the default');
    assert(life.filters.some((f) => /maximum Life/.test(f.text)), 'Life weighting should weigh a maximum Life mod');
    log('PASS');

    log('Test 4: weightAdjustments add / replace / remove and survive the cap');
    const replaced = base.filters[0];
    const removed = base.filters[1];
    const added = 'pseudo.pseudo_total_fire_resistance';
    const adjusted = await search({
      weightAdjustments: [
        { tradeId: replaced.tradeId, weight: 0.0123 },
        { tradeId: removed.tradeId, weight: 0 },
        { tradeId: added, weight: 0.0042 },
      ],
    });
    const aq = decodeQuery(adjusted.url).query.stats[0].filters;
    assert(aq.length <= 36, 'still within the cap');
    assert(aq.find((f) => f.id === replaced.tradeId)?.value?.weight === 0.0123, 'replaced weight applies');
    assert(!aq.some((f) => f.id === removed.tradeId), 'weight 0 removes the filter');
    assert(aq.find((f) => f.id === added)?.value?.weight === 0.0042, 'added filter present even with the lowest weight');
    assert(adjusted.filters.find((f) => f.tradeId === added)?.source === 'added', 'added source');
    assert(adjusted.filters.find((f) => f.tradeId === replaced.tradeId)?.source === 'adjusted', 'adjusted source');
    log('PASS');

    log('Test 4b: single-resistance adjustments target PoB\'s pseudo total');
    const fire = await search({ weightAdjustments: [{ tradeId: FIRE_RES_EXPLICIT, weight: 2.5 }] });
    const fireFilters = decodeQuery(fire.url).query.stats[0].filters.filter((f) => /stat_3372524247$|pseudo_total_fire_resistance$/.test(f.id));
    assert(fireFilters.length === 1 && fireFilters[0].id === FIRE_RES_PSEUDO && fireFilters[0].value?.weight === 2.5, `one fire-res filter: ${JSON.stringify(fireFilters)}`);
    assert(fire.filters.find((f) => f.tradeId === FIRE_RES_PSEUDO)?.mappedFrom === FIRE_RES_EXPLICIT, 'response says which id was mapped');
    await userError('generate_trade_search', {
      slot: 'Helmet', league: LEAGUE, weightAdjustments: [{ tradeId: FIRE_RES_EXPLICIT, weight: 1 }, { tradeId: FIRE_RES_PSEUDO, weight: 2 }],
    }, /more than once/);
    log('PASS');

    log('Test 4c0: bridge pseudoMap / ignoredStats match the installed TradeQueryGenerator.lua');
    const pobSource = pobGeneratorSource(paths.pobPath);
    const bridgeSource = readFileSync(bridgePath, 'utf8');
    const finishQuery = luaFunctionBody(pobSource, 'function TradeQueryGeneratorClass:FinishQuery()');
    const bridgeIgnoredFn = luaFunctionBody(bridgeSource, 'local function tradeIgnoredFor(id)');
    const pobPseudo = luaStringEntries(luaTable(finishQuery, 'pseudoMap'));
    const bridgePseudo = luaStringEntries(luaTable(bridgeSource, 'TRADE_PSEUDO_MAP'));
    assert(pobPseudo.length === 7, `PoB's pseudoMap should have 7 entries: ${JSON.stringify(pobPseudo)}`);
    assert(JSON.stringify(pobPseudo) === JSON.stringify(bridgePseudo),
      `TRADE_PSEUDO_MAP drifted from PoB's pseudoMap:\n  PoB    ${JSON.stringify(pobPseudo)}\n  bridge ${JSON.stringify(bridgePseudo)}`);
    const pobIgnored = luaKeys(luaTable(finishQuery, 'ignoredStats'));
    const bridgeIgnored = luaKeys(luaTable(bridgeSource, 'TRADE_IGNORED_LITERAL'));
    assert(pobIgnored.length === 3 && JSON.stringify(pobIgnored) === JSON.stringify(bridgeIgnored),
      `TRADE_IGNORED_LITERAL drifted from PoB's ignoredStats: PoB ${pobIgnored}, bridge ${bridgeIgnored}`);
    for (const line of IGNORED_ELEMENT_LINES) {
      assert(finishQuery.includes(line) && bridgeIgnoredFn.includes(line), `hybrid ignoredStats element list drifted (PoB FinishQuery / bridge): ${line}`);
    }
    for (const call of IGNORED_FORMAT_CALLS) {
      // PoB: `stats = { <call> }` then `ignoredStats[tostring(HashStats(stats))] = true`; bridge: `add(HashStats({ <call> }), ...)`.
      const feedsIgnored = new RegExp(`${escapeRe(call)}\\s*\\}\\s*\\n\\s*ignoredStats\\[tostring\\(HashStats\\(stats\\)\\)\\] = true`);
      assert(feedsIgnored.test(finishQuery), `PoB FinishQuery no longer hashes ${call} into ignoredStats`);
      assert(bridgeIgnoredFn.includes(`add(HashStats({ ${call} })`), `bridge tradeIgnoredFor no longer hashes ${call}`);
    }
    log(`PASS: ${pobPseudo.length} pseudoMap entries, ${pobIgnored.length} literal ignored stats, hybrid patterns match`);

    log('Test 4c1: every single resistance / attribute id maps to its pseudo total');
    const mapped = pobPseudo.map(([hash, pseudo], i) => ({ from: `explicit.stat_${hash}`, to: pseudo, weight: 1.5 + i }));
    const all7 = await search({ weightAdjustments: mapped.map((m) => ({ tradeId: m.from, weight: m.weight })) });
    const all7q = decodeQuery(all7.url).query.stats[0].filters;
    for (const m of mapped) {
      const hash = m.from.slice('explicit.stat_'.length);
      const hits = all7q.filter((f) => f.id === m.to || f.id.endsWith(`.stat_${hash}`));
      assert(hits.length === 1 && hits[0].id === m.to && hits[0].value?.weight === m.weight, `${m.from}: one ${m.to} filter: ${JSON.stringify(hits)}`);
      const f = all7.filters.find((x) => x.tradeId === m.to);
      assert(f?.mappedFrom === m.from && f.weight === m.weight, `${m.from}: response filter ${JSON.stringify(f)}`);
    }
    log('PASS');

    log('Test 4c2: all / hybrid resistance and attribute ids are refused as weights, accepted as required mods');
    await userError('generate_trade_search', { slot: 'Ring 1', league: LEAGUE, weightAdjustments: [{ tradeId: ALL_ELE_RES, weight: 1 }] },
      /cannot weigh explicit\.stat_2901986750.*pseudo_total_fire_resistance, pseudo\.pseudo_total_cold_resistance, pseudo\.pseudo_total_lightning_resistance.*requiredMods/);
    await userError('generate_trade_search', { slot: 'Ring 1', league: LEAGUE, weightAdjustments: [{ tradeId: ALL_ATTRIBUTES, weight: 1 }] },
      /pseudo_total_strength, pseudo\.pseudo_total_dexterity, pseudo\.pseudo_total_intelligence/);
    const ringRes = await ok<{ mods: TradeMod[] }>('search_trade_mods', { slot: 'Ring 1', query: 'resistances', limit: 100 });
    const fireCold = ringRes.mods.find((m) => m.text === '+#% to Fire and Cold Resistances' && m.type === 'Explicit');
    assert(fireCold?.weightable === false && JSON.stringify(fireCold.preferredTradeIds) === JSON.stringify([FIRE_RES_PSEUDO, 'pseudo.pseudo_total_cold_resistance']),
      `hybrid resistance is marked unweightable with its totals: ${JSON.stringify(fireCold)}`);
    assert(ringRes.mods.find((m) => m.tradeId === ALL_ELE_RES)?.weightable === false, 'all elemental resistances marked unweightable');
    assert(ringRes.mods.filter((m) => m.weightable === false).every((m) => (m.preferredTradeIds?.length ?? 0) >= 2), 'unweightable entries name their totals');
    assert(ringRes.mods.filter((m) => m.preferred).every((m) => m.weightable === undefined), 'pseudo totals stay weightable');
    await userError('generate_trade_search', { slot: 'Ring 1', league: LEAGUE, weightAdjustments: [{ tradeId: fireCold.tradeId, weight: 1 }] },
      /pseudo_total_fire_resistance, pseudo\.pseudo_total_cold_resistance already count it/);
    const amuletAttr = await ok<{ mods: TradeMod[] }>('search_trade_mods', { slot: 'Amulet', query: 'strength and dexterity', limit: 100 });
    const strDex = amuletAttr.mods.find((m) => m.type === 'Explicit');
    assert(strDex?.weightable === false && JSON.stringify(strDex.preferredTradeIds) === '["pseudo.pseudo_total_strength","pseudo.pseudo_total_dexterity"]',
      `hybrid attribute is marked unweightable: ${JSON.stringify(strDex)}`);
    await userError('generate_trade_search', { slot: 'Amulet', league: LEAGUE, weightAdjustments: [{ tradeId: strDex.tradeId, weight: 1 }] },
      /pseudo_total_strength, pseudo\.pseudo_total_dexterity already count it/);
    const reqIgnored = await ok<Search>('generate_trade_search', {
      slot: 'Ring 1', league: LEAGUE, requiredMods: [{ tradeId: ALL_ELE_RES, min: 10 }, { tradeId: fireCold.tradeId }, { tradeId: ALL_ATTRIBUTES }],
    });
    const reqAnd = decodeQuery(reqIgnored.url).query.stats.find((g) => g.type === 'and')?.filters.map((f) => f.id) ?? [];
    assert([ALL_ELE_RES, fireCold.tradeId, ALL_ATTRIBUTES].every((id) => reqAnd.includes(id)), `required ids kept exactly: ${reqAnd}`);
    log('PASS');

    log('Test 4c: PoB dialog options on Body Armour');
    const opts = await ok<Search>('generate_trade_search', {
      slot: 'Body Armour', league: LEAGUE, tradeType: 'securable', influences: ['shaper', 'elder'], includeMirrored: false,
      maxPrice: { amount: 5, currency: 'divine' }, maxLevel: 80, sockets: 6, links: 6,
    });
    const oq = decodeQuery(opts.url).query;
    assert(oq.status.option === 'securable', 'tradeType');
    assert(oq.filters.trade_filters.filters.price.option === 'divine' && oq.filters.trade_filters.filters.price.max === 5, 'maxPrice + currency');
    assert(oq.filters.req_filters.filters.lvl.max === 80, 'maxLevel');
    const sock = oq.filters.socket_filters.filters;
    assert(sock.sockets.min === 6 && sock.sockets.max === 6 && sock.links.min === 6 && sock.links.max === 6, 'sockets + links');
    assert(oq.filters.misc_filters.filters.mirrored === false, 'includeMirrored false');
    const infl = oq.stats.find((g) => g.type === 'and')?.filters.map((f) => f.id) ?? [];
    assert(infl.includes('pseudo.pseudo_has_shaper_influence') && infl.includes('pseudo.pseudo_has_elder_influence'), `influences: ${infl}`);
    // 36 - 2 - 5 options - 2 influences = 27.
    assert(opts.filterBudget === 27 && oq.stats[0].filters.length <= 27, `budget shrinks with every extra filter: ${opts.filterBudget}`);
    log('PASS');

    log('Test 4d: weapon and flask slots');
    const wand = await ok<Search>('generate_trade_search', { slot: 'Weapon 1', league: LEAGUE, maxPrice: { amount: 50 } });
    const wq = decodeQuery(wand.url).query;
    assert(wq.filters.type_filters.filters.category.option === 'weapon.wand', `weapon category: ${wand.itemCategory}`);
    const price = wq.filters.trade_filters.filters.price;
    assert(price.max === 50 && price.option === undefined, 'chaos-equivalent price has no currency option');
    const flask = await ok<Search>('generate_trade_search', { slot: 'Flask 1', league: LEAGUE });
    assert(decodeQuery(flask.url).query.filters.type_filters.filters.category.option === 'flask' && flask.filters.length > 0, 'flask search');
    log('PASS');

    log('Test 5: requiredMods and minWeightedSum');
    const lifeId = 'explicit.stat_3299347043';
    const req = await search({ requiredMods: [{ tradeId: lifeId, min: 70 }, { tradeId: 'pseudo.pseudo_total_life' }], minWeightedSum: 123.5 });
    const rq = decodeQuery(req.url).query;
    const and = rq.stats.find((s) => s.type === 'and');
    assert(and?.filters.some((f) => f.id === lifeId && f.value?.min === 70), 'required mod with min in an "and" group');
    assert(and?.filters.some((f) => f.id === 'pseudo.pseudo_total_life' && f.value === undefined), 'required mod without min');
    assert(rq.stats[0].value?.min === 123.5 && req.minWeightedSum === 123.5, 'min override applies');
    assert(rq.stats[0].filters.length + 2 <= 36, 'required mods count toward the cap');
    assert(req.filterBudget === 32, `required mods shrink the budget: ${req.filterBudget}`);
    const inflReq = await search({ influences: ['hunter'], requiredMods: [{ tradeId: lifeId, min: 50 }] });
    const irAnd = decodeQuery(inflReq.url).query.stats.filter((g) => g.type === 'and');
    assert(irAnd.length === 1 && irAnd[0].filters.map((f) => f.id).join() === `pseudo.pseudo_has_hunter_influence,${lifeId}`,
      `influence and required mod share one "and" group: ${JSON.stringify(irAnd)}`);
    // The influence filter also given as a required mod (with a min) is emitted once and counted once.
    const hunter = 'pseudo.pseudo_has_hunter_influence';
    const dup = await search({ influences: ['hunter'], requiredMods: [{ tradeId: hunter, min: 1 }, { tradeId: lifeId, min: 50 }] });
    const dupAnd = decodeQuery(dup.url).query.stats.filter((g) => g.type === 'and');
    assert(dupAnd.length === 1 && dupAnd[0].filters.length === 2 && dupAnd[0].filters.filter((f) => f.id === hunter).length === 1
      && dupAnd[0].filters.find((f) => f.id === hunter)?.value?.min === 1, `influence filter emitted once: ${JSON.stringify(dupAnd)}`);
    assert(dup.filterBudget === inflReq.filterBudget, `the duplicate is counted once: ${dup.filterBudget} vs ${inflReq.filterBudget}`);
    log('PASS');

    log('Test 6: input errors are user errors');
    await userError('generate_trade_search', { slot: 'Helmet', league: LEAGUE, statWeights: [{ stat: 'NoSuchStat', weight: 1 }] }, /Unknown stat weight.*Valid stats:.*FullDPS/);
    await userError('generate_trade_search', { slot: 'Helmet', league: LEAGUE, weightAdjustments: [{ tradeId: 'explicit stat"}', weight: 1 }] }, /Invalid trade stat id/);
    await userError('generate_trade_search', { slot: 'Helmet', league: LEAGUE, requiredMods: [{ tradeId: 'explicit.stat_1' }] }, /Unknown trade stat id/);
    await userError('generate_trade_search', { slot: 'Jewel 26725', league: LEAGUE }, /Jewel 26725: the passive tree jewel socket is not allocated.*allocate_nodes/);
    await userError('search_trade_mods', { slot: 'Jewel 26725', query: 'life' }, /not allocated.*Allocate node 26725/);
    await userError('generate_trade_search', { slot: 'Jewel 1', league: LEAGUE }, /Unsupported slot.*Helmet.*allocated passive tree jewel sockets/);
    await userError('generate_trade_search', { slot: 'Belt Abyssal Socket 1', league: LEAGUE }, /the item in Belt has 0 abyssal socket\(s\)/);
    await userError('generate_trade_search', { slot: 'Helmet', league: LEAGUE, jewelType: 'abyss' }, /jewelType only applies to jewel sockets, not Helmet/);
    await userError('search_trade_mods', { slot: 'Ring 1', query: 'life', jewelType: 'base' }, /jewelType only applies/);
    await userError('generate_trade_search', { slot: 'Helmet', league: 'a/b' }, /league/);
    await userError('generate_trade_search', { slot: 'Helmet', league: '   ' }, /league/);
    await userError('search_trade_mods', { slot: 'Nope', query: 'life' }, /Unsupported slot/);
    for (const league of ['.', '..', ' . ']) await userError('generate_trade_search', { slot: 'Helmet', league }, /league/);
    await userError('generate_trade_search', { slot: 'Helmet', league: LEAGUE, includeTalisman: true }, /includeTalisman true only applies to Amulet/);
    await userError('generate_trade_search', { slot: 'Ring 1', league: LEAGUE, includeEldritch: 'keepRegular' }, /includeEldritch "keepRegular" only applies/);
    await userError('generate_trade_search', { slot: 'Ring 1', league: LEAGUE, includeEldritch: 'keepRegularPresence' }, /only applies/);
    await userError('generate_trade_search', { slot: 'Helmet', league: LEAGUE, includeEldritch: 'keepRegular', influences: ['hunter'] }, /influences/);
    await userError('generate_trade_search', { slot: 'Ring 1', league: LEAGUE, links: 4 }, /links is not available/);
    await userError('generate_trade_search', { slot: 'Flask 1', league: LEAGUE, sockets: 1 }, /sockets is not available/);
    log('PASS');

    log('Test 6b: off-slot options that change nothing are accepted');
    for (const includeEldritch of ['copyCurrent', 'remove']) {
      const noop = await ok<Search>('generate_trade_search', { slot: 'Ring 1', league: LEAGUE, realm: 'xbox', includeTalisman: false, includeEldritch });
      assert(noop.url === xbox.url, `Ring 1 with includeTalisman false / includeEldritch ${includeEldritch} should equal the default search`);
    }
    log('PASS');

    log('Test 6c: weight 0 on an id PoB leaves out of the weights changes nothing');
    const zeroIgnored = await ok<Search>('generate_trade_search', {
      slot: 'Ring 1', league: LEAGUE, realm: 'xbox', weightAdjustments: [{ tradeId: ALL_ELE_RES, weight: 0 }, { tradeId: ALL_ATTRIBUTES, weight: 0 }],
    });
    assert(zeroIgnored.url === xbox.url && zeroIgnored.filterBudget === xbox.filterBudget, 'weight 0 on ignored ids should equal the default search');
    assert(!zeroIgnored.filters.some((f) => f.source !== 'pob'), 'nothing is added or pinned');
    log('PASS');

    log('Test 7: search_trade_mods');
    const mods = await ok<{ total: number; mods: { tradeId: string; text: string; type: string }[] }>('search_trade_mods', { slot: 'Helmet', query: 'LIFE', limit: 100 });
    assert(mods.mods.length > 0 && mods.mods.every((m) => /life/i.test(m.text)), 'every result mentions life');
    assert(mods.mods.every((m) => /^[a-z]+\.[a-z0-9_]+(\|[a-z0-9_]+)?$/.test(m.tradeId)), 'valid trade ids');
    assert(mods.mods.some((m) => m.tradeId === lifeId && m.type === 'Explicit'), '+# to maximum Life is listed');
    assert(mods.mods.some((m) => m.type === 'Pseudo'), 'pseudo stats are listed');
    const fireMods = await ok<{ mods: { tradeId: string; preferred?: boolean; preferredTradeId?: string }[] }>(
      'search_trade_mods', { slot: 'Helmet', query: 'fire resistance', limit: 100 });
    assert(fireMods.mods[0]?.tradeId === FIRE_RES_PSEUDO && fireMods.mods[0].preferred === true, `pseudo total first: ${JSON.stringify(fireMods.mods[0])}`);
    assert(fireMods.mods.find((m) => m.tradeId === FIRE_RES_EXPLICIT)?.preferredTradeId === FIRE_RES_PSEUDO, 'explicit fire res points at the pseudo id');
    const few = await ok<{ mods: unknown[]; total: number }>('search_trade_mods', { slot: 'Helmet', query: 'life', limit: 3 });
    assert(few.mods.length === 3 && few.total === mods.total, 'limit caps the list, total does not change');
    log('PASS');

    log('Test 7b: ids from search_trade_mods are accepted by generate_trade_search');
    let unweightable = 0;
    for (const query of ['life', 'resistance', 'attack speed']) {
      const found = await ok<{ mods: TradeMod[] }>('search_trade_mods', { slot: 'Gloves', query, limit: 10 });
      assert(found.mods.length > 0, `search_trade_mods found nothing for "${query}" on Gloves`);
      // Every id as a required mod; weightable ids also as weights (one per filter they land on).
      const targets = new Set<string>();
      const weightAdjustments = found.mods.filter((m) => {
        const target = m.preferredTradeId ?? m.tradeId;
        if (m.weightable === false || targets.has(target)) return false;
        targets.add(target);
        return true;
      }).map((m) => ({ tradeId: m.tradeId, weight: 1 }));
      unweightable += found.mods.filter((m) => m.weightable === false).length;
      const r = await call('generate_trade_search', {
        slot: 'Gloves', league: LEAGUE, requiredMods: found.mods.map((m) => ({ tradeId: m.tradeId })), weightAdjustments,
      });
      assert(!r.isError, `"${query}" ids should be accepted: ${text(r)}`);
      const gq = decodeQuery((JSON.parse(text(r)) as Search).url).query;
      const required = gq.stats.find((g) => g.type === 'and')?.filters.map((f) => f.id) ?? [];
      assert(found.mods.every((m) => required.includes(m.tradeId)), `"${query}": every id is a required mod`);
      assert([...targets].every((id) => gq.stats[0].filters.some((f) => f.id === id)), `"${query}": every weightable id is weighted`);
    }
    assert(unweightable > 0, 'the queries should cover at least one unweightable id');
    log('PASS');

    log('Test 8: build unchanged');
    assert((await keyState()) === before, 'Life/CombinedDPS/TotalEHP or export changed after trade searches');
    const undo = await call('undo_last_change');
    assert(undo.isError, 'trade searches must not push undo entries');
    log('PASS');

    // From here on the build is changed (a belt with an abyssal socket, an allocated socket).
    log('Test 9: passive-tree jewel sockets (jewelType, category, options)');
    const category = (s: Search) => decodeQuery(s.url, STANDARD_PREFIX).query.filters.type_filters.filters.category.option as string;
    const weighted = (s: Search) => s.filters.filter((f) => f.weight > 0).length;
    const treeBase = await jewelSearch({ slot: 'Jewel 36634' }); // a Cobalt (regular) jewel is socketed there
    assert(category(treeBase) === 'jewel.base' && treeBase.itemCategory === 'BaseJewel', `regular jewel default: ${treeBase.itemCategory}`);
    assert(weighted(treeBase) >= 5, `tree socket search should weigh mods: ${weighted(treeBase)}`);
    const treeAbyss = await jewelSearch({ slot: 'Jewel 36634', jewelType: 'abyss' });
    assert(category(treeAbyss) === 'jewel.abyss' && treeAbyss.itemCategory === 'AbyssJewel' && weighted(treeAbyss) >= 5, 'jewelType abyss');
    const treeAny = await jewelSearch({ slot: 'Jewel 36634', jewelType: 'any' });
    assert(category(treeAny) === 'jewel' && treeAny.itemCategory === 'AnyJewel' && weighted(treeAny) >= 5, 'jewelType any');
    const noScourge = await jewelSearch({ slot: 'Jewel 36634', includeScourge: false });
    assert(noScourge.url === treeBase.url, 'Standard league: jewel searches never include scourge, so false changes nothing');
    const baseMods = await ok<{ itemCategory: string; mods: TradeMod[] }>('search_trade_mods', { slot: 'Jewel 36634', query: 'maximum life', limit: 100 });
    const abyssMods = await ok<{ itemCategory: string; mods: TradeMod[] }>('search_trade_mods', { slot: 'Jewel 36634', query: 'maximum life', limit: 100, jewelType: 'abyss' });
    assert(baseMods.itemCategory === 'BaseJewel' && abyssMods.itemCategory === 'AbyssJewel', 'search_trade_mods uses the jewel type\'s category');
    assert(!baseMods.mods.some((m) => m.tradeId === lifeId) && abyssMods.mods.some((m) => m.tradeId === lifeId),
      'flat maximum Life rolls on abyss jewels only');
    for (const [extra, expect] of [
      [{ sockets: 1 }, /sockets is not available for jewel sockets/],
      [{ links: 2 }, /links is not available for Jewel 36634/],
      [{ influences: ['shaper'] }, /influences do not apply to jewel sockets/],
      [{ includeScourge: true }, /includeScourge true does not apply to jewel sockets/],
      [{ includeEldritch: 'keepRegular' }, /only applies to/],
    ] as [Record<string, unknown>, RegExp][]) {
      await userError('generate_trade_search', { slot: 'Jewel 36634', league: 'Standard', ...extra }, expect);
    }
    log('PASS');

    log('Test 10: abyssal sockets the item has');
    const vise = await call('swap_item', { slot: 'Belt', itemText: STYGIAN_VISE });
    assert(!vise.isError, `swap_item Stygian Vise: ${text(vise)}`);
    const abyssal = await jewelSearch({ slot: 'Belt Abyssal Socket 1' }); // empty socket
    assert(category(abyssal) === 'jewel.abyss' && abyssal.itemCategory === 'AbyssJewel' && weighted(abyssal) >= 5,
      `abyssal socket search: ${abyssal.itemCategory}, ${weighted(abyssal)} weighted`);
    assert((await jewelSearch({ slot: 'Belt Abyssal Socket 1', jewelType: 'abyss' })).url === abyssal.url, 'jewelType abyss is the abyssal default');
    await userError('generate_trade_search', { slot: 'Belt Abyssal Socket 1', league: 'Standard', jewelType: 'base' }, /abyssal sockets hold only abyss jewels/);
    await userError('generate_trade_search', { slot: 'Belt Abyssal Socket 2', league: 'Standard' }, /the item in Belt has 1 abyssal socket\(s\)/);
    await userError('generate_trade_search', { slot: 'Belt Abyssal Socket 1', league: 'Standard', sockets: 1 }, /sockets is not available for jewel sockets/);
    const abyssalMods = await ok<{ itemCategory: string; mods: TradeMod[] }>('search_trade_mods', { slot: 'Belt Abyssal Socket 1', query: 'maximum life' });
    assert(abyssalMods.itemCategory === 'AbyssJewel' && abyssalMods.mods.some((m) => m.tradeId === lifeId), 'abyssal socket mods');
    log('PASS');

    log('Test 11: a socket allocated for the search; an abyss jewel there defaults to abyss');
    const alloc = await call('allocate_nodes', { nodes: [26725] });
    assert(!alloc.isError, `allocate_nodes 26725: ${text(alloc)}`);
    const emptyTree = await jewelSearch({ slot: 'Jewel 26725' });
    assert(category(emptyTree) === 'jewel.base' && weighted(emptyTree) >= 5, 'an empty tree socket defaults to base jewels');
    const eye = await call('swap_item', { slot: 'Jewel 26725', itemText: ABYSS_EYE });
    assert(!eye.isError && !('note' in JSON.parse(text(eye))), `abyss jewel into the allocated socket (no note): ${text(eye)}`);
    const eyeSearch = await jewelSearch({ slot: 'Jewel 26725' });
    assert(category(eyeSearch) === 'jewel.abyss' && eyeSearch.currentItem === 'Test Eye', `socketed abyss jewel defaults to abyss: ${eyeSearch.itemCategory}`);
    assert(category(await jewelSearch({ slot: 'Jewel 26725', jewelType: 'base' })) === 'jewel.base', 'jewelType overrides the default');
    log('PASS');

    await test12Flasks(category, weighted);
    await test13WeaponSwap();
    await test15Uniques();
    await test14FlaskFaults(paths, readFileSync(fixturePath, 'utf8'));
    await test16Megalomaniac(paths, readFileSync(fixturePath, 'utf8'));
    await test17FeatureDetection(paths, readFileSync(fixturePath, 'utf8'));
    await test18Grafts(readFileSync(fixturePath, 'utf8'));
    await test19Tinctures();
    log('ALL TRADE SEARCH TESTS PASSED');
  } finally {
    await client.close().catch(() => undefined);
    rmSync(configDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
