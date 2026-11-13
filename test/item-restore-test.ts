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

function assertSameBuild(label: string, actual: BuildState, expected: BuildState, sortNodes = false): void {
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
  const norm = (xml: string): string => (sortNodes ? sortNodeLists(xml) : xml);
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
    // PoB writes the allocated node list in Lua table order, so after a spec
    // rebuild only that list's order may differ (same nodes). Compared with
    // the node list sorted; everything else byte for byte.
    await session.loadBuild(masteryXml);
    const c0 = await buildState(session);
    await session.swapItemWithDiff('Ring 1', RING_A);
    const a1 = await buildState(session);
    await session.swapItemWithDiff(`Jewel ${JEWEL_SOCKET}`, JEWEL_A);
    const a2 = await buildState(session);
    const conv1 = await session.convertTreeToLatest();
    assert(conv1.converted, 'the 3_24 fixture should convert');
    await session.undoLastChange();
    assertSameBuild('order 1: after undoing the conversion', await buildState(session), a2, true);
    await session.undoLastChange();
    assertSameBuild('order 1: after undoing the jewel swap', await buildState(session), a1, true);
    await session.undoLastChange();
    assertSameBuild('order 1: after undoing the ring swap', await buildState(session), c0, true);

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
    assertSameBuild('order 2: after undoing the conversion', await buildState(session), c0, true);
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
    assert(/does not match the build/.test(caught.message) && /reset_build/.test(caught.message) && /nothing was restored/.test(caught.message), `unexpected message: ${caught.message}`);
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

    log('ALL ITEM RESTORE TESTS PASSED');
  } finally {
    await bridge.shutdown();
  }
}

main().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
