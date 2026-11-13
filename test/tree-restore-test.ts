// Passive-tree snapshot/restore exactness: every what-if probe and every undo
// must put the tree back precisely (nodes, mastery selections, tattoos,
// socketed jewels, class/ascendancies, tree version) with bit-exact stats.
//
// Scenarios (all built through the engine, nothing hand-written):
//   1. ConvertTreeMasteries.xml (3_24): deallocating node 12247 also drops the
//      Life Mastery 2841 and its selection; simulate_passive_change and
//      pushUndo + dealloc + undo must both bring the selection back.
//   2. OccVortex.xml (3_13) with an Intuitive Leap in socket 36634 and two
//      notables it supports (53757, 29861): unequipping the jewel deallocates
//      them; undo must re-socket the jewel and re-allocate them.
//   3. The tattoo on node 1031 of ConvertTreeMasteries.xml: a cycle that
//      removes it must restore it.
//   4. A Large Cluster Jewel in socket 21984 whose notable 65898 was saved
//      allocated (PoB then remembers it in allocExtendedNodes) and is later
//      deallocated: a restore must not bring it back, and a stray extra node
//      must be reported by verifyTreeState.
//   5. A snapshot taken on 3_13 restores across a tree conversion.
//   6. A probe whose tree snapshot holds a node id PoB does not know (injected
//      through a test-only wrapper around this process's LuaBridge.send, not
//      reachable from MCP tool arguments): the restore error names
//      reset_build, the rest of the tree is restored, and a probe's own
//      error stays visible (and keeps its UserError class) when both fail.
//   7. The same through undo: items, config and skills are restored before
//      the error is raised.
//   8. A socket entry whose item id has no item is restored as captured by a
//      probe and by undo. PoB's ItemSlotControl:Populate zeroes such ids on
//      every socket that has a slot control, so this state only survives on
//      an entry without one (here a node id that is no socket on any tree,
//      which PassiveSpec:Load keeps).
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BuildSession, TreeSnapshot } from '../src/build-session.js';
import { LuaBridge, Stats } from '../src/lua-bridge.js';
import { UserError } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const MASTERY_FIXTURE = path.resolve(testDir, 'fixtures', 'ConvertTreeMasteries.xml');

const MASTERY_UPSTREAM_NODE = 12247; // Damage with Life Cost Skills -> Cannibalistic Rite -> Life Mastery
const MASTERY_NODE = 2841;
const TATTOO_NODE = 1031;
const IL_SOCKET = 36634;
const IL_SUPPORTED = [53757, 29861]; // Shamanistic Fury, Explosive Runes: not connected to the tree
const CLUSTER_SOCKET = 21984;
const CLUSTER_NOTABLE = 65898; // Smoking Remains on the cluster subgraph
const UNKNOWN_NODE = 999999; // no tree or cluster node has this id
const MISSING_ITEM = 9999; // no item in OccVortex has this id
const SLOTLESS_SOCKET = 999998; // no tree node: the items tab has no slot control for it

const RING = `Rarity: RARE
Tree Restore Ring
Coral Ring
Item Level: 63
LevelReq: 64
Implicits: 1
+30 to maximum Life
+150 to maximum Life
+50 to maximum Mana
+30% to all Elemental Resistances`;

const INTUITIVE_LEAP = `Rarity: UNIQUE
Intuitive Leap
Viridian Jewel
Radius: Small
Passive Skills in Radius can be Allocated without being connected to your tree`;

const LARGE_CLUSTER = `Rarity: RARE
Tree Restore Cluster
Large Cluster Jewel
Item Level: 84
Implicits: 3
Adds 8 Passive Skills (enchant)
2 Added Passive Skills are Jewel Sockets (enchant)
Added Small Passive Skills grant: 12% increased Fire Damage (enchant)
1 Added Passive Skill is Prismatic Heart
1 Added Passive Skill is Smoking Remains`;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface RawState {
  treeVersion: string;
  classId: number;
  ascendClassId?: number;
  secondaryAscendClassId?: number;
  nodeIds: number[];
  masteryEffects?: Array<[number, number]>;
  jewels?: Array<[number, number]>;
  hashOverrides?: Array<{ nodeId: number; dn: string }>;
}

