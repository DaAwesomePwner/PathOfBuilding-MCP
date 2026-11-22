// Committed build edits: apply_changes, create_socket_group,
// delete_socket_group, set_main_skill (on OccVortex: Vortex in group 5 is the
// main skill, group 2 holds Storm Brand and Cold Snap, group 7 is the
// monster-explosion group the build's items grant).
//
//   1. apply_changes parity with evaluate_changes (and the probe's raw
//      stats): (a) a gems-only variant, (b) a mixed variant (gem op, node,
//      config, item). One undo entry and one journal record each; undo
//      restores exactly (skills export byte-identical, export / node set /
//      stats as the other restore tests compare).
//   2. Refusals (bad gem name, bad group / gem index, granted group,
//      unreachable node, unknown config key, empty variant; bad create /
//      delete / set_main_skill arguments): UserError, export byte-identical,
//      undo depth and journal unchanged.
//   3. create_socket_group / delete_socket_group / set_main_skill change the
//      groups and the main skill as expected and undo cleanly.
//   4. Crash replay after apply_changes (with a node path) and after
//      create_socket_group reproduces the build.
//   5. Fault seams: a failure after the change (buildEditFailsAfterChange)
//      commits it (undo entry + journal record, "WAS applied", a crash
//      restores it), for apply_changes and create_socket_group; with the
//      recalculation failing too (buildEditRecalcFails) the error says the
//      stats may be stale; a failure part-way (applyChangesFailsMidway) rolls
//      back exactly and pushes nothing.
//   6. Through the MCP server: the four tools are listed as undoable,
//      apply_changes echoes the label and reports points, undo reverts.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BuildSession, EngineRestartedError, type NamedProbeVariant } from '../src/build-session.js';
import { evaluateChanges, roundStat } from '../src/evaluate-changes.js';
import { LuaBridge, Stats } from '../src/lua-bridge.js';
import { withoutNulls } from '../src/probe.js';
import { UserError } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const MAIN_GROUP = 5; // Vortex
const TWO_ACTIVES_GROUP = 2; // Storm Brand, Cold Snap
const GRANTED_GROUP = 7; // On Kill Monster Explosion (item-granted)
const OTHER_ASCENDANCY_NODE = 'Mindless Aggression'; // Necromancer; OccVortex is an Occultist
const RING = `Rarity: RARE
Build Edit Ring
Coral Ring
Item Level: 63
LevelReq: 64
Implicits: 1
+30 to maximum Life
+150 to maximum Life
+30% to all Elemental Resistances`;

const log = (msg: string): void => console.log(`[build-edit-test] ${msg}`);
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

function specNodes(xml: string): number[] {
  const m = /<Spec\b[^>]*\bnodes="([\d,]*)"/.exec(xml);
  assert(m, 'export has no Spec node list');
  return m[1] === '' ? [] : m[1].split(',').map(Number).sort((a, b) => a - b);
}

