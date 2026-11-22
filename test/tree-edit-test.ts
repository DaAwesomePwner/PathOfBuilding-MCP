// Committed passive-tree edits: allocate_nodes / deallocate_nodes.
//
//   1. allocate_nodes on a notable a few points away: the stats equal
//      simulate_passive_change's (probe) numbers for the same node, the added
//      nodes are the path (tree side first) and the export holds them; one
//      undo entry and one journal record.
//   2. undo_last_change restores the tree exactly: node set, export, stats.
//   3. deallocate_nodes on the first path node removes the nodes depending on
//      it (by name for the notable as well); undo restores.
//   4. Refusals (unknown, ambiguous name, already allocated by id and by name,
//      unreachable, listed twice, a bad node in a batch, mastery by id and by
//      name, not allocated): UserError, export byte-identical, undo depth and
//      journal unchanged.
//   5. Crash replay: after a committed allocate_nodes (and a deallocate_nodes)
//      a killed engine respawns with the change; an undone change is not
//      replayed.
//   6. Through the MCP server: allocate_nodes / deallocate_nodes are listed
//      with undoable annotations, return the compact result, export_build
//      holds the node, undo_last_change reverts it.
//   7. A Large Cluster Jewel socket: deallocating it drops its subgraph nodes
//      (ids above 65535) from the tree; `removed` and the refunded points
//      still list every one of them (described before the change). Undo and
//      a crash replay restore the tree.
//   8. Fault seams: a failure after the tree changed (treeEditFailsAfterChange)
//      commits the change (undo entry + journal record, the error says it was
//      applied, a crash restores it); a batch that fails and rolls back
//      (batchFailsAfterChange) is a UserError that pushes nothing; a rollback
//      that is not exact (treeRollbackInexact) is an internal error with an
//      undo entry but no journal record, and undo restores the tree.
//   9. Masteries (ConvertTreeMasteries.xml, a 3.24 tree): get_passive_tree
//      `masteries` lists a mastery's effects (chosen one, `takenBy` for
//      effects chosen elsewhere; a name lists allocated ones first);
//      allocate_nodes `masteries` switches an allocated mastery's effect
//      (by id) and allocates an unallocated one with its path (effect by
//      text), each with the probe's stats, the export holding the effect, one
//      undo entry and journal record; undo is exact and a crash replays both;
//      refusals (effect not offered, chosen on another mastery, text matching
//      nothing, not a mastery, ambiguous name, listed twice, one effect twice,
//      a mastery in `nodes`, nothing given) change nothing.
//   Points: every result's passive `pointCost` count equals the change in
//   PoB's own point total.
//   (No fixture has an ascendancy choice node, so `removed` for one option
//   replacing another is not exercised here.)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BuildSession, EngineRestartedError } from '../src/build-session.js';
import { LuaBridge, Stats } from '../src/lua-bridge.js';
import { UserError } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const MASTERY_FIXTURE = path.resolve(testDir, 'fixtures', 'ConvertTreeMasteries.xml');
const MASTERY_NODE = 2841; // Life Mastery in ConvertTreeMasteries.xml
const OTHER_ASCENDANCY_NODE = 'Mindless Aggression'; // Necromancer; OccVortex is an Occultist

const log = (msg: string): void => console.log(`[tree-edit-test] ${msg}`);
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const { paths, fixturePath } = setupTestEnv();
const occXml = readFileSync(fixturePath, 'utf8');
const bridges: LuaBridge[] = [];
const tempDirs: string[] = [];

function newBridge(testFaults?: string): LuaBridge {
  const b = new LuaBridge(paths, 120_000, { testFaults });
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

/** The active spec's node list, sorted (a restore or reload may reorder PoB's allocNodes table). */
function specNodes(xml: string): number[] {
  const m = /<Spec\b[^>]*\bnodes="([\d,]*)"/.exec(xml);
  assert(m, 'export has no Spec node list');
  return m[1] === '' ? [] : m[1].split(',').map(Number).sort((a, b) => a - b);
}

/** Export with node lists sorted and the tree URL dropped (both follow Lua table order). */
function canonical(xml: string): string {
  return xml
    .replace(/ nodes="([\d,]*)"/g, (_m, list: string) => ` nodes="${list.split(',').map(Number).sort((x, y) => x - y).join(',')}"`)
    .replace(/<URL>[\s\S]*?<\/URL>/g, '<URL/>');
}

interface State {
  xml: string;
  stats: Stats;
}

async function state(session: BuildSession): Promise<State> {
  // Export first: an export written before PoB recalculated carries stale
  // PlayerStat lines (reading the stats runs the recalculation), so this
  // order catches a change left unrecalculated.
  const xml = await session.exportXML();
  return { xml, stats: await session.getStats() };
}

function assertSameStats(label: string, actual: Stats, expected: Stats): void {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const k of keys) {
    assert(Object.is(actual[k], expected[k]), `${label}: ${k} ${String(actual[k])} != ${String(expected[k])}`);
  }
}

