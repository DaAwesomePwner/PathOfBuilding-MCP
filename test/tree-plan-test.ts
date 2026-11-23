// plan_passive_points / plan_respec (src/tree-plan.ts, BuildSession.planPassivePoints / planRespec)
// on the OccVortex fixture, plus ConvertTreeMasteries.xml (a 3.24 tree) for includeMasteries.
//
//   1. A 1-point plan picks find_best_next_nodes' top node (maxPoints 1) with the same gain.
//   2. A 10-point greedy plan: steps in order with increasing points and gains > 0, the
//      focus stat rising; timed (< 30 s). Deterministic: a second run gives the same plan.
//      A 4-point plan gains no more than the 10-point one.
//   3. Parity: the plan's `after` equals evaluate_changes (probeNamed) and apply_changes of
//      its `applyChanges` variant; then undo.
//   4. Constraints: a maxDelta the unconstrained plan breaks is kept by every step; a
//      constraint broken from the start is reported in `violates`. An objective plan and
//      excludeNodes (the 1-point pick is never allocated) run; beamWidth 2 runs and its
//      variant gives its `after`.
//   5. plan_respec: target = the tree -> unchanged; a modified target (a branch removed,
//      the plan's nodes added) -> removals / additions as expected, every target node
//      allocated by apply_changes of the variant, stats equal; then undo. keepAscendancy
//      false removes the ascendancy; unknown / ambiguous / unreachable / mastery targets
//      are refused with every problem listed.
//   6. includeMasteries (ConvertTreeMasteries.xml): mastery candidates are offered and the
//      plan's variant (with its masteries) reproduces its `after` through apply_changes.
//   After every tool: export_build byte-identical, undo depth, journal length and the
//   committed fingerprint unchanged.
import { mkdtempSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { BuildSession } from '../src/build-session.js';
import { LuaBridge, type Stats } from '../src/lua-bridge.js';
import { committedFingerprint } from '../src/probe.js';
import type { PlanPointsResult } from '../src/tree-plan.js';
import { UserError } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

process.env.POB_MCP_CONFIG_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-tree-plan-'));

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** Equal up to the 2-decimal rounding the tool output uses. */
function close(a: unknown, b: unknown, what: string): void {
  if (typeof a !== 'number' || typeof b !== 'number') {
    assert(a === b, `${what}: ${String(a)} vs ${String(b)}`);
    return;
  }
  assert(Math.abs(a - b) <= 0.01 + 1e-9 * Math.abs(b), `${what}: ${a} vs ${b}`);
}

function sameStats(a: Stats, b: Stats, keys: string[], what: string): void {
  for (const k of keys) close(a[k], b[k], `${what} ${k}`);
}

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const bridge = new LuaBridge(paths, 120_000);
  const session = new BuildSession(bridge);
  const send = { send: <T>(c: object) => bridge.send<T>(c) };

  const state = async () => ({
    xml: await session.exportXML(),
    undo: session.undoStackDepth(),
    journal: bridge.committedCount(),
    fingerprint: (await committedFingerprint(send)).join('\n'),
  });
  const assertUnchanged = async (s0: Awaited<ReturnType<typeof state>>, after: string): Promise<void> => {
    const s1 = await state();
    assert(s1.xml === s0.xml, `${after}: export changed`);
    assert(s1.undo === s0.undo, `${after}: undo depth ${s0.undo} -> ${s1.undo}`);
    assert(s1.journal === s0.journal, `${after}: journal ${s0.journal} -> ${s1.journal}`);
    assert(s1.fingerprint === s0.fingerprint, `${after}: committed fingerprint changed`);
  };
  const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    const r = await fn();
    log(`  ${label}: ${Date.now() - t} ms`);
    return r;
  };
  const refused = async (fn: () => Promise<unknown>, parts: string[], what: string): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      assert(e instanceof UserError, `${what}: expected a UserError, got ${(e as Error).message}`);
      for (const p of parts) assert(e.message.includes(p), `${what}: "${p}" missing from: ${e.message}`);
      return;
    }
    throw new Error(`${what}: not refused`);
  };

  try {
    await session.loadBuild(readFileSync(fixturePath, 'utf8'));
    const s0 = await state();
    const KEYS = ['CombinedDPS', 'TotalEHP', 'Life', 'EnergyShield', 'Mana'];

    log('1. A 1-point plan = find_best_next_nodes top pick');
    const best = await session.findBestNextNodes(1, 'CombinedDPS', false, 1, 'perPoint');
    const p1 = await timed('plan 1 point', () => session.planPassivePoints({ points: 1 }));
    await assertUnchanged(s0, 'plan 1 point');
    assert(p1.steps.length === 1 && p1.steps[0].node.id === best.rankings[0].nodeId, `plan 1: ${JSON.stringify(p1.steps)} vs ${best.rankings[0].nodeId}`);
    close(p1.gain, best.rankings[0].delta, 'plan 1 gain');
    log(`PASS: ${p1.steps[0].node.name} (+${p1.gain})`);

    log('2. 10-point greedy plan: monotone, deterministic, timed');
    const t10 = Date.now();
    const p10 = await session.planPassivePoints({ points: 10 });
    const ms10 = Date.now() - t10;
    log(`  plan 10 points: ${ms10} ms, ${p10.evaluated} candidate evaluations, ${p10.steps.length} steps`);
    await assertUnchanged(s0, 'plan 10 points');
    assert(ms10 < 30_000, `10-point plan took ${ms10} ms`);
    assert(p10.pointsUsed <= 10 && p10.pointsUsed > 1, `points used ${p10.pointsUsed}`);
    let prevPoints = 0;
    let prevValue = p10.before.CombinedDPS as number;
    for (const s of p10.steps) {
      assert(s.pointsUsed === prevPoints + s.points && s.points >= 1, `step ${s.step}: points ${s.points} / ${s.pointsUsed}`);
      assert(s.gain > 0 && (s.after.CombinedDPS as number) > prevValue, `step ${s.step}: gain ${s.gain}`);
      assert(s.path.length >= 1 && s.path[s.path.length - 1].id === s.node.id, `step ${s.step}: path ends at the node`);
      prevPoints = s.pointsUsed;
      prevValue = s.after.CombinedDPS as number;
    }
    assert(p10.pointsUsed === prevPoints, 'pointsUsed = last step');
    close(p10.after.CombinedDPS, prevValue, 'after = last step');
    assert(p10.nodeIds.length === p10.steps.reduce((n, s) => n + s.path.length, 0), 'nodeIds = every step path');
    const p10b = await session.planPassivePoints({ points: 10 });
    assert(JSON.stringify(p10b.nodeIds) === JSON.stringify(p10.nodeIds) && p10b.gain === p10.gain, 'plan not deterministic');
    const p4 = await session.planPassivePoints({ points: 4 });
    assert(p4.pointsUsed <= 4 && p4.gain <= p10.gain && p4.gain > 0, `4-point plan gain ${p4.gain} vs ${p10.gain}`);
    log(`PASS: ${p10.steps.map((s) => `${s.node.name} (${s.points})`).join(' -> ')}; +${p10.gain}`);

    log('3. Parity: evaluate_changes and apply_changes of the variant');
    const evald = await session.probeNamed({ stats: KEYS, variants: [p10.applyChanges] });
    assert(evald.results[0].error === undefined, `evaluate: ${evald.results[0].error}`);
    sameStats(evald.results[0].stats, p10.after, KEYS, 'evaluate_changes');
    const applied = await session.applyChanges(p10.applyChanges);
    sameStats(applied.after, p10.after, KEYS, 'apply_changes');
    assert(applied.added.length === p10.nodeIds.length, `apply_changes added ${applied.added.length} nodes, plan ${p10.nodeIds.length}`);
    await session.undoLastChange();
    await assertUnchanged(s0, 'apply_changes + undo');
    log('PASS: variant reproduces the plan');

    log('4. Constraints, objective, excludeNodes, beamWidth');
    const manaCap = await session.planPassivePoints({ points: 10, constraints: [{ stat: 'Mana', maxDelta: 0 }] });
    await assertUnchanged(s0, 'constrained plan');
    const mana0 = p10.before.Mana as number;
    assert((p10.after.Mana as number) > mana0, 'the unconstrained plan raises Mana (else the constraint test is moot)');
    assert(manaCap.violates === undefined && manaCap.steps.length > 0, `constrained plan: ${JSON.stringify(manaCap.violates)}`);
    for (const s of manaCap.steps) assert((s.after.Mana as number) <= mana0 && s.violates === undefined, `step ${s.step} raised Mana`);
    const broken = await session.planPassivePoints({ points: 2, constraints: [{ stat: 'Life', min: 1e9 }] });
    assert(broken.steps.length > 0 && broken.violates?.[0]?.startsWith('Life'), `start-violating constraint: ${JSON.stringify(broken.violates)}`);
    const objective = await session.planPassivePoints({ points: 3, objective: { weights: { CombinedDPS: 1, TotalEHP: 1 } } });
    assert(objective.objective?.mode === 'relative' && objective.gain > 0 && objective.optimizeFor === undefined, 'objective plan');
    const excluded = await session.planPassivePoints({ points: 1, excludeNodes: [p1.steps[0].node.id] });
    assert(excluded.steps.length === 1 && !excluded.nodeIds.includes(p1.steps[0].node.id), 'excludeNodes by id');
    const excludedByName = await session.planPassivePoints({ points: 1, excludeNodes: [p1.steps[0].node.name] });
    assert(excludedByName.steps.every((s) => s.path.every((n) => n.name !== p1.steps[0].node.name)), 'excludeNodes by name');
    const beam = await timed('beamWidth 2, 4 points', () => session.planPassivePoints({ points: 4, beamWidth: 2 }));
    assert(beam.pointsUsed <= 4 && beam.gain > 0 && beam.beamWidth === 2, 'beam plan');
    const beamEval = await session.probeNamed({ stats: KEYS, variants: [beam.applyChanges] });
    sameStats(beamEval.results[0].stats, beam.after, KEYS, 'beam variant');
    await refused(() => session.planPassivePoints({ points: 0 }), ['points'], 'points 0');
    await refused(() => session.planPassivePoints({ points: 3, optimizeFor: 'Life', objective: { weights: { Life: 1 } } }), ['not both'], 'optimizeFor + objective');
    await assertUnchanged(s0, 'section 4');
    log(`PASS: constrained +${manaCap.gain} (Mana kept), beam +${beam.gain} vs greedy 4 +${p4.gain}`);

    log('5. plan_respec');
    const tree = await session.getPassiveTree();
    const allocated = tree.allocatedNodes.map((n) => n.id);
    const same = await timed('respec to the current tree', () => session.planRespec(allocated, true, KEYS));
    await assertUnchanged(s0, 'respec unchanged');
    assert(same.removed.length === 0 && same.added.length === 0 && same.deallocate.length === 0 && same.allocate.length === 0, `same tree: ${JSON.stringify(same).slice(0, 300)}`);
    sameStats(same.after, same.before, KEYS, 'unchanged respec');

    const worst = await session.findWorstAllocatedNodes(10, 'CombinedDPS', 'perPoint');
    const branch = worst.rankings.find((r) => (r.removedNodeCount ?? 0) >= 2 && (r.removedNodeCount ?? 0) <= 25) ?? worst.rankings[0];
    const cut = new Set(branch.removedNodes!.map((n) => n.id));
    const newTargets = p10.steps.map((s) => s.node.id);
    const target = [...allocated.filter((id) => !cut.has(id)), ...newTargets];
    const respec = await timed('respec to a modified target', () => session.planRespec(target, true, KEYS));
    await assertUnchanged(s0, 'respec modified');
    const removedIds = new Set(respec.removed.map((n) => n.id));
    // Only nodes of the cut branch go (the rest is target); a cut node a new target's path needs stays.
    for (const id of removedIds) assert(cut.has(id), `node ${id} outside the cut branch was removed`);
    assert(removedIds.size > 0, 'nothing of the cut branch was removed');
    assert(respec.readded.length === 0, `readded: ${respec.readded}`);
    for (const id of newTargets) assert(respec.added.some((n) => n.id === id), `target ${id} not added`);
    const netPoints = respec.added.filter((n) => n.pointCost === 'passive').length - respec.removed.filter((n) => n.pointCost === 'passive').length;
    assert(respec.pointsAfter.totalPoints - respec.pointsBefore.totalPoints === netPoints, 'points net');
    const committed = await session.applyChanges({ deallocate: respec.deallocate, allocate: respec.allocate });
    sameStats(committed.after, respec.after, KEYS, 'respec apply_changes');
    const afterIds = new Set((await session.getPassiveTree()).allocatedNodes.map((n) => n.id));
    for (const id of target) assert(afterIds.has(id), `target ${id} not allocated after apply_changes`);
    const expected = new Set([...allocated.filter((id) => !removedIds.has(id)), ...respec.added.map((n) => n.id)]);
    assert(afterIds.size === expected.size && [...expected].every((id) => afterIds.has(id)), 'tree after apply_changes = before - removed + added');
    await session.undoLastChange();
    await assertUnchanged(s0, 'respec apply + undo');
    log(`PASS: -${respec.removed.length} +${respec.added.length} nodes, ${respec.pointsBefore.totalPoints} -> ${respec.pointsAfter.totalPoints} points`);

    const ascendancy = tree.allocatedNodes.filter((n) => (n as { ascendancyName?: string }).ascendancyName);
    const noAsc = await session.planRespec(allocated.filter((id) => !ascendancy.some((n) => n.id === id)), false, KEYS);
    assert(ascendancy.length > 0 && noAsc.pointsAfter.ascendancyPoints === 0 && noAsc.pointsBefore.ascendancyPoints > 0, `keepAscendancy false: ${noAsc.pointsAfter.ascendancyPoints}`);
    const keptAsc = await session.planRespec(allocated.filter((id) => !ascendancy.some((n) => n.id === id)), true, KEYS);
    assert(keptAsc.removed.length === 0, 'keepAscendancy true keeps the ascendancy');
    const mastery = (await session.getPassiveTree(['Life Mastery'])).masteryOptions!.find((m) => !m.allocated);
    await refused(
      () => session.planRespec([...allocated, 999999, 'No Such Node Name', 'Strength', mastery!.id], true, KEYS),
      ['999999', '"No Such Node Name"', '"Strength"', String(mastery!.id), 'masteries'],
      'bad targets',
    );
    const juggernaut = await bridge.send<{ node: { id: number } | null }>({ cmd: 'getNodeInfo', name: 'Unflinching' });
    assert(juggernaut.node, 'Unflinching (Juggernaut) exists');
    await refused(() => session.planRespec([...allocated, juggernaut.node!.id], true, KEYS), ['no path', String(juggernaut.node.id)], 'other ascendancy');
    await assertUnchanged(s0, 'respec refusals');
    log('PASS: keepAscendancy, refusals');

    log('6. includeMasteries (ConvertTreeMasteries.xml)');
    await session.loadBuild(readFileSync(path.join(path.dirname(fixturePath), 'ConvertTreeMasteries.xml'), 'utf8'));
    const m0 = await state();
    const masteryCands = await bridge.send<{ masteries?: unknown }>({ cmd: 'probe', candidates: 'allocate', maxPoints: 3, includeMasteries: true });
    assert(Array.isArray(masteryCands.masteries) && masteryCands.masteries.length > 0, 'mastery candidates listed');
    let mp: PlanPointsResult | undefined;
    for (const optimizeFor of ['Life', 'TotalEHP', 'CombinedDPS', 'EnergyShield', 'Armour']) {
      const p = await timed(`includeMasteries plan (${optimizeFor})`, () => session.planPassivePoints({ points: 4, optimizeFor, includeMasteries: true }));
      await assertUnchanged(m0, 'mastery plan');
      if (p.steps.some((s) => s.mastery) || mp === undefined) mp = p;
      if (p.steps.some((s) => s.mastery)) break;
    }
    assert(mp && mp.steps.length > 0, 'mastery plan has steps');
    log(`  steps: ${mp.steps.map((s) => `${s.node.name}${s.mastery ? ` [${s.mastery.stats}]` : ''}`).join(' -> ')}`);
    assert(mp.steps.some((s) => s.mastery), 'no plan chose a mastery');
    assert(mp.applyChanges.masteries && mp.applyChanges.allocate.every((id) => !mp!.applyChanges.masteries!.some((m) => m.node === id)), 'masteries go in `masteries`');
    const mKeys = [mp.optimizeFor!, ...KEYS];
    const mApplied = await session.applyChanges(mp.applyChanges);
    sameStats(mApplied.after, mp.after, mKeys, 'mastery plan apply_changes');
    await session.undoLastChange();
    await assertUnchanged(m0, 'mastery apply + undo');
    log('PASS: mastery steps reproduced');

    log('ALL TESTS PASSED');
  } finally {
    await bridge.shutdown();
  }
}

main().catch((e) => {
  console.error('FAIL:', e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
