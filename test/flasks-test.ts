/**
 * Flask slots' active state (PoB's "Activate this flask" check box):
 * listings carry `active`; probe variants take `flasks` [{slot, active}] and
 * give the numbers a committed toggle + full recalc gives, through the
 * calculator alone and inside a full-recalculation fallback; an item what-if
 * into an inactive flask slot is refused unless the variant turns it on
 * (compare_items `activate`); set_flask_active commits a toggle with one undo
 * entry, `unchanged` when already set, refusals that change nothing, and a
 * crash replay; full snapshots (swap_item / apply_changes undo) restore the
 * flags exactly and what-ifs leave the export byte-identical.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BuildSession, EngineRestartedError } from '../src/build-session.js';
import { LuaBridge, type Stats } from '../src/lua-bridge.js';
import type { ProbeVariant } from '../src/probe.js';
import { TOOL_ANNOTATIONS } from '../src/tool-registry.js';
import { UserError } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'src', 'server.ts');
const { paths, fixturePath } = setupTestEnv();
const occXml = readFileSync(fixturePath, 'utf8');
const bridges: LuaBridge[] = [];

const FLASKS = ['Flask 1', 'Flask 2', 'Flask 3', 'Flask 4', 'Flask 5'];
/** Flask 2 is a Granite Flask (Armour), Flask 3 a Silver Flask (Onslaught: speed, DPS), Flask 4 a Quicksilver Flask. */
const STATS = ['Life', 'TotalEHP', 'Armour', 'CombinedDPS', 'Speed', 'MovementSpeedMod', 'EnergyShield', 'Mana', 'FireResist', 'PhysicalMaximumHitTaken'];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
function newBridge(testFaults?: string): LuaBridge {
  const b = new LuaBridge(paths, 120_000, testFaults ? { testFaults } : {});
  bridges.push(b);
  return b;
}
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}
async function refusedWith(label: string, p: Promise<unknown>, ...needles: RegExp[]): Promise<void> {
  const e = await rejection(p);
  assert(e instanceof UserError, `${label}: expected a UserError, got ${e.constructor.name}: ${e.message}`);
  for (const n of needles) assert(n.test(e.message), `${label}: "${e.message}" does not match ${n}`);
}
function sameStats(label: string, actual: Stats, expected: Stats): void {
  for (const k of STATS) {
    assert(actual[k] === expected[k], `${label}: ${k} ${String(actual[k])} != ${String(expected[k])}`);
  }
}
/** The committed build's STATS, read as the probe reads its base (the last full recalc). */
async function committed(session: BuildSession): Promise<Stats> {
  return (await session.probe({ stats: STATS, variants: [] })).base;
}
async function probeOne(session: BuildSession, variant: ProbeVariant) {
  const res = await session.probe({ stats: STATS, variants: [variant] });
  return res.results[0];
}
async function flaskStates(session: BuildSession): Promise<Record<string, boolean | undefined>> {
  const out: Record<string, boolean | undefined> = {};
  for (const s of await session.getValidSlots()) if (FLASKS.includes(s.slot)) out[s.slot] = s.active;
  return out;
}
function diffAt(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `${JSON.stringify(a.slice(Math.max(0, i - 80), i + 80))}\n  vs ${JSON.stringify(b.slice(Math.max(0, i - 80), i + 80))}`;
}
async function sameExport(label: string, session: BuildSession, expected: string): Promise<void> {
  const xml = await session.exportXML();
  assert(xml === expected, `${label}: export differs: ${diffAt(xml, expected)}`);
}

/** The `active` attribute of every exported <Slot> element of `slot` (attributes parsed, whatever their order). */
function slotActiveAttrs(xml: string, slot: string): Array<string | undefined> {
  const out: Array<string | undefined> = [];
  for (const m of xml.matchAll(/<Slot\s([^>]*?)\/?>/g)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    if (attrs.name === slot) out.push(attrs.active);
  }
  return out;
}

async function itemText(session: BuildSession, slot: string): Promise<string> {
  const item = await session.getItemInSlot(slot);
  assert(item?.raw, `${slot} holds an item`);
  return item.raw;
}

