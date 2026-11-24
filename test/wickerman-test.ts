// Wickerman (PoE 3.30) item slots, as Path of Building 2.68.1's UI handles them:
//
//   1. validateItemText accepts Viscera text copied from the game (first line
//      "Item Class: Viscera", no Rarity line) and still refuses any other text
//      without a Rarity line; a leading UTF-8 BOM is stripped.
//   2. On a pre-3.30 tree, Head/Body/Arm/Leg and Graft 1/2 are not listed, and
//      swap_item / compare_items into them are UserErrors naming the remedy
//      that change nothing (no undo entry, export unchanged).
//   2b. Grafts: listed and usable on a 3.27 tree; on another tree an equipped
//      graft is listed by list_equipped_items as hidden (PoB ignores it) and
//      unequip_item removes it.
//   3. On a 3.30 tree (OccVortex converted to the latest tree; skipped when
//      PoB has no 3.30 tree, e.g. 2.67.2) the slots are listed, a Viscera item
//      from game text goes into its slot, stats recompute, a Viscera item in
//      the wrong Wickerman slot is refused, undo restores the export exactly,
//      and the build round-trips through export_build code / xml.
//   3c. generate_trade_search on a Wickerman slot ranks the Viscera parts that
//      fit it (BuildSession.rankViscera): every part fits the slot, scores
//      sorted, compare_items parity for the top part, a hidden slot and trade
//      options refused, the bridge's trade search / mod list refuse the slot,
//      suggest_upgrades gives suggestedViscera; the export is unchanged.
//   4. A build holding Viscera items on a tree that hides the slots keeps them
//      exactly: export, a what-if probe, and swap + undo leave the hidden
//      <Slot> entries unchanged. list_equipped_items shows them as hidden
//      (PoB still counts them), and unequip_item removes one (stats change,
//      undo restores the export).
import { readFileSync } from 'fs';
import { BuildSession } from '../src/build-session.js';
import { LuaBridge, Stats } from '../src/lua-bridge.js';
import { tradeQueryCommand, visceraRankArgs } from '../src/trade-search-command.js';
import { buildVisceraRanking } from '../src/trade-search-response.js';
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

const GRAFT = `Rarity: NORMAL
Battering Uulgraft
Item Level: 80
Implicits: 1
8% reduced Enemy Stun Threshold`;

const RING = `Rarity: RARE
Wickerman Test Ring
Coral Ring
Item Level: 63
Implicits: 1
+30 to maximum Life
+70 to maximum Life`;

// A magic item names its base inside its name line: with a BOM left on the
// Rarity line PoB would not find the base, so this one shows the BOM is stripped.
const MAGIC_RING = `Rarity: MAGIC
Hale Coral Ring
--------
Item Level: 63
--------
+30 to maximum Life`;

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
  assert(validateItemText('\uFEFF' + VISCERA_HEAD) === VISCERA_HEAD, 'a leading BOM is stripped (Viscera)');
  assert(validateItemText('\uFEFF' + RING) === RING, 'a leading BOM is stripped (Rarity)');
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
  log('PASS: Viscera game text accepted, BOM stripped; other text without Rarity refused, naming the exception');
}

