// Integration test for new_build, set_character_level and set_ascendancy.
//
// Session level (LuaBridge + BuildSession): blank builds for several classes,
// ascendancies and a bloodline; refusals that leave the loaded build (and its
// undo history) untouched; export code round trip; reset_build back to the
// blank build; the level and ascendancy edits with exact undo and crash
// replay. Then through the MCP server: new_build -> allocate_nodes ->
// create_socket_group -> build_item + swap_item -> stats -> export_build ->
// load_build, and get_engine_info.
//
// Node and bloodline names are those of PoB's 3.25+ trees (checked on 3_30).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BuildSession, EngineRestartedError } from '../src/build-session.js';
import { type BuildInfo, LuaBridge, type Stats } from '../src/lua-bridge.js';
import { TOOL_ANNOTATIONS } from '../src/tool-registry.js';
import { UserError } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

const log = (msg: string): void => console.log(`[new-build-test] ${msg}`);
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'src', 'server.ts');
const { paths, fixturePath } = setupTestEnv();
const occXml = readFileSync(fixturePath, 'utf8');
const bridges: LuaBridge[] = [];
const configDir = mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-new-build-'));

const RING = `Rarity: RARE
New Build Ring
Coral Ring
Item Level: 63
LevelReq: 64
Implicits: 1
+30 to maximum Life
+150 to maximum Life`;

type Info = BuildInfo & { secondaryAscendancy?: string };

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

async function refusedWith(label: string, p: Promise<unknown>, ...needles: RegExp[]): Promise<void> {
  const e = await rejection(p);
  assert(e instanceof UserError, `${label}: expected a UserError, got ${e.constructor.name}: ${e.message}`);
  for (const n of needles) assert(n.test(e.message), `${label}: "${e.message}" does not match ${n}`);
}