async function tinctureText(session: BuildSession): Promise<string> {
  const res = await session.readItemData<{ text?: string }>({ cmd: 'itemText', base: 'Oakbranch Tincture' });
  assert(typeof res.text === 'string' && /Tincture/.test(res.text), `tincture text: ${JSON.stringify(res).slice(0, 200)}`);
  return res.text;
}

// ---------------------------------------------------------------------------

async function test1Listing(session: BuildSession): Promise<void> {
  log('Test 1: list_equipped_items / list_valid_slots carry each flask slot\'s active state');
  const equipped = await session.listEquippedItems();
  for (const slot of FLASKS) {
    const item = equipped.find((i) => i.slot === slot);
    assert(item?.active === true && item.note === undefined, `${slot} listed active: ${JSON.stringify(item)?.slice(0, 200)}`);
  }
  assert(equipped.filter((i) => !FLASKS.includes(i.slot)).every((i) => i.active === undefined), 'only flask slots carry active');
  const slots = await session.getValidSlots();
  assert(FLASKS.every((f) => slots.find((s) => s.slot === f)?.active === true), 'list_valid_slots: every flask slot active');
  assert(slots.filter((s) => !FLASKS.includes(s.slot)).every((s) => s.active === undefined), 'list_valid_slots: only flask slots carry active');

  await session.setFlaskActive('Flask 2', false);
  const off = (await session.listEquippedItems()).find((i) => i.slot === 'Flask 2');
  assert(off?.active === false && /not active.*set_flask_active/.test(off.note ?? ''), `inactive flask listed: ${JSON.stringify(off)?.slice(0, 300)}`);
  assert((await flaskStates(session))['Flask 2'] === false, 'list_valid_slots shows it inactive');
  await session.undoLastChange();
  await sameExport('undo the listing toggle', session, await baseExport(session));
  log('PASS 1');
}

let baseXml: string | undefined;
async function baseExport(session: BuildSession): Promise<string> {
  baseXml ??= await session.exportXML();
  return baseXml;
}

async function test2CalculatorParity(session: BuildSession): Promise<void> {
  log('Test 2: one flask toggle through the calculator = committed toggle + full recalc');
  const base = await committed(session);
  const xml = await baseExport(session);
  const res = await session.probe({ stats: STATS, variants: FLASKS.map((slot) => ({ flasks: [{ slot, active: false }] })) });
  assert(res.results.every((r) => r.error === undefined && r.fallback === undefined), `calculator path: ${JSON.stringify(res.results)}`);
  sameStats('probe base', res.base, base);
  assert((res.results[1].stats.Armour as number) < (base.Armour as number), 'Granite Flask off lowers Armour');
  assert((res.results[2].stats.CombinedDPS as number) < (base.CombinedDPS as number), 'Silver Flask off lowers DPS');
  assert((res.results[3].stats.MovementSpeedMod as number) < (base.MovementSpeedMod as number), 'Quicksilver Flask off lowers movement speed');
  await sameExport('after the calculator probes', session, xml);
  for (let i = 0; i < FLASKS.length; i++) {
    const commit = await session.setFlaskActive(FLASKS[i], false);
    assert(commit.unchanged === undefined && commit.previous === true, `${FLASKS[i]} committed: ${JSON.stringify(commit).slice(0, 200)}`);
    sameStats(`${FLASKS[i]} off: probe vs commit`, res.results[i].stats, await committed(session));
    // Turning it back on through the calculator gives the original numbers.
    const back = await probeOne(session, { flasks: [{ slot: FLASKS[i], active: true }] });
    assert(back.error === undefined && back.fallback === undefined, `back on: ${JSON.stringify(back)}`);
    sameStats(`${FLASKS[i]} back on: probe vs base`, back.stats, base);
    await session.undoLastChange();
    await sameExport(`undo ${FLASKS[i]}`, session, xml);
    sameStats(`undo ${FLASKS[i]}`, await committed(session), base);
  }

  // Several toggles, and a toggle together with an item, in one calculator variant.
  const granite = await itemText(session, 'Flask 2');
  const multi = await probeOne(session, { flasks: [{ slot: 'Flask 2', active: false }, { slot: 'Flask 3', active: false }] });
  assert(multi.error === undefined && multi.fallback === undefined, `two toggles: ${JSON.stringify(multi)}`);
  await session.setFlaskActive('Flask 3', false);
  await session.setFlaskActive('Flask 2', false);
  sameStats('two toggles: probe vs commit', multi.stats, await committed(session));
  // Flask 2 is inactive now: an item there with the slot turned on in the same variant.
  const withItem = await probeOne(session, { items: [{ slot: 'Flask 2', itemText: granite }], flasks: [{ slot: 'Flask 2', active: true }] });
  assert(withItem.error === undefined && withItem.fallback === undefined, `item + toggle: ${JSON.stringify(withItem)}`);
  await session.undoLastChange();
  sameStats('item + toggle on an inactive slot = the build with the slot on', withItem.stats, await committed(session));
  await session.undoLastChange();
  await sameExport('undo the two toggles', session, xml);
  log('PASS 2');
}

