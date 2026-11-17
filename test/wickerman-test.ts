// Wickerman (PoE 3.30) item slots, as Path of Building 2.68.1's UI handles them:
//
//   1. validateItemText accepts Viscera text copied from the game (first line
//      "Item Class: Viscera", no Rarity line) and still refuses any other text
//      without a Rarity line.
//   2. On a pre-3.30 tree, Head/Body/Arm/Leg are not listed, and swap_item /
//      unequip_item / compare_items into them are UserErrors that change
//      nothing (no undo entry, export unchanged).
//   3. On a 3.30 tree (OccVortex converted to the latest tree; skipped when
//      PoB has no 3.30 tree, e.g. 2.67.2) the slots are listed, a Viscera item
//      from game text goes into its slot, stats recompute, a Viscera item in
//      the wrong Wickerman slot is refused, undo restores the export exactly,
//      and the build round-trips through export_build code / xml.
//   4. A build holding Viscera items on a tree that hides the slots keeps them
//      exactly: export, a what-if probe, and swap + undo leave the hidden
//      <Slot> entries unchanged.
import { readFileSync } from 'fs';
import { BuildSession } from '../src/build-session.js';
import { LuaBridge, Stats } from '../src/lua-bridge.js';
import { UserError, validateItemText } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

const WICKERMAN = ['Head', 'Body', 'Arm', 'Leg'];

// Game "Copy item" text for a Viscera item: no Rarity line.
const VISCERA_HEAD = `Item Class: Viscera
Thaumaturge's Head
--------
Item Level: 69
--------
Gain 10% of Physical Damage as Extra Damage of a random Element (implicit)
+40 to maximum Life (implicit)`;

const VISCERA_ARM = `Item Class: Viscera
King Crab's Claw
--------
Item Level: 83
--------
Gain 5% of Physical Damage as Extra Cold Damage (implicit)
+20 to maximum Life (implicit)`;

const RING = `Rarity: RARE
Wickerman Test Ring
Coral Ring
Item Level: 63
Implicits: 1
+30 to maximum Life
+70 to maximum Life`;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function expectUserError(label: string, fn: () => Promise<unknown>, pattern: RegExp): Promise<string> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof UserError, `${label}: expected a UserError, got ${String(caught)}`);
  assert(pattern.test(caught.message), `${label}: message ${JSON.stringify(caught.message)} does not match ${pattern}`);
  return caught.message;
}

function sameStats(a: Stats, b: Stats): boolean {
  return ['Life', 'CombinedDPS', 'TotalEHP'].every((k) => a[k] === b[k]);
}

// The <Slot> entries of the exported XML, by name.
function slotIds(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<Slot\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[0])?.[1];
    const id = /\bitemId="([^"]*)"/.exec(m[0])?.[1];
    if (name !== undefined && id !== undefined) out.set(name, id);
  }
  return out;
}

function testValidation(): void {
  log('Test 1: Viscera item text without a Rarity line');
  assert(validateItemText(VISCERA_HEAD) === VISCERA_HEAD, 'Viscera game text should be accepted');
  assert(validateItemText(`\n  ${VISCERA_ARM}\n`) === VISCERA_ARM, 'leading blank lines are trimmed');
  assert(validateItemText(RING) === RING, 'Rarity text still accepted');
  for (const bad of [
    'Item Class: Rings\nCoral Ring\n--------\n+30 to maximum Life',
    'Thaumaturge\'s Head\nItem Class: Viscera',
    'Item Class: Visceral\nThaumaturge\'s Head',
  ]) {
    let caught: unknown;
    try {
      validateItemText(bad);
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof UserError, `should refuse ${JSON.stringify(bad)}`);
    assert(/Rarity/.test(caught.message) && /Item Class: Viscera/.test(caught.message), `message: ${caught.message}`);
  }
  log('PASS: Viscera game text accepted; other text without Rarity refused, naming the exception');
}

