// Item snapshot/restore exactness: every what-if item probe and every undo
// must put each slot back to the same item id (not a re-added copy), leave no
// probe items behind, cover every slot the engine has, and keep the exported
// build byte-identical with bit-exact stats. Items that cannot go in a slot,
// and item text PoB cannot parse, are refused before anything changes.
//
//   1. compare_items on Ring 1 (and on Weapon 1 with a two-hander, which makes
//      PoB empty Weapon 2) repeated many times: item list, slot ids, export
//      and stats unchanged, no growth.
//   2. swap_item + undo re-selects the original id, no duplicate.
//   3. A helmet into a ring slot, and an abyss jewel into an abyssal socket
//      the item does not have, are UserErrors; the slot keeps its item and
//      no undo entry is pushed.
//   4. Unparseable item text is a UserError even right after a refused item
//      that did parse; the slot keeps its item.
//   5. Slots the old hardcoded list missed (Ring 3, abyssal sockets) are
//      restored by probes and by undo.
//   6. On ConvertTreeMasteries.xml (jewels 17/18/19 socketed): a tree
//      snapshot taken first still restores exactly, with its jewel item ids
//      resolving, after item probes on rings and on a jewel socket, and after
//      a jewel swap + undo.
//   7. Two swaps then two undos step back exactly.
//   8. Ring and jewel swaps before and after convert_tree_to_latest, undone
//      back to the loaded build.
//   9. More than 20 committed swaps (undo cap): undoing what is left leaves
//      items behind but never removes one in use.
//  10. A second item set (OccVortexItemSets.xml) survives probes and undo.
//  11. A full snapshot taken before reset_build is refused, as an internal
//      error naming reset_build, before anything changes.
//  12. A load_build PoB rejects keeps the previous build (the bridge reloads
//      it from its own save): undo entries taken before it (item, jewel,
//      config, tree conversion) still undo back to the loaded build, also
//      with crafted, variant and ranged items whose text PoB re-serialises.
//  13. Item identity tokens differ between engine processes, so a snapshot
//      from an engine that has since crashed or been replaced (same build,
//      same ids) is refused by the new one.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BuildSession } from '../src/build-session.js';
import { LuaBridge, Stats } from '../src/lua-bridge.js';
import { UserError } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const MASTERY_FIXTURE = path.resolve(testDir, 'fixtures', 'ConvertTreeMasteries.xml');
const JEWEL_SOCKET = 36634; // holds item 17 in ConvertTreeMasteries.xml
// OccVortex.xml plus a second item set (Ring 1 = a ring of its own, id 8,
// Amulet = the shared amulet), made through PoB's ItemsTab:NewItemSet and
// ItemsTab:EquipItemInSet and saved with exportXML.
const ITEM_SETS_FIXTURE = path.resolve(testDir, 'fixtures', 'OccVortexItemSets.xml');

const AMULET = `Rarity: RARE
Item Restore Amulet
Jade Amulet
Item Level: 80
Implicits: 1
+25 to Dexterity
+60 to maximum Life`;

const RING_A = `Rarity: RARE
Item Restore Ring A
Coral Ring
Item Level: 63
LevelReq: 64
Implicits: 1
+30 to maximum Life
+150 to maximum Life
+30% to all Elemental Resistances`;

const RING_B = `Rarity: RARE
Item Restore Ring B
Iron Ring
Item Level: 50
Implicits: 1
Adds 1 to 4 Physical Damage to Attacks
+30 to Strength
+30 to Intelligence`;

const STAFF = `Rarity: RARE
Item Restore Staff
Imperial Staff
Item Level: 80
Implicits: 1
+20% Chance to Block Attack Damage while wielding a Staff
+1 to Level of all Spell Skill Gems
50% increased Spell Damage`;

const HELMET = `Rarity: RARE
Item Restore Helmet
Hubris Circlet
Item Level: 84
+80 to maximum Life`;

const ABYSS_HELMET = `Rarity: RARE
Item Restore Abyss Helmet
Hubris Circlet
Item Level: 84
Has 1 Abyssal Socket
+70 to maximum Life`;

const ABYSS_JEWEL_A = `Rarity: RARE
Item Restore Eye A
Murderous Eye Jewel
Item Level: 84
+40 to maximum Life`;

const ABYSS_JEWEL_B = `Rarity: RARE
Item Restore Eye B
Murderous Eye Jewel
Item Level: 84
+20 to maximum Life
+10% to Fire Resistance`;

const JEWEL_A = `Rarity: RARE
Item Restore Jewel A
Cobalt Jewel
Item Level: 84
+8% to all Elemental Resistances
10% increased maximum Energy Shield`;

const JEWEL_B = `Rarity: RARE
Item Restore Jewel B
Crimson Jewel
Item Level: 84
7% increased maximum Life`;