function assertSame(label: string, actual: State, expected: State): void {
  assertSameStats(label, actual.stats, expected.stats);
  assert(JSON.stringify(specNodes(actual.xml)) === JSON.stringify(specNodes(expected.xml)), `${label}: node set differs`);
  const a = canonical(actual.xml);
  const e = canonical(expected.xml);
  if (a !== e) {
    let i = 0;
    while (i < a.length && a[i] === e[i]) i++;
    throw new Error(`${label}: export differs at ${i}: ${JSON.stringify(a.slice(i - 80, i + 80))}\n  vs ${JSON.stringify(e.slice(i - 80, i + 80))}`);
  }
}

/** A session on a build already in PoB's re-read form (loading a fresh XML is not byte-idempotent once). */
async function primedSession(bridge: LuaBridge, xml = occXml): Promise<BuildSession> {
  const session = new BuildSession(bridge);
  await session.loadBuild(xml);
  await session.loadBuild(await session.exportXML());
  return session;
}

interface Candidate {
  id: number;
  name: string;
  type: string;
  points: number;
}

async function candidates(bridge: LuaBridge): Promise<Candidate[]> {
  const r = await bridge.send<{ nodes: Candidate[] }>({ cmd: 'probe', candidates: 'allocate', maxPoints: 4 });
  return r.nodes;
}

// ---------------------------------------------------------------------------

