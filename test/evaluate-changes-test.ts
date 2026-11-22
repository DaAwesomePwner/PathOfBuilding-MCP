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
import { mkdtempSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { BuildSession, type NamedProbeVariant, type TreeNodeInfo } from '../src/build-session.js';
import { DEFAULT_EVALUATE_STATS, evaluateChanges, roundStat, type EvaluateChangesResult, type EvaluateChangesVariant } from '../src/evaluate-changes.js';
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

    console.log('\nAll evaluate_changes tests passed.');
  } finally {
    await bridge.dispose();
  }
}

main().catch((error: unknown) => {
  console.error('FAILED:', error);
  process.exit(1);
});