/** The export's <Skills> section, byte for byte. */
function skillsXml(xml: string): string {
  const m = /<Skills\b[\s\S]*?<\/Skills>/.exec(xml);
  assert(m, 'export has no Skills section');
  return m[0];
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
  // PlayerStat lines, so this order catches a change left unrecalculated.
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
  assert(skillsXml(actual.xml) === skillsXml(expected.xml), `${label}: skills export differs`);
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
async function primedSession(bridge: LuaBridge): Promise<BuildSession> {
  const session = new BuildSession(bridge);
  await session.loadBuild(occXml);
  await session.loadBuild(await session.exportXML());
  return session;
}

async function twoPointNotable(bridge: LuaBridge): Promise<{ id: number; name: string }> {
  const r = await bridge.send<{ nodes: Array<{ id: number; name: string; type: string; points: number; fallback?: string }> }>({
    cmd: 'probe',
    candidates: 'allocate',
    maxPoints: 2,
  });
  const target = r.nodes.find((c) => c.type === 'Notable' && c.points === 2 && !c.fallback);
  assert(target, 'a 2-point notable the calculator can evaluate');
  return target;
}

/** apply_changes' stats equal the probe's raw numbers and evaluate_changes' (rounded) deltas for the same variant. */
async function assertParity(label: string, session: BuildSession, variant: NamedProbeVariant, apply: () => Promise<Stats>): Promise<Stats> {
  const probed = await session.probeNamed({ variants: [variant] });
  const r = probed.results[0];
  assert(r.error === undefined, `${label}: probe refused the variant: ${r.error}`);
  const evaluated = await evaluateChanges(session, { variants: [variant] });
  const row = evaluated.results[0];
  assert(row.error === undefined && row.delta, `${label}: evaluate_changes refused the variant: ${row.error}`);
  const after = await apply();
  const expected = withoutNulls(r.stats);
  for (const [k, v] of Object.entries(expected)) {
    assert(Object.is(after[k], v), `${label}: ${k} apply_changes ${String(after[k])} != probe ${String(v)}`);
  }
  for (const [k, d] of Object.entries(row.delta)) {
    const b = probed.base[k];
    const a = after[k];
    if (typeof a === 'number' && typeof b === 'number') {
      assert(d === roundStat(a - b), `${label}: ${k} delta evaluate_changes ${d} != apply_changes ${roundStat(a - b)}`);
    }
  }
  return after;
}

// ---------------------------------------------------------------------------

async function test1Parity(): Promise<void> {
  const bridge = newBridge();
  const session = await primedSession(bridge);
  const base = await state(session);

  log('Test 1a: a gems-only variant');
  const gemsOnly: NamedProbeVariant = {
    gems: [
      { op: 'set', group: MAIN_GROUP, index: 2, name: 'Elemental Focus' },
      { op: 'set', group: MAIN_GROUP, index: 3, level: 15, quality: 10 },
      { op: 'add', group: MAIN_GROUP, name: 'Inspiration', level: 18 },
    ],
  };
  const gemsAfter = await assertParity('gems-only', session, gemsOnly, async () => (await session.applyChanges(gemsOnly)).after);
  assert(toNumber(gemsAfter.CombinedDPS) !== toNumber(base.stats.CombinedDPS), 'the gem change changes DPS');
  assert(session.undoStackDepth() === 1 && bridge.committedCount() === 1, 'one undo entry, one journal record');
  const gemsState = await state(session);
  assert(/nameSpec="Elemental Focus"/.test(skillsXml(gemsState.xml)) && /nameSpec="Inspiration"/.test(skillsXml(gemsState.xml)), 'the export holds the new gems');
  assertSameStats('stats after apply_changes', gemsState.stats, gemsAfter);
  await session.undoLastChange();
  assertSame('undo of the gems-only variant', await state(session), base);
  assert(session.undoStackDepth() === 0 && bridge.committedCount() === 0, 'undo pops the entry and the journal record');
  log('PASS 1a');

  log('Test 1b: a mixed variant (gem op, node, config, item)');
  const notable = await twoPointNotable(bridge);
  const mixed: NamedProbeVariant = {
    gems: [{ op: 'set', group: MAIN_GROUP, index: 2, name: 'Elemental Focus' }],
    allocate: [notable.name],
    config: { enemyIsBoss: 'Pinnacle', usePowerCharges: true },
    items: [{ slot: 'Ring 1', itemText: RING }],
  };
  let result: Awaited<ReturnType<BuildSession['applyChanges']>> | undefined;
  await assertParity('mixed', session, mixed, async () => {
    result = await session.applyChanges(mixed);
    return result.after;
  });
  assert(result, 'apply result');
  assert(result.added.length === 2 && result.added[1].id === notable.id && result.removed.length === 0, `added: ${JSON.stringify(result.added)}`);
  assert(result.summary && result.summary.totalPoints === Number((await session.getPassiveTree()).summary.totalPoints), 'summary is the tree after');
  const mixedState = await state(session);
  assert(specNodes(mixedState.xml).includes(notable.id), 'the export holds the node');
  assert(/<Input (boolean="true" name="usePowerCharges"|name="usePowerCharges" boolean="true")\/>/.test(mixedState.xml), 'the export holds the config');
  assert(mixedState.xml.includes('Build Edit Ring'), 'the export holds the ring');
  assert(session.undoStackDepth() === 1 && bridge.committedCount() === 1, 'one undo entry, one journal record');
  await session.undoLastChange();
  assertSame('undo of the mixed variant', await state(session), base);
  log('PASS 1b');
}

function toNumber(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

async function test2Refusals(): Promise<void> {
  log('Test 2: refusals change nothing');
  const bridge = newBridge();
  const session = await primedSession(bridge);
  const base = await state(session);
  const notable = await twoPointNotable(bridge);
  const refusals: Array<[string, () => Promise<unknown>, RegExp]> = [
    ['bad gem name', () => session.applyChanges({ gems: [{ op: 'set', group: MAIN_GROUP, index: 2, name: 'No Such Gem Whatsoever' }] }), /gem lookup failed/i],
    ['bad gem name after a good op', () => session.applyChanges({ gems: [{ op: 'remove', group: MAIN_GROUP, index: 1 }, { op: 'add', group: MAIN_GROUP, name: 'No Such Gem Whatsoever' }] }), /gem lookup failed/i],
    ['bad group index', () => session.applyChanges({ gems: [{ op: 'remove', group: 99, index: 1 }] }), /not found/],
    ['bad gem index', () => session.applyChanges({ gems: [{ op: 'remove', group: MAIN_GROUP, index: 40 }] }), /not found/],
    ['granted group', () => session.applyChanges({ gems: [{ op: 'remove', group: GRANTED_GROUP, index: 1 }] }), /granted/],
    ['unreachable node', () => session.applyChanges({ allocate: [OTHER_ASCENDANCY_NODE], gems: [{ op: 'remove', group: MAIN_GROUP, index: 1 }] }), /no path/],
    ['unknown node', () => session.applyChanges({ allocate: ['No Such Passive Node'] }), /not found/],
    ['unknown config key', () => session.applyChanges({ config: { noSuchConfigKeyAtAll: true }, allocate: [notable.id] }), /Unknown config key/],
    ['bad item', () => session.applyChanges({ items: [{ slot: 'Ring 1', itemText: 'not an item' }] }), /Rarity/],
    ['empty variant', () => session.applyChanges({}), /changes nothing/],
    ['create: bad gem', () => session.createSocketGroup({ gems: [{ name: 'Fireball' }, { name: 'No Such Gem Whatsoever' }] }), /gem lookup failed/i],
    ['create: bad slot', () => session.createSocketGroup({ gems: [{ name: 'Fireball' }], slot: 'Flask 1' }), /slot must be/],
    ['delete: granted group', () => session.deleteSocketGroup(GRANTED_GROUP), /granted by/],
    ['delete: no such group', () => session.deleteSocketGroup(99), /not found/],
    ['set main: no such group', () => session.setMainSkill(99), /not found/],
    ['set main: activeSkill out of range', () => session.setMainSkill(TWO_ACTIVES_GROUP, 3), /out of range/],
  ];
  for (const [label, call, pattern] of refusals) {
    const e = await rejection(call());
    assert(e instanceof UserError, `${label}: expected a UserError, got ${e.constructor.name}: ${e.message}`);
    assert(pattern.test(e.message), `${label}: "${e.message}" does not match ${pattern}`);
    const now = await state(session);
    assert(now.xml === base.xml, `${label}: export changed`);
    assertSameStats(label, now.stats, base.stats);
    assert(session.undoStackDepth() === 0 && bridge.committedCount() === 0, `${label}: undo/journal changed`);
  }
  log(`PASS 2 (${refusals.length} refusals)`);
}

async function test3SocketGroups(): Promise<void> {
  log('Test 3: create / delete socket groups and set the main skill');
  const bridge = newBridge();
  const session = await primedSession(bridge);
  const base = await state(session);
  const groups0 = await session.listSkillGroups();
  assert((await session.getBuildInfo()).mainSkill === 'Vortex', 'Vortex is the main skill');

  const created = await session.createSocketGroup({ gems: [{ name: 'Fireball' }, { name: 'Spell Echo', quality: 20 }], label: 'Test group', setAsMain: true });
  const newIndex = created.details.index as number;
  assert(newIndex === groups0.length + 1, `new group goes last: ${newIndex}`);
  assert(created.mainSkill === 'Fireball' && (await session.getBuildInfo()).mainSkill === 'Fireball', `main skill: ${created.mainSkill}`);
  const breakdown = await session.getSkillBreakdown();
  assert(breakdown.index === newIndex && breakdown.isMainGroup && breakdown.gems.map((g) => g.nameSpec).join() === 'Fireball,Spell Echo', `breakdown: ${JSON.stringify(breakdown)}`);
  assert(toNumber(created.after.CombinedDPS) !== toNumber(base.stats.CombinedDPS), 'DPS now describes Fireball');
  assert(session.undoStackDepth() === 1 && bridge.committedCount() === 1, 'one undo entry, one journal record');
  await session.undoLastChange();
  assertSame('undo of create_socket_group', await state(session), base);
  assert((await session.getBuildInfo()).mainSkill === 'Vortex', 'undo restores the main skill');

  // Deleting a group before the main one shifts the main group down by one.
  const deleted = await session.deleteSocketGroup(TWO_ACTIVES_GROUP);
  assert(deleted.details.mainSocketGroup === MAIN_GROUP - 1, `main group shifts: ${JSON.stringify(deleted.details)}`);
  const groups1 = await session.listSkillGroups();
  assert(groups1.length === groups0.length - 1 && groups1[MAIN_GROUP - 2].isMainGroup, 'one group fewer, Vortex still main');
  assert(deleted.mainSkill === 'Vortex' && Object.keys(deleted.diff).length === 0, `deleting an unrelated group keeps the main skill: ${JSON.stringify(deleted.diff)}`);
  await session.undoLastChange();
  assertSame('undo of delete_socket_group', await state(session), base);

  // Deleting the main group: the next group takes its index and is main.
  const deletedMain = await session.deleteSocketGroup(MAIN_GROUP);
  assert(deletedMain.details.mainSocketGroup === MAIN_GROUP, 'the main index stays valid');
  const groups2 = await session.listSkillGroups();
  assert(groups2[MAIN_GROUP - 1].isMainGroup && groups2[MAIN_GROUP - 1].label === groups0[MAIN_GROUP].label, 'the next group is main');
  await session.undoLastChange();
  assertSame('undo of deleting the main group', await state(session), base);

  // set_main_skill: the second active skill of group 2.
  const setMain = await session.setMainSkill(TWO_ACTIVES_GROUP, 2);
  assert(setMain.details.mainSocketGroup === TWO_ACTIVES_GROUP && setMain.details.activeSkill === 2, JSON.stringify(setMain.details));
  assert(setMain.mainSkill === 'Cold Snap', `main skill: ${setMain.mainSkill}`);
  const groups3 = await session.listSkillGroups();
  assert(groups3[TWO_ACTIVES_GROUP - 1].isMainGroup && groups3[TWO_ACTIVES_GROUP - 1].mainActiveSkill === 2, 'group 2, second skill');
  const first = await session.setMainSkill(TWO_ACTIVES_GROUP, 1);
  assert(first.mainSkill === 'Storm Brand', `main skill: ${first.mainSkill}`);
  assert(session.undoStackDepth() === 2 && bridge.committedCount() === 2, 'one entry per call');
  await session.undoLastChange();
  await session.undoLastChange();
  assertSame('undo of set_main_skill', await state(session), base);
  assert(session.undoStackDepth() === 0 && bridge.committedCount() === 0, 'undo stack and journal back');
  log('PASS 3');
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

async function test4CrashReplay(): Promise<void> {
  log('Test 4: a crash after committed build edits respawns with them');
  const bridge = newBridge();
  const session = await primedSession(bridge);
  const notable = await twoPointNotable(bridge);

  // An undone apply_changes is not replayed.
  await session.applyChanges({ gems: [{ op: 'remove', group: MAIN_GROUP, index: 1 }] });
  await session.undoLastChange();
  await session.applyChanges({
    allocate: [notable.id],
    gems: [{ op: 'set', group: MAIN_GROUP, index: 2, name: 'elemental focus' }],
    config: { usePowerCharges: true },
    items: [{ slot: 'Ring 1', itemText: RING }],
  });
  const applied = await state(session);
  await crash(bridge);
  await expectRestart('after apply_changes', session.getStats());
  assertSame('respawned after apply_changes', await state(session), applied);

  await session.createSocketGroup({ gems: [{ name: 'fireball' }, { name: 'Spell Echo' }], slot: 'Gloves', setAsMain: true });
  await session.setMainSkill(TWO_ACTIVES_GROUP, 2);
  await session.deleteSocketGroup(1);
  const edited = await state(session);
  await crash(bridge);
  await expectRestart('after the socket group edits', session.getStats());
  assertSame('respawned after the socket group edits', await state(session), edited);
  log('PASS 4');
}

async function test5Faults(): Promise<void> {
  log('Test 5: fault seams around the change');
  {
    const bridge = newBridge('buildEditFailsAfterChange');
    const session = await primedSession(bridge);
    const base = await state(session);
    const notable = await twoPointNotable(bridge);
    const e = await rejection(session.applyChanges({ allocate: [notable.id], gems: [{ op: 'remove', group: MAIN_GROUP, index: 1 }] }));
    assert(!(e instanceof UserError) && /WAS applied/.test(e.message) && /test fault/.test(e.message), `applied-but-failed: ${e.message}`);
    assert(session.undoStackDepth() === 1 && bridge.committedCount() === 1, 'the applied change is committed with its journal record');
    const applied = await state(session);
    assert(specNodes(applied.xml).includes(notable.id), 'the change is in the build');
    await session.undoLastChange();
    assertSame('undo of the applied-but-failed apply_changes', await state(session), base);
    await rejection(session.applyChanges({ allocate: [notable.id], gems: [{ op: 'remove', group: MAIN_GROUP, index: 1 }] }));
    await crash(bridge);
    await expectRestart('after the applied-but-failed apply_changes', session.getStats());
    assertSame('respawned after the applied-but-failed apply_changes', await state(session), applied);

    const c = await rejection(session.createSocketGroup({ gems: [{ name: 'Fireball' }], setAsMain: true }));
    assert(!(c instanceof UserError) && /WAS applied/.test(c.message), `create applied-but-failed: ${c.message}`);
    assert((await session.getBuildInfo()).mainSkill === 'Fireball', 'the new group is in the build');
    assert(session.undoStackDepth() === 1 && bridge.committedCount() === 2, 'committed with its journal record');
    const created = await state(session);
    await crash(bridge);
    await expectRestart('after the applied-but-failed create_socket_group', session.getStats());
    assertSame('respawned after the applied-but-failed create_socket_group', await state(session), created);
  }
  {
    const bridge = newBridge('buildEditFailsAfterChange,buildEditRecalcFails');
    const session = await primedSession(bridge);
    const e = await rejection(session.setMainSkill(TWO_ACTIVES_GROUP));
    assert(/WAS applied/.test(e.message) && /recalculation also failed/.test(e.message) && /may show values from before/.test(e.message), `recalc failed too: ${e.message}`);
    assert(session.undoStackDepth() === 1 && bridge.committedCount() === 1, 'committed');
    assert((await session.listSkillGroups())[TWO_ACTIVES_GROUP - 1].isMainGroup, 'the main group changed');
  }
  {
    const bridge = newBridge('applyChangesFailsMidway');
    const session = await primedSession(bridge);
    const base = await state(session);
    const e = await rejection(session.applyChanges({ config: { usePowerCharges: true }, gems: [{ op: 'remove', group: MAIN_GROUP, index: 1 }], items: [{ slot: 'Ring 1', itemText: RING }] }));
    assert(!(e instanceof UserError) && /failed part-way/.test(e.message) && !/WAS applied/.test(e.message), `rolled back: ${e.message}`);
    assert(session.undoStackDepth() === 0 && bridge.committedCount() === 0, 'nothing pushed or journaled');
    assertSame('rolled back after a failure part-way', await state(session), base);
  }
  log('PASS 5');
}

interface ToolText {
  type: 'text';
  text: string;
}

async function test6Mcp(): Promise<void> {
  log('Test 6: through the MCP server');
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'pob-build-edit-'));
  tempDirs.push(configDir);
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', path.resolve(testDir, '..', 'src', 'server.ts')],
    env: { ...process.env, POB_PATH: paths.pobPath, LUAJIT_PATH: paths.luajitPath, POB_MCP_CONFIG_DIR: configDir } as Record<string, string>,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'build-edit-test', version: '0.0.0' });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
    const r = (await client.callTool({ name, arguments: args })) as { content: ToolText[]; isError?: boolean };
    return { text: r.content[0].text, isError: r.isError === true };
  };
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    for (const name of ['apply_changes', 'create_socket_group', 'delete_socket_group', 'set_main_skill']) {
      const t = tools.find((x) => x.name === name);
      assert(t, `${name} is listed`);
      assert(t.annotations?.readOnlyHint === false && t.annotations?.destructiveHint === false, `${name}: undoable annotations`);
    }
    assert(!(await call('load_build', { source: occXml })).isError, 'load_build');
    const bridge = newBridge();
    const probeSession = new BuildSession(bridge);
    await probeSession.loadBuild(occXml);
    const notable = await twoPointNotable(bridge);
    const variant = { label: 'winner', allocate: [notable.id], gems: [{ op: 'set', group: MAIN_GROUP, index: 2, name: 'Elemental Focus' }] };
    const evaluated = JSON.parse((await call('evaluate_changes', { variants: [variant] })).text) as { results: Array<{ delta: Record<string, number> }> };
    const res = await call('apply_changes', { variant });
    assert(!res.isError && !res.text.includes('\n'), `apply_changes: ${res.text}`);
    const parsed = JSON.parse(res.text) as {
      status: string;
      label: string;
      added: Array<{ id: number }>;
      pointsUsed: number;
      points: { used: number; max: number; remaining: number };
      keyDeltas: Record<string, number>;
    };
    assert(parsed.status === 'applied' && parsed.label === 'winner' && parsed.pointsUsed === 2 && parsed.added[1].id === notable.id, `result: ${res.text}`);
    assert(roundStat(parsed.keyDeltas.CombinedDPS) === evaluated.results[0].delta.CombinedDPS, 'the committed DPS change is the evaluated one');
    const created = JSON.parse((await call('create_socket_group', { gems: [{ name: 'Fireball' }], setAsMain: true })).text) as { status: string; group: number; mainSkill: string };
    assert(created.status === 'created' && created.mainSkill === 'Fireball' && created.group > 0, `create: ${JSON.stringify(created)}`);
    const refused = await call('delete_socket_group', { group: GRANTED_GROUP });
    assert(refused.isError && /granted by/.test(refused.text) && !/Internal error/.test(refused.text), `refusal: ${refused.text}`);
    assert(!(await call('undo_last_change')).isError && !(await call('undo_last_change')).isError, 'undo both');
    const info = JSON.parse((await call('get_skill_breakdown')).text) as { activeGem: { nameSpec: string } };
    assert(info.activeGem.nameSpec === 'Vortex', 'undo_last_change reverts the main skill');
  } finally {
    await client.close();
  }
  log('PASS 6');
}

async function main(): Promise<void> {
  try {
    await test1Parity();
    await test2Refusals();
    await test3SocketGroups();
    await test4CrashReplay();
    await test5Faults();
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