async function test1To4(): Promise<void> {
  const bridge = newBridge();
  const session = await primedSession(bridge);
  const cands = await candidates(bridge);
  // A notable whose name is unique among the reachable nodes, 3 points away.
  const nameCount = new Map<string, number>();
  for (const c of cands) nameCount.set(c.name, (nameCount.get(c.name) ?? 0) + 1);
  const target = cands.find((c) => c.type === 'Notable' && c.points === 3 && nameCount.get(c.name) === 1);
  assert(target, 'no unique 3-point notable among the candidates');
  const ambiguous = [...nameCount].find(([, n]) => n > 1);
  assert(ambiguous, 'no shared node name among the candidates');

  log(`Test 1: allocate_nodes ${target.id} (${target.name}, ${target.points} points) matches the probe`);
  const base = await state(session);
  const depth0 = session.undoStackDepth();
  const pointsBase = (await session.getPassiveTree()).summary.totalPoints;
  const journal0 = bridge.committedCount();
  const simulated = await session.simulatePassiveChange([target.id]);
  assert(simulated.valid, 'simulate_passive_change: tree valid');
  const result = await session.allocateNodes([target.id]);
  assert(result.added.length === target.points, `added ${result.added.length} nodes, want ${target.points}`);
  assert(result.added[result.added.length - 1].id === target.id, 'the notable comes last (tree side first)');
  assert(result.added.every((n) => typeof n.name === 'string' && n.name !== ''), 'added nodes carry names');
  assert(result.removed.length === 0, `nothing removed: ${JSON.stringify(result.removed)}`);
  for (const [k, v] of Object.entries(simulated.after)) {
    assert(Object.is(result.after[k], v), `stat ${k}: allocate_nodes ${String(result.after[k])} != simulate_passive_change ${String(v)}`);
  }
  assert(Object.keys(result.diff).length > 0, 'the allocation changes some stat');
  assert(result.summary.totalPoints === Number((await session.getPassiveTree()).summary.totalPoints), 'summary is the tree after');
  assert(passivePoints(result.added) === result.summary.totalPoints - pointsBase, 'passive points used = PoB total change');
  assertSameStats('stats after allocate_nodes', await session.getStats(), result.after);
  const allocated = await state(session);
  const nodes = specNodes(allocated.xml);
  for (const n of result.added) assert(nodes.includes(n.id), `export lacks allocated node ${n.id}`);
  assert(nodes.length === specNodes(base.xml).length + target.points, 'export holds exactly the added nodes more');
  assert(session.undoStackDepth() === depth0 + 1, 'exactly one undo entry');
  assert(bridge.committedCount() === journal0 + 1, 'exactly one journal record');
  log('PASS 1');

  log('Test 2: undo_last_change restores the tree exactly');
  await session.undoLastChange();
  assertSame('after undo', await state(session), base);
  assert(session.undoStackDepth() === depth0 && bridge.committedCount() === journal0, 'undo pops the entry and the journal record');
  log('PASS 2');

  log('Test 3: deallocate_nodes removes the dependents; undo restores');
  await session.allocateNodes([target.name]); // by name this time
  assertSame('allocate by name = by id', await state(session), allocated);
  const first = result.added[0];
  const dealloc = await session.deallocateNodes([first.id]);
  const removedIds = dealloc.removed.map((n) => n.id).sort((a, b) => a - b);
  assert(
    JSON.stringify(removedIds) === JSON.stringify(result.added.map((n) => n.id).sort((a, b) => a - b)),
    `deallocating ${first.id} removes the whole path: ${JSON.stringify(removedIds)}`,
  );
  assert(dealloc.added.length === 0, 'deallocate adds nothing');
  assertSame('after dealloc (= the base tree)', await state(session), base);
  assert(session.undoStackDepth() === depth0 + 2 && bridge.committedCount() === journal0 + 2, 'one entry per call');
  await session.undoLastChange();
  assertSame('after undoing the dealloc', await state(session), allocated);
  const byName = await session.deallocateNodes([target.name]);
  assert(byName.removed.length === 1 && byName.removed[0].id === target.id, 'by name: only the notable (a leaf) goes');
  await session.undoLastChange();
  await session.undoLastChange();
  assertSame('after undoing everything', await state(session), base);
  assert(session.undoStackDepth() === depth0 && bridge.committedCount() === journal0, 'undo stack and journal back');
  log('PASS 3');

  log('Test 4: refusals change nothing');
  const allocatedNotable = (await session.getPassiveTree()).notables.find((n) => !/\d/.test(n.name));
  assert(allocatedNotable, 'an allocated notable');
  const otherAsc = await session.getNodeInfo({ name: OTHER_ASCENDANCY_NODE });
  assert(otherAsc && !otherAsc.alloc, `${OTHER_ASCENDANCY_NODE} found, unallocated`);
  const refusals: Array<[string, () => Promise<unknown>, RegExp]> = [
    ['unknown name', () => session.allocateNodes(['No Such Passive Node']), /not found/],
    ['unknown id', () => session.allocateNodes([999999]), /Unknown node id/],
    ['ambiguous name', () => session.allocateNodes([ambiguous[0]]), /matches \d+ nodes/],
    ['already allocated (id)', () => session.allocateNodes([allocatedNotable.id]), /already allocated/],
    ['already allocated (name)', () => session.allocateNodes([allocatedNotable.name]), /already allocated/],
    ['unreachable', () => session.allocateNodes([otherAsc.id]), /no path/],
    ['listed twice', () => session.allocateNodes([target.id, target.id]), /more than once/],
    ['bad node in a batch', () => session.allocateNodes([target.id, 'No Such Passive Node']), /not found/],
    ['batch with an allocated node', () => session.allocateNodes([target.id, allocatedNotable.id]), /already allocated/],
    ['dealloc unallocated', () => session.deallocateNodes([target.id]), /not allocated/],
    ['dealloc listed twice', () => session.deallocateNodes([allocatedNotable.id, allocatedNotable.id]), /more than once/],
    ['empty list', () => session.allocateNodes([]), /at least one/],
  ];
  for (const [label, call, pattern] of refusals) {
    const e = await rejection(call());
    assert(e instanceof UserError, `${label}: expected a UserError, got ${e.constructor.name}: ${e.message}`);
    assert(pattern.test(e.message), `${label}: "${e.message}" does not match ${pattern}`);
    const now = await state(session);
    assert(now.xml === base.xml, `${label}: export changed`);
    assertSameStats(label, now.stats, base.stats);
    assert(session.undoStackDepth() === depth0 && bridge.committedCount() === journal0, `${label}: undo/journal changed`);
  }

  // Masteries (none on OccVortex's 3.13 tree): a 3.24 build with Life Mastery 2841 allocated.
  const mastery = await primedSession(bridge, readFileSync(MASTERY_FIXTURE, 'utf8'));
  const masteryBase = await mastery.exportXML();
  const unallocatedMastery = (await bridge.send<{ node: { id: number; alloc: boolean } | null }>({ cmd: 'getNodeInfo', name: 'Attack Mastery' })).node;
  assert(unallocatedMastery, 'a mastery named Attack Mastery');
  // (A name several allocated masteries share, e.g. "Life Mastery" here, is refused as ambiguous first.)
  for (const [label, ref] of [['mastery id', MASTERY_NODE], ['mastery name', 'Attack Mastery'], ['unallocated mastery', unallocatedMastery.id]] as const) {
    const e = await rejection(mastery.allocateNodes([ref]));
    assert(e instanceof UserError && /is a mastery/.test(e.message), `${label}: ${e.message}`);
    assert((await mastery.exportXML()) === masteryBase, `${label}: export changed`);
    assert(mastery.undoStackDepth() === 0 && bridge.committedCount() === 0, `${label}: undo/journal changed`);
  }
  log(`PASS 4 (${refusals.length + 3} refusals)`);
}

