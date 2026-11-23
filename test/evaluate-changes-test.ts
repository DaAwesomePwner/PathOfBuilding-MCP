// evaluate_changes (src/evaluate-changes.ts) against the OccVortex fixture.
//
//   1. A mixed 30-variant call (nodes by id and by name, deallocations, item
//      swaps, unequips, gem ops, config, a combined variant, and four refused
//      variants) runs without a fallback and is timed (< 1 s; one retry so a
//      load spike in a parallel test run does not fail it).
//   2. Ranking: successes are sorted by the rankBy delta (desc), refused
//      variants come after them with their user errors; labels and indices
//      point back at the input.
//   3. Parity: every successful row's deltas, value and points equal the same
//      variant run alone through session.probe, and a few equal the single
//      tools (simulate_passive_change by name, compare_items, swap_gem,
//      simulate_config / toggle_buffs).
//   4. Nothing changes: export_build xml byte-identical and undo depth
//      unchanged afterwards.
//   5. rankBy "Life" with order "asc", a custom stats list with an unknown key
//      (null base and delta), and a node name nobody has.
//  12. Masteries and mainSkill (ConvertTreeMasteries.xml, a 3.24 tree): two
//      effects of one mastery (by id and by text) and a `mainSkill` row run
//      through the calculator; each row's deltas equal the change committed
//      (allocate_nodes `masteries` / set_main_skill) + get_stats; the export
//      stays byte-identical and the undo depth unchanged.
import { mkdtempSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { BuildSession, type NamedProbeVariant, type TreeNodeInfo } from '../src/build-session.js';
import { DEFAULT_EVALUATE_STATS, evaluateChanges, makeScorer, roundStat, violations,type EvaluateChangesResult, type EvaluateChangesVariant } from '../src/evaluate-changes.js';
import { LuaBridge, type Stats } from '../src/lua-bridge.js';
import { setupTestEnv } from './_skip.js';

process.env.POB_MCP_CONFIG_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-evaluate-'));

const MAIN_GROUP = 5; // Body Armour: Hypothermia, Controlled Destruction, Rapid Decay, Efficacy, Concentrated Effect, Vortex
const VORTEX = 6;

const RING_A = `Rarity: RARE
Probe Ring A
Coral Ring
Item Level: 63
LevelReq: 64
Implicits: 1
+30 to maximum Life
+150 to maximum Life
+30% to all Elemental Resistances`;

const AMULET = `Rarity: RARE
Probe Amulet
Jade Amulet
Item Level: 80
Implicits: 1
+25 to Dexterity
+60 to maximum Life`;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);