async function main(): Promise<void> {
  testValidation();

  const { paths, fixturePath } = setupTestEnv();
  const occXml = readFileSync(fixturePath, 'utf8');
  const bridge = new LuaBridge(paths, 120_000);
  const session = new BuildSession(bridge);
  try {
    log('Test 2: pre-3.30 tree hides and refuses the Wickerman and Graft slots');
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
      hasWickerman ? new RegExp(`${slot}.*3\\.30.*convert_tree_to_latest`) : new RegExp(`Unknown slot: ${slot}`);
    if (!hasWickerman) log('  this Path of Building has no Wickerman slots: expecting "Unknown slot" refusals');
    const xml0 = await session.exportBuild('xml');
    const stats0 = await session.getStats();
    const msg = await expectUserError('swap_item into Head', () => session.swapItemWithDiff('Head', VISCERA_HEAD), hidden('Head'));
    log(`  refusal: ${msg}`);
    if (!hasWickerman) await expectUserError('unequip_item on Arm', () => session.unequipItemWithDiff('Arm'), hidden('Arm'));
    const graftMsg = await expectUserError('swap_item into Graft 1', () => session.swapItemWithDiff('Graft 1', GRAFT),
      /Graft 1.*3\.27.*no tree conversion/);
    log(`  refusal: ${graftMsg}`);
    await expectUserError('compare_items in Graft 2', () => session.compareItems('Graft 2', [GRAFT, GRAFT]), /Graft 2.*3\.27/);
    await expectUserError('compare_items in Leg', () => session.compareItems('Leg', [VISCERA_HEAD, VISCERA_ARM]), hidden('Leg'));
    await expectUserError('compare_items in an unknown slot', () => session.compareItems('Tail', [RING, RING]), /Unknown slot/);
    if (hasWickerman) {
      await expectUserError('Viscera ranking in a hidden slot', () => session.rankViscera('Head', [{ stat: 'Life', weight: 1 }], 5),
        /Head.*3\.30.*convert_tree_to_latest/);
    }
    // Probe what-ifs (evaluate_changes, suggest_upgrades, ...) refuse a hidden slot per variant, as swap_item does.
    const probed = await session.probe({ variants: [{ items: [{ slot: 'Graft 1', itemText: GRAFT }] }] });
    assert(probed.results[0].userError === true && /Graft 1.*3\.27/.test(probed.results[0].error ?? ''),
      `probe into a hidden slot: ${JSON.stringify(probed.results[0])}`);
    // Probe item text is normalized as swap_item's: a leading BOM changes nothing.
    const ringProbe = await session.probe({
      variants: [{ items: [{ slot: 'Ring 1', itemText: MAGIC_RING }] }, { items: [{ slot: 'Ring 1', itemText: '﻿' + MAGIC_RING }] }],
    });
    assert(ringProbe.results.every((r) => r.error === undefined) && sameStats(ringProbe.results[0].stats, ringProbe.results[1].stats),
      `a BOM-prefixed probe item gives the same stats: ${JSON.stringify(ringProbe.results)}`);
    await expectUserError('nothing to undo', () => session.undoLastChange(), /[Nn]othing to undo|empty/);
    assert((await session.exportBuild('xml')) === xml0, 'refused changes must leave the export unchanged');
    assert(sameStats(await session.getStats(), stats0), 'refused changes must leave stats unchanged');
    assert(!(await session.listEquippedItems()).some((i) => WICKERMAN.includes(i.slot)), 'no Wickerman items listed');
    log('PASS: hidden, refused before any change');

    log('Test 2b: Graft slots on a 3.27 tree, and a graft left on another tree');
    const xml327 = occXml.replace(/treeVersion="3_13"/g, 'treeVersion="3_27"');
    assert(xml327 !== occXml, 'fixture rewrite to 3_27 failed');
    await session.loadBuild(xml327);
    assert((await session.getBuildInfo()).treeVersion === '3_27', 'tree should be 3_27');
    const slots327 = (await session.getValidSlots()).map((s) => s.slot);
    assert(slots327.includes('Graft 1') && slots327.includes('Graft 2'), `grafts listed on 3_27: ${slots327.join(', ')}`);
    for (const w of WICKERMAN) assert(!slots327.includes(w), `${w} listed on 3_27`);
    await session.swapItemWithDiff('Graft 1', GRAFT);
    const graft327 = (await session.listEquippedItems()).find((i) => i.slot === 'Graft 1');
    assert(graft327 && graft327.baseName === 'Battering Uulgraft' && !graft327.hidden, `Graft 1 on 3_27: ${JSON.stringify(graft327)}`);
    // suggest_upgrades lists shown grafts (measured); an equipped one gets PoB-weighted graft mods, an empty one a modsError.
    const up327 = await session.suggestUpgrades(undefined, { modSlots: 0 });
    const g1 = up327.find((s) => s.slot === 'Graft 1');
    const g2 = up327.find((s) => s.slot === 'Graft 2');
    assert(g1?.kind === 'treeGated' && !g1.empty && typeof g1.priority === 'number' && g1.modsError === undefined
      && g2?.empty === true && /Empty graft slot/.test(g2.modsError ?? ''),
    `suggest_upgrades grafts on 3_27: ${JSON.stringify([g1 && { ...g1, currentItem: undefined }, g2])}`);
    const g1Mods = (await session.suggestUpgrades('Graft 1'))[0];
    assert(g1Mods.modsError === undefined && (g1Mods.suggestedMods?.length ?? 0) > 0, `Graft 1 suggestedMods: ${JSON.stringify(g1Mods.suggestedMods ?? g1Mods.modsError)}`);
    assert(!up327.some((s) => WICKERMAN.includes(s.slot)), 'no hidden Wickerman slots in suggest_upgrades on 3_27');
    const xml326 = (await session.exportBuild('xml')).replace(/treeVersion="3_27"/g, 'treeVersion="3_26"');
    await session.loadBuild(xml326);
    assert(!(await session.getValidSlots()).some((s) => s.slot === 'Graft 1'), 'Graft 1 not listed on 3_26');
    assert(!(await session.suggestUpgrades(undefined, { modSlots: 0 })).some((s) => /^Graft/.test(s.slot)), 'hidden grafts left out of suggest_upgrades');
    const graft326 = (await session.listEquippedItems()).find((i) => i.slot === 'Graft 1');
    assert(graft326 && graft326.hidden === true && /3\.27/.test(graft326.note ?? '') && /ignores/.test(graft326.note ?? ''),
      `hidden graft on 3_26: ${JSON.stringify({ hidden: graft326?.hidden, note: graft326?.note })}`);
    log(`  note: ${graft326.note}`);
    const ungraft = await session.unequipItemWithDiff('Graft 1');
    assert(Object.keys(ungraft.diff).length === 0,
      `PoB ignores a hidden graft, so removing it changes no stat: ${JSON.stringify(ungraft.diff)}`);
    assert(!(await session.listEquippedItems()).some((i) => i.slot === 'Graft 1'), 'graft removed');
    log('PASS: grafts listed and usable on 3.27; a hidden graft is listed as hidden and can be removed');

    await session.loadBuild(occXml);

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
    // evaluate_changes / probe variants take Viscera game text too, BOM or not, with swap_item's numbers.
    const headProbe = await session.probe({
      variants: [{ items: [{ slot: 'Head', itemText: VISCERA_HEAD }] }, { items: [{ slot: 'Head', itemText: '﻿' + VISCERA_HEAD }] }],
    });
    assert(headProbe.results.every((r) => r.error === undefined) && sameStats(headProbe.results[0].stats, headProbe.results[1].stats)
      && headProbe.results[0].stats.Life !== before.Life, `Viscera probe with and without BOM: ${JSON.stringify(headProbe.results)}`);
    const head = await session.swapItemWithDiff('Head', '\uFEFF' + VISCERA_HEAD);
    assert(head.after.Life !== before.Life && head.diff.Life, `Life should change: ${JSON.stringify(head.diff)}`);
    assert(sameStats(head.after, headProbe.results[0].stats), 'the probe matches swap_item');
    const headItem = (await session.listEquippedItems()).find((i) => i.slot === 'Head');
    assert(headItem && headItem.baseName === "Thaumaturge's Head" && headItem.rarity === 'NORMAL'
      && headItem.raw === VISCERA_HEAD && !headItem.hidden,
      `Head item: ${JSON.stringify(headItem)}`);
    assert((await session.getValidSlots()).find((s) => s.slot === 'Head')?.occupied, 'Head occupied');
    await expectUserError('a head in the Arm slot', () => session.swapItemWithDiff('Arm', VISCERA_HEAD), /cannot be equipped in Arm/);
    await session.swapItemWithDiff('Arm', VISCERA_ARM);
    const cmp = await session.compareItems('Arm', [VISCERA_ARM, VISCERA_HEAD]);
    assert(cmp.candidates[0].error === null && cmp.candidates[1].error !== null, `compare: ${JSON.stringify(cmp.candidates.map((c) => c.error))}`);
    const up330 = await session.suggestUpgrades(undefined, { modSlots: 0 });
    const headRow = up330.find((s) => s.slot === 'Head');
    assert(WICKERMAN.every((w) => up330.find((s) => s.slot === w)?.kind === 'treeGated') && headRow && !headRow.empty
      && typeof headRow.priority === 'number' && headRow.modsError === undefined,
    `suggest_upgrades Wickerman rows on 3.30: ${JSON.stringify(headRow && { ...headRow, currentItem: undefined })}`);
    log('PASS: listed, Viscera equipped from game text, stats recomputed, wrong slot refused, suggest_upgrades rows');

    log('Test 3c: Viscera parts ranked for a Wickerman slot');
    const xmlRank = await session.exportBuild('xml');
    const weights = [{ stat: 'FullDPS', weight: 1 }, { stat: 'TotalEHP', weight: 0.5 }];
    const legs = await session.rankViscera('Leg', weights, 500);
    assert(legs.total > 10 && legs.candidates.length === legs.total - legs.errors.length && legs.currentItem === null,
      `every leg part evaluated: ${legs.total}, ${legs.candidates.length}, errors ${JSON.stringify(legs.errors)}`);
    for (let i = 1; i < legs.candidates.length; i++) {
      assert(legs.candidates[i - 1].score >= legs.candidates[i].score, `sorted by score at ${i}`);
    }
    assert(legs.candidates[0].score > 0 && legs.candidates.some((c) => c.score === 0), 'some parts help, some change nothing');
    const arms = await session.rankViscera('Arm', weights, 500);
    const legNames = new Set(legs.candidates.map((c) => c.name));
    assert(arms.currentItem === "King Crab's Claw" && arms.candidates.every((c) => !legNames.has(c.name)), 'arm and leg parts are different parts');
    // Every listed part fits its slot (PoB's IsItemValidForSlot): one arm part goes in Leg as an error.
    const wrong = await session.compareItems('Leg', [arms.candidates[0].itemText]);
    assert(wrong.candidates[0].error !== null, 'an arm part does not fit Leg');
    // compare_items gives the same numbers as the ranking (the probe engine, read-only).
    const top = legs.candidates.slice(0, 3);
    const cmpLegs = await session.compareItems('Leg', top.map((c) => c.itemText));
    top.forEach((c, i) => {
      for (const key of ['CombinedDPS', 'TotalEHP', 'Life']) {
        assert(cmpLegs.candidates[i].stats?.[key] === c.stats[key], `${c.name} ${key}: compare_items ${cmpLegs.candidates[i].stats?.[key]} vs ranking ${c.stats[key]}`);
      }
    });
    const ehpOnly = await session.rankViscera('Leg', [{ stat: 'TotalEHP', weight: 1 }], 3);
    assert(ehpOnly.candidates.length === 3 && ehpOnly.candidates[0].change.TotalEHP > 0 && ehpOnly.candidates[0].change.TotalEHP >= Math.max(...legs.candidates.map((c) => c.change.TotalEHP ?? 0)),
      `TotalEHP weights rank the part adding the most EHP first: ${JSON.stringify(ehpOnly.candidates[0])}`);
    // The tool's argument checks and response.
    const ranked = buildVisceraRanking({ slot: 'Leg', league: 'Standard' }, legs);
    assert(ranked.url === null && ranked.itemCategory === 'Viscera' && /no Viscera category/.test(String(ranked.note)), 'response shape');
    assert(visceraRankArgs({ slot: 'Leg', league: 'Standard', tradeType: 'any' }).statWeights.length === 2, 'tradeType accepted, default weights');
    for (const extra of [{ requiredMods: [{ tradeId: 'explicit.stat_3299347043' }] }, { maxPrice: { amount: 5 } }, { influences: ['shaper' as const] }]) {
      let caught: unknown;
      try { visceraRankArgs({ slot: 'Leg', league: 'Standard', ...extra }); } catch (err) { caught = err; }
      assert(caught instanceof UserError && /not apply to Leg: Viscera parts have fixed implicits/.test(caught.message), `refused: ${JSON.stringify(extra)}`);
    }
    await expectUserError('a weighted search in a Wickerman slot', () => session.generateTradeQuery(tradeQueryCommand({ slot: 'Arm', league: 'Standard' })),
      /Arm: Viscera parts have fixed implicits and no affixes/);
    await expectUserError('trade mods of a Wickerman slot', () => session.searchTradeMods('Arm', 'life', 5), /Viscera parts have fixed implicits/);
    await expectUserError('Viscera ranking in a graft slot', () => session.rankViscera('Graft 1', weights, 5), /not a Wickerman slot/);
    const headUp = (await session.suggestUpgrades('Head'))[0];
    assert(headUp.modsError === undefined && (headUp.suggestedViscera?.length ?? 0) > 0 && headUp.suggestedMods === undefined,
      `suggest_upgrades Head: ${JSON.stringify({ ...headUp, currentItem: undefined })}`);
    assert((await session.exportBuild('xml')) === xmlRank, 'Viscera rankings leave the export unchanged');
    log(`PASS: ${legs.total} leg parts ranked (top ${legs.candidates[0].name}, score ${legs.candidates[0].score}), compare_items parity`);

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
    const hiddenItems = (await session.listEquippedItems()).filter((i) => WICKERMAN.includes(i.slot));
    assert(hiddenItems.map((i) => i.slot).sort().join() === 'Arm,Head',
      `hidden occupied slots listed: ${hiddenItems.map((i) => i.slot)}`);
    for (const i of hiddenItems) {
      assert(i.hidden === true && /3\.30/.test(i.note ?? '') && /still counts/.test(i.note ?? ''),
        `${i.slot}: ${JSON.stringify(i.note)}`);
    }
    log(`  note: ${hiddenItems[0].note}`);
    const hiddenStats = await session.getStats();
    await expectUserError('compare_items in a hidden slot', () => session.compareItems('Head', [VISCERA_HEAD, VISCERA_HEAD]),
      /Head.*3\.30.*3\.29.*convert_tree_to_latest/);
    await session.compareItems('Ring 1', [RING, RING]);
    assert((await session.exportBuild('xml')) === xmlHidden, 'a probe keeps hidden slots exactly');
    await session.swapItemWithDiff('Ring 1', RING);
    await session.undoLastChange();
    assert((await session.exportBuild('xml')) === xmlHidden, 'swap + undo keeps hidden slots exactly');
    assert(sameStats(await session.getStats(), hiddenStats), 'stats unchanged after probe and undo');
    const unequipped = await session.unequipItemWithDiff('Head');
    assert(unequipped.diff.Life && Number(unequipped.after.Life) < Number(hiddenStats.Life),
      `removing the hidden Head changes Life: ${JSON.stringify(unequipped.diff)}`);
    assert(slotIds(await session.exportBuild('xml')).get('Head') === '0', 'Head emptied');
    await session.undoLastChange();
    assert((await session.exportBuild('xml')) === xmlHidden, 'undo of the hidden unequip restores the export');
    assert(sameStats(await session.getStats(), hiddenStats), 'undo of the hidden unequip restores stats');
    log('PASS: hidden Viscera items survive export, probes and undo; listed as hidden; unequip removes one');
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