async function test3FallbackParity(session: BuildSession): Promise<void> {
  log('Test 3: a toggle inside a full-recalculation fallback variant = apply_changes + recalc; restores exact');
  const xml = await baseExport(session);
  const reachable = (await session.getReachableNodes()).filter((n) => !n.isJewelSocket && !n.isMastery).slice(0, 2).map((n) => n.id);
  assert(reachable.length === 2, 'two reachable nodes');
  const variant = { allocate: reachable, flasks: [{ slot: 'Flask 2', active: false }] };
  const probed = await probeOne(session, variant);
  assert(probed.error === undefined && probed.fallback === true, `fallback variant: ${JSON.stringify(probed)}`);
  await sameExport('after the fallback probe', session, xml);
  const applied = await session.applyChanges(variant);
  assert(applied.unchanged === undefined, 'apply_changes applied');
  sameStats('fallback probe vs apply_changes', probed.stats, await committed(session));
  assert((await flaskStates(session))['Flask 2'] === false, 'apply_changes turned Flask 2 off');
  await session.undoLastChange();
  await sameExport('undo apply_changes', session, xml);

  // A tincture (equipped for real in an active slot) through both paths.
  const tincture = await tinctureText(session);
  await session.swapItemWithDiff('Flask 5', tincture);
  const tXml = await session.exportXML();
  const tOff = await probeOne(session, { flasks: [{ slot: 'Flask 5', active: false }] });
  assert(tOff.error === undefined && tOff.fallback === undefined, `tincture toggle: ${JSON.stringify(tOff)}`);
  const tOffFallback = await probeOne(session, { allocate: reachable, flasks: [{ slot: 'Flask 5', active: false }] });
  assert(tOffFallback.fallback === true && tOffFallback.error === undefined, `tincture fallback: ${JSON.stringify(tOffFallback)}`);
  await sameExport('after the tincture probes', session, tXml);
  const t = await session.setFlaskActive('Flask 5', false);
  assert(t.itemType === 'Tincture', `item type: ${t.itemType}`);
  sameStats('tincture off: probe vs commit', tOff.stats, await committed(session));
  await session.undoLastChange();
  await session.applyChanges({ allocate: reachable, flasks: [{ slot: 'Flask 5', active: false }] });
  sameStats('tincture fallback vs apply_changes', tOffFallback.stats, await committed(session));
  await session.undoLastChange();
  await sameExport('undo tincture apply_changes', session, tXml);
  await session.undoLastChange(); // the tincture swap
  await sameExport('undo the tincture swap', session, xml);
  log('PASS 3');
}