// Item text PoB re-serialises when it saves (ItemsTab:Save rebuilds the raw
// text): a crafted mod, a unique with variants, and rolled ranges.
const CRAFTED_RING = `Rarity: RARE
Item Restore Crafted Ring
Two-Stone Ring
Item Level: 84
Implicits: 1
+(12-16)% to Cold and Lightning Resistances
+42 to maximum Life
{crafted}+35% to Fire Resistance`;

const VARIANT_RING = `Rarity: UNIQUE
Item Restore Variant Ring
Gold Ring
Variant: Old
Variant: New
Selected Variant: 2
Implicits: 1
(6-15)% increased Rarity of Items found
{variant:1}+20 to maximum Life
{variant:2}+40 to maximum Life
+25% to Fire Resistance`;

const RANGED_AMULET = `Rarity: RARE
Item Restore Ranged Amulet
Onyx Amulet
Item Level: 84
Implicits: 1
{range:0.5}+(10-16) to all Attributes
{range:0.25}+(70-79) to maximum Life
{range:1}+(36-41)% to Cold Resistance`;

const GARBAGE = `Rarity: RARE
Item Restore Garbage
Not A Real Base Type
+10 to maximum Life`;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface ItemsState {
  slots: Array<[string, number]>;
  itemOrder: number[];
}

interface BuildState {
  items: ItemsState;
  xml: string;
  stats: Pick<Stats, 'Life' | 'CombinedDPS' | 'TotalEHP'>;
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/**
 * Item list order and the occupied slots of the active item set, read from
 * the exported XML (independent of the bridge's own item-state command).
 */
function itemsSection(xml: string): string {
  const start = xml.indexOf('<Items');
  return xml.slice(start, xml.indexOf('</Items>', start));
}

/** Occupied slots of item set `setId` in an exported build. */
function itemSetSlots(xml: string, setId: string): Map<string, number> {
  const set = [...itemsSection(xml).matchAll(/<ItemSet [^>]*>([\s\S]*?)<\/ItemSet>/g)].find((m) => attrs(m[0].slice(0, m[0].indexOf('>'))).id === setId);
  assert(set, `item set ${setId} not found in the export`);
  const slots = new Map<string, number>();
  for (const m of set[1].matchAll(/<Slot [^>]*\/>/g)) {
    const a = attrs(m[0]);
    if (Number(a.itemId) !== 0) slots.set(a.name, Number(a.itemId));
  }
  return slots;
}

function itemsFromXml(xml: string): ItemsState {
  const section = itemsSection(xml);
  const active = attrs(/<Items[^>]*>/.exec(section)?.[0] ?? '').activeItemSet;
  const itemOrder = [...section.matchAll(/<Item id="(\d+)"/g)].map((m) => Number(m[1]));
  return { slots: [...itemSetSlots(xml, active)], itemOrder };
}

async function itemsState(session: BuildSession): Promise<ItemsState> {
  return itemsFromXml(await session.exportXML());
}

async function buildState(session: BuildSession): Promise<BuildState> {
  const stats = await session.getStats();
  const xml = await session.exportXML();
  return {
    items: itemsFromXml(xml),
    xml,
    stats: { Life: stats.Life, CombinedDPS: stats.CombinedDPS, TotalEHP: stats.TotalEHP },
  };
}

function slotId(state: ItemsState, slot: string): number {
  return state.slots.find(([name]) => name === slot)?.[1] ?? 0;
}

function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}: ...${JSON.stringify(a.slice(Math.max(0, i - 80), i + 80))}\n  vs ...${JSON.stringify(b.slice(Math.max(0, i - 80), i + 80))}`;
}

/**
 * Sort every exported passive node list and drop the tree URL, which encodes
 * the same list in the same order: both follow Lua table order, which a spec
 * rebuild (tree conversion, or undoing one) reshuffles.
 */
function sortNodeLists(xml: string): string {
  return xml
    .replace(/ nodes="([\d,]*)"/g, (_m, list: string) => ` nodes="${list.split(',').map(Number).sort((x, y) => x - y).join(',')}"`)
    .replace(/<URL>[\s\S]*?<\/URL>/g, '<URL/>');
}

/**
 * For builds whose spec PoB rebuilt (tree conversion or its undo) or that PoB
 * re-read from its own save (the failed-load recovery):
 * every list PoB writes in Lua table order may come back in another order.
 * Node lists are sorted (sortNodeLists), attributes are sorted inside each
 * tag, runs of consecutive self-closing sibling elements at one indentation
 * (<Input/>, <PlayerStat/>, <Slot/> mixed with <SocketIdURL/>, <Socket/>, ...)
 * are sorted, and so are the top-level sections. <Gem/> lines keep their
 * order (it is the gem order of a socket group). Items keep their order and
 * text (they are not self-closing), and the item list and slot ids are
 * compared separately anyway.
 */
function canonicalXml(xml: string): string {
  const lines = sortNodeLists(xml)
    .split('\n')
    .map((line) =>
      line.replace(/<(\w+)((?:\s+\w+="[^"]*")+)\s*(\/?)>/g, (_m, tag: string, attrList: string, close: string) =>
        `<${tag} ${[...attrList.matchAll(/\w+="[^"]*"/g)].map((m) => m[0]).sort().join(' ')}${close}>`),
    );
  const out: string[] = [];
  let run: string[] = [];
  let runKey: string | null = null;
  const flush = (): void => {
    out.push(...run.sort());
    run = [];
  };
  for (const line of lines) {
    const m = /^(\s*)<(\w+)\b[^>]*\/>\s*$/.exec(line);
    const key = m && m[2] !== 'Gem' ? m[1] : null;
    if (key === null || key !== runKey) flush();
    runKey = key;
    if (key === null) out.push(line);
    else run.push(line);
  }
  flush();
  // Top-level sections (<Build>, <Items>, <Config>, ...) are written in the
  // order of a Lua table too, which can differ between engine processes.
  const blocks: string[][] = [];
  const head: string[] = [];
  const tail: string[] = [];
  for (const line of out) {
    if (/^<\/PathOfBuilding>/.test(line) || tail.length > 0) tail.push(line);
    else if (/^\t<\w/.test(line)) blocks.push([line]);
    else if (blocks.length > 0) blocks[blocks.length - 1].push(line);
    else head.push(line);
  }
  blocks.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return [...head, ...blocks.flat(), ...tail].join('\n');
}