async function crash(bridge: LuaBridge): Promise<void> {
  const pid = bridge.getPid();
  assert(pid !== undefined && bridge.isRunning(), 'engine should be running before the crash');
  process.kill(pid, 'SIGKILL');
  const end = Date.now() + 10_000;
  while (bridge.isRunning()) {
    if (Date.now() > end) throw new Error('timed out waiting for the engine to exit');
    await sleep(25);
  }
}

async function expectRestart(label: string, p: Promise<unknown>): Promise<void> {
  const e = await rejection(p);
  assert(e instanceof EngineRestartedError && /build was restored/.test(e.message), `${label}: expected the restart notice, got ${e.message}`);
}

async function test5CrashReplay(): Promise<void> {
  log('Test 5: a crash after committed tree edits respawns with them');
  const bridge = newBridge();
  const session = await primedSession(bridge);
  const base = await state(session);
  const cands = await candidates(bridge);
  const [a, b] = cands.filter((c) => c.type === 'Notable' && c.points >= 2);
  assert(a && b, 'two notables at least 2 points away');

  // An allocation that is then undone is not replayed.
  await session.allocateNodes([a.id]);
  await session.undoLastChange();
  const alloc = await session.allocateNodes([b.id]);
  const allocated = await state(session);
  await crash(bridge);
  await expectRestart('after allocate_nodes', session.getStats());
  const restored = await state(session);
  assertSame('respawned after allocate_nodes', restored, allocated);
  assert(!specNodes(restored.xml).includes(a.id), 'the undone allocation is not replayed');
  for (const n of alloc.added) assert(specNodes(restored.xml).includes(n.id), `replayed tree lacks ${n.id}`);

  // A deallocation on top (with dependents), crash again.
  await session.deallocateNodes([alloc.added[0].id]);
  const deallocated = await state(session);
  assertSame('dealloc of the path start', deallocated, base);
  await crash(bridge);
  await expectRestart('after deallocate_nodes', session.getStats());
  assertSame('respawned after deallocate_nodes', await state(session), deallocated);
  log('PASS 5');
}

interface ToolText {
  type: 'text';
  text: string;
}

async function test6Mcp(): Promise<void> {
  log('Test 6: through the MCP server');
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'pob-tree-edit-'));
  tempDirs.push(configDir);
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', path.resolve(testDir, '..', 'src', 'server.ts')],
    env: { ...process.env, POB_PATH: paths.pobPath, LUAJIT_PATH: paths.luajitPath, POB_MCP_CONFIG_DIR: configDir } as Record<string, string>,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'tree-edit-test', version: '0.0.0' });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
    const r = (await client.callTool({ name, arguments: args })) as { content: ToolText[]; isError?: boolean };
    return { text: r.content[0].text, isError: r.isError === true };
  };
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    for (const name of ['allocate_nodes', 'deallocate_nodes']) {
      const t = tools.find((x) => x.name === name);
      assert(t, `${name} is listed`);
      assert(t.annotations?.readOnlyHint === false && t.annotations?.destructiveHint === false, `${name}: undoable annotations`);
    }
    assert(!(await call('load_build', { source: occXml })).isError, 'load_build');
    const exported = async (): Promise<string> => (await call('export_build', { format: 'xml' })).text;
    const before = await exported();
    const bridge = newBridge();
    const probeSession = new BuildSession(bridge);
    await probeSession.loadBuild(occXml);
    const target = (await candidates(bridge)).find((c) => c.type === 'Notable' && c.points === 2);
    assert(target, 'a 2-point notable');

    const res = await call('allocate_nodes', { nodes: [target.id] });
    assert(!res.isError, `allocate_nodes: ${res.text}`);
    assert(!res.text.includes('\n'), 'compact JSON');
    const parsed = JSON.parse(res.text) as {
      status: string;
      added: Array<{ id: number; name: string }>;
      pointsUsed: number;
      points: { used: number; max: number; remaining: number };
      keyDeltas: Record<string, number>;
      diff: Record<string, unknown>;
    };
    assert(parsed.status === 'allocated' && parsed.pointsUsed === 2 && parsed.added.length === 2, `result: ${res.text}`);
    assert(parsed.added[1].id === target.id && parsed.added[1].name === target.name, 'the notable is named');
    assert(parsed.points.remaining === parsed.points.max - parsed.points.used, 'points remaining');
    assert(typeof parsed.keyDeltas.CombinedDPS === 'number' && typeof parsed.diff === 'object', 'stat diff shape');
    assert(specNodes(await exported()).includes(target.id), 'export_build holds the node');

    const refused = await call('allocate_nodes', { nodes: [target.id] });
    assert(refused.isError && /already allocated/.test(refused.text) && !/Internal error/.test(refused.text), `refusal: ${refused.text}`);

    const dealloc = await call('deallocate_nodes', { nodes: [target.name] });
    const d = JSON.parse(dealloc.text) as { status: string; removed: Array<{ id: number }>; pointsRefunded: number };
    assert(d.status === 'deallocated' && d.pointsRefunded === 1 && d.removed[0].id === target.id, `dealloc: ${dealloc.text}`);
    assert(!(await call('undo_last_change')).isError, 'undo dealloc');
    assert(!(await call('undo_last_change')).isError, 'undo alloc');
    assert(JSON.stringify(specNodes(await exported())) === JSON.stringify(specNodes(before)), 'undo_last_change reverts the node set');
  } finally {
    await client.close();
  }
  log('PASS 6');
}