/** Node lists and the tree URL follow Lua table order; attributes are sorted per tag (as crash-recovery-test compares). */
function canonicalXml(xml: string): string {
  return xml
    .replace(/ nodes="([\d,]*)"/g, (_m, list: string) => ` nodes="${list.split(',').filter(Boolean).map(Number).sort((x, y) => x - y).join(',')}"`)
    .replace(/<URL>[\s\S]*?<\/URL>/g, '<URL/>')
    .split('\n')
    .map((line) =>
      line.replace(/<(\w+)((?:\s+\w+="[^"]*")+)\s*(\/?)>/g, (_m, tag: string, attrList: string, close: string) =>
        `<${tag} ${[...attrList.matchAll(/\w+="[^"]*"/g)].map((m) => m[0]).sort().join(' ')}${close}>`),
    )
    .join('\n');
}

interface State {
  info: Info;
  xml: string;
  stats: Pick<Stats, 'Life' | 'Mana' | 'CombinedDPS' | 'TotalEHP'>;
}

async function state(session: BuildSession): Promise<State> {
  const s = await session.getStats();
  return {
    info: (await session.getBuildInfo()) as Info,
    xml: await session.exportXML(),
    stats: { Life: s.Life, Mana: s.Mana, CombinedDPS: s.CombinedDPS, TotalEHP: s.TotalEHP },
  };
}

function assertSame(label: string, actual: State, expected: State): void {
  for (const k of ['class', 'ascendancy', 'secondaryAscendancy', 'level', 'treeVersion'] as const) {
    assert(actual.info[k] === expected.info[k], `${label}: ${k} ${actual.info[k]} != ${expected.info[k]}`);
  }
  for (const k of ['Life', 'Mana', 'CombinedDPS', 'TotalEHP'] as const) {
    assert(actual.stats[k] === expected.stats[k], `${label}: ${k} ${actual.stats[k]} != ${expected.stats[k]}`);
  }
  const a = canonicalXml(actual.xml);
  const e = canonicalXml(expected.xml);
  if (a !== e) {
    let i = 0;
    while (i < a.length && a[i] === e[i]) i++;
    throw new Error(`${label}: export differs at ${i}: ${JSON.stringify(a.slice(i - 80, i + 80))}\n  vs ${JSON.stringify(e.slice(i - 80, i + 80))}`);
  }
}

/** Kill the engine as a crash would; the next locked call restarts it and replays the committed changes. */
async function crashAndRestart(bridge: LuaBridge, session: BuildSession, label: string): Promise<void> {
  const pid = bridge.getPid();
  assert(pid !== undefined && bridge.isRunning(), `${label}: engine should be running`);
  process.kill(pid, 'SIGKILL');
  const end = Date.now() + 10_000;
  while (bridge.isRunning()) {
    if (Date.now() > end) throw new Error(`${label}: engine did not exit`);
    await new Promise((r) => setTimeout(r, 25));
  }
  const e = await rejection(session.getStats());
  assert(e instanceof EngineRestartedError && /build was restored/.test(e.message), `${label}: expected the restart notice, got ${e.message}`);
}

// ---------------------------------------------------------------------------

async function test1NewBuilds(session: BuildSession): Promise<void> {
  log('Test 1: new_build for several classes / ascendancies / a bloodline');
  const witch = (await session.newBuild({ className: 'witch', ascendancy: 'ELEMENTALIST', level: 90 })) as Info;
  const latest = witch.latestTreeVersion;
  assert(witch.class === 'Witch' && witch.ascendancy === 'Elementalist' && witch.level === 90, `witch: ${JSON.stringify(witch)}`);
  assert(witch.treeVersion === latest && witch.secondaryAscendancy === undefined, `witch tree: ${JSON.stringify(witch)}`);
  assert(session.undoStackDepth() === 0, 'a new build starts with no undo history');
  const witchStats = await session.getStats();
  assert((witchStats.Life ?? 0) > 0, 'a blank level 90 build has life');
  const allocated = (await session.getPassiveTree()).allocatedNodes;
  assert(allocated.every((n) => n.type === 'ClassStart' || n.type === 'AscendClassStart'), `only start nodes: ${JSON.stringify(allocated)}`);

  const marauder = (await session.newBuild({ className: 'Marauder' })) as Info;
  assert(marauder.class === 'Marauder' && marauder.ascendancy === 'None' && marauder.level === 1, `marauder: ${JSON.stringify(marauder)}`);

  // An ascendancy alone picks its class; a bloodline (3.25+ trees).
  const jugg = (await session.newBuild({ ascendancy: 'juggernaut', secondaryAscendancy: 'Aul', level: 70 })) as Info;
  assert(jugg.class === 'Marauder' && jugg.ascendancy === 'Juggernaut' && jugg.secondaryAscendancy === 'Aul Bloodline' && jugg.level === 70,
    `juggernaut: ${JSON.stringify(jugg)}`);
  const exported = await session.exportXML();
  assert(/secondaryAscendClassId="[1-9]/.test(exported), 'the export keeps the bloodline');

  const older = (await session.newBuild({ className: 'Ranger', ascendancy: 'Deadeye', treeVersion: '3.28' })) as Info;
  assert(older.treeVersion === '3_28' && older.ascendancy === 'Deadeye', `older tree: ${JSON.stringify(older)}`);
  log('PASS 1');
}

async function test2Refusals(session: BuildSession): Promise<void> {
  log('Test 2: invalid names are refused, the loaded build and its undo history untouched');
  await session.loadBuild(occXml);
  await session.swapItemWithDiff('Ring 1', RING);
  const before = await state(session);
  await refusedWith('class', session.newBuild({ className: 'Wizard' }), /Unknown class 'Wizard'/, /Witch \(Occultist, Elementalist, Necromancer\)/);
  await refusedWith('ascendancy', session.newBuild({ className: 'Witch', ascendancy: 'Nope' }), /Unknown ascendancy/, /Marauder \(Juggernaut/);
  await refusedWith('other class', session.newBuild({ className: 'Witch', ascendancy: 'Juggernaut' }), /Juggernaut is a Marauder ascendancy/);
  await refusedWith('bloodline', session.newBuild({ className: 'Witch', secondaryAscendancy: 'Nope' }), /Unknown secondary ascendancy/, /Aul Bloodline/);
  await refusedWith('no bloodlines', session.newBuild({ className: 'Witch', secondaryAscendancy: 'Aul', treeVersion: '3_20' }), /no secondary ascendancies/);
  await refusedWith('tree', session.newBuild({ className: 'Witch', treeVersion: '9_99' }), /Unknown passive tree version/, /3_28/);
  await refusedWith('no class', session.newBuild({ level: 10 }), /Pass className/);
  await refusedWith('level', session.newBuild({ className: 'Witch', level: 101 }), /level must be/);
  assertSame('after the refusals', await state(session), before);
  assert(session.undoStackDepth() === 1, 'the undo history is kept');
  log('PASS 2');
}

async function test3RoundTripAndReset(session: BuildSession): Promise<void> {
  log('Test 3: export code round trip; reset_build returns to the blank build');
  await session.newBuild({ className: 'Templar', ascendancy: 'Inquisitor', secondaryAscendancy: 'Catarina Bloodline', level: 85 });
  const blank = await state(session);
  const code = await session.exportBuild('code');
  const reloaded = (await session.loadBuild(code)) as Info;
  assert(reloaded.class === 'Templar' && reloaded.ascendancy === 'Inquisitor' && reloaded.secondaryAscendancy === 'Catarina Bloodline',
    `reloaded: ${JSON.stringify(reloaded)}`);
  // PoB's first save/load of a build is not byte-idempotent (it adds TimelessData
  // defaults), so the first trip keeps info and stats and the second the whole export.
  const once = await state(session);
  assertSame('code round trip (info, stats)', { ...once, xml: blank.xml }, blank);
  await session.loadBuild(await session.exportBuild('code'));
  assertSame('code round trip', await state(session), once);

  await session.newBuild({ className: 'Templar', ascendancy: 'Inquisitor', secondaryAscendancy: 'Catarina Bloodline', level: 85 });
  const reach = (await session.getReachableNodes()).filter((n) => !n.isJewelSocket).slice(0, 2).map((n) => n.id);
  await session.allocateNodes(reach);
  await session.setCharacterLevel(40);
  await session.setAscendancy({ ascendancy: 'Hierophant' });
  await session.swapItemWithDiff('Ring 1', RING);
  const info = (await session.resetBuild()) as Info;
  assert(info.level === 85 && info.ascendancy === 'Inquisitor', `reset: ${JSON.stringify(info)}`);
  assertSame('reset_build', await state(session), blank);
  log('PASS 3');
}

async function test4Level(bridge: LuaBridge, session: BuildSession): Promise<void> {
  log('Test 4: set_character_level: Life as PoB computes it, undo exact, crash replay');
  await session.newBuild({ className: 'Duelist', ascendancy: 'Slayer', level: 90 });
  const at90 = (await session.getStats()).Life;
  await session.newBuild({ className: 'Duelist', ascendancy: 'Slayer', level: 1 });
  await session.allocateNodes((await session.getReachableNodes()).filter((n) => !n.isJewelSocket).slice(0, 2).map((n) => n.id));
  const base = await state(session);
  const res = await session.setCharacterLevel(90);
  assert(res.previous.level === 1 && !res.previous.autoMode && res.level === 90, `result: ${JSON.stringify(res.previous)}`);
  assert(res.diff.Life && (res.after.Life ?? 0) > (res.before.Life ?? 0), 'Life rises with the level');
  await session.undoLastChange();
  assertSame('undo set_character_level', await state(session), base);
  await session.setCharacterLevel(90);
  const set = await state(session);
  assert(set.info.level === 90 && set.stats.Life !== base.stats.Life, `level 90: ${JSON.stringify(set.info)}`);
  const unchanged = await session.setCharacterLevel(90);
  assert(unchanged.unchanged === true && session.undoStackDepth() === 2, 'the same level is unchanged and pushes nothing');
  await crashAndRestart(bridge, session, 'set_character_level');
  assertSame('replayed set_character_level', await state(session), set);

  // The same Life as a build PoB creates at that level.
  await session.newBuild({ className: 'Duelist', ascendancy: 'Slayer', level: 1 });
  await session.setCharacterLevel(90);
  assert((await session.getStats()).Life === at90, `Life at 90: ${(await session.getStats()).Life} != ${at90} (new_build at 90)`);
  log('PASS 4');
}

async function test5Ascendancy(bridge: LuaBridge, session: BuildSession): Promise<void> {
  log('Test 5: set_ascendancy: old ascendancy passives removed, undo exact, crash replay, refusals');
  await session.newBuild({ className: 'Witch', ascendancy: 'Elementalist', level: 90 });
  await session.allocateNodes(['Shaper of Flames']);
  await session.allocateNodes((await session.getReachableNodes()).filter((n) => !n.isJewelSocket).slice(0, 3).map((n) => n.id));
  const base = await state(session);
  const res = await session.setAscendancy({ ascendancy: 'necromancer' });
  assert(res.from.ascendancy === 'Elementalist' && res.to.ascendancy === 'Necromancer' && res.to.className === 'Witch', `switch: ${JSON.stringify(res.to)}`);
  assert(res.removed.some((n) => n.name === 'Shaper of Flames') && res.removed.every((n) => n.ascendancyName === 'Elementalist'),
    `removed: ${JSON.stringify(res.removed)}`);
  assert(res.summary.ascendancyPoints === 0 && res.summary.totalPoints > 0 && res.removed.every((n) => n.pointCost !== 'passive'),
    `only ascendancy points are refunded: ${JSON.stringify(res.summary)}`);
  const switched = await state(session);
  assert(switched.info.ascendancy === 'Necromancer', 'build info follows');
  await session.undoLastChange();
  assertSame('undo set_ascendancy', await state(session), base);
  assert((await session.getBuildInfo()).ascendancy === 'Elementalist', 'undo restores the build info');

  await session.setAscendancy({ ascendancy: 'Necromancer' });
  assert((await session.setAscendancy({ ascendancy: 'Necromancer' })).unchanged === true && session.undoStackDepth() === 3, 'unchanged pushes nothing');
  await session.setAscendancy({ secondaryAscendancy: 'Oshabi Bloodline' });
  const committed = await state(session);
  assert(committed.info.secondaryAscendancy === 'Oshabi Bloodline', `bloodline: ${JSON.stringify(committed.info)}`);
  await crashAndRestart(bridge, session, 'set_ascendancy');
  assertSame('replayed set_ascendancy', await state(session), committed);

  const depth = session.undoStackDepth();
  await refusedWith('other class', session.setAscendancy({ ascendancy: 'Juggernaut' }), /Marauder ascendancy/, /className/);
  await refusedWith('mismatch', session.setAscendancy({ className: 'Witch', ascendancy: 'Juggernaut' }), /not a Witch one/);
  await refusedWith('unknown', session.setAscendancy({ ascendancy: 'Nope' }), /Unknown ascendancy/);
  await refusedWith('nothing', session.setAscendancy({}), /Pass ascendancy/);
  await refusedWith('class change', session.setAscendancy({ className: 'Marauder' }), /would reset the passive tree/, /allowTreeReset/);
  assertSame('after the refusals', await state(session), committed);
  assert(session.undoStackDepth() === depth, 'refusals push nothing');

  // PoB's Continue: the class changes and passives that no longer connect go.
  const reset = await session.setAscendancy({ className: 'Marauder', ascendancy: 'Berserker', allowTreeReset: true });
  assert(reset.to.className === 'Marauder' && reset.to.ascendancy === 'Berserker' && reset.to.secondaryAscendancy === 'Oshabi Bloodline',
    `class change: ${JSON.stringify(reset.to)}`);
  assert(reset.summary.totalPoints === 0 && reset.removed.length > 0, `class change removed: ${JSON.stringify(reset.removed)}`);
  await session.undoLastChange();
  assertSame('undo the class change', await state(session), committed);

  // A class change on an empty tree needs no reset (PoB does not ask).
  await session.newBuild({ className: 'Shadow' });
  const empty = await session.setAscendancy({ className: 'Ranger', ascendancy: 'Pathfinder' });
  assert(empty.to.className === 'Ranger' && empty.to.ascendancy === 'Pathfinder', `empty tree: ${JSON.stringify(empty.to)}`);
  log('PASS 5');
}

// ---------------------------------------------------------------------------

interface ToolResult {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function test6Mcp(reachableWitch: number[]): Promise<void> {
  log('Test 6: end to end through the MCP server');
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverPath],
    env: { ...process.env, POB_PATH: paths.pobPath, LUAJIT_PATH: paths.luajitPath, POB_MCP_CONFIG_DIR: configDir } as Record<string, string>,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'pob-mcp-new-build-test', version: '0.0.0' });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> => {
    const r = (await client.callTool({ name, arguments: args })) as ToolResult;
    const text = r.content?.[0]?.text ?? '';
    if (r.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text) as Record<string, any>;
  };
  try {
    const tools = (await client.listTools()).tools;
    for (const name of ['new_build', 'set_character_level', 'set_ascendancy']) {
      assert(tools.some((t) => t.name === name) && TOOL_ANNOTATIONS[name], `${name} registered and annotated`);
    }
    assert(tools.find((t) => t.name === 'new_build')?.annotations?.destructiveHint === true, 'new_build is destructive like load_build');

    const created = await call('new_build', { className: 'Witch', ascendancy: 'Elementalist', level: 90 });
    assert(created.status === 'created' && created.class === 'Witch' && created.level === 90, `new_build: ${JSON.stringify(created)}`);
    const engineInfo = await call('get_engine_info');
    assert(engineInfo.build?.class === 'Witch' && engineInfo.build?.ascendancy === 'Elementalist' && engineInfo.build?.level === 90,
      `get_engine_info: ${JSON.stringify(engineInfo.build)}`);
    const blankLife = (await call('get_stats', { stats: ['Life'] })).stats.Life as number;

    const alloc = await call('allocate_nodes', { nodes: [...reachableWitch.slice(0, 3), 'Shaper of Flames'] });
    assert(alloc.status === 'allocated', `allocate_nodes: ${JSON.stringify(alloc).slice(0, 300)}`);
    const group = await call('create_socket_group', { gems: [{ name: 'Fireball' }, { name: 'Spell Echo' }], setAsMain: true });
    assert(group.status === 'created', `create_socket_group: ${JSON.stringify(group).slice(0, 300)}`);
    const item = await call('build_item', { base: 'Vaal Regalia', mods: ['+110 to maximum Life'], crafted: ['+20% to Fire Resistance'] });
    await call('swap_item', { slot: 'Body Armour', itemText: item.text });
    const stats = (await call('get_stats', { stats: ['Life', 'CombinedDPS', 'EnergyShield'] })).stats as Record<string, number>;
    assert(stats.Life > blankLife && stats.CombinedDPS > 0 && stats.EnergyShield > 0, `stats: ${JSON.stringify(stats)} (blank life ${blankLife})`);

    const level = await call('set_character_level', { level: 95 });
    assert(level.status === 'set' && level.previousLevel === 90 && level.keyDeltas, `set_character_level: ${JSON.stringify(level).slice(0, 300)}`);
    const asc = await call('set_ascendancy', { ascendancy: 'Occultist' });
    assert(asc.status === 'changed' && asc.to.ascendancy === 'Occultist' && asc.ascendancyPointsRefunded >= 1 && asc.undo,
      `set_ascendancy: ${JSON.stringify(asc).slice(0, 400)}`);
    const refused = (await client.callTool({ name: 'set_ascendancy', arguments: { ascendancy: 'Slayer' } })) as ToolResult;
    assert(refused.isError && /Duelist ascendancy/.test(refused.content?.[0]?.text ?? '') && !/Internal error/.test(refused.content?.[0]?.text ?? ''),
      `refusal is a user error: ${JSON.stringify(refused)}`);

    const finalStats = (await call('get_stats', { stats: ['Life', 'CombinedDPS'] })).stats as Record<string, number>;
    const code = (await client.callTool({ name: 'export_build', arguments: { format: 'code' } })) as ToolResult;
    const codeText = code.content?.[0]?.text ?? '';
    const parsed = (() => {
      try {
        return JSON.parse(codeText) as { code?: string };
      } catch {
        return { code: codeText };
      }
    })();
    const loaded = await call('load_build', { source: parsed.code ?? codeText });
    assert(loaded.class === 'Witch' && loaded.ascendancy === 'Occultist' && loaded.level === 95, `reloaded: ${JSON.stringify(loaded)}`);
    const reloadedStats = (await call('get_stats', { stats: ['Life', 'CombinedDPS'] })).stats as Record<string, number>;
    assert(reloadedStats.Life === finalStats.Life && reloadedStats.CombinedDPS === finalStats.CombinedDPS,
      `export round trip: ${JSON.stringify(reloadedStats)} != ${JSON.stringify(finalStats)}`);

    const bad = (await client.callTool({ name: 'new_build', arguments: { className: 'Wizard' } })) as ToolResult;
    assert(bad.isError && /Unknown class/.test(bad.content?.[0]?.text ?? ''), 'new_build refusal through MCP');
    assert((await call('get_engine_info')).build?.ascendancy === 'Occultist', 'the refused new_build left the build loaded');
  } finally {
    await client.close().catch(() => undefined);
  }
  log('PASS 6');
}

async function main(): Promise<void> {
  const bridge = newBridge();
  const session = new BuildSession(bridge);
  let reachableWitch: number[] = [];
  try {
    await test1NewBuilds(session);
    await test2Refusals(session);
    await test3RoundTripAndReset(session);
    await test4Level(bridge, session);
    await test5Ascendancy(bridge, session);
    await session.newBuild({ className: 'Witch', ascendancy: 'Elementalist', level: 90 });
    reachableWitch = (await session.getReachableNodes()).filter((n) => !n.isJewelSocket).map((n) => n.id);
  } finally {
    for (const b of bridges) await b.dispose().catch(() => undefined);
  }
  await test6Mcp(reachableWitch);
  rmSync(configDir, { recursive: true, force: true });
  log('ALL NEW BUILD TESTS PASSED');
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error('FAIL:', err instanceof Error ? err.stack ?? err.message : err);
    for (const b of bridges) b.forceKill();
    rmSync(configDir, { recursive: true, force: true });
    process.exit(1);
  },
);