/**
 * 'rebuilt': PoB rebuilt the passive spec or re-read the build, so the order
 * of table-ordered lists may differ (canonicalXml); everything else exact.
 */
type XmlCompare = false | 'rebuilt';

function assertSameBuild(label: string, actual: BuildState, expected: BuildState, compare: XmlCompare = false): void {
  assert(
    JSON.stringify(actual.items.itemOrder) === JSON.stringify(expected.items.itemOrder),
    `${label}: item list differs\n  expected ${JSON.stringify(expected.items.itemOrder)}\n  actual   ${JSON.stringify(actual.items.itemOrder)}`,
  );
  const sorted = (s: ItemsState): string => JSON.stringify([...s.slots].sort((x, y) => x[0].localeCompare(y[0])));
  assert(
    sorted(actual.items) === sorted(expected.items),
    `${label}: slot item ids differ\n  expected ${sorted(expected.items)}\n  actual   ${sorted(actual.items)}`,
  );
  for (const key of ['Life', 'CombinedDPS', 'TotalEHP'] as const) {
    assert(actual.stats[key] === expected.stats[key], `${label}: ${key} not bit-exact (${actual.stats[key]} != ${expected.stats[key]})`);
  }
  const norm = (xml: string): string => (compare === 'rebuilt' ? canonicalXml(xml) : xml);
  assert(norm(actual.xml) === norm(expected.xml), `${label}: exported XML differs ${firstDifference(norm(actual.xml), norm(expected.xml))}`);
}