function passivePoints(nodes: Array<{ pointCost: string }>): number {
  return nodes.filter((n) => n.pointCost === 'passive').length;
}

async function allocatedIds(bridge: LuaBridge): Promise<number[]> {
  const r = await bridge.send<{ nodeIds: number[] }>({ cmd: 'getAllocatedNodes' });
  return [...r.nodeIds].sort((a, b) => a - b);
}

const CLUSTER_SOCKET = 21984;
const CLUSTER_NOTABLE = 65898; // Smoking Remains on the subgraph of the jewel below
const LARGE_CLUSTER = `Rarity: RARE
Tree Edit Cluster
Large Cluster Jewel
Item Level: 84
Implicits: 3
Adds 8 Passive Skills (enchant)
2 Added Passive Skills are Jewel Sockets (enchant)
Added Small Passive Skills grant: 12% increased Fire Damage (enchant)
1 Added Passive Skill is Prismatic Heart
1 Added Passive Skill is Smoking Remains`;

async function test7Cluster(): Promise<void> {
  log('Test 7: deallocating a Large Cluster Jewel socket reports its subgraph nodes');
  const bridge = newBridge();
  const session = await primedSession(bridge);
  await session.allocateNodes([CLUSTER_SOCKET]);
  await session.swapItemWithDiff(`Jewel ${CLUSTER_SOCKET}`, LARGE_CLUSTER);
  const alloc = await session.allocateNodes([CLUSTER_NOTABLE]);
  assert(alloc.added.some((n) => n.id === CLUSTER_NOTABLE), 'the cluster notable is allocated');
  assert(alloc.added.every((n) => n.id > 65535), `the path runs on the subgraph: ${JSON.stringify(alloc.added)}`);
  const withCluster = await state(session);
  const idsBefore = await allocatedIds(bridge);
  const pointsBefore = (await session.getPassiveTree()).summary.totalPoints;
  const depth = session.undoStackDepth();
  const journal = bridge.committedCount();

  const dealloc = await session.deallocateNodes([CLUSTER_SOCKET]);
  const idsAfter = await allocatedIds(bridge);
  const lost = idsBefore.filter((id) => !idsAfter.includes(id));
  const removedIds = dealloc.removed.map((n) => n.id).sort((a, b) => a - b);
  assert(JSON.stringify(removedIds) === JSON.stringify(lost), `removed ${JSON.stringify(removedIds)} != lost ${JSON.stringify(lost)}`);
  assert(removedIds.includes(CLUSTER_NOTABLE) && removedIds.filter((id) => id > 65535).length === alloc.added.length, 'every subgraph node is listed');
  const notable = dealloc.removed.find((n) => n.id === CLUSTER_NOTABLE);
  assert(notable && notable.name === 'Smoking Remains' && notable.pointCost === 'passive', `subgraph node described: ${JSON.stringify(notable)}`);
  assert(passivePoints(dealloc.removed) === pointsBefore - dealloc.summary.totalPoints,
    `refunded ${passivePoints(dealloc.removed)} != PoB's ${pointsBefore - dealloc.summary.totalPoints}`);
  assert(session.undoStackDepth() === depth + 1 && bridge.committedCount() === journal + 1, 'one undo entry and journal record');
  const deallocated = await state(session);

  await session.undoLastChange();
  assertSame('undo of the socket deallocation', await state(session), withCluster);
  await session.deallocateNodes([CLUSTER_SOCKET]);
  await crash(bridge);
  await expectRestart('after the cluster deallocation', session.getStats());
  assertSame('respawned after the cluster deallocation', await state(session), deallocated);
  log('PASS 7');
}