async function test4Refusals(session: BuildSession): Promise<void> {
  log('Test 4: refusals (non-flask slot, empty slot, twice, item into an inactive slot) change nothing');
  const xml = await baseExport(session);
  const depth = session.undoStackDepth();
  const granite = await itemText(session, 'Flask 2');
  const variants: ProbeVariant[] = [
    { flasks: [{ slot: 'Helmet', active: true }] },
    { flasks: [{ slot: 'Flask 9', active: true }] },
    { flasks: [{ slot: 'Flask 2', active: false }, { slot: 'Flask 2', active: true }] },
    { items: [{ slot: 'Flask 1', unequip: true }], flasks: [{ slot: 'Flask 1', active: true }] },
    { items: [{ slot: 'Flask 1', unequip: true }] },
  ];
  const res = await session.probe({ stats: STATS, variants });
  const [helmet, unknown, twice, emptied, unequipOnly] = res.results;
  assert(helmet.userError && /Helmet is not a flask slot/.test(helmet.error ?? ''), `non-flask slot: ${JSON.stringify(helmet)}`);
  assert(unknown.userError && /Unknown slot: Flask 9/.test(unknown.error ?? ''), `unknown slot: ${JSON.stringify(unknown)}`);
  assert(twice.userError && /listed twice/.test(twice.error ?? ''), `twice: ${JSON.stringify(twice)}`);
  assert(emptied.userError && /Flask 1 is empty after this variant's items/.test(emptied.error ?? ''), `emptied: ${JSON.stringify(emptied)}`);
  assert(unequipOnly.error === undefined, `unequipping a flask is not refused: ${JSON.stringify(unequipOnly)}`);

  // Flask 2 inactive: an item into it alone is refused; turning it on in the same variant is not.
  await session.setFlaskActive('Flask 2', false);
  const offXml = await session.exportXML();
  const [intoInactive, intoActivated, unequipInactive] = (await session.probe({
    stats: STATS,
    variants: [
      { items: [{ slot: 'Flask 2', itemText: granite }] },
      { items: [{ slot: 'Flask 2', itemText: granite }], flasks: [{ slot: 'Flask 2', active: true }] },
      { items: [{ slot: 'Flask 2', unequip: true }] },
    ],
  })).results;
  assert(intoInactive.userError && /Flask 2 is not active.*flasks: \[\{ slot: "Flask 2", active: true \}\].*set_flask_active/.test(intoInactive.error ?? ''),
    `item into an inactive slot: ${JSON.stringify(intoInactive)}`);
  assert(intoActivated.error === undefined && (intoActivated.stats.Armour as number) > ((await committed(session)).Armour as number),
    `activated in the variant: ${JSON.stringify(intoActivated)}`);
  assert(unequipInactive.error === undefined, `unequip from an inactive slot: ${JSON.stringify(unequipInactive)}`);
  await refusedWith('apply_changes item into an inactive slot', session.applyChanges({ items: [{ slot: 'Flask 2', itemText: granite }] }), /Flask 2 is not active/);

  // compare_items: refused on an inactive slot unless activate; activate only for flask slots.
  await refusedWith('compare_items inactive', session.compareItems('Flask 2', [granite, granite]), /Flask 2 is not active/, /activate: true/);
  await refusedWith('compare_items activate on a non-flask slot', session.compareItems('Helmet', [granite, granite], true), /only applies to flask slots/);
  const cmp = await session.compareItems('Flask 2', [granite, granite], true);
  assert(cmp.activated === true && cmp.flaskSlotActive === false, `activated: ${JSON.stringify({ a: cmp.activated, s: cmp.flaskSlotActive })}`);
  assert(cmp.candidates.every((c) => c.error === null && (c.diff.Armour?.delta ?? 0) > 0), `candidates evaluated active: ${JSON.stringify(cmp.candidates.map((c) => c.diff.Armour))}`);
  const cmpActive = await session.compareItems('Flask 3', [granite, granite]);
  assert(cmpActive.flaskSlotActive === true && cmpActive.activated === false, 'an active slot needs no activate');

  // set_flask_active refusals push nothing.
  const offDepth = session.undoStackDepth();
  await refusedWith('set_flask_active non-flask', session.setFlaskActive('Helmet', true), /Helmet is not a flask slot/);
  await refusedWith('set_flask_active unknown', session.setFlaskActive('Flask 6', true), /Unknown slot/);
  await session.unequipItemWithDiff('Flask 1');
  const emptyDepth = session.undoStackDepth();
  await refusedWith('set_flask_active empty', session.setFlaskActive('Flask 1', false), /Flask 1 is empty/, /swap_item/);
  const [emptySlot] = (await session.probe({ stats: STATS, variants: [{ flasks: [{ slot: 'Flask 1', active: false }] }] })).results;
  assert(emptySlot.userError && /Flask 1 is empty:/.test(emptySlot.error ?? ''), `probe on an empty slot: ${JSON.stringify(emptySlot)}`);
  assert(session.undoStackDepth() === emptyDepth, 'refusals push nothing');
  assert((await flaskStates(session))['Flask 1'] === true, 'an empty flask slot keeps (and lists) its active flag');
  await session.undoLastChange(); // the unequip
  assert(session.undoStackDepth() === offDepth, 'refusals pushed nothing');
  await sameExport('after the refusals', session, offXml);
  await session.undoLastChange(); // Flask 2 back on
  assert(session.undoStackDepth() === depth, 'back to the starting depth');
  await sameExport('after test 4', session, xml);
  log('PASS 4');
}

async function test4bErrorAfterApply(session: BuildSession): Promise<void> {
  log('Test 4b: a calculator variant that fails after its flask toggle is applied leaves the flags as they were');
  const xml = await baseExport(session);
  const base = await committed(session);
  const groups = await session.listSkillGroups();
  const main = groups.findIndex((g) => g.isMainGroup) + 1;
  assert(main > 0, 'the build has a main group');
  // mainSkill's activeSkill is checked when it is applied, after the flask toggle.
  const [failed, after] = (await session.probe({
    stats: STATS,
    variants: [
      { flasks: [{ slot: 'Flask 2', active: false }, { slot: 'Flask 3', active: false }], mainSkill: { group: main, activeSkill: 99 } },
      { flasks: [{ slot: 'Flask 4', active: false }] },
    ],
  })).results;
  assert(failed.userError === true && /activeSkill 99 is out of range/.test(failed.error ?? ''), `variant failed after applying: ${JSON.stringify(failed)}`);
  assert(after.error === undefined && (after.stats.Armour as number) === (base.Armour as number) && (after.stats.CombinedDPS as number) === (base.CombinedDPS as number),
    `the next variant sees Flask 2 and 3 back on: ${JSON.stringify(after.stats)}`);
  const states = await flaskStates(session);
  assert(FLASKS.every((f) => states[f] === true), `flags put back: ${JSON.stringify(states)}`);
  await sameExport('after the failed variant', session, xml);
  sameStats('after the failed variant', await committed(session), base);

  // An item state naming a slot that is not a flask slot is refused before anything is restored.
  const bridge = (session as unknown as { bridge: LuaBridge }).bridge;
  const { state } = await bridge.send<{ ok: true; state: { flasks: unknown[] } & Record<string, unknown> }>({ cmd: 'captureItemsState' });
  await session.setFlaskActive('Flask 2', false);
  const offXml = await session.exportXML();
  for (const bad of [[...state.flasks, ['Helmet', 1, 1]], [...state.flasks, ['Flask 3', 2, 1]], 'nope']) {
    const e = await rejection(bridge.send({ cmd: 'restoreItemsState', state: { ...state, flasks: bad } }));
    assert(!(e instanceof UserError) && /malformed or unknown flask slot states; nothing was restored/.test(e.message), `bad flask state: ${e.message}`);
    await sameExport('after a refused item restore', session, offXml);
  }
  await session.undoLastChange();
  await sameExport('undo after the refused restores', session, xml);
  log('PASS 4b');
}

async function test5CommitUndo(session: BuildSession): Promise<void> {
  log('Test 5: set_flask_active / apply_changes flasks: undo exact, unchanged pushes nothing, full snapshots keep the flags');
  const xml = await baseExport(session);
  const base = await committed(session);
  const depth = session.undoStackDepth();
  const same = await session.setFlaskActive('Flask 3', true);
  assert(same.unchanged === true && session.undoStackDepth() === depth, 'already active: unchanged, nothing pushed');
  const off = await session.setFlaskActive('Flask 3', false);
  assert(off.previous === true && off.active === false && (off.diff.CombinedDPS?.delta ?? 0) < 0, `off: ${JSON.stringify(off).slice(0, 300)}`);
  assert(session.undoStackDepth() === depth + 1, 'one undo entry');
  const onAttrs = slotActiveAttrs(xml, 'Flask 3');
  assert(onAttrs.length > 0 && onAttrs.every((a) => a === 'true'), `the base export has Flask 3 active: ${JSON.stringify(onAttrs)}`);
  const offAttrs = slotActiveAttrs(await session.exportXML(), 'Flask 3');
  assert(offAttrs.length === onAttrs.length && offAttrs.every((a) => a !== 'true'), `the export has Flask 3 inactive: ${JSON.stringify(offAttrs)}`);
  const again = await session.setFlaskActive('Flask 3', false);
  assert(again.unchanged === true && session.undoStackDepth() === depth + 1, 'already inactive: unchanged');

  // A swap into the inactive slot notes it; apply_changes turns it on; undo restores each step exactly.
  const offXml = await session.exportXML();
  const silver = await itemText(session, 'Flask 3');
  const swapped = await session.swapItemWithDiff('Flask 3', silver);
  assert(/Flask 3 is not active.*set_flask_active/.test(swapped.note ?? ''), `swap note: ${swapped.note}`);
  const swappedXml = await session.exportXML();
  const unchangedApply = await session.applyChanges({ flasks: [{ slot: 'Flask 3', active: false }] });
  assert(unchangedApply.unchanged === true && unchangedApply.flasksUnchanged === true, 'apply_changes with flasks already set: unchanged');
  const on = await session.applyChanges({ flasks: [{ slot: 'Flask 3', active: true }, { slot: 'Flask 4', active: false }] });
  assert(on.unchanged === undefined && (on.diff.CombinedDPS?.delta ?? 0) > 0, `apply_changes flasks: ${JSON.stringify(on.diff.CombinedDPS)}`);
  const states = await flaskStates(session);
  assert(states['Flask 3'] === true && states['Flask 4'] === false, `states: ${JSON.stringify(states)}`);
  await session.undoLastChange();
  await sameExport('undo apply_changes flasks', session, swappedXml);
  await session.undoLastChange();
  await sameExport('undo the swap (full snapshot)', session, offXml);
  assert((await flaskStates(session))['Flask 3'] === false, 'still inactive after undoing the swap');
  await session.undoLastChange();
  await sameExport('undo set_flask_active', session, xml);
  sameStats('after the undos', await committed(session), base);
  assert(session.undoStackDepth() === depth, 'back to the starting depth');
  log('PASS 5');
}

async function test5bMeleeTincture(session: BuildSession): Promise<void> {
  log('Test 5b: a tincture that changes DPS (Rosethorn on a blank Duelist with a foil): calculator, fallback and commit agree');
  await session.newBuild({ className: 'Duelist', level: 90 });
  const foil = (await session.readItemData<{ text: string }>({ cmd: 'itemText', base: 'Jewelled Foil' })).text;
  const rosethorn = (await session.readItemData<{ text: string }>({ cmd: 'itemText', base: 'Rosethorn Tincture' })).text;
  await session.swapItemWithDiff('Weapon 1', foil);
  const swap = await session.swapItemWithDiff('Flask 1', rosethorn);
  // A blank build's flask slots start inactive.
  assert(/Flask 1 is not active/.test(swap.note ?? ''), `swap note: ${swap.note}`);
  const xml = await session.exportXML();
  const base = await committed(session);
  const reachable = (await session.getReachableNodes()).filter((n) => !n.isJewelSocket && !n.isMastery).slice(0, 2).map((n) => n.id);
  const [on, onFallback] = (await session.probe({
    stats: STATS,
    variants: [{ flasks: [{ slot: 'Flask 1', active: true }] }, { allocate: reachable, flasks: [{ slot: 'Flask 1', active: true }] }],
  })).results;
  assert(on.error === undefined && on.fallback === undefined && (on.stats.CombinedDPS as number) > (base.CombinedDPS as number),
    `the tincture raises DPS when active: ${JSON.stringify(on)} vs ${JSON.stringify(base.CombinedDPS)}`);
  assert(onFallback.error === undefined && onFallback.fallback === true, `fallback: ${JSON.stringify(onFallback)}`);
  await sameExport('after the tincture probes', session, xml);
  const commit = await session.setFlaskActive('Flask 1', true);
  assert(commit.itemType === 'Tincture' && (commit.diff.CombinedDPS?.delta ?? 0) > 0, `set_flask_active: ${JSON.stringify(commit.diff.CombinedDPS)}`);
  sameStats('tincture on: probe vs commit', on.stats, await committed(session));
  await session.undoLastChange();
  await sameExport('undo the tincture toggle', session, xml);
  await session.applyChanges({ allocate: reachable, flasks: [{ slot: 'Flask 1', active: true }] });
  sameStats('tincture fallback vs apply_changes', onFallback.stats, await committed(session));
  await session.undoLastChange();
  await sameExport('undo apply_changes', session, xml);
  log('PASS 5b');
}

async function test6CrashReplay(): Promise<void> {
  log('Test 6: set_flask_active and apply_changes flasks are replayed after a crash');
  const bridge = newBridge();
  const session = new BuildSession(bridge);
  await session.loadBuild(occXml);
  await session.setFlaskActive('Flask 2', false);
  await session.applyChanges({ flasks: [{ slot: 'Flask 4', active: false }] });
  await session.setFlaskActive('Flask 2', true);
  await session.setFlaskActive('Flask 3', false);
  await session.undoLastChange(); // Flask 3 back on: its record is dropped
  const xml = await session.exportXML();
  const stats = await committed(session);
  const pid = bridge.getPid();
  assert(pid !== undefined && bridge.isRunning(), 'engine running');
  process.kill(pid, 'SIGKILL');
  const end = Date.now() + 10_000;
  while (bridge.isRunning()) {
    if (Date.now() > end) throw new Error('engine did not exit');
    await new Promise((r) => setTimeout(r, 25));
  }
  const e = await rejection(session.getStats());
  assert(e instanceof EngineRestartedError && /build was restored/.test(e.message), `restart notice: ${e.message}`);
  await sameExport('replayed flask changes', session, xml);
  sameStats('replayed flask changes', await committed(session), stats);
  const states = await flaskStates(session);
  assert(states['Flask 2'] === true && states['Flask 3'] === true && states['Flask 4'] === false, `replayed states: ${JSON.stringify(states)}`);
  log('PASS 6');
}

async function test6bAppliedButFailed(): Promise<void> {
  log('Test 6b: set_flask_active that fails after the change is in: committed (undo entry + replay), with the applied wording');
  const bridge = newBridge('flaskFailsAfterChange');
  const session = new BuildSession(bridge);
  await session.loadBuild(occXml);
  const xml = await session.exportXML();
  const base = await committed(session);
  const e = await rejection(session.setFlaskActive('Flask 2', false));
  assert(!(e instanceof UserError) && /test fault: set_flask_active failed/.test(e.message) && /WAS applied/.test(e.message),
    `applied-but-failed error: ${e.message}`);
  assert(session.undoStackDepth() === 1, 'the applied change pushed its undo entry');
  assert((await flaskStates(session))['Flask 2'] === false, 'the change is in the build');
  assert(((await committed(session)).Armour as number) < (base.Armour as number), 'and recalculated');
  await session.undoLastChange();
  await sameExport('undo the applied-but-failed change', session, xml);

  // Replayed after a crash (the replay is not faulted).
  await rejection(session.setFlaskActive('Flask 3', false));
  const changed = await session.exportXML();
  const stats = await committed(session);
  const pid = bridge.getPid();
  assert(pid !== undefined, 'engine running');
  process.kill(pid, 'SIGKILL');
  const end = Date.now() + 10_000;
  while (bridge.isRunning()) {
    if (Date.now() > end) throw new Error('engine did not exit');
    await new Promise((r) => setTimeout(r, 25));
  }
  const restart = await rejection(session.getStats());
  assert(restart instanceof EngineRestartedError, `restart notice: ${restart.message}`);
  await sameExport('replayed applied-but-failed change', session, changed);
  sameStats('replayed applied-but-failed change', await committed(session), stats);
  assert((await flaskStates(session))['Flask 3'] === false, 'Flask 3 stays off after the replay');
  log('PASS 6b');
}

async function test7Mcp(): Promise<void> {
  log('Test 7: over MCP: set_flask_active, annotations, compare_items activate, evaluate_changes flasks');
  assert(TOOL_ANNOTATIONS.set_flask_active?.readOnlyHint === false, 'set_flask_active is not read-only');
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-flasks-'));
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverPath],
    env: { ...process.env, POB_PATH: paths.pobPath, LUAJIT_PATH: paths.luajitPath, POB_MCP_CONFIG_DIR: configDir } as Record<string, string>,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'pob-mcp-flasks-test', version: '0.0.0' });
  type Resp = { content?: Array<{ type: string; text: string }>; isError?: boolean };
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as Resp;
  const text = (r: Resp) => r.content?.[0]?.text ?? '';
  const ok = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const r = await call(name, args);
    assert(!r.isError, `${name} failed: ${text(r)}`);
    return JSON.parse(text(r)) as T;
  };
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const tool = tools.find((t) => t.name === 'set_flask_active');
    assert(tool && tool.annotations?.readOnlyHint === false && tool.annotations?.destructiveHint === false, 'set_flask_active registered with annotations');
    await ok('load_build', { source: occXml });
    const off = await ok<{ status: string; active: boolean; keyDeltas: Record<string, number>; undo: string }>('set_flask_active', { slot: 'Flask 2', active: false });
    assert(off.status === 'deactivated' && off.active === false && typeof off.undo === 'string', `set_flask_active: ${JSON.stringify(off).slice(0, 300)}`);
    const same = await ok<{ status: string }>('set_flask_active', { slot: 'Flask 2', active: false });
    assert(same.status === 'unchanged', `unchanged: ${JSON.stringify(same)}`);
    const refused = await call('set_flask_active', { slot: 'Belt', active: true });
    assert(refused.isError && /Belt is not a flask slot/.test(text(refused)) && !text(refused).startsWith('Internal error'), `refused: ${text(refused)}`);
    const listed = await ok<{ items: Array<{ slot: string; active?: boolean; note?: string }> }>('list_equipped_items');
    assert(listed.items.find((i) => i.slot === 'Flask 2')?.active === false, 'list_equipped_items shows Flask 2 inactive');
    const granite = (await ok<{ item: { raw: string } }>('get_item_in_slot', { slot: 'Flask 2' })).item.raw;
    const inactive = await call('compare_items', { slot: 'Flask 2', items: [granite, granite] });
    assert(inactive.isError && /not active/.test(text(inactive)), `compare_items inactive: ${text(inactive)}`);
    const cmp = await ok<{ activated?: boolean; baseline: { slotActive?: boolean }; candidates: Array<{ keyDeltas: Record<string, number> | null }> }>(
      'compare_items', { slot: 'Flask 2', items: [granite, granite], activate: true });
    assert(cmp.activated === true && cmp.baseline.slotActive === false && cmp.candidates.every((c) => (c.keyDeltas?.TotalEHP ?? 0) > 0),
      `compare_items activate: ${JSON.stringify(cmp).slice(0, 400)}`);
    const ev = await ok<{ results: Array<{ index: number; error?: string; delta?: Record<string, number> }> }>('evaluate_changes', {
      variants: [{ flasks: [{ slot: 'Flask 2', active: true }] }, { items: [{ slot: 'Flask 2', itemText: granite }] }],
      stats: ['Armour'],
      rankBy: 'Armour',
    });
    const byIndex = ev.results.sort((a, b) => a.index - b.index);
    assert((byIndex[0].delta?.Armour ?? 0) > 0 && /not active/.test(byIndex[1].error ?? ''), `evaluate_changes: ${JSON.stringify(byIndex)}`);
    const undo = await ok<{ status: string }>('undo_last_change');
    assert(undo.status === 'reverted', 'undo set_flask_active over MCP');
    assert((await ok<{ slots: Array<{ slot: string; active?: boolean }> }>('list_valid_slots')).slots.find((s) => s.slot === 'Flask 2')?.active === true,
      'Flask 2 active again');
  } finally {
    await client.close().catch(() => undefined);
    rmSync(configDir, { recursive: true, force: true });
  }
  log('PASS 7');
}

async function main(): Promise<void> {
  const bridge = newBridge();
  const session = new BuildSession(bridge);
  try {
    await session.loadBuild(occXml);
    await baseExport(session);
    await test1Listing(session);
    await test2CalculatorParity(session);
    await test3FallbackParity(session);
    await test4Refusals(session);
    await test4bErrorAfterApply(session);
    await test5CommitUndo(session);
    await test5bMeleeTincture(session);
    await test6CrashReplay();
    await test6bAppliedButFailed();
  } finally {
    for (const b of bridges) await b.dispose().catch(() => undefined);
  }
  await test7Mcp();
  log('ALL FLASK TESTS PASSED');
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error('FAIL:', err instanceof Error ? err.stack ?? err.message : err);
    for (const b of bridges) b.forceKill();
    process.exit(1);
  },
);