interface TreeState {
  treeVersion: string;
  classId: number;
  ascendClassId: number;
  secondaryAscendClassId: number;
  nodeIds: number[];
  masteries: string[];
  tattoos: string[];
  jewels: string[];
  stats: { Life: unknown; CombinedDPS: unknown; TotalEHP: unknown };
}

interface TreeReport {
  exact: boolean;
  correctedExtraNodeIds?: number[];
  extraNodeIds?: number[];
}

/** Test-only seam: while true, captured tree states also list UNKNOWN_NODE. */
let injectUnknownNode = false;

function installSeam(bridge: LuaBridge): void {
  const realSend = bridge.send.bind(bridge);
  bridge.send = (async (command: object, timeoutOverrideMs?: number) => {
    const result = await realSend<{ state?: RawState }>(command, timeoutOverrideMs);
    if (injectUnknownNode && (command as { cmd?: string }).cmd === 'captureSpecState' && result.state) {
      result.state.nodeIds = [...result.state.nodeIds, UNKNOWN_NODE];
    }
    return result;
  }) as LuaBridge['send'];
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    assert(err instanceof Error, `rejected with a non-Error: ${String(err)}`);
    return err;
  }
  throw new Error('expected the call to fail, but it succeeded');
}

const list = <T>(v: T[] | undefined | Record<string, never>): T[] => (Array.isArray(v) ? v : []);

async function rawState(bridge: LuaBridge): Promise<RawState> {
  return (await bridge.send<{ state: RawState }>({ cmd: 'captureSpecState' })).state;
}

async function treeState(bridge: LuaBridge): Promise<TreeState> {
  const s = await rawState(bridge);
  const stats = (await bridge.getStats()) as Stats;
  return {
    treeVersion: s.treeVersion,
    classId: s.classId,
    ascendClassId: s.ascendClassId ?? 0,
    secondaryAscendClassId: s.secondaryAscendClassId ?? 0,
    nodeIds: [...list(s.nodeIds)].sort((a, b) => a - b),
    masteries: list(s.masteryEffects).map(([n, e]) => `${n}:${e}`).sort(),
    tattoos: list(s.hashOverrides).map((o) => `${o.nodeId}:${o.dn}`).sort(),
    jewels: list(s.jewels).filter(([, item]) => item !== 0).map(([n, item]) => `${n}:${item}`).sort(),
    stats: { Life: stats.Life, CombinedDPS: stats.CombinedDPS, TotalEHP: stats.TotalEHP },
  };
}