async function twoPointNotable(bridge: LuaBridge): Promise<Candidate> {
  const target = (await candidates(bridge)).find((c) => c.type === 'Notable' && c.points === 2);
  assert(target, 'a 2-point notable');
  return target;
}

async function test8Faults(): Promise<void> {
  log('Test 8: fault seams around the tree change');
  {
    const bridge = newBridge('treeEditFailsAfterChange');
    const session = await primedSession(bridge);
    const base = await state(session);
    const target = await twoPointNotable(bridge);
    const e = await rejection(session.allocateNodes([target.id]));
    assert(!(e instanceof UserError) && /WAS applied/.test(e.message) && /test fault/.test(e.message), `applied-but-failed error: ${e.message}`);
    assert(session.undoStackDepth() === 1 && bridge.committedCount() === 1, 'the applied change is committed with its journal record');
    const applied = await state(session);
    assert(specNodes(applied.xml).includes(target.id), 'the change is in the build');
    await session.undoLastChange();
    assertSame('undo of the applied-but-failed change', await state(session), base);
    assert(bridge.committedCount() === 0, 'undo truncates the journal');
    await rejection(session.allocateNodes([target.id]));
    await crash(bridge);
    await expectRestart('after the applied-but-failed change', session.getStats());
    assertSame('respawned after the applied-but-failed change', await state(session), applied);
    const d = await rejection(session.deallocateNodes([target.id]));
    assert(/WAS applied/.test(d.message) && !specNodes((await state(session)).xml).includes(target.id), `dealloc applied-but-failed: ${d.message}`);
    assert(session.undoStackDepth() === 1 && bridge.committedCount() === 2, 'dealloc committed too');
  }
  // A strict batch that fails before its handler runs (failOn_<cmd>) right
  // after a successful one changes nothing and is not credited with the
  // earlier change: no undo entry, no journal record, build unchanged.
  for (const [fault, label] of [['failOn_deallocNodes', 'deallocate after allocate'], ['failOn_allocNodes', 'allocate after deallocate']] as const) {
    const bridge = newBridge(fault);
    const session = await primedSession(bridge);
    const target = await twoPointNotable(bridge);
    let failing: () => Promise<unknown>;
    if (fault === 'failOn_deallocNodes') {
      await session.allocateNodes([target.id]);
      failing = () => session.deallocateNodes([target.id]);
    } else {
      const notable = (await session.getPassiveTree()).notables[0];
      assert(notable, 'an allocated notable to deallocate');
      await session.deallocateNodes([notable.id]);
      failing = () => session.allocateNodes([target.id]);
    }
    const committed = await state(session);
    const depth = session.undoStackDepth();
    const journal = bridge.committedCount();
    const e = await rejection(failing());
    assert(/test fault: (de)?allocNodes failed/.test(e.message) && !/WAS applied/.test(e.message), `${label}: ${e.message}`);
    assert(session.undoStackDepth() === depth && bridge.committedCount() === journal, `${label}: undo/journal changed`);
    assertSame(`${label}: build unchanged`, await state(session), committed);
  }
  {
    const bridge = newBridge('batchFailsAfterChange');
    const session = await primedSession(bridge);
    const base = await state(session);
    const target = await twoPointNotable(bridge);
    const e = await rejection(session.allocateNodes([target.id]));
    assert(e instanceof UserError && /test fault/.test(e.message), `rolled-back batch: ${e.message}`);
    assert((await state(session)).xml === base.xml, 'export unchanged after the rollback');
    assert(session.undoStackDepth() === 0 && bridge.committedCount() === 0, 'nothing pushed or journaled');
  }
  {
    const bridge = newBridge('batchFailsAfterChange,treeRollbackInexact');
    const session = await primedSession(bridge);
    const base = await state(session);
    const target = await twoPointNotable(bridge);
    const e = await rejection(session.allocateNodes([target.id]));
    assert(!(e instanceof UserError) && /rolling the passive tree back also failed/.test(e.message), `inexact rollback: ${e.message}`);
    assert(session.undoStackDepth() === 1 && bridge.committedCount() === 0, 'an undo entry, no journal record');
    await session.undoLastChange();
    assertSame('undo after the inexact rollback', await state(session), base);
  }
  log('PASS 8');
}

