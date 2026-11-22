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

function newBridge(): LuaBridge {
  const b = new LuaBridge(paths, 120_000);
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
  return { xml: await session.exportXML(), stats: await session.getStats() };
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

async function main(): Promise<void> {
  try {
    await test1To4();
    await test5CrashReplay();
    await test6Mcp();
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