async function main(): Promise<void> {
  testValidation();

  const { paths, fixturePath } = setupTestEnv();
  const occXml = readFileSync(fixturePath, 'utf8');
  const bridge = new LuaBridge(paths, 120_000);
  const session = new BuildSession(bridge);
  try {
    log('Test 2: pre-3.30 tree hides and refuses the Wickerman slots');
    await session.loadBuild(occXml);
    const oldTree = (await session.getBuildInfo()).treeVersion;
    assert(oldTree !== '3_30', `fixture should be on an old tree, got ${oldTree}`);
    const oldSlots = (await session.getValidSlots()).map((s) => s.slot);
    for (const w of WICKERMAN) assert(!oldSlots.includes(w), `${w} listed on tree ${oldTree}: ${oldSlots.join(', ')}`);
    assert(!oldSlots.includes('Graft 1'), `Graft 1 listed on tree ${oldTree}`);
    assert(oldSlots.includes('Ring 1') && oldSlots.includes('Weapon 1 Swap') && oldSlots.includes('Ring 3'),
      `ordinary slots must stay listed: ${oldSlots.join(', ')}`);
    // PoB before 2.68 (e.g. 2.67.2) has no Wickerman slots at all.
    const hasWickerman = await session.getItemInSlot('Head').then(
      () => true,
      (err: unknown) => !(err instanceof UserError && /Unknown slot/.test(err.message)),
    );
    const hidden = (slot: string): RegExp =>
      hasWickerman ? new RegExp(`${slot}.*3\\.30`) : new RegExp(`Unknown slot: ${slot}`);
    if (!hasWickerman) log('  this Path of Building has no Wickerman slots: expecting "Unknown slot" refusals');
    const xml0 = await session.exportBuild('xml');
    const stats0 = await session.getStats();
    const msg = await expectUserError('swap_item into Head', () => session.swapItemWithDiff('Head', VISCERA_HEAD), hidden('Head'));
    log(`  refusal: ${msg}`);
    await expectUserError('unequip_item on Arm', () => session.unequipItemWithDiff('Arm'), hidden('Arm'));
    await expectUserError('compare_items in Leg', () => session.compareItems('Leg', [VISCERA_HEAD, VISCERA_ARM]), hidden('Leg'));
    await expectUserError('compare_items in an unknown slot', () => session.compareItems('Tail', [RING, RING]), /Unknown slot/);
    await expectUserError('nothing to undo', () => session.undoLastChange(), /[Nn]othing to undo|empty/);
    assert((await session.exportBuild('xml')) === xml0, 'refused changes must leave the export unchanged');
    assert(sameStats(await session.getStats(), stats0), 'refused changes must leave stats unchanged');
    assert(!(await session.listEquippedItems()).some((i) => WICKERMAN.includes(i.slot)), 'no Wickerman items listed');
    log('PASS: hidden, refused before any change');

    log('Test 3: 3.30 tree lists and accepts the Wickerman slots');
    const conv = await session.convertTreeToLatest();
    if (!hasWickerman || conv.toVersion !== '3_30') {
      log(`SKIPPED Tests 3-4: this Path of Building has no Wickerman slots (latest tree ${conv.toVersion})`);
      return;
    }
    const slots330 = await session.getValidSlots();
    for (const w of WICKERMAN) {
      const s = slots330.find((x) => x.slot === w);
      assert(s && !s.occupied, `${w} should be listed and empty: ${JSON.stringify(s)}`);
    }
    const xmlConverted = await session.exportBuild('xml');
    const before = await session.getStats();
    const head = await session.swapItemWithDiff('Head', VISCERA_HEAD);
    assert(head.after.Life !== before.Life && head.diff.Life, `Life should change: ${JSON.stringify(head.diff)}`);
    const headItem = (await session.listEquippedItems()).find((i) => i.slot === 'Head');
    assert(headItem && headItem.baseName === "Thaumaturge's Head" && headItem.rarity === 'NORMAL',
      `Head item: ${JSON.stringify(headItem)}`);
    assert((await session.getValidSlots()).find((s) => s.slot === 'Head')?.occupied, 'Head occupied');
    await expectUserError('a head in the Arm slot', () => session.swapItemWithDiff('Arm', VISCERA_HEAD), /cannot be equipped in Arm/);
    await session.swapItemWithDiff('Arm', VISCERA_ARM);
    const cmp = await session.compareItems('Arm', [VISCERA_ARM, VISCERA_HEAD]);
    assert(cmp.candidates[0].error === null && cmp.candidates[1].error !== null, `compare: ${JSON.stringify(cmp.candidates.map((c) => c.error))}`);
    log('PASS: listed, Viscera equipped from game text, stats recomputed, wrong slot refused');

    log('Test 3b: export round-trip and undo');
    const statsEquipped = await session.getStats();
    // PoB's first save of the fixture adds default attributes (TimelessData,
    // includeInFullDPS); compare exports from the second generation on.
    await session.loadBuild(await session.exportBuild('xml'));
    assert(sameStats(await session.getStats(), statsEquipped), 'xml reload keeps stats');
    const xmlEquipped = await session.exportBuild('xml');
    const ids = slotIds(xmlEquipped);
    assert(ids.get('Head') !== '0' && ids.get('Arm') !== '0', `exported slots: ${JSON.stringify([...ids])}`);
    assert(/Rarity: NORMAL\r?\nThaumaturge&apos;s Head/.test(xmlEquipped), 'the Viscera item is saved in PoB format');
    const code = await session.exportBuild('code');
    await session.loadBuild(code);
    assert(sameStats(await session.getStats(), statsEquipped), 'code round-trip keeps stats');
    assert((await session.exportBuild('xml')) === xmlEquipped, 'code round-trip keeps the export');
    await session.loadBuild(xmlEquipped);
    assert((await session.exportBuild('xml')) === xmlEquipped, 'xml round-trip keeps the export');
    // Undo on a fresh copy: convert, two swaps, undo both.
    await session.loadBuild(xmlConverted);
    const xmlBase = await session.exportBuild('xml');
    await session.swapItemWithDiff('Head', VISCERA_HEAD);
    await session.swapItemWithDiff('Arm', VISCERA_ARM);
    await session.undoLastChange();
    await session.undoLastChange();
    assert((await session.exportBuild('xml')) === xmlBase, 'undo restores the export exactly');
    assert(sameStats(await session.getStats(), before), 'undo restores stats');
    log('PASS: export round-trips, undo restores exactly');

    log('Test 4: Viscera items in slots the tree hides are kept');
    const hiddenXml = xmlEquipped.replace(/treeVersion="3_30"/g, 'treeVersion="3_29"');
    assert(hiddenXml !== xmlEquipped, 'fixture rewrite failed');
    await session.loadBuild(hiddenXml);
    assert((await session.getBuildInfo()).treeVersion === '3_29', 'tree should be 3_29');
    const xmlHidden = await session.exportBuild('xml');
    const hiddenIds = slotIds(xmlHidden);
    assert(hiddenIds.get('Head') === ids.get('Head') && hiddenIds.get('Arm') === ids.get('Arm'),
      `hidden slots must keep their items: ${JSON.stringify([...hiddenIds].filter(([k]) => WICKERMAN.includes(k)))}`);
    const hiddenSlots = (await session.getValidSlots()).map((s) => s.slot);
    for (const w of WICKERMAN) assert(!hiddenSlots.includes(w), `${w} listed on 3_29`);
    assert(!(await session.listEquippedItems()).some((i) => WICKERMAN.includes(i.slot)), 'hidden items not listed');
    const hiddenStats = await session.getStats();
    await expectUserError('unequip a hidden slot', () => session.unequipItemWithDiff('Head'), /Head.*3\.30.*3\.29/);
    await session.compareItems('Ring 1', [RING, RING]);
    assert((await session.exportBuild('xml')) === xmlHidden, 'a probe keeps hidden slots exactly');
    await session.swapItemWithDiff('Ring 1', RING);
    await session.undoLastChange();
    assert((await session.exportBuild('xml')) === xmlHidden, 'swap + undo keeps hidden slots exactly');
    assert(sameStats(await session.getStats(), hiddenStats), 'stats unchanged after probe and undo');
    log('PASS: hidden Viscera items survive export, probes and undo');
  } finally {
    await bridge.dispose();
  }
}

main()
  .then(() => {
    log('ALL WICKERMAN TESTS PASSED');
    process.exit(0);
  })
  .catch((error: unknown) => {
    log(`FAILED: ${error instanceof Error ? error.stack : error}`);
    process.exit(1);
  });
