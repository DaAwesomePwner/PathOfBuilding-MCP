// search_items / get_item_text / list_item_mods / build_item on Path of Building's
// own item data (test/fixtures/OccVortex.xml):
//   1. search_items finds a known unique and a known base; slot / modQuery filters.
//   2. get_item_text for a unique and for a base: the text swap_item accepts, and
//      compare_items (probe) stats for it equal swap_item's.
//   3. list_item_mods for a body armour base: life / resistance mods with tiers,
//      itemLevel respected, bench crafts on request.
//   4. build_item: a rare (life + 2 resists + a crafted resist) that swap_item
//      accepts with the expected stat change; refusals for a mod that cannot roll,
//      too many prefixes, two mods of one group, unknown base, item level.
//   5. The loaded build's export, undo depth and crash journal are unchanged
//      after every read tool.
import { readFileSync } from 'fs';
import { z } from 'zod';
import { BuildSession } from '../src/build-session.js';
import {
  buildItem, buildItemSchema, getItemText, listItemMods, searchItems,
  type BuildItemArgs, type ItemTextArgs, type ListItemModsArgs, type SearchItemsArgs,
} from '../src/item-data.js';
import { LuaBridge } from '../src/lua-bridge.js';
import { UserError } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function approxEq(a: unknown, b: unknown, tol = 1e-6): boolean {
  const an = Number(a);
  const bn = Number(b);
  if (!Number.isFinite(an) || !Number.isFinite(bn)) return a === b;
  return Math.abs(an - bn) <= tol * Math.max(1, Math.abs(an), Math.abs(bn));
}

interface SearchResult { kind: string; name: string; base?: string; type: string; slot: string; variants?: string[]; mods?: string[] }
interface TextResult { text: string; name: string; base: string; rarity: string; mods: string[]; implicits: string[]; variant?: string; warnings?: string[] }
interface ModRow { id: string; type: string; tier: number; tiers: number; level: number; group: string; text: string; weight: number }
interface ModsResult { mods: ModRow[]; total: number; more: number; prefixLimit: number; suffixLimit: number; crafted?: Array<{ id: string; type: string; text: string }> }
interface BuildResult extends TextResult { affixes: Array<{ id: string; type: string; tier?: number; crafted?: boolean; text: string }> }

