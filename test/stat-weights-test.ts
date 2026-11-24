// stat_weights and suggest_upgrades' suggested mods (src/stat-weights.ts).
//
//   1. A "+X to maximum Life" line raises Life by about X x (1 + inc%) (checked
//      against a "% increased maximum Life" line: (dFlat / X) x (dInc / 0.1) is
//      the build's Life), ranks above damage lines by TotalEHP; a cold damage
//      line raises CombinedDPS.
//   2. A nonsense line is listed in `unparsed` with a reason, not as a zero row.
//   3. Parity: each weight equals the probe (what evaluate_changes runs on) and
//      evaluate_changes with config {customMods: <existing> + "\n" + line}.
//   4. Existing custom modifiers are kept: with "20% increased maximum Life"
//      committed (set_config customMods, and as a CustomModifierBlock in the
//      build XML, which PoB reads instead of the customMods input), the flat
//      life line is worth more.
//   5. The build export, config, undo depth and committed fingerprint are
//      unchanged by stat_weights and suggest_upgrades.
//   6. Input checks; a probe variant mixing modLines with a full-recalculation
//      change is refused.
//   7. suggest_upgrades: the first modSlots slots carry PoB trade-generator
//      mods with numeric weights, the rest none; priority order kept; the
//      archetype table is gone; timing logged.
//   8. A trade query failure the engine reports (EngineCommandError) is
//      recorded on its slot (measurements kept); one that ends the engine, and
//      a transport / protocol failure with the engine alive (a stdin write
//      error, a reply that is not JSON), fail the call and no further slot is
//      queried.
import { mkdtempSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BuildSession } from '../src/build-session.js';
import { evaluateChanges, roundStat } from '../src/evaluate-changes.js';
import { EngineCommandError, LuaBridge } from '../src/lua-bridge.js';
import { compactStatWeights, computeStatWeights, DEFAULT_STAT_WEIGHT_MODS } from '../src/stat-weights.js';
import { UserError } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

process.env.POB_MCP_CONFIG_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-statweights-'));
const testDir = path.dirname(fileURLToPath(import.meta.url));

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function expectUserError(fn: () => Promise<unknown>, pattern: RegExp, label: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    assert(e instanceof UserError, `${label}: expected a UserError, got ${String(e)}`);
    assert(pattern.test(e.message), `${label}: unexpected message: ${e.message}`);
    return;
  }
  throw new Error(`${label}: expected a UserError`);
}

const FLAT_LIFE = '+50 to maximum Life';
const INC_LIFE = '10% increased maximum Life';
const COLD = '10% increased Cold Damage';
const NONSENSE = 'Grants the wielder a pleasant afternoon of llama herding';
const EXISTING = '20% increased maximum Life';
const STATS = ['CombinedDPS', 'TotalEHP', 'Life', 'EnergyShield'];

const STYGIAN_VISE = 'Rarity: RARE\nTest Vise\nStygian Vise\nItem Level: 80\nImplicits: 1\nHas 1 Abyssal Socket\n+80 to maximum Life';
const ABYSS_EYE = 'Rarity: RARE\nTest Eye\nMurderous Eye Jewel\nItem Level: 80\nImplicits: 0\n+40 to maximum Life\n+10% to Fire Resistance';

/**
 * 9. suggest_upgrades lists every item slot PoB uses (OccVortex: gear, five
 * flasks, three tree jewels; no unused weapon-swap slots, no Ring 3, no
 * hidden slots): flasks adding nothing to DPS/EHP and inactive flask slots
 * are unranked with a note, abyssal sockets the item has are measured, the
 * `slot` argument takes flask / jewel / abyssal slots, tinctures and empty
 * flask slots get a modsError. The build is unchanged after undoing the setup.
 */