/** The export is byte-identical to `xml0` (masteries / mainSkill section). */
async function assertExportUnchanged2(session: BuildSession, xml0: string, after: string): Promise<void> {
  const xml = await session.exportXML();
  assert(xml === xml0, `export changed after ${after}`);
}
const sameNumber = (a: unknown, b: unknown): boolean => a === b || (Number.isNaN(a) && Number.isNaN(b));

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const bridge = new LuaBridge(paths, 120_000);
  const session = new BuildSession(bridge);
  const undoDepth = (): number => session.undoStackDepth();

  try {
    await session.loadBuild(readFileSync(fixturePath, 'utf8'));
    const undo0 = undoDepth();
    const stats0 = await session.getStats();

    const reachable = (await session.getReachableNodes()).filter((n) => !n.isJewelSocket && !n.isMastery && !n.isAscendancy);
    const allocated = (await bridge.send<{ nodes: TreeNodeInfo[] }>({ cmd: 'getAllocatedNodesDetailed' })).nodes;
    const nameCount = new Map<string, number>();
    for (const n of [...reachable, ...allocated]) nameCount.set(n.name, (nameCount.get(n.name) ?? 0) + 1);
    const notableByName = reachable.filter((n) => n.isNotable && nameCount.get(n.name) === 1);
    assert(notableByName.length >= 3, `only ${notableByName.length} reachable notables with a unique name`);
    const byId = reachable.filter((n) => !n.isNotable).slice(0, 8);
    // Deallocations the calculator handles (no jewel socket holding a jewel among the dependents).
    const fastDealloc = async (nodes: TreeNodeInfo[]): Promise<TreeNodeInfo[]> => {
      const res = await session.probe({ variants: nodes.map((n) => ({ deallocate: [n.id] })) });
      return nodes.filter((_n, i) => !res.results[i].fallback && res.results[i].error === undefined);
    };
    const allocNotables = await fastDealloc(allocated.filter((n) => n.isNotable && !n.isAscendancy && nameCount.get(n.name) === 1));
    assert(allocNotables.length >= 2, 'fixture needs allocated notables');
    const [allocNormal] = await fastDealloc(allocated.filter((n) => n.type === 'Normal'));
    assert(allocNormal, 'fixture needs an allocated normal node');
    // Taken after the setup probes above: a deallocation that takes the
    // tree-only fallback restores the passive tree, which on PoB 2.67.2 may
    // list the same nodes in another order in the export.
    const xml0 = await session.exportXML();
    /** The export must still be byte-identical to the loaded build's; names the first differing line. */
    const assertExportUnchanged = async (after: string): Promise<void> => {
      const xml = await session.exportXML();
      if (xml === xml0) return;
      const a = xml0.split(/\r?\n/);
      const b = xml.split(/\r?\n/);
      const at = a.findIndex((l, k) => l !== b[k]);
      throw new Error(`export changed after ${after}, at line ${at + 1}: ${a[at]?.slice(0, 300)} -> ${b[at]?.slice(0, 300)}`);
    };

    // ------------------------------------------------------------------
    log('1. Mixed 30-variant call');
    const variants: EvaluateChangesVariant[] = [
      ...byId.map((n) => ({ label: `alloc ${n.id}`, allocate: [n.id] })),
      ...notableByName.slice(0, 3).map((n) => ({ label: `alloc ${n.name}`, allocate: [n.name] })),
      { label: `dealloc ${allocNotables[0].name}`, deallocate: [allocNotables[0].name] },
      { label: `dealloc ${allocNotables[1].id}`, deallocate: [allocNotables[1].id] },
      { label: `dealloc ${allocNormal.id}`, deallocate: [allocNormal.id] },
      { label: 'ring', items: [{ slot: 'Ring 1', itemText: RING_A }] },
      { label: 'amulet', items: [{ slot: 'Amulet', itemText: AMULET }] },
      { label: 'unequip ring 2', items: [{ slot: 'Ring 2', unequip: true }] },
      { label: 'unequip gloves', items: [{ slot: 'Gloves', unequip: true }] },
      { label: 'vortex 21', gems: [{ op: 'set', group: MAIN_GROUP, index: VORTEX, level: 21 }] },
      { label: 'remove support', gems: [{ op: 'remove', group: MAIN_GROUP, index: 2 }] },
      { label: 'swap to elemental focus', gems: [{ op: 'set', group: MAIN_GROUP, index: 1, name: 'Elemental Focus' }] },
      { label: 'add elemental focus', gems: [{ op: 'add', group: MAIN_GROUP, name: 'Elemental Focus', level: 20, quality: 20 }] },
      { label: 'pinnacle', config: { enemyIsBoss: 'Pinnacle' } },
      { label: 'power charges', config: { usePowerCharges: true } },
      { label: 'onslaught', config: { buffOnslaught: true } },
      {
        label: 'combined',
        allocate: [byId[0].id],
        items: [{ slot: 'Ring 1', itemText: RING_A }],
        gems: [{ op: 'set', group: MAIN_GROUP, index: VORTEX, level: 21 }],
        config: { usePowerCharges: true },
      },
      { label: 'bad node', allocate: ['Not A Real Passive Node'] },
      { label: 'bad gem', gems: [{ op: 'set', group: MAIN_GROUP, index: 1, name: 'Not A Real Gem' }] },
      { label: 'bad config', config: { notARealConfigKey: true } },
      { label: 'ring in helmet', items: [{ slot: 'Helmet', itemText: RING_A }] },
    ];
    assert(variants.length === 30, `expected 30 variants, have ${variants.length}`);
    const REFUSED = new Set(['bad node', 'bad gem', 'bad config', 'ring in helmet']);

    const timed = async (): Promise<{ result: EvaluateChangesResult; ms: number }> => {
      const t0 = performance.now();
      const result = await evaluateChanges(session, { variants });
      return { result, ms: performance.now() - t0 };
    };
    let { result, ms } = await timed();
    await assertExportUnchanged('evaluate_changes');
    if (ms >= 1000) {
      log(`   first run took ${ms.toFixed(0)} ms; retrying once`);
      ({ result, ms } = await timed());
    }
    log(`   30 variants in ${ms.toFixed(0)} ms (${result.evaluated} evaluated, ${result.failed} refused, ${result.fallbacks} fallbacks)`);
    log(`   response ${JSON.stringify(result).length} bytes`);
    assert(ms < 1000, `30 variants took ${ms.toFixed(0)} ms (limit 1000 ms)`);
    assert(result.fallbacks === 0, `variants fell back: ${result.results.filter((r) => r.fallback).map((r) => r.label).join(", ")}`);
    assert(result.rankBy === 'CombinedDPS' && result.order === 'desc', 'default rankBy / order');
    assert(JSON.stringify(Object.keys(result.base)) === JSON.stringify(DEFAULT_EVALUATE_STATS), `base keys ${Object.keys(result.base)}`);
    for (const key of DEFAULT_EVALUATE_STATS) {
      assert(result.base[key] === roundStat(num(stats0[key])), `base ${key}: ${result.base[key]} vs get_stats ${stats0[key]}`);
    }

    // ------------------------------------------------------------------
    log('2. Ranking and refused variants');
    assert(result.results.length === 30, 'every variant has a row');
    const indices = result.results.map((r) => r.index).sort((a, b) => a - b);
    assert(indices.every((v, i) => v === i), 'each index appears once');
    const okRows = result.results.filter((r) => r.error === undefined);
    const errRows = result.results.filter((r) => r.error !== undefined);
    assert(okRows.length === 26 && errRows.length === 4, `${okRows.length} ok, ${errRows.length} refused`);
    assert(result.results.slice(26).every((r) => r.error !== undefined), 'refused variants come last');
    for (const r of result.results) {
      assert(r.label === variants[r.index].label, `row ${r.index} label ${r.label}`);
      if (REFUSED.has(r.label!)) assert(r.error && r.userError === true, `${r.label}: expected a user error, got ${JSON.stringify(r)}`);
      else assert(r.error === undefined, `${r.label}: unexpected error ${r.error}`);
    }
    for (let i = 1; i < okRows.length; i++) {
      assert(okRows[i - 1].delta!.CombinedDPS! >= okRows[i].delta!.CombinedDPS!,
        `rows ${i - 1}/${i} out of order: ${okRows[i - 1].delta!.CombinedDPS} < ${okRows[i].delta!.CombinedDPS}`);
    }
    log(`   top: ${okRows.slice(0, 3).map((r) => `${r.label} ${r.delta!.CombinedDPS}`).join(', ')}`);
    log(`   errors: ${errRows.map((r) => `${r.label}: ${r.error}`).join(' | ')}`);
    assert(/not found/.test(errRows.find((r) => r.label === 'bad node')!.error!), 'bad node error names the node');

    // ------------------------------------------------------------------
    log('3. Parity with single probes and single tools');
    const keys = DEFAULT_EVALUATE_STATS;
    for (const row of okRows) {
      const { label: _label, ...variant } = variants[row.index];
      const single = await session.probeNamed({ stats: keys, variants: [variant as NamedProbeVariant] });
      const r = single.results[0];
      assert(r.error === undefined, `${row.label}: single probe failed: ${r.error}`);
      for (const key of keys) {
        const want = roundStat(num(r.stats[key]) - num(single.base[key]));
        assert(sameNumber(row.delta![key], want), `${row.label} ${key}: ${row.delta![key]} vs single probe ${want}`);
      }
      assert(row.value === roundStat(num(r.stats.CombinedDPS)), `${row.label}: value ${row.value}`);
      assert((row.pointsAdded ?? 0) === (r.pointsAdded ?? 0) && (row.pointsRemoved ?? 0) === (r.pointsRemoved ?? 0),
        `${row.label}: points ${row.pointsAdded}/${row.pointsRemoved} vs ${r.pointsAdded}/${r.pointsRemoved}`);
      await assertExportUnchanged(`the single probe of ${row.label}`);
    }
    const rowOf = (label: string) => okRows.find((r) => r.label === label)!;
    const expectDiff = (label: string, before: Stats, after: Stats) => {
      for (const key of keys) {
        const want = roundStat(num(after[key]) - num(before[key]));
        assert(sameNumber(rowOf(label).delta![key], want), `${label} ${key}: ${rowOf(label).delta![key]} vs tool ${want}`);
      }
    };
    const named = notableByName[0];
    const sim = await session.simulatePassiveChange([named.name], []);
    expectDiff(`alloc ${named.name}`, sim.before, sim.after);
    await assertExportUnchanged('simulate_passive_change');
    assert(rowOf(`alloc ${named.name}`).pointsAdded! >= 1, 'a named allocate reports its points');
    const cmp = await session.compareItems('Ring 1', [RING_A, AMULET]);
    expectDiff('ring', cmp.baseline.stats, cmp.candidates[0].stats!);
    await assertExportUnchanged('compare_items');
    const gem = await session.swapGemWithDiff(MAIN_GROUP, 1, 'Elemental Focus');
    expectDiff('swap to elemental focus', gem.before, gem.after);
    await assertExportUnchanged('swap_gem');
    const boss = await session.simulateConfig({ enemyIsBoss: 'Pinnacle' });
    expectDiff('pinnacle', boss.before, boss.after);
    await assertExportUnchanged('simulate_scenario');
    const onslaught = await session.toggleBuffs({ onslaught: true });
    expectDiff('onslaught', onslaught.before, onslaught.after);
    await assertExportUnchanged('toggle_buffs');
    log('   PASS');

    // ------------------------------------------------------------------
    log('4. Build unchanged');
    await assertExportUnchanged('evaluate_changes and the single tools');
    assert(undoDepth() === undo0, `undo depth ${undoDepth()} vs ${undo0}`);
    log('   PASS: export byte-identical, undo depth unchanged');

    // ------------------------------------------------------------------
    log('5. rankBy / order / stats options');
    const asc = await evaluateChanges(session, {
      variants: variants.filter((v) => !REFUSED.has(v.label!)),
      rankBy: 'Life',
      order: 'asc',
      stats: ['Life', 'NotARealStat'],
    });
    assert(JSON.stringify(Object.keys(asc.base)) === '["Life","NotARealStat"]', `stats keys ${Object.keys(asc.base)}`);
    assert(asc.base.NotARealStat === null, 'unknown stat base is null');
    assert(asc.results.every((r) => r.delta!.NotARealStat === null), 'unknown stat delta is null');
    for (let i = 1; i < asc.results.length; i++) {
      assert(asc.results[i - 1].delta!.Life! <= asc.results[i].delta!.Life!, `asc rows ${i - 1}/${i} out of order`);
    }
    assert(asc.results[0].value === roundStat(num(stats0.Life) + asc.results[0].delta!.Life!), 'value is the rankBy stat');
    const rankAdded = await evaluateChanges(session, { variants: [{ config: { usePowerCharges: true } }], rankBy: 'TotalDPS', stats: ['Life'] });
    assert(JSON.stringify(Object.keys(rankAdded.base)) === '["TotalDPS","Life"]', 'rankBy is added to stats');
    log(`   PASS: lowest Life first is ${asc.results[0].label} (${asc.results[0].delta!.Life})`);
    assert((await session.exportXML()) === xml0, 'export changed after the option checks');
    assert(undoDepth() === undo0, 'undo depth changed after the option checks');

    // ------------------------------------------------------------------
    log('6. Node names several nodes share');
    const unallocated = (await bridge.send<{ nodes: Array<{ id: number; name: string }> }>({ cmd: 'probe', candidates: 'allocate', maxPoints: 10_000 })).nodes;
    const group = (nodes: Array<{ id: number; name: string }>): Map<string, number[]> => {
      const m = new Map<string, number[]>();
      for (const n of nodes) m.set(n.name.toLowerCase(), [...(m.get(n.name.toLowerCase()) ?? []), n.id]);
      return m;
    };
    const unallocByName = group(unallocated);
    const allocByName = group(allocated);
    const [ambAlloc, ambAllocIds] = [...unallocByName.entries()].find(([, ids]) => ids.length > 1)!;
    const [ambDealloc, ambDeallocIds] = [...allocByName.entries()].find(([, ids]) => ids.length > 1)!;
    // Allocated once, unallocated elsewhere too: deallocating it by name is not ambiguous.
    const [onceName, [onceId]] = [...allocByName.entries()].find(([name, ids]) => ids.length === 1 && (unallocByName.get(name)?.length ?? 0) > 0)!;
    assert(ambAlloc && ambDealloc && onceName, 'fixture needs shared node names');
    const shared = await evaluateChanges(session, {
      variants: [
        { label: 'ambiguous allocate', allocate: [ambAlloc] },
        { label: 'ambiguous deallocate', deallocate: [ambDealloc] },
        { label: 'allocated-once by name', deallocate: [onceName] },
        { label: 'allocated-once by id', deallocate: [onceId] },
        { label: 'config still runs', config: { usePowerCharges: true } },
      ],
    });
    const row = (label: string) => shared.results.find((r) => r.label === label)!;
    for (const [label, ids] of [['ambiguous allocate', ambAllocIds], ['ambiguous deallocate', ambDeallocIds]] as const) {
      const r = row(label);
      assert(r.userError === true && /matches \d+ nodes/.test(r.error ?? '') && r.error!.includes('Pass the node id'), `${label}: ${JSON.stringify(r)}`);
      assert(r.error!.includes(`matches ${ids.length} nodes`), `${label}: count: ${r.error}`);
      log(`   ${label}: ${r.error!.slice(0, 140)}`);
    }
    assert(row('ambiguous allocate').error!.includes('unallocated'), 'allocate candidates say unallocated');
    assert(row('allocated-once by name').error === undefined && row('config still runs').error === undefined, 'the other variants ran');
    assert(JSON.stringify(row('allocated-once by name').delta) === JSON.stringify(row('allocated-once by id').delta), 'name resolves to the allocated node');
    let simError: unknown;
    try {
      await session.simulatePassiveChange([ambAlloc], []);
    } catch (e) {
      simError = e;
    }
    assert(simError instanceof Error && simError.constructor.name === 'UserError' && /matches \d+ nodes/.test(simError.message),
      `simulate_passive_change with an ambiguous name: ${String(simError)}`);
    assert((await session.exportXML()) === xml0, 'export changed after the name checks');
    log('   PASS');

    // ------------------------------------------------------------------
    log('7. objective / constraints: backwards compatibility');
    const good = variants.filter((v) => !REFUSED.has(v.label!));
    const plain = await evaluateChanges(session, { variants });
    assert(JSON.stringify(Object.keys(plain)) === '["rankBy","order","base","evaluated","failed","fallbacks","results"]', `plain keys ${Object.keys(plain)}`);
    const OLD_ROW_KEYS = ['index', 'label', 'value', 'delta', 'pointsAdded', 'pointsRemoved', 'fallback', 'error', 'userError'];
    for (const r of plain.results) assert(Object.keys(r).every((k) => OLD_ROW_KEYS.includes(k)), `plain row keys ${Object.keys(r)}`);
    // The old behaviour, rebuilt here from raw probe numbers: successes by CombinedDPS change (desc, ties by index), refused variants after them by index.
    const rawProbe = await session.probeNamed({ stats: ['CombinedDPS'], variants: variants.map(({ label: _l, ...v }) => v as NamedProbeVariant) });
    const rawDelta = (i: number): number => num(rawProbe.results[i].stats.CombinedDPS) - num(rawProbe.base.CombinedDPS);
    const okIdx = rawProbe.results.map((r, i) => i).filter((i) => rawProbe.results[i].error === undefined);
    const errIdx = rawProbe.results.map((r, i) => i).filter((i) => rawProbe.results[i].error !== undefined);
    const expectedOrder = [...okIdx.sort((a, b) => (rawDelta(a) === rawDelta(b) ? a - b : rawDelta(b) - rawDelta(a))), ...errIdx];
    assert(JSON.stringify(plain.results.map((r) => r.index)) === JSON.stringify(expectedOrder), `plain order ${plain.results.map((r) => r.index)} vs expected ${expectedOrder}`);
    assert(plain.results[0].label === 'add elemental focus' && plain.results[1].label === 'swap to elemental focus', `top two: ${plain.results[0].label}, ${plain.results[1].label}`);
    const KEY_ORDER = ['index', 'label', 'value', 'delta', 'pointsAdded', 'pointsRemoved', 'fallback', 'error', 'userError'];
    for (const r of plain.results) {
      const keys = Object.keys(r);
      assert(JSON.stringify(keys) === JSON.stringify(KEY_ORDER.filter((k) => keys.includes(k))), `plain row key order ${keys}`);
      assert(r.error === undefined ? keys.includes('value') && keys.includes('delta') : keys.includes('error') && keys.includes('userError'), `plain row keys ${keys}`);
    }
    // Constraints nobody breaks change nothing but the `violating` counter.
    const loose = await evaluateChanges(session, { variants, constraints: [{ stat: 'Life', min: -1e9 }] });
    assert(loose.violating === 0, `loose violating ${loose.violating}`);
    assert(JSON.stringify(loose.results.map((r) => r.index)) === JSON.stringify(expectedOrder), 'unbroken constraints keep the order');
    assert(loose.results.every((r) => r.violates === undefined), 'no violates when nothing is broken');
    log('   PASS');

    // ------------------------------------------------------------------
    log('8. objective: weighted ranking');
    const ratio = (r: { delta?: Record<string, number | null> }, key: string): number => r.delta![key]! / Math.abs(num(stats0[key]));
    // A pair where A gains more DPS but B gains more EHP: the weights decide which comes first.
    const dpsEhp = good.length > 0 ? (await evaluateChanges(session, { variants: good, stats: ['CombinedDPS', 'TotalEHP'] })).results : [];
    let pair: [typeof dpsEhp[number], typeof dpsEhp[number]] | undefined;
    for (const a of dpsEhp) {
      for (const b of dpsEhp) {
        if (a === b) continue;
        const dd = ratio(a, 'CombinedDPS') - ratio(b, 'CombinedDPS');
        const de = ratio(b, 'TotalEHP') - ratio(a, 'TotalEHP');
        const best = pair ? ratio(pair[0], 'CombinedDPS') - ratio(pair[1], 'CombinedDPS') : 0;
        if (dd > 1e-6 && de > 1e-6 && dd > best) pair = [a, b];
      }
    }
    assert(pair, 'fixture variants need a DPS-up/EHP-down vs DPS-down/EHP-up pair');
    const [A, B] = pair;
    const dd = ratio(A, 'CombinedDPS') - ratio(B, 'CombinedDPS');
    const de = ratio(B, 'TotalEHP') - ratio(A, 'TotalEHP');
    log(`   pair: ${A.label} (DPS ${A.delta!.CombinedDPS}, EHP ${A.delta!.TotalEHP}) vs ${B.label} (DPS ${B.delta!.CombinedDPS}, EHP ${B.delta!.TotalEHP})`);
    const posOf = (res: EvaluateChangesResult, label: string): number => res.results.findIndex((r) => r.label === label);
    const dpsHeavy = await evaluateChanges(session, { variants: good, objective: { weights: { CombinedDPS: 1, TotalEHP: (0.5 * dd) / de } } });
    const ehpHeavy = await evaluateChanges(session, { variants: good, objective: { weights: { CombinedDPS: (0.5 * de) / dd, TotalEHP: 1 } } });
    assert(posOf(dpsHeavy, A.label!) < posOf(dpsHeavy, B.label!), `DPS-heavy weights: ${A.label} should come before ${B.label}`);
    assert(posOf(ehpHeavy, B.label!) < posOf(ehpHeavy, A.label!), `EHP-heavy weights: ${B.label} should come before ${A.label}`);
    assert(dpsHeavy.rankBy === undefined && dpsHeavy.objective?.mode === 'relative', `objective header ${JSON.stringify(dpsHeavy.objective)}`);
    assert(dpsHeavy.results.every((r) => r.value === undefined && typeof r.score === 'number'), 'rows carry score, not value');
    for (const res of [dpsHeavy, ehpHeavy]) {
      for (let i = 1; i < res.results.length; i++) assert(res.results[i - 1].score! >= res.results[i].score!, `score rows ${i - 1}/${i} out of order`);
      assert(Object.keys(res.base).includes('CombinedDPS') && Object.keys(res.base).includes('TotalEHP'), 'weighted stats are in base');
    }
    // The score is exactly sum(weight * delta / |base|).
    const w = { CombinedDPS: 1, TotalEHP: (0.5 * dd) / de };
    for (const r of dpsHeavy.results) {
      const want = w.CombinedDPS * ratio(r, 'CombinedDPS') + w.TotalEHP * ratio(r, 'TotalEHP');
      // the score is rounded like every number (2 decimals at 1 and above), the deltas it is checked against already are
      assert(Math.abs(r.score! - want) <= 0.01 + 1e-3 * Math.abs(want),`${r.label}: score ${r.score} vs ${want}`);
    }
    // Absolute mode, a negative weight, and stats added to `stats`.
    const abs = await evaluateChanges(session, { variants: good, stats: ['CombinedDPS'], objective: { mode: 'absolute', weights: { Life: 1, Mana: -2 } } });
    assert(JSON.stringify(Object.keys(abs.base)) === '["CombinedDPS","Life","Mana"]', `objective stats added: ${Object.keys(abs.base)}`);
    for (const r of abs.results) {
      const want = r.delta!.Life! - 2 * r.delta!.Mana!;
      assert(Math.abs(r.score! - want) <= 0.02, `${r.label}: absolute score ${r.score} vs ${want}`);
    }
    assert(abs.objective!.mode === 'absolute' && abs.objective!.ignored === undefined, 'absolute header');
    const ascObj = await evaluateChanges(session, { variants: good, objective: { weights: { Life: 1 } }, order: 'asc' });
    for (let i = 1; i < ascObj.results.length; i++) assert(ascObj.results[i - 1].score! <= ascObj.results[i].score!, 'asc objective order');
    // An unknown stat (null) contributes nothing and is listed; the others still score.
    const unk = await evaluateChanges(session, { variants: good, objective: { weights: { Life: 1, NotARealStat: 5 } } });
    assert(JSON.stringify(unk.objective) === '{"mode":"relative","ignored":["NotARealStat"]}', `ignored ${JSON.stringify(unk.objective)}`);
    const lifeOnly = await evaluateChanges(session, { variants: good, objective: { weights: { Life: 1 } } });
    assert(JSON.stringify(unk.results.map((r) => [r.index, r.score])) === JSON.stringify(lifeOnly.results.map((r) => [r.index, r.score])), 'unknown stat adds nothing');
    log('   PASS');

    // ------------------------------------------------------------------
    log('9. constraints: violators after passing rows, onlyPassing');
    const lifeBase = num(stats0.Life);
    const keepLife = await evaluateChanges(session, { variants, constraints: [{ stat: 'Life', min: lifeBase }] });
    const lifeDown = plain.results.filter((r) => r.error === undefined && r.delta!.Life! < 0).length;
    assert(lifeDown >= 1, 'fixture needs a variant that lowers Life');
    assert(keepLife.violating === lifeDown, `violating ${keepLife.violating} vs ${lifeDown}`);
    const okKeep = keepLife.results.filter((r) => r.error === undefined);
    const firstViolator = okKeep.findIndex((r) => r.violates !== undefined);
    assert(firstViolator === okKeep.length - lifeDown && okKeep.slice(firstViolator).every((r) => r.violates), 'violating rows follow all passing rows');
    assert(keepLife.results.slice(okKeep.length).every((r) => r.error !== undefined), 'refused variants stay last');
    const passingKeep = okKeep.slice(0, firstViolator).map((r) => r.index);
    assert(JSON.stringify(passingKeep) === JSON.stringify(plain.results.filter((r) => r.error === undefined && r.delta!.Life! >= 0).map((r) => r.index)),
      'passing rows keep their rankBy order');
    for (const r of okKeep.slice(firstViolator)) {
      const value = roundStat(lifeBase + r.delta!.Life!);
      assert(r.violates!.length === 1 && r.violates![0] === `Life ${value} < ${lifeBase}`, `${r.label}: violates ${JSON.stringify(r.violates)}`);
    }
    log(`   e.g. ${okKeep[firstViolator].label}: ${okKeep[firstViolator].violates![0]}`);
    // onlyPassing drops them but still counts them.
    const only = await evaluateChanges(session, { variants, constraints: [{ stat: 'Life', min: lifeBase }], onlyPassing: true });
    assert(only.violating === lifeDown && only.evaluated === okKeep.length, 'onlyPassing keeps the counters');
    assert(only.results.every((r) => r.violates === undefined), 'onlyPassing leaves no violators');
    assert(only.results.filter((r) => r.error === undefined).length === okKeep.length - lifeDown, 'onlyPassing drops the violators');
    assert(only.results.filter((r) => r.error !== undefined).length === 4, 'refused variants stay listed with onlyPassing');
    // A resistance floor nobody reaches; max, minDelta and several bounds on one stat.
    const frBase = num(stats0.FireResist);
    const fr = await evaluateChanges(session, { variants: good, constraints: [{ stat: 'FireResist', min: frBase + 1000 }] });
    assert(fr.violating === good.length && fr.results.every((r) => r.violates!.length === 1 && /^FireResist -?[\d.]+ < /.test(r.violates![0])), 'FireResist floor');
    const mix = await evaluateChanges(session, {
      variants: good,
      constraints: [{ stat: 'Life', max: lifeBase - 1, minDelta: 1 }],
    });
    // max = base - 1 is broken by every variant that does not lower Life; minDelta 1 by every one that does not raise it.
    for (const r of mix.results) {
      const d = r.delta!.Life!;
      const hasMax = r.violates?.includes(`Life ${roundStat(lifeBase + d)} > ${lifeBase - 1}`) ?? false;
      const hasMinDelta = r.violates?.includes(`Life change ${d} < 1`) ?? false;
      assert(hasMax === (d >= 0), `${r.label}: max bound (${JSON.stringify(r.violates)})`);
      assert(hasMinDelta === (d < 1), `${r.label}: minDelta bound (${JSON.stringify(r.violates)})`);
    }
    // Objective + constraints: passing rows by score first, then violators by score; constrained stats join `stats`.
    const both = await evaluateChanges(session, {
      variants: good,
      stats: ['CombinedDPS'],
      objective: { weights: { CombinedDPS: 1 } },
      constraints: [{ stat: 'Life', min: lifeBase }],
    });
    assert(JSON.stringify(Object.keys(both.base)) === '["CombinedDPS","Life"]', `constraint stat added: ${Object.keys(both.base)}`);
    const passScores = both.results.filter((r) => !r.violates).map((r) => r.score!);
    const failScores = both.results.filter((r) => r.violates).map((r) => r.score!);
    assert(both.results.findIndex((r) => r.violates) === passScores.length, 'objective: violators last');
    for (const group of [passScores, failScores]) for (let i = 1; i < group.length; i++) assert(group[i - 1] >= group[i], 'objective order inside each group');
    // A stat that is not a number breaks its constraint.
    const nul = await evaluateChanges(session, { variants: good, constraints: [{ stat: 'NotARealStat', min: 0 }] });
    assert(nul.violating === good.length && nul.results.every((r) => r.violates![0] === 'NotARealStat n/a (not a number) < 0'), 'null violates');
    assert((await session.exportXML()) === xml0, 'export changed after the objective / constraint checks');
    assert(undoDepth() === undo0, 'undo depth changed after the objective / constraint checks');
    log('   PASS');

    // ------------------------------------------------------------------
    log('10. invalid objective / constraint input');
    const base1 = { variants: [{ config: { usePowerCharges: true } }] };
    const weights21 = Object.fromEntries(Array.from({ length: 21 }, (_v, i) => [`Stat${i}`, 1]));
    const cons21 = Array.from({ length: 21 }, (_v, i) => ({ stat: `Stat${i}`, min: 0 }));
    const cases: Array<[string, Partial<Parameters<typeof evaluateChanges>[1]>, RegExp]> = [
      ['objective with rankBy', { objective: { weights: { Life: 1 } }, rankBy: 'Life' }, /either `objective` or `rankBy`/],
      ['empty weights', { objective: { weights: {} } }, /at least one stat/],
      ['all-zero weights', { objective: { weights: { Life: 0 } } }, /all 0/],
      ['NaN weight', { objective: { weights: { Life: NaN } } }, /finite/],
      ['Infinity weight', { objective: { weights: { Life: Infinity } } }, /finite/],
      ['21 weights', { objective: { weights: weights21 } }, /at most 20/],
      ['bad mode', { objective: { weights: { Life: 1 }, mode: 'nope' as 'relative' } }, /mode/],
      ['constraint without bounds', { constraints: [{ stat: 'Life' }] }, /at least one of/],
      ['NaN min', { constraints: [{ stat: 'Life', min: NaN }] }, /finite/],
      ['Infinity max', { constraints: [{ stat: 'Life', max: Infinity }] }, /finite/],
      ['min above max', { constraints: [{ stat: 'Life', min: 5, max: 1 }] }, /above max/],
      ['minDelta above maxDelta', { constraints: [{ stat: 'Life', minDelta: 5, maxDelta: 1 }] }, /above maxDelta/],
      ['empty stat', { constraints: [{ stat: '', min: 1 }] }, /stat is required/],
      ['21 constraints', { constraints: cons21 }, /at most 20/],
      ['onlyPassing without constraints', { onlyPassing: true }, /needs `constraints`/],
    ];
    for (const [name, extra, pattern] of cases) {
      let err: unknown;
      try {
        await evaluateChanges(session, { ...base1, ...extra });
      } catch (e) {
        err = e;
      }
      assert(err instanceof Error && err.constructor.name === 'UserError' && pattern.test(err.message), `${name}: ${String(err)}`);
    }
    log(`   PASS: ${cases.length} invalid inputs refused with a UserError`);

    // ------------------------------------------------------------------
    log('11. base-0 stats, unscored rows, precision, the stat limit');
    // A stat that is 0 in the build cannot take a relative change: it is ignored in relative mode, scored in absolute mode.
    const zeroStat = Object.keys(stats0).find((k) => stats0[k] === 0);
    assert(zeroStat, 'fixture needs a stat that is 0');
    const rel0 = await evaluateChanges(session, { variants: good, objective: { weights: { Life: 1, [zeroStat]: 3 } } });
    assert(JSON.stringify(rel0.objective) === JSON.stringify({ mode: 'relative', ignored: [zeroStat] }), `relative ignored ${JSON.stringify(rel0.objective)}`);
    assert(rel0.results.every((r) => r.unscored === undefined), 'an ignored stat is not reported per row');
    const abs0 = await evaluateChanges(session, { variants: good, objective: { mode: 'absolute', weights: { Life: 1, [zeroStat]: 3 } } });
    assert(abs0.objective!.ignored === undefined, `absolute mode keeps a 0-base stat: ${JSON.stringify(abs0.objective)}`);
    log(`   base-0 stat ${zeroStat}: ignored in relative mode only`);

    // unscored: a weighted stat that is a number in the base but not in the variant (no build gives one, so checked on the scorer).
    const scorer = makeScorer({ weights: { A: 2, B: 1, C: 1 } }, { A: 10, B: 0, C: 'x' });
    assert(JSON.stringify(scorer.ignored) === '["B","C"]', `scorer ignored ${scorer.ignored}`);
    const scored = scorer.score({ A: 15, B: 4, C: 'x' });
    assert(scored.score === 1 && scored.unscored.length === 0, `score ${JSON.stringify(scored)}`);
    const unscoredRow = makeScorer({ weights: { A: 2, D: 1 } }, { A: 10, D: 5 }).score({ A: 15, D: 'n/a' });
    assert(unscoredRow.score === 1 && JSON.stringify(unscoredRow.unscored) === '["D"]', `unscored ${JSON.stringify(unscoredRow)}`);

    // Violation text keeps enough digits to read true.
    const vio = (c: Parameters<typeof violations>[0][number], after: number, before = 80): string[] => violations([c], { S: before }, { S: after });
    assert(vio({ stat: 'S', min: 75 }, 74.996)[0] === 'S 74.996 < 75', `precision: ${vio({ stat: 'S', min: 75 }, 74.996)}`);
    assert(vio({ stat: 'S', max: 75 }, 75.004)[0] === 'S 75.004 > 75', `precision max: ${vio({ stat: 'S', max: 75 }, 75.004)}`);
    assert(vio({ stat: 'S', min: 75 }, 72)[0] === 'S 72 < 75', 'plain text unchanged');
    assert(vio({ stat: 'S', min: 75 }, 74.3333333)[0] === 'S 74.33 < 75', 'rounded when it reads true');
    assert(vio({ stat: 'S', minDelta: 0 }, 79.9996)[0] === 'S change -0.0004 < 0', `delta: ${vio({ stat: 'S', minDelta: 0 }, 79.9996)}`);
    assert(vio({ stat: 'S', min: 75 }, 75).length === 0, 'at the bound passes');

    // Stats already listed are not counted twice; only added stats can push the call over the limit.
    const fifty = ['Life', ...Array.from({ length: 49 }, (_v, i) => `FakeStat${i}`)];
    const dedup = await evaluateChanges(session, {
      variants: [{ config: { usePowerCharges: true } }],
      stats: fifty,
      objective: { weights: { Life: 1, FakeStat3: 1 } },
      constraints: [{ stat: 'Life', min: 0 }, { stat: 'FakeStat7', max: 1 }],
    });
    assert(Object.keys(dedup.base).length === 50, `${Object.keys(dedup.base).length} stats`);
    let tooMany: unknown;
    try {
      await evaluateChanges(session, { variants: [{ config: { usePowerCharges: true } }], stats: fifty, objective: { weights: { Life: 1 } }, constraints: [{ stat: 'Life', min: 0 }, { stat: 'ExtraStat51', min: 0 }] });
    } catch (e) {
      tooMany = e;
    }
    assert(tooMany instanceof Error && tooMany.constructor.name === 'UserError' && /50 requested plus 1 more/.test(tooMany.message) && /ExtraStat51/.test(tooMany.message) && !/Life/.test(tooMany.message),
      `too many stats: ${String(tooMany)}`);
    log('   PASS');

    log('12. Masteries and mainSkill (ConvertTreeMasteries.xml, a 3.24 tree)');
    {
      await session.loadBuild(readFileSync(path.join(path.dirname(fixturePath), 'ConvertTreeMasteries.xml'), 'utf8'));
      const mXml = await session.exportXML();
      const mUndo = undoDepth();
      const mStats = await session.getStats();
      const life = (await session.getPassiveTree([2841])).masteryOptions![0];
      const free = (life.options ?? []).filter((o) => o.takenBy === undefined && o.effect !== life.effect);
      assert(free.length >= 2, 'two free effects on Life Mastery 2841');
      const effectA = free[0];
      const effectB = free[1];
      const ranked = await evaluateChanges(session, {
        variants: [
          { label: 'A', masteries: [{ node: 2841, effect: effectA.effect }] },
          { label: 'B', masteries: [{ node: 2841, effect: effectB.stats }] },
          { label: 'other skill', mainSkill: { group: 2, activeSkill: 2 } },
        ],
        rankBy: 'Life',
        stats: ['Life', 'CombinedDPS', 'TotalEHP'],
      });
      assert(ranked.failed === 0 && ranked.fallbacks === 0, `no failure, no fallback: ${JSON.stringify(ranked.results)}`);
      await assertExportUnchanged2(session, mXml, 'evaluate_changes with masteries / mainSkill');
      assert(undoDepth() === mUndo, 'undo depth unchanged');
      const lifeRows = ranked.results.filter((r) => r.label === 'A' || r.label === 'B');
      assert(lifeRows.length === 2 && (lifeRows[0].delta!.Life ?? 0) >= (lifeRows[1].delta!.Life ?? 0), `ranked by Life: ${JSON.stringify(lifeRows)}`);
      // Each row equals the change committed (allocate_nodes / set_main_skill) + get_stats, then undone.
      const committed = async (commit: () => Promise<unknown>): Promise<Stats> => {
        await commit();
        const stats = await session.getStats();
        await session.undoLastChange();
        return stats;
      };
      const expected: Record<string, Stats> = {
        A: await committed(() => session.allocateNodes([], [{ node: 2841, effect: effectA.effect }])),
        B: await committed(() => session.allocateNodes([], [{ node: 2841, effect: effectB.effect }])),
        'other skill': await committed(() => session.setMainSkill(2, 2)),
      };
      for (const row of ranked.results) {
        const after = expected[row.label!];
        for (const key of ['Life', 'CombinedDPS', 'TotalEHP']) {
          const want = roundStat(num(after[key]) - num(mStats[key]));
          assert(sameNumber(row.delta![key], want), `${row.label} ${key}: evaluate_changes delta ${row.delta![key]} != committed ${want}`);
        }
      }
      assert(ranked.results.find((r) => r.label === 'other skill')!.delta!.CombinedDPS !== 0, 'the other main skill changes CombinedDPS');
      await assertExportUnchanged2(session, mXml, 'the commits and undos');
      log('   PASS: two mastery effects ranked, mainSkill row, each equal to the committed change; build unchanged');
    }

    console.log('\nAll evaluate_changes tests passed.');
  } finally {
    await bridge.dispose();
  }
}

main().catch((error: unknown) => {
  console.error('FAILED:', error);
  process.exit(1);
});