function assertSameTree(label: string, actual: TreeState, expected: TreeState): void {
  for (const key of ['treeVersion', 'classId', 'ascendClassId', 'secondaryAscendClassId'] as const) {
    assert(actual[key] === expected[key], `${label}: ${key} ${actual[key]} != ${expected[key]}`);
  }
  const missing = expected.nodeIds.filter((id) => !actual.nodeIds.includes(id));
  const extra = actual.nodeIds.filter((id) => !expected.nodeIds.includes(id));
  assert(missing.length === 0 && extra.length === 0, `${label}: nodes differ, missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`);
  for (const key of ['masteries', 'tattoos', 'jewels'] as const) {
    assert(
      JSON.stringify(actual[key]) === JSON.stringify(expected[key]),
      `${label}: ${key} differ\n  expected ${JSON.stringify(expected[key])}\n  actual   ${JSON.stringify(actual[key])}`,
    );
  }
  for (const key of ['Life', 'CombinedDPS', 'TotalEHP'] as const) {
    assert(actual.stats[key] === expected.stats[key], `${label}: ${key} not bit-exact (${actual.stats[key]} != ${expected.stats[key]})`);
  }
}

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const occXml = readFileSync(fixturePath, 'utf8');
  const masteryXml = readFileSync(MASTERY_FIXTURE, 'utf8');
  const bridge = new LuaBridge(paths, 120_000);
  installSeam(bridge);
  const session = new BuildSession(bridge);

  try {
    // ---------------------------------------------------------------- 1
    log('Test 1: mastery selections survive a probe and an undo that drop them');
    await session.loadBuild(masteryXml);
    const m0 = await treeState(bridge);
    assert(m0.treeVersion === '3_24', `mastery fixture loaded on ${m0.treeVersion}`);
    assert(m0.masteries.length === 4 && m0.masteries.some((m) => m.startsWith(`${MASTERY_NODE}:`)), `fixture masteries ${m0.masteries}`);
    assert(m0.nodeIds.includes(MASTERY_UPSTREAM_NODE), `node ${MASTERY_UPSTREAM_NODE} not allocated in the fixture`);

    await session.simulatePassiveChange([], [MASTERY_UPSTREAM_NODE]);
    assertSameTree('after simulate_passive_change', await treeState(bridge), m0);
    log('PASS: simulate_passive_change restores the mastery selection exactly');

    await session.pushUndo();
    await session.deallocNode(MASTERY_UPSTREAM_NODE);
    const m1 = await treeState(bridge);
    assert(!m1.masteries.some((m) => m.startsWith(`${MASTERY_NODE}:`)), `dealloc ${MASTERY_UPSTREAM_NODE} did not drop mastery ${MASTERY_NODE}`);
    assert(!m1.nodeIds.includes(MASTERY_NODE), `mastery ${MASTERY_NODE} still allocated`);
    await session.undoLastChange();
    assertSameTree('after undo of a mastery-dropping dealloc', await treeState(bridge), m0);
    log('PASS: undo_last_change restores the mastery selection exactly');

    // A probe-heavy tool over the same tree also leaves it exact.
    await session.findWorstAllocatedNodes(5, 'Life');
    assertSameTree('after find_worst_allocated_nodes', await treeState(bridge), m0);
    log('PASS: find_worst_allocated_nodes leaves masteries and stats exact');

    // ---------------------------------------------------------------- 3
    log('Test 3: tattoo (hash override) survives a restore cycle that removes it');
    assert(m0.tattoos.length === 1 && m0.tattoos[0].startsWith(`${TATTOO_NODE}:`), `fixture tattoo ${m0.tattoos}`);
    const removeTattoo = async (): Promise<void> => {
      const state = await rawState(bridge);
      await bridge.send({ cmd: 'restoreSpecState', state: { ...state, hashOverrides: [] } });
      const t = await treeState(bridge);
      assert(t.tattoos.length === 0, `tattoo still present after removal: ${t.tattoos}`);
    };
    const snap: TreeSnapshot = await session.snapshotTree();
    assert(snap.treeVersion === '3_24', `tree snapshot version ${snap.treeVersion}`);
    await removeTattoo();
    await session.restoreTree(snap);
    assertSameTree('after restoreTree of a tattooed snapshot', await treeState(bridge), m0);
    await session.pushUndo();
    await removeTattoo();
    await session.undoLastChange();
    assertSameTree('after undo of a tattoo removal', await treeState(bridge), m0);
    log('PASS: tattoo restored exactly by restoreTree and by undo');

    // ---------------------------------------------------------------- 2
    log('Test 2: nodes supported by an Intuitive Leap come back on undo');
    await session.loadBuild(occXml);
    await session.equipItem(`Jewel ${IL_SOCKET}`, INTUITIVE_LEAP);
    for (const id of IL_SUPPORTED) {
      const before = (await rawState(bridge)).nodeIds.length;
      await session.allocNode(id);
      const after = await rawState(bridge);
      assert(after.nodeIds.includes(id) && after.nodeIds.length === before + 1, `node ${id} is not supported by the Intuitive Leap`);
    }
    const il0 = await treeState(bridge);
    assert(il0.jewels.some((j) => j.startsWith(`${IL_SOCKET}:`)), `Intuitive Leap not socketed: ${il0.jewels}`);

    await session.unequipItemWithDiff(`Jewel ${IL_SOCKET}`);
    const il1 = await treeState(bridge);
    assert(!il1.jewels.some((j) => j.startsWith(`${IL_SOCKET}:`)), 'socket still holds the jewel after unequip');
    for (const id of IL_SUPPORTED) assert(!il1.nodeIds.includes(id), `node ${id} survived unequipping the Intuitive Leap`);
    await session.undoLastChange();
    assertSameTree('after undo of unequipping the Intuitive Leap', await treeState(bridge), il0);
    log('PASS: undo re-sockets the Intuitive Leap and re-allocates the nodes it supported');

    await session.simulatePassiveChange([], [IL_SUPPORTED[0]]);
    assertSameTree('after a probe on a jewel-supported node', await treeState(bridge), il0);
    log('PASS: probe on a jewel-supported node restores exactly');

    // ---------------------------------------------------------------- 4
    log('Test 4: cluster nodes PoB remembers are not re-allocated by a restore');
    await session.loadBuild(occXml);
    await session.allocNode(CLUSTER_SOCKET);
    await session.equipItem(`Jewel ${CLUSTER_SOCKET}`, LARGE_CLUSTER);
    await session.allocNode(CLUSTER_NOTABLE);
    assert((await rawState(bridge)).nodeIds.includes(CLUSTER_NOTABLE), `cluster notable ${CLUSTER_NOTABLE} not allocated`);
    // Saving and reloading puts the cluster allocation through PoB's
    // allocSubgraphNodes -> allocExtendedNodes path.
    await session.loadBuild(await session.exportXML());
    assert((await rawState(bridge)).nodeIds.includes(CLUSTER_NOTABLE), 'cluster notable lost on reload');
    await session.deallocNode(CLUSTER_NOTABLE);
    const c0 = await treeState(bridge);
    assert(!c0.nodeIds.includes(CLUSTER_NOTABLE), 'cluster notable still allocated after dealloc');

    // PoB's ImportFromNodeList re-allocates the remembered cluster notable;
    // restoreTreeState must deallocate it again and say so, once.
    const cSnap = await session.snapshotTree();
    const first = await bridge.send<TreeReport>({ cmd: 'restoreTreeState', state: cSnap.state });
    assert(first.exact === true, `first restore not exact: ${JSON.stringify(first)}`);
    assert(
      JSON.stringify(first.correctedExtraNodeIds) === JSON.stringify([CLUSTER_NOTABLE]),
      `expected correctedExtraNodeIds [${CLUSTER_NOTABLE}], got ${JSON.stringify(first)}`,
    );
    assertSameTree('after the correcting restore', await treeState(bridge), c0);
    const second = await bridge.send<TreeReport>({ cmd: 'restoreTreeState', state: cSnap.state });
    assert(second.exact === true && second.correctedExtraNodeIds === undefined, `second restore: ${JSON.stringify(second)}`);
    log('PASS: a cluster notable PoB re-allocates on restore is deallocated and reported in correctedExtraNodeIds');

    await session.simulatePassiveChange([CLUSTER_NOTABLE], []);
    assertSameTree('after a cluster probe', await treeState(bridge), c0);
    await session.restoreTree(cSnap);
    assertSameTree('after restoring an unchanged tree', await treeState(bridge), c0);
    log('PASS: restore leaves the deallocated cluster notable unallocated');

    await session.allocNode(CLUSTER_NOTABLE);
    const report = await bridge.send<{ exact: boolean; extraNodeIds?: number[] }>({ cmd: 'verifyTreeState', state: cSnap.state });
    assert(report.exact === false, 'verifyTreeState did not notice an extra node');
    assert(list(report.extraNodeIds).includes(CLUSTER_NOTABLE), `extra node not reported: ${JSON.stringify(report)}`);
    const restored = await bridge.send<{ exact: boolean; extraNodeIds?: number[] }>({ cmd: 'restoreTreeState', state: cSnap.state });
    assert(restored.exact === true && restored.extraNodeIds === undefined, `restoreTreeState not exact: ${JSON.stringify(restored)}`);
    assertSameTree('after restoreTreeState over an extra node', await treeState(bridge), c0);
    log('PASS: an extra node is reported by verifyTreeState and removed by restoreTreeState');

    // ---------------------------------------------------------------- 5
    log('Test 5: a tree snapshot carries its tree version');
    await session.loadBuild(occXml);
    const v0 = await treeState(bridge);
    const vSnap = await session.snapshotTree();
    assert(vSnap.treeVersion === v0.treeVersion, `snapshot version ${vSnap.treeVersion} != ${v0.treeVersion}`);
    const conv = await session.convertTreeToLatest();
    assert(conv.converted, 'fixture is already on the latest tree');
    assert((await treeState(bridge)).treeVersion !== v0.treeVersion, 'convert did not change the tree version');
    await session.restoreTree(vSnap);
    assertSameTree('after restoring a pre-convert snapshot', await treeState(bridge), v0);
    log(`PASS: snapshot on ${v0.treeVersion} restores exactly after converting to ${conv.toVersion}`);

    // ---------------------------------------------------------------- 6
    log('Test 6: an inexact tree restore after a probe is an error naming reset_build');
    await session.loadBuild(occXml);
    const p0 = await treeState(bridge);
    let someNode: number | undefined;
    for (const id of p0.nodeIds) {
      const info = await bridge.send<{ node: { type: string } | null }>({ cmd: 'getNodeInfo', nodeId: id });
      if (info.node?.type === 'Normal') {
        someNode = id;
        break;
      }
    }
    assert(someNode !== undefined, 'no allocated Normal node to probe');
    injectUnknownNode = true;
    const probeErr = await rejection(session.simulatePassiveChange([], [someNode]));
    injectUnknownNode = false;
    assert(!(probeErr instanceof UserError), `inexact restore reported as a user error: ${probeErr.message}`);
    assert(/not exact/.test(probeErr.message) && probeErr.message.includes(String(UNKNOWN_NODE)), `unexpected error: ${probeErr.message}`);
    assert(probeErr.message.includes('reset_build'), `error does not name reset_build: ${probeErr.message}`);
    assert(!probeErr.message.endsWith('.'), `error text ends in a period (the MCP layer appends one): ${probeErr.message}`);
    assertSameTree('after an inexact probe restore (everything but the unknown node)', await treeState(bridge), p0);
    log('PASS: probe restore that cannot place a node throws, names reset_build, and restores the rest');

    // The probe's own error stays visible when the restore also fails, and a
    // user error from the probe is still a user error.
    injectUnknownNode = true;
    const bothErr = await rejection(session.simulatePassiveChange([], [UNKNOWN_NODE]));
    injectUnknownNode = false;
    assert(bothErr instanceof UserError, `probe user error lost its class: ${bothErr.name}: ${bothErr.message}`);
    assert(bothErr.message.includes(`Unknown node id: ${UNKNOWN_NODE}`), `probe error missing: ${bothErr.message}`);
    assert(/restoring the build afterwards also failed: Passive tree restore was not exact/.test(bothErr.message), `restore error missing: ${bothErr.message}`);
    assert(bothErr.message.includes('reset_build'), `combined error does not name reset_build: ${bothErr.message}`);
    assert(bothErr.cause instanceof UserError && /Unknown node id/.test(bothErr.cause.message), 'probe error is not the cause');
    const plainErr = await rejection(session.simulatePassiveChange([], [UNKNOWN_NODE]));
    assert(plainErr instanceof UserError && !/also failed/.test(plainErr.message), `plain probe error changed: ${plainErr.message}`);
    assertSameTree('after failing probes', await treeState(bridge), p0);
    log('PASS: probe error and restore error are both reported; user-error class kept');

    // ---------------------------------------------------------------- 7
    log('Test 7: an inexact undo still restores items, config and skills before failing');
    await session.loadBuild(occXml);
    const u0 = await treeState(bridge);
    const ring0 = await session.getItemInSlot('Ring 1');
    const config0 = JSON.stringify((await session.snapshotConfig()).input);
    const skills0 = JSON.stringify(await session.snapshotSkills());
    injectUnknownNode = true;
    await session.swapItemWithDiff('Ring 1', RING); // pushes the (tampered) full undo snapshot
    injectUnknownNode = false;
    const powerCharges = (await session.snapshotConfig()).input.usePowerCharges === true;
    await session.setConfig({ usePowerCharges: !powerCharges });
    const groups = (await bridge.send<{ groups: Array<{ isMainGroup?: boolean; gems?: unknown[] }> }>({ cmd: 'getSocketGroups' })).groups;
    const mainGroup = Math.max(0, groups.findIndex((g) => g.isMainGroup)) + 1;
    await bridge.send({ cmd: 'setGemLevel', groupIndex: mainGroup, gemIndex: 1, level: 1, quality: 0 });
    assert((await session.getItemInSlot('Ring 1'))?.raw !== ring0?.raw, 'ring swap did not change Ring 1');
    assert(JSON.stringify((await session.snapshotConfig()).input) !== config0, 'config change did not apply');
    assert(JSON.stringify(await session.snapshotSkills()) !== skills0, 'gem level change did not apply');
    const undoErr = await rejection(session.undoLastChange());
    assert(/not exact/.test(undoErr.message) && undoErr.message.includes('reset_build'), `unexpected undo error: ${undoErr.message}`);
    assert((await session.getItemInSlot('Ring 1'))?.raw === ring0?.raw, 'undo threw before restoring Ring 1');
    assert(JSON.stringify((await session.snapshotConfig()).input) === config0, 'undo threw before restoring config');
    assert(JSON.stringify(await session.snapshotSkills()) === skills0, 'undo threw before restoring skills');
    assertSameTree('after an inexact undo (everything but the unknown node)', await treeState(bridge), u0);
    log('PASS: inexact undo throws naming reset_build after items, config and skills are back');

    // ---------------------------------------------------------------- 8
    log('Test 8: a socket entry pointing at a missing item restores as captured');
    await session.loadBuild(occXml);
    const exported = await session.exportXML();
    assert((exported.match(/<Sockets>/g) ?? []).length === 1, 'export should have exactly one <Sockets> element');
    await session.loadBuild(exported.replace('<Sockets>', `<Sockets><Socket nodeId="${SLOTLESS_SOCKET}" itemId="${MISSING_ITEM}"/>`));
    const j0 = await treeState(bridge);
    assert(j0.jewels.includes(`${SLOTLESS_SOCKET}:${MISSING_ITEM}`), `PoB dropped the dangling socket id: ${j0.jewels}`);
    await session.simulatePassiveChange([], [someNode]);
    assertSameTree('after a probe on a build with a dangling socket id', await treeState(bridge), j0);
    await session.pushUndo();
    await session.deallocNode(someNode);
    await session.undoLastChange();
    assertSameTree('after undo on a build with a dangling socket id', await treeState(bridge), j0);
    log('PASS: dangling socket item id survives probe and undo unchanged');

    log('ALL TREE-RESTORE TESTS PASSED');
  } finally {
    await bridge.shutdown().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('[tree-restore-test] FAILED:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