const SLOT = 'Body Armour';
const PARITY_KEYS = ['Life', 'EnergyShield', 'TotalEHP', 'CombinedDPS', 'FireResist', 'ColdResist', 'LightningResist', 'Armour', 'Evasion'];

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const bridge = new LuaBridge(paths, 60_000);
  const session = new BuildSession(bridge);
  const search = (a: SearchItemsArgs) => searchItems(session, a) as Promise<{ total: number; more: number; results: SearchResult[] }>;
  const text = (a: ItemTextArgs) => getItemText(session, a) as Promise<TextResult>;
  const mods = (a: ListItemModsArgs) => listItemMods(session, a) as Promise<ModsResult>;
  const build = (a: BuildItemArgs) => buildItem(session, a) as Promise<BuildResult>;
  const state = async (): Promise<string> =>
    JSON.stringify([await session.exportXML(), session.undoStackDepth(), bridge.getRecoveryState()]);
  const refused = async (label: string, fn: () => Promise<unknown>, pattern: RegExp): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      assert(e instanceof UserError, `${label}: expected a UserError, got ${(e as Error).message}`);
      assert(pattern.test(e.message), `${label}: message ${JSON.stringify(e.message)} does not match ${pattern}`);
      log(`  refused (${label}): ${e.message.slice(0, 140)}`);
      return;
    }
    throw new Error(`${label}: expected a refusal`);
  };
  // compare_items (the probe engine) and swap_item must give the same numbers for the text.
  const parity = async (label: string, itemText: string): Promise<Record<string, unknown>> => {
    const compared = await session.compareItems(SLOT, [itemText, itemText]);
    const probed = compared.candidates[0];
    assert(probed.error === null && probed.stats, `${label}: compare_items refused it: ${probed.error}`);
    const swapped = await session.swapItemWithDiff(SLOT, itemText);
    for (const key of PARITY_KEYS) {
      assert(approxEq(probed.stats[key], swapped.after[key]), `${label}: ${key} compare_items ${probed.stats[key]} != swap_item ${swapped.after[key]}`);
    }
    await session.undoLastChange();
    log(`  ${label}: swap_item accepted it; compare_items stats equal swap_item's (Life ${swapped.after.Life}, ES ${swapped.after.EnergyShield})`);
    return swapped.after;
  };

  try {
    await session.loadBuild(readFileSync(fixturePath, 'utf8'));
    const before = await state();
    const unchanged = async (label: string): Promise<void> => {
      assert((await state()) === before, `${label} changed the build, the undo depth or the journal`);
    };

    log('Test 1: search_items');
    const kaom = await search({ query: "Kaom's Heart" });
    assert(kaom.results[0]?.kind === 'unique' && kaom.results[0].name === "Kaom's Heart" && kaom.results[0].base === 'Glorious Plate' && kaom.results[0].slot === SLOT,
      `Kaom's Heart first: ${JSON.stringify(kaom.results[0])}`);
    assert(kaom.results[0].mods?.some((m) => m.includes('+1000 to maximum Life')), 'Kaom\'s Heart mod summary');
    const regalia = await search({ query: 'vaal regalia', kind: 'base' });
    assert(regalia.results[0]?.kind === 'base' && regalia.results[0].name === 'Vaal Regalia' && regalia.results[0].type === 'Body Armour', `Vaal Regalia base: ${JSON.stringify(regalia.results[0])}`);
    assert(regalia.results.every((r) => r.kind === 'base'), 'kind "base" lists bases only');
    const rings = await search({ slot: 'Ring 1', kind: 'unique', modQuery: 'maximum life', limit: 5 });
    assert(rings.results.length === 5 && rings.more === rings.total - 5 && rings.results.every((r) => r.kind === 'unique' && r.type === 'Ring'),
      `ring uniques with life: ${JSON.stringify(rings).slice(0, 400)}`);
    await refused('unknown slot', () => search({ slot: 'Tail' }), /No item base fits slot/);
    await refused('nothing to search for', () => search({}), /query, a slot or a modQuery/);
    await unchanged('search_items');
    log('PASS');

    log('Test 2: get_item_text for a unique and a base');
    const kaomText = await text({ unique: "kaom's heart" });
    assert(kaomText.text.startsWith("Rarity: UNIQUE\nKaom's Heart\nGlorious Plate") && kaomText.mods.includes('+1000 to maximum Life') && kaomText.variant === 'Current',
      `Kaom's Heart text: ${JSON.stringify(kaomText).slice(0, 400)}`);
    await refused('unknown unique', () => text({ unique: 'Kaoms Hart' }), /Unknown unique/);
    await refused('unknown variant', () => text({ unique: "Kaom's Heart", variant: 'Nope' }), /Unknown variant/);
    await refused('unique and base', () => text({ unique: "Kaom's Heart", base: 'Vaal Regalia' }), /either unique or base/);
    const atziriMin = await text({ unique: "Atziri's Splendour", variant: 'Current (Evasion)', roll: 'min' });
    const atziriMax = await text({ unique: "Atziri's Splendour", variant: 'Current (Evasion)' });
    assert(atziriMin.variant === 'Current (Evasion)' && atziriMin.mods.includes('380% increased Evasion Rating') && atziriMax.mods.includes('420% increased Evasion Rating'),
      `Atziri's Splendour rolls: ${JSON.stringify(atziriMin.mods)} / ${JSON.stringify(atziriMax.mods)}`);
    const robeText = await text({ base: 'Vaal Regalia' });
    assert(robeText.text.startsWith('Rarity: NORMAL\nVaal Regalia') && robeText.rarity === 'NORMAL', `Vaal Regalia text: ${robeText.text}`);
    await unchanged('get_item_text');
    const kaomStats = await parity("Kaom's Heart", kaomText.text);
    const atziriStats = await parity("Atziri's Splendour (min roll)", atziriMin.text);
    const atziriMaxStats = await parity("Atziri's Splendour (max roll)", atziriMax.text);
    assert(Number(atziriMaxStats.Evasion) > Number(atziriStats.Evasion), 'max roll gives more evasion than min roll');
    const robeStats = await parity('Vaal Regalia', robeText.text);
    assert(Number(kaomStats.Life) > Number(robeStats.Life) + 1000, `Kaom's Heart adds life: ${kaomStats.Life} vs ${robeStats.Life}`);
    await unchanged('swap_item + undo');
    log('PASS');

    log('Test 3: list_item_mods on a body armour base');
    const life = await mods({ base: 'Vaal Regalia', query: 'to maximum life', affix: 'prefix', limit: 200 });
    const flatLife = life.mods.filter((m) => m.group === 'IncreasedLife');
    assert(flatLife.length >= 10 && flatLife.every((m) => m.type === 'prefix' && m.tiers === flatLife.length && m.weight > 0), `life tiers: ${JSON.stringify(flatLife).slice(0, 400)}`);
    const t1 = flatLife.find((m) => m.tier === 1);
    assert(t1 && flatLife.every((m) => m.level <= t1.level) && /\+\(\d+-\d+\) to maximum Life/.test(t1.text), `tier 1 is the highest level: ${JSON.stringify(t1)}`);
    assert(life.prefixLimit === 3 && life.suffixLimit === 3, 'rare body armour: 3 prefixes, 3 suffixes');
    const low = await mods({ base: 'Vaal Regalia', query: 'to maximum life', affix: 'prefix', itemLevel: 30, limit: 200 });
    const lowLife = low.mods.filter((m) => m.group === 'IncreasedLife');
    assert(lowLife.length > 0 && lowLife.length < flatLife.length && low.mods.every((m) => m.level <= 30) && !lowLife.some((m) => m.tier === 1),
      `itemLevel 30: ${JSON.stringify(lowLife.map((m) => [m.id, m.level]))}`);
    const res = await mods({ base: 'Vaal Regalia', query: 'resistance', affix: 'suffix', includeCrafted: true, limit: 200 });
    for (const group of ['FireResistance', 'ColdResistance', 'LightningResistance']) {
      assert(res.mods.some((m) => m.group === group && m.type === 'suffix' && m.tier === 1), `${group} suffixes listed`);
    }
    assert(res.crafted?.some((c) => c.id.startsWith('bench:') && /Lightning Resistance/.test(c.text)), 'bench lightning resistance listed');
    const weaponMod = (await mods({ base: 'Vaal Regalia', query: 'increased physical damage', limit: 200 })).mods;
    assert(!weaponMod.some((m) => m.id.startsWith('LocalIncreasedPhysicalDamagePercent')), 'local weapon physical damage does not roll on body armour');
    const limited = await mods({ base: 'Vaal Regalia', limit: 3 });
    assert(limited.mods.length === 3 && limited.more === limited.total - 3 && limited.total > 30, `limit and more: ${limited.total} / ${limited.more}`);
    await refused('unknown base (mods)', () => mods({ base: 'Vaal Regalla' }), /Unknown item base "Vaal Regalla".*Vaal Regalia|Unknown item base/);
    await unchanged('list_item_mods');
    log('PASS');

    log('Test 4: build_item');
    const rare = await build({
      base: 'Vaal Regalia',
      name: 'Test Robe',
      mods: ['+110 to maximum Life', 'FireResist7', '+(42-45)% to Cold Resistance'],
      crafted: ['+20% to Lightning Resistance'],
    });
    assert(rare.text.startsWith('Rarity: RARE\nTest Robe\nVaal Regalia') && rare.rarity === 'RARE', `rare text: ${rare.text}`);
    for (const line of ['+110 to maximum Life', '+45% to Fire Resistance', '+45% to Cold Resistance', '+20% to Lightning Resistance (crafted)']) {
      assert(rare.mods.includes(line), `rare has "${line}": ${JSON.stringify(rare.mods)}`);
    }
    assert(rare.affixes.find((a) => a.id === 'FireResist7')?.tier === 2 && rare.affixes.some((a) => a.crafted && a.id.startsWith('bench:')), `affixes: ${JSON.stringify(rare.affixes)}`);
    await unchanged('build_item');
    const rareStats = await parity('built rare', rare.text);
    assert(Number(rareStats.Life) > Number(robeStats.Life), `the rare adds life: ${rareStats.Life} vs ${robeStats.Life}`);
    for (const key of ['FireResist', 'ColdResist', 'LightningResist']) {
      assert(Number(rareStats[key]) > Number(robeStats[key]) || Number(robeStats[key]) >= 75, `${key} rises: ${robeStats[key]} -> ${rareStats[key]}`);
    }
    // The stat change is the one its mods give: the same item written by hand scores the same.
    const byHand = ['Rarity: RARE', 'Hand Robe', 'Vaal Regalia', 'Item Level: 86', 'Quality: 20', 'Sockets: B-B-B-B-B-B', 'Implicits: 0',
      '+110 to maximum Life', '+45% to Fire Resistance', '+45% to Cold Resistance', '{crafted}+20% to Lightning Resistance'].join('\n');
    const both = await session.compareItems(SLOT, [rare.text, byHand]);
    for (const key of ['Life', 'FireResist', 'ColdResist', 'LightningResist', 'TotalEHP', 'CombinedDPS']) {
      assert(approxEq(both.candidates[0].stats?.[key], both.candidates[1].stats?.[key]), `${key}: built ${both.candidates[0].stats?.[key]} != by hand ${both.candidates[1].stats?.[key]}`);
    }
    const lifeOnly = await build({ base: 'Vaal Regalia', mods: ['IncreasedLife7'], roll: 'min' });
    assert(lifeOnly.mods.includes('+100 to maximum Life'), `roll min: ${JSON.stringify(lifeOnly.mods)}`);
    const avg = await build({ base: 'Vaal Regalia', rarity: 'magic', mods: ['IncreasedLife7', 'FireResist1'], roll: 'avg', quality: 0 });
    assert(avg.rarity === 'MAGIC' && avg.mods.includes('+107 to maximum Life') && /\nQuality: 0\n/.test(avg.text), `magic avg: ${JSON.stringify(avg)}`.slice(0, 500));
    await parity('magic item', avg.text);

    const prefixes = (await mods({ base: 'Vaal Regalia', affix: 'prefix', limit: 200 })).mods;
    const byGroup = new Map<string, string>();
    for (const m of prefixes) if (!byGroup.has(m.group)) byGroup.set(m.group, m.id);
    const fourPrefixes = [...byGroup.values()].slice(0, 4);
    assert(fourPrefixes.length === 4, 'four prefix groups');
    await refused('mod that cannot roll', () => build({ base: 'Vaal Regalia', mods: ['LocalIncreasedPhysicalDamagePercent1'] }), /cannot roll on Vaal Regalia/);
    await refused('too many prefixes', () => build({ base: 'Vaal Regalia', mods: fourPrefixes }), /4 prefixes .* can have 3/);
    await refused('magic: two prefixes', () => build({ base: 'Vaal Regalia', rarity: 'magic', mods: fourPrefixes.slice(0, 2) }), /2 prefixes .* can have 1/);
    const threeNonLife = [...byGroup.entries()].filter(([g]) => g !== 'IncreasedLife').slice(0, 3).map(([, id]) => id);
    await refused('crafted prefix over the limit', () => build({ base: 'Vaal Regalia', mods: threeNonLife, crafted: ['bench:1'] }), /4 prefixes \(crafted ones included\)/);
    await refused('two mods of one group', () => build({ base: 'Vaal Regalia', mods: ['IncreasedLife7', 'IncreasedLife8'] }), /both in mod group IncreasedLife/);
    await refused('crafted mod in a used group', () => build({ base: 'Vaal Regalia', mods: ['IncreasedLife7'], crafted: ['bench:1'] }), /both in mod group IncreasedLife/);
    await refused('unknown base', () => build({ base: 'Nope Robe' }), /Unknown item base "Nope Robe"/);
    await refused('item level', () => build({ base: 'Vaal Regalia', mods: ['IncreasedLife12'], itemLevel: 80 }), /needs item level 86/);
    await refused('value out of every tier', () => build({ base: 'Vaal Regalia', mods: ['+500 to maximum Life'] }), /outside every tier/);
    await refused('unknown mod', () => build({ base: 'Vaal Regalia', mods: ['+3 to Level of all Minion Skill Gems and a pony'] }), /No prefix or suffix matches/);
    await refused('normal item with mods', () => build({ base: 'Vaal Regalia', rarity: 'normal', mods: ['IncreasedLife7'] }), /normal item has no prefixes/);
    await refused('bench id for another class', () => build({ base: 'Vaal Regalia', crafted: ['bench:99999'] }), /not a crafting bench/);
    await refused('rare flask', () => build({ base: 'Divine Life Flask', rarity: 'rare' }), /cannot be rare/);
    await refused('duplicate mods', () => build({ base: 'Vaal Regalia', mods: ['IncreasedLife7', 'increasedlife7'] }), /twice/);
    assert(!z.object(buildItemSchema).safeParse({ base: 'Vaal Regalia', name: 'Two\nLines' }).success, 'a name with a newline is refused by the schema');
    assert(!z.object(buildItemSchema).safeParse({ base: 'Vaal Regalia', mods: Array.from({ length: 13 }, () => 'IncreasedLife7') }).success, '13 mods are refused by the schema');
    await unchanged('build_item refusals');
    log('PASS');

    log('ALL PASS');
  } finally {
    await bridge.dispose();
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