async function expectUserError(label: string, fn: () => Promise<unknown>, ...needles: string[]): Promise<string> {
  let caught: unknown = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof UserError, `${label}: expected a UserError, got ${caught instanceof Error ? `${caught.constructor.name}: ${caught.message}` : String(caught)}`);
  for (const needle of needles) {
    assert(caught.message.includes(needle), `${label}: error "${caught.message}" does not mention "${needle}"`);
  }
  return caught.message;
}

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const occXml = readFileSync(fixturePath, 'utf8');
  const masteryXml = readFileSync(MASTERY_FIXTURE, 'utf8');
  const bridge = new LuaBridge(paths, 120_000);
  const session = new BuildSession(bridge);

  try {
    await session.loadBuild(occXml);
    const base = await buildState(session);
    assert(slotId(base.items, 'Ring 1') !== 0 && slotId(base.items, 'Weapon 2') !== 0, 'fixture should have Ring 1 and Weapon 2 equipped');

    // ---------------------------------------------------------------- 1
    log('Test 1: repeated what-if item comparisons leave the build unchanged');
    for (let i = 0; i < 12; i++) {
      const cmp = await session.compareItems('Ring 1', [RING_A, RING_B]);
      assert(cmp.candidates.every((c) => c.error === null && c.stats !== null), `compare ${i} had a failed candidate: ${JSON.stringify(cmp.candidates.map((c) => c.error))}`);
      assertSameBuild(`after compare_items #${i + 1}`, await buildState(session), base);
    }
    // A two-hander in Weapon 1 makes PoB empty Weapon 2 (the shield).
    const staff = await session.compareItems('Weapon 1', [STAFF]);
    assert(staff.candidates[0].error === null, `staff probe failed: ${staff.candidates[0].error}`);
    assertSameBuild('after a two-hander probe in Weapon 1', await buildState(session), base);
    await session.suggestUpgrades();
    assertSameBuild('after suggest_upgrades', await buildState(session), base);
    await session.withTemporaryChange(async (b) => {
      await b.send({ cmd: 'equipItem', slot: 'Ring 2', itemText: RING_B });
    });
    assertSameBuild('after withTemporaryChange', await buildState(session), base);
    log('PASS: item list, slot ids, export and stats unchanged after 12 comparisons and other probes');

    // ---------------------------------------------------------------- 2
    log('Test 2: swap_item then undo re-selects the original item');
    const ring1 = slotId(base.items, 'Ring 1');
    await session.swapItemWithDiff('Ring 1', RING_A);
    const swapped = await itemsState(session);
    assert(slotId(swapped, 'Ring 1') !== ring1, 'swap did not change Ring 1');
    assert(swapped.itemOrder.includes(ring1), 'the replaced ring must stay in the build for undo');
    await session.undoLastChange();
    assertSameBuild('after swap_item + undo', await buildState(session), base);
    await session.swapItemWithDiff('Weapon 1', STAFF);
    assert(slotId(await itemsState(session), 'Weapon 2') === 0, 'PoB should empty Weapon 2 for a two-hander');
    await session.undoLastChange();
    assertSameBuild('after a two-hander swap + undo', await buildState(session), base);
    log('PASS: undo re-selects the original ids and leaves no duplicate');

    // ---------------------------------------------------------------- 3
    log('Test 3: an item that does not fit the slot is refused before any change');
    const depth = session.undoStackDepth();
    await expectUserError('helmet into Ring 1', () => session.swapItemWithDiff('Ring 1', HELMET), 'cannot be equipped in Ring 1: a Helmet item does not go in that slot');
    await expectUserError('abyss jewel into a missing abyssal socket', () => session.swapItemWithDiff('Helmet Abyssal Socket 1', ABYSS_JEWEL_A), 'cannot be equipped in Helmet Abyssal Socket 1: the item in Helmet has 0 abyssal socket(s)');
    await expectUserError('ring into a jewel socket', () => session.equipItem(`Jewel ${JEWEL_SOCKET}`, RING_A), `cannot be equipped in Jewel ${JEWEL_SOCKET}: only jewels go in passive tree jewel sockets`);
    assert(session.undoStackDepth() === depth, 'a refused swap must not push an undo entry');
    assertSameBuild('after refused items', await buildState(session), base);
    const refusedCmp = await session.compareItems('Ring 1', [HELMET, RING_A]);
    assert(refusedCmp.candidates[0].error?.includes('Ring 1: a Helmet item does not go in that slot') && refusedCmp.candidates[0].stats === null, `helmet candidate should fail: ${JSON.stringify(refusedCmp.candidates[0])}`);
    assert(refusedCmp.candidates[1].error === null, 'the ring candidate should still be evaluated');
    assertSameBuild('after a comparison with a refused candidate', await buildState(session), base);
    log('PASS: refused with the slot named; slot, item list and undo stack unchanged');

    // ---------------------------------------------------------------- 4
    log('Test 4: unparseable item text is refused and nothing stale is equipped');
    const helmetId = slotId(base.items, 'Helmet');
    // The helmet parses fine (it is only refused for the slot); unparseable
    // text right after must not equip it in the Helmet slot.
    await expectUserError('helmet into Ring 2', () => session.equipItem('Ring 2', HELMET), 'cannot be equipped in Ring 2: a Helmet item does not go in that slot');
    await expectUserError('garbage into Helmet', () => session.swapItemWithDiff('Helmet', GARBAGE), 'Could not parse the item text for Helmet: Path of Building does not recognise its base type');
    await expectUserError('garbage into Helmet (unequipped path)', () => session.equipItem('Helmet', GARBAGE), 'Could not parse the item text for Helmet:');
    const afterGarbage = await buildState(session);
    assert(slotId(afterGarbage.items, 'Helmet') === helmetId, 'Helmet lost its item');
    assert(session.undoStackDepth() === depth, 'an unparseable swap must not push an undo entry');
    assertSameBuild('after unparseable item text', afterGarbage, base);
    log('PASS: unparseable text refused; Helmet keeps its item');

    // ---------------------------------------------------------------- 5
    log('Test 5: slots outside the old hardcoded list are restored');
    // Ring 3 (PoB keeps it whether or not the build can use a third ring).
    await session.equipItem('Ring 3', RING_A);
    await session.equipItem('Helmet', ABYSS_HELMET);
    await session.equipItem('Helmet Abyssal Socket 1', ABYSS_JEWEL_A);
    const extra = await buildState(session);
    const ring3 = slotId(extra.items, 'Ring 3');
    const eye = slotId(extra.items, 'Helmet Abyssal Socket 1');
    assert(ring3 !== 0 && eye !== 0, `Ring 3 / abyssal socket not equipped: ${JSON.stringify(extra.items.slots)}`);

    await session.compareItems('Ring 3', [RING_B]);
    assertSameBuild('after a Ring 3 probe', await buildState(session), extra);
    // A helmet without the abyssal socket makes PoB drop the abyss jewel.
    await session.compareItems('Helmet', [HELMET]);
    assertSameBuild('after a helmet probe that drops the abyss jewel', await buildState(session), extra);
    await session.compareItems('Helmet Abyssal Socket 1', [ABYSS_JEWEL_B]);
    assertSameBuild('after an abyssal socket probe', await buildState(session), extra);

    await session.swapItemWithDiff('Ring 3', RING_B);
    await session.undoLastChange();
    assertSameBuild('after Ring 3 swap + undo', await buildState(session), extra);
    await session.swapItemWithDiff('Helmet Abyssal Socket 1', ABYSS_JEWEL_B);
    await session.undoLastChange();
    assertSameBuild('after abyssal socket swap + undo', await buildState(session), extra);
    await session.unequipItemWithDiff('Helmet Abyssal Socket 1');
    await session.undoLastChange();
    assertSameBuild('after abyssal socket unequip + undo', await buildState(session), extra);
    await session.swapItemWithDiff('Helmet', HELMET);
    assert(slotId(await itemsState(session), 'Helmet Abyssal Socket 1') === 0, 'PoB should drop the abyss jewel with the socket');
    await session.undoLastChange();
    assertSameBuild('after a helmet swap that dropped the abyss jewel + undo', await buildState(session), extra);
    log('PASS: Ring 3 and abyssal sockets restored by probes and by undo');

    // ---------------------------------------------------------------- 6
    log('Test 6: tree snapshots holding jewel item ids restore exactly after item probes');
    await session.loadBuild(masteryXml);
    const m0 = await buildState(session);
    const treeSnap = await session.snapshotTree();
    // Encoded by the bridge as [socket node id, item id] pairs.
    const jewels = new Map((treeSnap.state as { jewels?: Array<[number, number]> }).jewels ?? []);
    const jewelIds = [...jewels.values()].filter((id) => id !== 0);
    assert(jewelIds.length === 3, `fixture should socket 3 jewels, tree state has ${JSON.stringify([...jewels])}`);
    assert(jewels.get(JEWEL_SOCKET) === 17, `socket ${JEWEL_SOCKET} should hold item 17`);

    for (let i = 0; i < 5; i++) {
      await session.compareItems('Ring 2', [RING_A, RING_B]);
      await session.compareItems(`Jewel ${JEWEL_SOCKET}`, [JEWEL_A, JEWEL_B]);
    }
    assertSameBuild('after ring and jewel-socket probes', await buildState(session), m0);
    await session.swapItemWithDiff(`Jewel ${JEWEL_SOCKET}`, JEWEL_A);
    await session.compareItems('Ring 1', [RING_A]);
    await session.undoLastChange();
    assertSameBuild('after a jewel swap + probe + undo', await buildState(session), m0);
    await session.restoreTree(treeSnap);
    assertSameBuild('after restoring the early tree snapshot onto an unchanged tree', await buildState(session), m0);

    // Commit a jewel swap, then put the early tree snapshot back: the socket
    // must hold item 17 again, which the item probes above must not have
    // deleted or renumbered.
    await session.swapItemWithDiff(`Jewel ${JEWEL_SOCKET}`, JEWEL_B);
    await session.compareItems('Amulet', [RING_A]).catch(() => undefined); // refused candidate, not a throw
    await session.restoreTree(treeSnap);
    const restoredJewels = new Map(
      (await bridge.send<{ state: { jewels: Array<[number, number]> } }>({ cmd: 'captureSpecState' })).state.jewels,
    );
    assert(restoredJewels.get(JEWEL_SOCKET) === 17, `socket ${JEWEL_SOCKET} holds ${restoredJewels.get(JEWEL_SOCKET)} after restoreTree`);
    const m1 = await buildState(session);
    for (const id of jewelIds) assert(m1.items.itemOrder.includes(id), `jewel item ${id} referenced by the tree snapshot is gone`);
    for (const key of ['Life', 'CombinedDPS', 'TotalEHP'] as const) {
      assert(m1.stats[key] === m0.stats[key], `after restoreTree: ${key} not bit-exact (${m1.stats[key]} != ${m0.stats[key]})`);
    }
    // The swapped-in jewel is still in the build (only the tree was restored);
    // undo removes it and leaves the build exactly as loaded.
    await session.undoLastChange();
    assertSameBuild('after undoing the committed jewel swap', await buildState(session), m0);
    log('PASS: early tree snapshot restores exactly; its jewel item ids still resolve');

    // ---------------------------------------------------------------- 7
    log('Test 7: two swaps then two undos step back exactly');
    await session.loadBuild(occXml);
    const t0 = await buildState(session);
    await session.swapItemWithDiff('Ring 1', RING_A);
    const t1 = await buildState(session);
    await session.swapItemWithDiff('Ring 1', RING_B);
    const t2 = await buildState(session);
    assert(t2.items.itemOrder.includes(slotId(t1.items, 'Ring 1')), 'ring A must stay in the build for the undo');
    assert(slotId(t2.items, 'Ring 1') !== slotId(t1.items, 'Ring 1'), 'the second swap did not change Ring 1');
    await session.undoLastChange();
    assertSameBuild('after the first undo (back to ring A)', await buildState(session), t1);
    await session.undoLastChange();
    assertSameBuild('after the second undo (back to the loaded ring)', await buildState(session), t0);
    log('PASS: A->B->C, undo, undo restores each step exactly');

    // ---------------------------------------------------------------- 8
    log('Test 8: item and jewel swaps around convert_tree_to_latest, both orders');
    // Converting rebuilds the passive spec, and undoing it rebuilds it again;
    // PoB writes the allocated nodes and socketed jewels in Lua table order,
    // so after a spec rebuild only the order of such lists may differ (same
    // entries). Compared with canonicalXml; items, slot ids and stats exact.
    await session.loadBuild(masteryXml);
    const c0 = await buildState(session);
    await session.swapItemWithDiff('Ring 1', RING_A);
    const a1 = await buildState(session);
    await session.swapItemWithDiff(`Jewel ${JEWEL_SOCKET}`, JEWEL_A);
    const a2 = await buildState(session);
    const conv1 = await session.convertTreeToLatest();
    assert(conv1.converted, 'the 3_24 fixture should convert');
    await session.undoLastChange();
    assertSameBuild('order 1: after undoing the conversion', await buildState(session), a2, 'rebuilt');
    await session.undoLastChange();
    assertSameBuild('order 1: after undoing the jewel swap', await buildState(session), a1, 'rebuilt');
    await session.undoLastChange();
    assertSameBuild('order 1: after undoing the ring swap', await buildState(session), c0, 'rebuilt');

    await session.loadBuild(masteryXml);
    const conv2 = await session.convertTreeToLatest();
    assert(conv2.converted, 'the 3_24 fixture should convert');
    const b1 = await buildState(session);
    await session.swapItemWithDiff(`Jewel ${JEWEL_SOCKET}`, JEWEL_B);
    const b2 = await buildState(session);
    await session.swapItemWithDiff('Ring 1', RING_B);
    await session.compareItems(`Jewel ${JEWEL_SOCKET}`, [JEWEL_A]);
    await session.undoLastChange();
    assertSameBuild('order 2: after undoing the ring swap', await buildState(session), b2);
    await session.undoLastChange();
    assertSameBuild('order 2: after undoing the jewel swap', await buildState(session), b1);
    await session.undoLastChange();
    assertSameBuild('order 2: after undoing the conversion', await buildState(session), c0, 'rebuilt');
    log('PASS: swaps before and after a tree conversion undo back to the loaded build');

    // ---------------------------------------------------------------- 9
    log('Test 9: more than 20 committed swaps, then undo everything that is left');
    await session.loadBuild(occXml);
    const u0 = await buildState(session);
    let afterFifth: BuildState | null = null;
    for (let i = 1; i <= 25; i++) {
      await session.swapItemWithDiff('Ring 1', i % 2 ? RING_A : RING_B);
      if (i === 5) afterFifth = await buildState(session);
    }
    assert(afterFifth, 'state after the fifth swap not recorded');
    assert(session.undoStackDepth() === 20, `undo depth ${session.undoStackDepth()}, expected the 20-entry cap`);
    for (let i = 0; i < 20; i++) await session.undoLastChange();
    const trimmed = await buildState(session);
    assertSameBuild('after undoing all 20 remaining entries', trimmed, afterFifth);
    // Items from the five trimmed swaps are left behind (unequipped), and
    // nothing in use was removed: the loaded items are all still there.
    assert(trimmed.items.itemOrder.length === u0.items.itemOrder.length + 5, `expected 5 leftover items: ${JSON.stringify(trimmed.items.itemOrder)}`);
    for (const id of u0.items.itemOrder) assert(trimmed.items.itemOrder.includes(id), `loaded item ${id} was removed`);
    for (const [slot, id] of trimmed.items.slots) assert(trimmed.items.itemOrder.includes(id), `${slot} holds missing item ${id}`);
    await expectUserError('undo past the trimmed entries', () => session.undoLastChange(), 'empty');
    await session.compareItems('Ring 1', [RING_B]);
    assertSameBuild('after a probe on the trimmed build', await buildState(session), afterFifth);
    log('PASS: the trim leaves items behind, never removes one in use');

    // ---------------------------------------------------------------- 10
    log('Test 10: items of a non-active item set survive probes and undo');
    await session.loadBuild(readFileSync(ITEM_SETS_FIXTURE, 'utf8'));
    const s0 = await buildState(session);
    const secondSet = itemSetSlots(s0.xml, '2');
    assert(secondSet.get('Ring 1') === 8 && secondSet.get('Amulet') === slotId(s0.items, 'Amulet'), `fixture item set 2: ${JSON.stringify([...secondSet])}`);
    assert(!s0.items.slots.some(([, id]) => id === 8), 'the set-2 ring must not be equipped in the active set');
    for (let i = 0; i < 3; i++) await session.compareItems('Ring 1', [RING_A, RING_B]);
    await session.compareItems('Amulet', [RING_A]);
    await session.suggestUpgrades();
    await session.swapItemWithDiff('Ring 1', RING_A);
    await session.swapItemWithDiff('Amulet', AMULET);
    await session.undoLastChange();
    await session.undoLastChange();
    const s1 = await buildState(session);
    assertSameBuild('after probes and undo with two item sets', s1, s0);
    assert(JSON.stringify([...itemSetSlots(s1.xml, '2')]) === JSON.stringify([...secondSet]), 'item set 2 changed');
    log('PASS: the second item set and its own ring are untouched');

    // ---------------------------------------------------------------- 11
    log('Test 11: a snapshot taken before reset_build is refused before anything changes');
    await session.loadBuild(occXml);
    await session.swapItemWithDiff('Ring 1', RING_A); // a differing build, so a wrong restore would show
    const stale = await session.snapshotAll();
    await session.resetBuild();
    await session.swapItemWithDiff('Ring 2', RING_B);
    const r0 = await buildState(session);
    let caught: unknown = null;
    try {
      await session.restoreAll(stale);
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof Error && !(caught instanceof UserError), `stale restore should be an internal error, got ${String(caught)}`);
    assert(/does not match the build/.test(caught.message) && /restarted or the build was reloaded/.test(caught.message) && /reset_build/.test(caught.message) && /nothing was restored/.test(caught.message), `unexpected message: ${caught.message}`);
    assertSameBuild('after a refused stale full restore', await buildState(session), r0);
    caught = null;
    try {
      await bridge.send({ cmd: 'restoreItemsState', state: stale.items });
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof Error && !(caught instanceof UserError) && /reset_build/.test(caught.message), `stale item restore should be refused: ${String(caught)}`);
    assertSameBuild('after a refused stale item restore', await buildState(session), r0);
    log('PASS: a mismatched snapshot is refused with an internal error naming reset_build');

    // ---------------------------------------------------------------- 12
    log('Test 12: undo still works after a load_build that PoB rejects');
    const badXml = occXml.replace(/treeVersion="3_13"/g, 'treeVersion="9_99"');
    const failLoad = async (label: string): Promise<void> => {
      let err: unknown = null;
      try {
        await session.loadBuild(badXml);
      } catch (e) {
        err = e;
      }
      assert(err instanceof Error && /previously loaded build is still active/.test(err.message), `${label}: expected a recovered failed load, got ${String(err)}`);
    };
    // The recovery reloads the build from the bridge's own SaveDB output, so
    // what is left is PoB's re-read of that save. A first re-read is not
    // byte-idempotent (values PoB saved as "nil" come back as defaults, a
    // <TimelessData> gains socketFilterDistance), so the build is put through
    // one failed load before any baseline is taken: every expected state is
    // then already in re-read form and is compared strictly ('rebuilt': only
    // the order of table-ordered lists may differ; items, slot ids and stats
    // exact).
    await session.loadBuild(occXml);
    await failLoad('priming');
    // The plain case: swap, failed load, undo.
    const f0 = await buildState(session);
    await session.swapItemWithDiff('Ring 1', RING_A);
    const f1 = await buildState(session);
    await failLoad('after a swap');
    assertSameBuild('after the failed load (build kept as left)', await buildState(session), f1, 'rebuilt');
    await session.undoLastChange();
    assertSameBuild('swap, failed load, undo', await buildState(session), f0, 'rebuilt');
    // Every undo entry kind across the recovery reload: config, item, jewel
    // (tree-owned socket), and a tree conversion (spec entry).
    await session.setConfigWithUndo({ usePowerCharges: true });
    const g1 = await buildState(session);
    await session.swapItemWithDiff('Ring 2', RING_B);
    const g2 = await buildState(session);
    await session.swapItemWithDiff('Jewel 36634', JEWEL_A);
    const g3 = await buildState(session);
    const conv3 = await session.convertTreeToLatest();
    assert(conv3.converted, 'OccVortex (3_13) should convert');
    const g4 = await buildState(session);
    await failLoad('after config, item, jewel and conversion entries');
    assertSameBuild('after the second failed load', await buildState(session), g4, 'rebuilt');
    await session.compareItems('Ring 1', [RING_B]); // probes work on the reloaded build too
    await session.undoLastChange();
    assertSameBuild('undo of the conversion after a failed load', await buildState(session), g3, 'rebuilt');
    await session.undoLastChange();
    assertSameBuild('undo of the jewel swap after a failed load', await buildState(session), g2, 'rebuilt');
    await session.undoLastChange();
    assertSameBuild('undo of the ring swap after a failed load', await buildState(session), g1, 'rebuilt');
    await session.undoLastChange();
    assertSameBuild('undo of the config change after a failed load', await buildState(session), f0, 'rebuilt');
    // Items whose text PoB re-serialises on save (crafted mods, variants,
    // rolled ranges): the carry-over compares the text the bridge saved with
    // the re-read item's text, so their undo entries must keep working too.
    // Round 1 never exports before the failed load, so the items' text is
    // still exactly as pasted when the undo entry is taken.
    await session.equipItem('Ring 1', CRAFTED_RING);
    await session.equipItem('Ring 2', VARIANT_RING);
    await session.equipItem('Amulet', RANGED_AMULET);
    type RawItems = { state: { slots: Array<[string, number]>; itemOrder: number[] } };
    const pasted = await bridge.send<RawItems>({ cmd: 'captureItemsState' });
    const pastedStats = await session.getStats();
    await session.swapItemWithDiff('Ring 1', RING_A);
    await session.swapItemWithDiff('Amulet', AMULET);
    await failLoad('with crafted, variant and ranged items');
    await session.undoLastChange();
    await session.undoLastChange();
    const back = await bridge.send<RawItems>({ cmd: 'captureItemsState' });
    assert(JSON.stringify(back.state.itemOrder) === JSON.stringify(pasted.state.itemOrder), `item list after undo: ${JSON.stringify(back.state.itemOrder)} vs ${JSON.stringify(pasted.state.itemOrder)}`);
    assert(JSON.stringify(back.state.slots) === JSON.stringify(pasted.state.slots), 'slot ids after undo differ');
    const backStats = await session.getStats();
    for (const key of ['Life', 'CombinedDPS', 'TotalEHP'] as const) {
      assert(backStats[key] === pastedStats[key], `special items, round 1: ${key} ${backStats[key]} != ${pastedStats[key]}`);
    }
    // The premise: PoB's save did rewrite each item's text, so the
    // carry-over really had to match re-serialised text.
    for (const [slot, pastedText] of [['Ring 1', CRAFTED_RING], ['Ring 2', VARIANT_RING], ['Amulet', RANGED_AMULET]]) {
      const raw = (await bridge.send<{ item: { raw: string } }>({ cmd: 'getItemInSlot', slot })).item.raw;
      assert(raw !== pastedText, `${slot}: PoB kept the pasted text, so this case tests nothing`);
    }
    // Round 2 with full export comparisons (exporting re-serialises the text).
    await failLoad('re-read form for round 2');
    const h0 = await buildState(session);
    await session.swapItemWithDiff('Ring 2', RING_B);
    await session.swapItemWithDiff('Amulet', AMULET);
    await failLoad('with special items, round 2');
    await session.undoLastChange();
    await session.undoLastChange();
    assertSameBuild('crafted/variant/ranged items: swap, failed load, undo', await buildState(session), h0, 'rebuilt');
    // Still refused: a snapshot from before a successful reload.
    const old = await session.snapshotAll();
    await session.loadBuild(occXml);
    let refused: unknown = null;
    try {
      await session.restoreAll(old);
    } catch (e) {
      refused = e;
    }
    assert(refused instanceof Error && /restarted or the build was reloaded/.test(refused.message) && /reset_build/.test(refused.message), `a pre-reload snapshot must still be refused: ${String(refused)}`);
    log('PASS: undo entries survive the failed-load recovery; pre-reload snapshots are still refused');

    // ---------------------------------------------------------------- 13
    log('Test 13: a snapshot from another engine process is refused');
    await session.loadBuild(occXml);
    const mine = (await bridge.send<{ state: { itemOrder: number[]; itemTokens: string[] } }>({ cmd: 'captureItemsState' })).state;
    const otherBridge = new LuaBridge(paths, 120_000);
    try {
      await otherBridge.loadBuildXML(occXml, 'OccVortex');
      const theirs = (await otherBridge.send<{ state: { itemOrder: number[]; itemTokens: string[] } }>({ cmd: 'captureItemsState' })).state;
      assert(JSON.stringify(theirs.itemOrder) === JSON.stringify(mine.itemOrder), 'both engines should hold the same item ids');
      const tag = (t: string): string => t.slice(0, t.lastIndexOf(':'));
      assert(tag(theirs.itemTokens[0]) !== tag(mine.itemTokens[0]), `engines share a token tag: ${theirs.itemTokens[0]} / ${mine.itemTokens[0]}`);
      for (const t of theirs.itemTokens) assert(!mine.itemTokens.includes(t), `token ${t} exists in both engines`);
      const before = (await otherBridge.send<{ xml: string }>({ cmd: 'exportXML' })).xml;
      let crossErr: unknown = null;
      try {
        await otherBridge.send({ cmd: 'restoreItemsState', state: { ...mine, slots: [] } });
      } catch (e) {
        crossErr = e;
      }
      assert(crossErr instanceof Error && !(crossErr instanceof UserError) && /restarted or the build was reloaded/.test(crossErr.message), `another engine's snapshot must be refused: ${String(crossErr)}`);
      assert((await otherBridge.send<{ xml: string }>({ cmd: 'exportXML' })).xml === before, 'a refused restore changed the other engine');
    } finally {
      await otherBridge.shutdown();
    }
    log('PASS: tokens are per engine process; a foreign snapshot is refused');

    log('ALL ITEM RESTORE TESTS PASSED');
  } finally {
    await bridge.shutdown();
  }
}

main().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