async function test9SlotKinds(session: BuildSession, state: () => Promise<string>): Promise<void> {
  log('Test 9: suggest_upgrades covers flask, jewel and abyssal slots');
  const before = await state();
  const rows = await session.suggestUpgrades(undefined, { modSlots: 0 });
  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  for (const slot of ['Weapon 1', 'Weapon 2', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Belt']) {
    assert(bySlot.get(slot)?.kind === 'gear', `${slot} listed as gear`);
  }
  assert(rows.every((r) => !/Swap|Ring 3|Graft|^(Head|Body|Arm|Leg)$/.test(r.slot)), `unused swap, Ring 3 and hidden slots are left out: ${rows.map((r) => r.slot)}`);
  const jewels = rows.filter((r) => r.kind === 'treeJewel');
  assert(jewels.length === 3 && jewels.every((j) => /^Jewel \d+$/.test(j.slot) && typeof j.priority === 'number' && (j.dpsContribution ?? 0) > 0),
    `tree jewel sockets measured: ${JSON.stringify(jewels.map((j) => [j.slot, j.priority, j.dpsContribution]))}`);
  const flasks = rows.filter((r) => r.kind === 'flask');
  assert(flasks.length === 5 && flasks.every((f) => f.active === true), 'five active flask slots');
  const granite = bySlot.get('Flask 2')!;
  assert(typeof granite.priority === 'number' && (granite.ehpContribution ?? 0) > 0 && granite.note === undefined,
    `Granite Flask is ranked: ${JSON.stringify({ ...granite, currentItem: undefined })}`);
  for (const slot of ['Flask 1', 'Flask 4', 'Flask 5']) {
    const f = bySlot.get(slot)!;
    assert(f.priority === null && f.dpsContribution === 0 && f.ehpContribution === 0 && /adds nothing to DPS or EHP/.test(f.note ?? ''),
      `${slot}: a flask adding nothing is not ranked: ${JSON.stringify({ ...f, currentItem: undefined })}`);
  }

  // An inactive flask slot: not measured or ranked, with a note; asked for, it still gets PoB-weighted mods (evaluated active).
  await session.setFlaskActive('Flask 2', false);
  const off = (await session.suggestUpgrades(undefined, { modSlots: 0 })).find((r) => r.slot === 'Flask 2')!;
  assert(off.active === false && off.priority === null && off.ehpContribution === 0 && /not active.*set_flask_active/.test(off.note ?? ''),
    `inactive flask slot: ${JSON.stringify({ ...off, currentItem: undefined })}`);
  const offOne = await session.suggestUpgrades('Flask 2');
  assert(offOne.length === 1 && (offOne[0].suggestedMods?.length ?? 0) > 0, `slot Flask 2 (inactive) gets mods: ${JSON.stringify(offOne[0].modsError)}`);
  await session.undoLastChange();

  // An abyssal socket the item has: measured, and `slot` takes it (and a tree jewel socket).
  await session.swapItemWithDiff('Belt', STYGIAN_VISE);
  // Empty jewel / abyssal sockets: listed unranked after the measured slots, no
  // default suggestedMods (empty gear / flask slots keep their place at the top).
  await session.allocateNodes([26725]);
  await session.unequipItemWithDiff('Ring 2');
  const withEmpty = await session.suggestUpgrades();
  const emptyRows = withEmpty.filter((r) => r.slot === 'Belt Abyssal Socket 1' || r.slot === 'Jewel 26725');
  assert(emptyRows.length === 2 && emptyRows.every((r) => r.empty && r.priority === null && /empty socket/.test(r.note ?? '') && r.suggestedMods === undefined
    && r.modsError === undefined), `empty sockets: ${JSON.stringify(emptyRows)}`);
  const lastOccupied = Math.max(...withEmpty.map((r, i) => (r.empty ? -1 : i)));
  assert(withEmpty.findIndex((r) => r.slot === 'Belt Abyssal Socket 1') > lastOccupied && withEmpty.findIndex((r) => r.slot === 'Jewel 26725') > lastOccupied,
    `empty sockets sort after the measured slots: ${withEmpty.map((r) => r.slot)}`);
  assert(withEmpty[0].slot === 'Ring 2' && withEmpty[0].priority === 100 && (withEmpty[0].suggestedMods?.length ?? 0) > 0, 'an empty gear slot still leads, with mods');
  assert(withEmpty.filter((r) => (r.suggestedMods?.length ?? 0) > 0).length === 3, 'three slots with mods by default');
  for (const slot of ['Belt Abyssal Socket 1', 'Jewel 26725']) {
    const one = await session.suggestUpgrades(slot);
    assert(one.length === 1 && one[0].empty && (one[0].suggestedMods?.length ?? 0) > 0, `${slot} asked for: suggestedMods (${one[0].modsError})`);
  }
  await session.undoLastChange();
  await session.undoLastChange();
  await session.swapItemWithDiff('Belt Abyssal Socket 1', ABYSS_EYE);
  const withAbyss = await session.suggestUpgrades(undefined, { modSlots: 0 });
  const abyss = withAbyss.find((r) => r.slot === 'Belt Abyssal Socket 1');
  assert(abyss?.kind === 'abyssal' && abyss.parentSlot === 'Belt' && (abyss.ehpContribution ?? 0) > 0 && /^Test Eye/.test(abyss.currentItemName ?? ''),
    `abyssal socket row: ${JSON.stringify(abyss && { ...abyss, currentItem: undefined })}`);
  assert(!withAbyss.some((r) => r.slot === 'Belt Abyssal Socket 2'), 'only the sockets the belt has');
  const abyssOne = await session.suggestUpgrades('Belt Abyssal Socket 1');
  assert(abyssOne.length === 1 && (abyssOne[0].suggestedMods?.length ?? 0) > 0, `slot Belt Abyssal Socket 1 gets mods: ${abyssOne[0].modsError}`);
  const jewelOne = await session.suggestUpgrades(jewels[0].slot);
  assert(jewelOne.length === 1 && jewelOne[0].kind === 'treeJewel' && (jewelOne[0].suggestedMods?.length ?? 0) > 0, `slot ${jewels[0].slot} gets mods`);
  await session.undoLastChange();
  await session.undoLastChange();

  // Empty flask slots get a modsError (and use none of the modSlots budget); tinctures are weighed from PoB's tincture mods.
  const tincture = await session.readItemData<{ text: string }>({ cmd: 'itemText', base: 'Oakbranch Tincture' });
  await session.swapItemWithDiff('Flask 4', tincture.text);
  await session.unequipItemWithDiff('Flask 5');
  const odd = await session.suggestUpgrades(undefined, { modSlots: 3 });
  const tin = odd.find((r) => r.slot === 'Flask 4')!;
  const empty = odd.find((r) => r.slot === 'Flask 5')!;
  assert(tin.modsError === undefined, `tincture: ${JSON.stringify({ ...tin, currentItem: undefined })}`);
  // Asked for: queried (this spell build gains nothing from Oakbranch's melee mods, so the list may be empty).
  const tinOne = (await session.suggestUpgrades('Flask 4'))[0];
  assert(tinOne.modsError === undefined && tinOne.modsQueried === true && Array.isArray(tinOne.suggestedMods),
    `slot Flask 4 (tincture) is queried: ${JSON.stringify({ ...tinOne, currentItem: undefined })}`);
  assert(empty.empty && empty.kind === 'flask' && empty.suggestedMods === undefined && /Empty flask slot: generate_trade_search with flaskType/.test(empty.modsError ?? ''),
    `empty flask slot: ${JSON.stringify(empty)}`);
  assert(odd.filter((r) => (r.suggestedMods?.length ?? 0) > 0).length === 3, 'unsupported slots use none of the 3 mod slots');
  await session.undoLastChange();
  await session.undoLastChange();
  assert((await state()) === before, 'suggest_upgrades slot kinds: build not back after undo');
  log('PASS: flask / jewel / abyssal rows, unranked flasks, slot argument, unsupported slots');
}

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const bridge = new LuaBridge(paths, 120_000);
  const session = new BuildSession(bridge);
  const fixtureXml = readFileSync(fixturePath, 'utf8');
  const fingerprint = async (): Promise<string> =>
    JSON.stringify((await bridge.send<{ fingerprint: unknown }>({ cmd: 'probe', fingerprint: true })).fingerprint);
  const state = async (): Promise<string> =>
    JSON.stringify([await session.exportBuild('xml'), await session.getConfigOrganized(), session.undoStackDepth(), await fingerprint()]);
  try {
    await session.loadBuild(fixtureXml);
    const before = await state();

    log('Test 1: life and damage lines');
    let t = Date.now();
    const res = await computeStatWeights(session, { mods: [COLD, FLAT_LIFE, NONSENSE, INC_LIFE], stats: STATS, rankBy: 'TotalEHP' });
    log(`  ${Date.now() - t} ms for 4 lines`);
    const row = (mod: string) => res.weights.find((w) => w.mod === mod);
    const flat = row(FLAT_LIFE);
    const inc = row(INC_LIFE);
    const cold = row(COLD);
    assert(flat && inc && cold, `missing rows: ${JSON.stringify(res.weights.map((w) => w.mod))}`);
    const life = Number(res.base.Life);
    const dFlat = Number(flat.delta.Life);
    const dInc = Number(inc.delta.Life);
    assert(dFlat > 50, `+50 life should give more than 50 Life with increased life on the tree, got ${dFlat}`);
    const implied = (dFlat / 50) * (dInc / 0.1);
    assert(Math.abs(implied - life) / life < 0.02, `(dFlat/50)*(dInc/0.1) = ${implied} should be about Life ${life}`);
    assert(Number(flat.delta.TotalEHP) > 0, 'life line should raise TotalEHP');
    assert(Number(flat.pct.Life) > 0 && Math.abs(Number(flat.pct.Life) - (dFlat / life) * 100) < 1e-9, 'pct is delta in % of base');
    assert(Number(cold.delta.CombinedDPS) > 0, `cold damage line should raise CombinedDPS, got ${cold.delta.CombinedDPS}`);
    const ehp = res.weights.map((w) => Number(w.delta.TotalEHP));
    for (let i = 1; i < ehp.length; i++) assert(ehp[i - 1] >= ehp[i], `not ranked by TotalEHP: ${JSON.stringify(ehp)}`);
    assert(res.weights.indexOf(flat) < res.weights.indexOf(cold), 'life line should rank above the cold line by TotalEHP');
    log(`PASS: +50 life -> Life +${dFlat}, TotalEHP +${flat.delta.TotalEHP}; cold -> CombinedDPS +${cold.delta.CombinedDPS}`);

    log('Test 2: unparsed lines are reported');
    assert(!row(NONSENSE), 'nonsense line must not be listed as a weight');
    const bad = res.unparsed.find((u) => u.mod === NONSENSE);
    assert(bad && bad.reason.length > 0, `nonsense line missing from unparsed: ${JSON.stringify(res.unparsed)}`);
    log(`PASS: "${NONSENSE}" -> ${bad.reason}`);

    log('Test 3: parity with the probe and evaluate_changes (config customMods)');
    const parity = async (existing: string, rows: typeof res.weights, label: string): Promise<void> => {
      for (const w of rows) {
        const text = existing === '' ? w.mod : `${existing}\n${w.mod}`;
        const probed = await session.probe({ stats: STATS, variants: [{ config: { customMods: text } }] });
        const evaluated = await evaluateChanges(session, { variants: [{ config: { customMods: text } }], stats: STATS });
        for (const key of STATS) {
          const want = Number(probed.results[0].stats[key]) - Number(probed.base[key]);
          assert(w.delta[key] === want, `${label} ${w.mod} ${key}: stat_weights ${w.delta[key]} vs probe ${want}`);
          const ev = evaluated.results[0].delta?.[key];
          assert(ev === roundStat(want), `${label} ${w.mod} ${key}: evaluate_changes ${ev} vs ${roundStat(want)}`);
        }
      }
    };
    await parity('', res.weights, 'no custom mods:');
    log('PASS: identical deltas without custom modifiers');

    log('Test 4: existing custom modifiers are kept');
    await session.setConfigWithUndo({ customMods: EXISTING });
    const depth = session.undoStackDepth();
    const withExisting = await computeStatWeights(session, { mods: [FLAT_LIFE, COLD], stats: STATS });
    const flat2 = withExisting.weights.find((w) => w.mod === FLAT_LIFE);
    assert(flat2, 'flat life row missing');
    // +50 flat with 20% more increased: 50 x (1 + inc + 0.2) = dFlat + 50 x 0.2 (x more, 1 here).
    assert(Math.abs(Number(flat2.delta.Life) - (dFlat + 10)) <= 1, `with ${EXISTING} committed, +50 life should give about ${dFlat + 10}, got ${flat2.delta.Life}`);
    await parity(EXISTING, withExisting.weights, 'customMods input:');
    assert(session.undoStackDepth() === depth, 'stat_weights pushed to undo');
    await session.undoLastChange();
    log(`PASS: +50 life -> Life +${flat2.delta.Life} with "${EXISTING}" committed; parity holds`);

    const blockXml = fixtureXml.replace('</Config>',
      `\t<CustomModifierBlock title="Default" enabled="true">${EXISTING}</CustomModifierBlock>\n\t</Config>`);
    await session.loadBuild(blockXml);
    const blockBase = await computeStatWeights(session, { mods: [FLAT_LIFE], stats: STATS });
    const flat3 = blockBase.weights[0];
    assert(Math.abs(Number(flat3.delta.Life) - (dFlat + 10)) <= 1,
      `with ${EXISTING} in a custom modifier block, +50 life should give about ${dFlat + 10}, got ${flat3.delta.Life}`);
    assert(Number(blockBase.base.Life) > life, 'the block\'s life mod should count in the base');
    log(`PASS: custom modifier block kept: +50 life -> Life +${flat3.delta.Life}`);
    await session.loadBuild(fixtureXml);

    log('Test 5: default pack, build unchanged');
    t = Date.now();
    const all = await computeStatWeights(session, {});
    const allMs = Date.now() - t;
    assert(all.weights.length + all.unparsed.length + (all.failed?.length ?? 0) === DEFAULT_STAT_WEIGHT_MODS.length, 'every default line accounted for');
    assert(all.unparsed.length === 0, `default lines PoB cannot parse: ${JSON.stringify(all.unparsed)}`);
    assert(all.failed === undefined, `default lines failed: ${JSON.stringify(all.failed)}`);
    assert(all.rankBy === 'CombinedDPS' && Number(all.weights[0].delta.CombinedDPS) > 0, 'default ranking by CombinedDPS');
    const compact = compactStatWeights(all);
    log(`  default pack: ${DEFAULT_STAT_WEIGHT_MODS.length} lines in ${allMs} ms, reply ${JSON.stringify(compact).length} bytes; top: ${all.weights.slice(0, 3).map((w) => w.mod).join(' | ')}`);
    assert((await state()) === before, 'stat_weights changed the build, config, undo depth or fingerprint');
    log('PASS: export, config, undo depth and fingerprint unchanged');

    log('Test 6: input checks');
    await expectUserError(() => computeStatWeights(session, { mods: ['  '] }), /empty/, 'empty line');
    await expectUserError(() => computeStatWeights(session, { mods: ['+1 to a\n+2 to b'] }), /one line/, 'two lines in one entry');
    await expectUserError(() => computeStatWeights(session, { mods: [FLAT_LIFE], rankBy: 'NoSuchStat' }), /rankBy/, 'unknown rankBy');
    const unknown = await computeStatWeights(session, { mods: [FLAT_LIFE], stats: ['Life', 'NoSuchStat'], rankBy: 'Life' });
    assert(unknown.unknownStats?.includes('NoSuchStat') && !('NoSuchStat' in unknown.weights[0].delta), 'unknown stat reported');
    const near = await bridge.send<{ nodes: Array<{ id: number }> }>({ cmd: 'probe', candidates: 'allocate', maxPoints: 1 });
    assert(near.nodes.length >= 2, 'need two adjacent unallocated nodes');
    const mixed = await bridge.send<{ results: Array<{ error?: string; userError?: boolean }> }>({
      cmd: 'probe',
      variants: [{ modLines: [FLAT_LIFE], allocate: [near.nodes[0].id, near.nodes[1].id] }, { modLines: [NONSENSE] }],
    });
    assert(mixed.results[0].userError === true && /cannot be combined with a change that needs a full recalculation/.test(mixed.results[0].error ?? ''),
      `modLines + several node changes should be refused: ${JSON.stringify(mixed.results[0])}`);
    assert(mixed.results[1].userError === true && /cannot be used/.test(mixed.results[1].error ?? ''), `unparsed modLines refused: ${JSON.stringify(mixed.results[1])}`);
    assert((await state()) === before, 'input checks changed the build');
    log('PASS: bad input refused');

    log('Test 7: suggest_upgrades uses PoB trade weights');
    const source = readFileSync(path.join(testDir, '..', 'src', 'build-session.ts'), 'utf8');
    assert(!/identifyArchetype|getSuggestedMods|archmage/i.test(source), 'archetype table still in build-session.ts');
    t = Date.now();
    const suggestions = await session.suggestUpgrades();
    const ms = Date.now() - t;
    const measured = suggestions.filter((s) => s.error === undefined);
    const withMods = suggestions.filter((s) => s.suggestedMods !== undefined || s.modsError !== undefined);
    assert(withMods.length === 3, `default: 3 slots with mods, got ${withMods.length}`);
    assert(withMods.every((s, i) => s === measured[i]), 'mods go to the highest-priority slots');
    for (const s of withMods) {
      assert(s.suggestedMods && s.suggestedMods.length > 0, `${s.slot}: no suggested mods (${s.modsError})`);
      for (const m of s.suggestedMods) {
        assert(typeof m.mod === 'string' && m.mod.length > 0 && typeof m.weight === 'number' && m.weight > 0, `${s.slot}: bad mod ${JSON.stringify(m)}`);
      }
      assert(new Set(s.suggestedMods.map((m) => m.mod)).size === s.suggestedMods.length, `${s.slot}: duplicate mod texts`);
    }
    const ranked = measured.filter((s) => !s.empty && s.priority !== null);
    for (let i = 1; i < ranked.length; i++) assert(ranked[i - 1].priority! >= ranked[i].priority!, 'priority order lost');
    const firstUnranked = measured.findIndex((s) => s.priority === null);
    assert(firstUnranked < 0 || measured.slice(firstUnranked).every((s) => s.priority === null), 'unranked slots come after the ranked ones');
    log(`  suggest_upgrades (default, 3 slots with mods): ${ms} ms`);
    log(`  ${withMods.map((s) => `${s.slot}: ${s.suggestedMods!.slice(0, 2).map((m) => `${m.mod} (${m.weight})`).join(', ')}`).join(' | ')}`);
    assert(ms < 15_000, `default suggest_upgrades took ${ms} ms`);

    t = Date.now();
    const none = await session.suggestUpgrades(undefined, { modSlots: 0 });
    log(`  modSlots 0: ${Date.now() - t} ms`);
    assert(none.every((s) => s.suggestedMods === undefined), 'modSlots 0 computes no mods');
    const single = await session.suggestUpgrades('Gloves');
    assert(single.length === 1 && (single[0].suggestedMods?.length ?? 0) > 0, 'single slot gets mods');
    t = Date.now();
    const every = await session.suggestUpgrades(undefined, { modSlots: 10 });
    log(`  modSlots 10: ${Date.now() - t} ms`);
    // modSlots 10: the first 10 slots the generator supports, in order (unsupported ones carry a modsError and use none of the budget).
    const supported = every.filter((s) => s.error === undefined && !(s.suggestedMods === undefined && s.modsError !== undefined));
    assert(supported.slice(0, 10).every((s) => (s.suggestedMods?.length ?? 0) > 0) && supported.slice(10).every((s) => s.suggestedMods === undefined),
      `modSlots 10 covers the first 10 supported slots: ${JSON.stringify(every.map((s) => [s.slot, s.suggestedMods?.length, s.modsError]))}`);
    assert((await state()) === before, 'suggest_upgrades changed the build, config, undo depth or fingerprint');
    log('PASS: suggested mods carry PoB weights; build unchanged');

    log('Test 8: a trade query failure stays on its slot');
    const realSend = bridge.send.bind(bridge);
    const realRunning = bridge.isRunning.bind(bridge);
    const order = measured.map((s) => s.slot);
    const failSlot = (slot: string, gone: boolean, error: Error = new EngineCommandError('simulated trade query failure')): void => {
      (bridge as unknown as { send: typeof bridge.send }).send = (<T>(command: object, timeout?: number): Promise<T> => {
        const c = command as { cmd?: string; slot?: string };
        if (c.cmd === 'tradeQuery' && c.slot === slot) {
          if (gone) (bridge as unknown as { isRunning: () => boolean }).isRunning = () => false;
          return Promise.reject(error);
        }
        return realSend<T>(command, timeout);
      }) as typeof bridge.send;
    };
    try {
      failSlot(order[0], false);
      const failedOne = await session.suggestUpgrades();
      assert(failedOne.length === suggestions.length, 'every slot still listed');
      const first = failedOne.find((s) => s.slot === order[0])!;
      assert(first.suggestedMods === undefined && /trade query generator failed: simulated/.test(first.modsError ?? ''), `failed slot: ${JSON.stringify(first)}`);
      assert(first.dpsContribution === measured[0].dpsContribution && first.ehpContribution === measured[0].ehpContribution, 'measurement kept');
      assert(failedOne.filter((s) => (s.suggestedMods?.length ?? 0) > 0).length === 2, 'the other two slots still get mods');
      // The call fails, after one query, when the engine is gone and when the
      // protocol failed with the engine alive (the next reply may not be the
      // next query's).
      const protocolFailures: Array<[string, boolean, Error]> = [
        ['the engine is gone', true, new EngineCommandError('simulated trade query failure')],
        ['a reply that is not JSON', false, new Error('Invalid JSON from Lua: {"ok":tru; simulated')],
        ['a stdin write error', false, Object.assign(new Error('write EPIPE (simulated)'), { code: 'EPIPE' })],
      ];
      for (const [what, gone, error] of protocolFailures) {
        failSlot(order[0], gone, error);
        let queried = 0;
        const countingSend = bridge.send;
        (bridge as unknown as { send: typeof bridge.send }).send = (<T>(command: object, timeout?: number): Promise<T> => {
          if ((command as { cmd?: string }).cmd === 'tradeQuery') queried++;
          return countingSend<T>(command, timeout);
        }) as typeof bridge.send;
        let failedCall: unknown;
        try {
          await session.suggestUpgrades();
        } catch (e) {
          failedCall = e;
        }
        assert(failedCall === error, `${what}: the call fails with that error: ${String(failedCall)}`);
        assert(queried === 1, `${what}: no slot is queried after it (${queried} queries)`);
        (bridge as unknown as { isRunning: () => boolean }).isRunning = realRunning;
      }
    } finally {
      (bridge as unknown as { send: typeof bridge.send }).send = realSend;
      (bridge as unknown as { isRunning: () => boolean }).isRunning = realRunning;
    }
    assert((await state()) === before, 'build changed');
    log('PASS: engine-reported failures recorded per slot; the call fails once the engine is gone or the protocol failed');

    await test9SlotKinds(session, state);

    console.log('\nALL STAT WEIGHTS TESTS PASSED');
  } finally {
    await bridge.dispose();
  }
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  log(`FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