/** The active spec's mastery selections in the export, sorted ("{node,effect}" each). */
function specMasteries(xml: string): string[] {
  const m = /<Spec\b[^>]*\bmasteryEffects="([^"]*)"/.exec(xml);
  assert(m, 'export has no masteryEffects attribute');
  return (m[1].match(/\{\d+,\d+\}/g) ?? []).sort();
}

async function test9Masteries(): Promise<void> {
  log('Test 9: masteries through allocate_nodes (ConvertTreeMasteries.xml, a 3.24 tree)');
  const bridge = newBridge();
  const session = await primedSession(bridge, readFileSync(MASTERY_FIXTURE, 'utf8'));
  const base = await state(session);
  const depth0 = session.undoStackDepth();
  const journal0 = bridge.committedCount();

  // Listing: Life Mastery 2841 has 64381 chosen; 34242 / 47642 are chosen on 12125 / 12382.
  const listed = (await session.getPassiveTree([MASTERY_NODE])).masteryOptions;
  assert(listed && listed.length === 1, `one listed mastery: ${JSON.stringify(listed)}`);
  const life = listed[0];
  assert(life.id === MASTERY_NODE && life.allocated === true && life.effect === 64381, `2841 chosen effect: ${JSON.stringify(life)}`);
  const takenBy = new Map((life.options ?? []).map((o) => [o.effect, o.takenBy]));
  assert(takenBy.get(34242) === 12125 && takenBy.get(47642) === 12382 && takenBy.get(64381) === undefined, `takenBy: ${JSON.stringify(life.options)}`);
  const free = (life.options ?? []).filter((o) => o.takenBy === undefined && o.effect !== life.effect);
  assert(free.length >= 2, 'at least two free Life Mastery effects');
  const byName = (await session.getPassiveTree(['Life Mastery'])).masteryOptions ?? [];
  assert(byName.filter((m) => m.allocated).length === 3 && byName[0].allocated, `a name lists the allocated ones first: ${JSON.stringify(byName.map((m) => m.id))}`);
  const reachable = byName.filter((m) => !m.allocated && m.points !== undefined).sort((a, b) => a.points! - b.points!);
  assert(reachable.length > 0, 'an unallocated Life Mastery a path reaches');

  log('  9a. switch an allocated mastery to another effect (by id), equal to the probe; undo exact');
  const switchTo = free[0];
  const probed = await session.probe({ variants: [{ masteries: [{ node: MASTERY_NODE, effect: switchTo.effect }] }] });
  assert(!probed.results[0].error && !probed.results[0].fallback, `probe: ${JSON.stringify(probed.results[0])}`);
  const switched = await session.allocateNodes([], [{ node: MASTERY_NODE, effect: switchTo.effect }]);
  assert(switched.added.length === 0 && switched.removed.length === 0, 'a switch allocates nothing');
  assert(switched.masteries?.length === 1 && switched.masteries[0].id === MASTERY_NODE && switched.masteries[0].effect === switchTo.effect
    && switched.masteries[0].previousEffect === 64381 && switched.masteries[0].stats === switchTo.stats, `masteries: ${JSON.stringify(switched.masteries)}`);
  for (const [k, v] of Object.entries(probed.results[0].stats)) {
    if (v !== null) assert(Object.is(switched.after[k], v), `switch ${k}: committed ${String(switched.after[k])} != probe ${String(v)}`);
  }
  const switchedState = await state(session);
  assert(specMasteries(switchedState.xml).includes(`{${MASTERY_NODE},${switchTo.effect}}`), 'export holds the new effect');
  assert(session.undoStackDepth() === depth0 + 1 && bridge.committedCount() === journal0 + 1, 'one undo entry, one journal record');
  await session.undoLastChange();
  assertSame('undo of the switch', await state(session), base);

  log('  9b. allocate an unallocated mastery with its path, effect by text');
  const target = reachable[0];
  // (Not the effect 9a used: 2841 takes it again below.)
  const targetEffect = (target.options ?? []).find((o) => o.takenBy === undefined && o.effect !== switchTo.effect);
  assert(targetEffect, 'a free effect on the target');
  const effectText = targetEffect.stats.split(' / ')[0].toUpperCase();
  const probedAlloc = await session.probe({ variants: [{ masteries: [{ node: target.id!, effect: effectText }] }] });
  assert(!probedAlloc.results[0].error, `probe allocate: ${probedAlloc.results[0].error}`);
  const alloc = await session.allocateNodes([], [{ node: target.id!, effect: effectText }]);
  assert(alloc.added.length === target.points && alloc.added[alloc.added.length - 1].id === target.id, `added path, mastery last: ${JSON.stringify(alloc.added)}`);
  assert(probedAlloc.results[0].pointsAdded === target.points, `probe pointsAdded ${probedAlloc.results[0].pointsAdded}`);
  assert(alloc.masteries?.[0].effect === targetEffect.effect && alloc.masteries[0].previousEffect === undefined, `chosen: ${JSON.stringify(alloc.masteries)}`);
  for (const [k, v] of Object.entries(probedAlloc.results[0].stats)) {
    if (v !== null) assert(Object.is(alloc.after[k], v), `allocate ${k}: committed ${String(alloc.after[k])} != probe ${String(v)}`);
  }
  const allocState = await state(session);
  assert(specNodes(allocState.xml).includes(target.id!), 'export holds the mastery node');
  assert(specMasteries(allocState.xml).includes(`{${target.id},${targetEffect.effect}}`), 'export holds its effect');
  // A regular node and a mastery switch in one call; then a crash replays both calls.
  await session.allocateNodes([], [{ node: MASTERY_NODE, effect: switchTo.effect }]);
  const both = await state(session);
  await crash(bridge);
  await expectRestart('after the mastery edits', session.getStats());
  assertSame('respawned after the mastery edits', await state(session), both);

  log('  9c. refusals change nothing');
  const blockEffect = 41322; // chosen on Block Mastery 38921
  const notableId = await firstNotable(session);
  const now = await state(session);
  const depth = session.undoStackDepth();
  const journal = bridge.committedCount();
  const refusals: Array<[string, () => Promise<unknown>, RegExp]> = [
    ['effect not offered', () => session.allocateNodes([], [{ node: MASTERY_NODE, effect: blockEffect }]), /does not offer effect/],
    ['effect taken elsewhere', () => session.allocateNodes([], [{ node: MASTERY_NODE, effect: 47642 }]), /already chosen on mastery 12382/],
    ['effect text matching nothing', () => session.allocateNodes([], [{ node: MASTERY_NODE, effect: 'no such effect text' }]), /no effect of mastery/],
    ['not a mastery', () => session.allocateNodes([], [{ node: notableId, effect: 1 }]), /is not a mastery/],
    ['ambiguous mastery name', () => session.allocateNodes([], [{ node: 'Life Mastery', effect: switchTo.effect }]), /matches \d+ nodes/],
    ['listed twice', () => session.allocateNodes([], [{ node: MASTERY_NODE, effect: free[1].effect }, { node: MASTERY_NODE, effect: free[1].effect }]), /listed twice/],
    ['one effect twice', () => session.allocateNodes([], [{ node: MASTERY_NODE, effect: free[1].effect }, { node: 12125, effect: free[1].effect }]), /also chosen/],
    ['mastery in nodes', () => session.allocateNodes([reachable[reachable.length - 1].id!]), /is a mastery; pass it in `masteries`/],
    ['nothing given', () => session.allocateNodes([], []), /at least one node or mastery/],
  ];
  for (const [label, call, pattern] of refusals) {
    const e = await rejection(call());
    assert(e instanceof UserError, `${label}: expected a UserError, got ${e.constructor.name}: ${e.message}`);
    assert(pattern.test(e.message), `${label}: "${e.message}" does not match ${pattern}`);
    const after = await state(session);
    assert(after.xml === now.xml, `${label}: export changed`);
    assert(session.undoStackDepth() === depth && bridge.committedCount() === journal, `${label}: undo/journal changed`);
  }
  log('PASS 9');
}

async function firstNotable(session: BuildSession): Promise<number> {
  const n = (await session.getPassiveTree()).notables[0];
  assert(n, 'an allocated notable');
  return n.id;
}

async function main(): Promise<void> {
  try {
    await test1To4();
    await test5CrashReplay();
    await test6Mcp();
    await test7Cluster();
    await test8Faults();
    await test9Masteries();
    log('ALL PASS');
  } finally {
    for (const b of bridges) await b.shutdown().catch(() => undefined);
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
