// Integration test for convert_tree_to_latest: OccVortex.xml is saved on tree
// 3_13, so it is converted to the engine's latest tree, undone, reconverted,
// exported and reloaded, and reset.
//
// ConvertTreeMasteries.xml was produced through the engine from OccVortex
// (PoB's own convert, AllocNode pathing, RestoreUndoState and SaveDB; never
// hand-edited). It has two specs:
//   1 (active): tree 3_24, mastery selections {12382,47642} and {12125,34242}
//     (both still offered on those nodes in 3_29), {38921,41322} (Block
//     Mastery: effect 41322 no longer exists in 3_29) and {2841,64381} (Life
//     Mastery: 3_29 offers 64381 only on other nodes, so PoB keeps the
//     selection but the node no longer offers it), and the tattoo
//     "Tattoo of the Arohongui Makanga" on node 1031.
//   2: PoB "Copy + Convert" of spec 1 onto 3_28_alternate with secondary
//     ascendancy 4 (Chaos Bloodline), which 3_29 has no alternate tree for.
//
// The latest tree version is read from the running engine. The notes above
// describe tree 3_29 (FIXTURE_DATA_VERSION); assertions that depend on that
// tree's data run only when it is the latest and otherwise print why they
// were skipped. Everything else is checked on any latest tree.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BuildInfo, LuaBridge } from '../src/lua-bridge.js';
import { ResolvedPaths } from '../src/paths.js';
import { setupTestEnv } from './_skip.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'src', 'server.ts');
const FIXTURE_TREE_VERSION = '3_13';
const MASTERY_FIXTURE = path.resolve(testDir, 'fixtures', 'ConvertTreeMasteries.xml');
const GONE_MASTERY = { nodeId: 38921, effectId: 41322 };
const MOVED_MASTERY = { nodeId: 2841, effectId: 64381 };
const TATTOO = '1031=Tattoo of the Arohongui Makanga';
/** Tree whose data the mastery/bloodline expectations below were checked against. */
const FIXTURE_DATA_VERSION = '3_29';

const RING = `Rarity: RARE
Convert Test Ring
Coral Ring
Item Level: 63
LevelReq: 64
Implicits: 1
+30 to maximum Life
+150 to maximum Life
+50 to maximum Mana
+30% to all Elemental Resistances`;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface ToolTextContent {
  type: 'text';
  text: string;
}

function extractText(result: unknown): string {
  const r = result as { content?: ToolTextContent[]; isError?: boolean };
  if (r.isError) {
    throw new Error(`Tool returned error: ${r.content?.[0]?.text ?? 'unknown'}`);
  }
  return r.content?.[0]?.text ?? '';
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return client.callTool({ name, arguments: args });
}

async function callJson<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  return JSON.parse(extractText(await call(client, name, args))) as T;
}

/** latestTreeVersion as reported by a running engine (bridge getBuildInfo). */
async function engineLatestTreeVersion(paths: ResolvedPaths, xml: string): Promise<string> {
  const bridge = new LuaBridge(paths, 60_000);
  try {
    await bridge.loadBuildXML(xml);
    const { info } = await bridge.send<{ info: BuildInfo }>({ cmd: 'getBuildInfo' });
    assert(typeof info.latestTreeVersion === 'string' && info.latestTreeVersion.length > 0, 'engine reported no latestTreeVersion');
    return info.latestTreeVersion;
  } finally {
    await bridge.shutdown().catch(() => undefined);
  }
}

interface SpecInfo {
  specCount: number;
  activeSpec: string;
  title: string;
  treeVersion: string;
  classId: string;
  ascendClassId: string;
  secondaryAscendClassId: string;
  nodes: string;
  masteryEffects: string;
  sockets: string;
  overrides: string;
  /** The other specs, which a convert must leave untouched. */
  inactive: string;
}

function attr(tag: string, name: string): string {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? '';
}

function sortedList(raw: string, re: RegExp): string {
  return [...raw.matchAll(re)].map((m) => m[0]).sort().join(',');
}

function parseOneSpec(specTag: string, body: string): Omit<SpecInfo, 'specCount' | 'activeSpec' | 'inactive'> {
  const sockets = [...body.matchAll(/<Socket\b([^>]*)\/>/g)]
    .map((m) => `${attr(m[1], 'nodeId')}=${attr(m[1], 'itemId')}`)
    .filter((s) => !s.endsWith('=0'))
    .sort()
    .join(',');
  const overrides = [...body.matchAll(/<Override\b([^>]*)>/g)]
    .map((m) => `${attr(m[1], 'nodeId')}=${attr(m[1], 'dn')}`)
    .sort()
    .join(',');
  return {
    title: attr(specTag, 'title'),
    treeVersion: attr(specTag, 'treeVersion'),
    classId: attr(specTag, 'classId'),
    ascendClassId: attr(specTag, 'ascendClassId'),
    secondaryAscendClassId: attr(specTag, 'secondaryAscendClassId'),
    nodes: sortedList(attr(specTag, 'nodes'), /\d+/g),
    masteryEffects: sortedList(attr(specTag, 'masteryEffects'), /\{\d+,\d+\}/g),
    sockets,
    overrides,
  };
}

/** The active <Spec> of an exported build, with lists normalised to sorted order. */
function parseSpec(xml: string): SpecInfo {
  const tree = /<Tree\b([^>]*)>([\s\S]*?)<\/Tree>/.exec(xml);
  assert(tree, 'exported XML has no <Tree> element');
  const activeSpec = attr(tree[1], 'activeSpec') || '1';
  const specs = [...tree[2].matchAll(/<Spec\b([^>]*)>([\s\S]*?)<\/Spec>/g)];
  assert(specs.length > 0, 'exported XML has no <Spec> element');
  const active = Number(activeSpec) - 1;
  const inactive = specs.filter((_, i) => i !== active).map((m) => parseOneSpec(m[1], m[2]));
  return {
    specCount: specs.length,
    activeSpec,
    ...parseOneSpec(specs[active][1], specs[active][2]),
    inactive: JSON.stringify(inactive),
  };
}

interface TreeState {
  spec: SpecInfo;
  nodeIds: number[];
  className: string;
  ascendClassName: string;
  stats: { Life: number; CombinedDPS: number; TotalEHP: number };
}

async function treeState(client: Client): Promise<TreeState> {
  const xml = extractText(await call(client, 'export_build', { format: 'xml' }));
  const tree = await callJson<{
    allocatedNodes: Array<{ id: number }>;
    summary: { className: string; ascendClassName: string };
  }>(client, 'get_passive_tree');
  const stats = await callJson<Record<string, Record<string, number>>>(client, 'get_stats');
  return {
    spec: parseSpec(xml),
    nodeIds: tree.allocatedNodes.map((n) => n.id).sort((a, b) => a - b),
    className: tree.summary.className,
    ascendClassName: tree.summary.ascendClassName,
    stats: {
      Life: stats.defense?.Life ?? 0,
      CombinedDPS: stats.offense?.CombinedDPS ?? 0,
      TotalEHP: stats.defense?.TotalEHP ?? 0,
    },
  };
}

function assertSameState(actual: TreeState, expected: TreeState, label: string): void {
  assert(
    JSON.stringify(actual.spec) === JSON.stringify(expected.spec),
    `${label}: spec differs\n  expected ${JSON.stringify(expected.spec)}\n  actual   ${JSON.stringify(actual.spec)}`,
  );
  assert(
    JSON.stringify(actual.nodeIds) === JSON.stringify(expected.nodeIds),
    `${label}: allocated node set differs (${actual.nodeIds.length} vs ${expected.nodeIds.length})`,
  );
  assert(actual.className === expected.className, `${label}: class ${actual.className} != ${expected.className}`);
  assert(
    actual.ascendClassName === expected.ascendClassName,
    `${label}: ascendancy ${actual.ascendClassName} != ${expected.ascendClassName}`,
  );
  for (const key of ['Life', 'CombinedDPS', 'TotalEHP'] as const) {
    assert(
      actual.stats[key] === expected.stats[key],
      `${label}: ${key} not bit-exact (${actual.stats[key]} != ${expected.stats[key]})`,
    );
  }
}

interface ConvertResult {
  status: string;
  treeVersion?: string;
  fromVersion?: string;
  toVersion?: string;
  allocatedBefore?: number;
  allocatedAfter?: number;
  lostNodeCount?: number;
  lostNodes?: Array<{ id: number; name?: string }>;
  lostNodesOmitted?: number;
  changedNodes?: unknown[];
  droppedMasteryCount?: number;
  droppedMasteries?: Array<{ nodeId: number; name?: string; effectId: number; effect?: string }>;
  droppedMasteriesOmitted?: number;
  droppedTattooCount?: number;
  droppedTattoos?: Array<{ nodeId: number; name: string }>;
  droppedTattoosOmitted?: number;
  keyDeltas?: Record<string, number>;
}

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const xml = readFileSync(fixturePath, 'utf8');
  const latest = await engineLatestTreeVersion(paths, xml);
  assert(latest !== FIXTURE_TREE_VERSION, `engine latest tree is the fixture's own version ${latest}`);
  log(`Engine latest tree: ${latest}`);
  /** Run a check that depends on FIXTURE_DATA_VERSION's tree data; skip it, saying why, on any other tree. */
  const onFixtureData = (what: string, check: () => void): void => {
    if (latest === FIXTURE_DATA_VERSION) {
      check();
    } else {
      log(`SKIP (latest tree is ${latest}, expectation written for ${FIXTURE_DATA_VERSION}): ${what}`);
    }
  };
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-convert-'));
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverPath],
    env: {
      ...process.env,
      POB_PATH: paths.pobPath,
      LUAJIT_PATH: paths.luajitPath,
      POB_MCP_CONFIG_DIR: configDir,
    } as Record<string, string>,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'convert-tree-test', version: '0.0.0' });

  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert(tools.includes('convert_tree_to_latest'), 'convert_tree_to_latest is not registered');
    log('PASS: convert_tree_to_latest registered');

    // No build loaded → the usual user error.
    const noBuild = (await call(client, 'convert_tree_to_latest')) as { isError?: boolean; content?: ToolTextContent[] };
    assert(noBuild.isError === true, 'convert without a build should be an error');
    assert(/No build loaded/.test(noBuild.content?.[0]?.text ?? ''), `unexpected no-build error: ${noBuild.content?.[0]?.text}`);
    log('PASS: no build loaded → user error');

    await call(client, 'load_build', { source: xml });
    const original = await treeState(client);
    assert(original.spec.treeVersion === FIXTURE_TREE_VERSION, `fixture loaded on ${original.spec.treeVersion}`);
    assert(original.spec.specCount === 1, `fixture should have one spec, has ${original.spec.specCount}`);
    log(`Original: tree ${original.spec.treeVersion}, ${original.nodeIds.length} nodes, Life=${original.stats.Life}, DPS=${original.stats.CombinedDPS}, EHP=${original.stats.TotalEHP}`);

    // 1. Convert 3_13 → latest; check result fields.
    const converted = await callJson<ConvertResult>(client, 'convert_tree_to_latest');
    assert(converted.status === 'converted', `expected converted, got ${converted.status}`);
    assert(converted.fromVersion === FIXTURE_TREE_VERSION, `fromVersion ${converted.fromVersion}`);
    assert(converted.toVersion === latest, `toVersion ${converted.toVersion} != engine latest ${latest}`);
    assert(converted.allocatedBefore === original.nodeIds.length, `allocatedBefore ${converted.allocatedBefore} != ${original.nodeIds.length}`);
    assert(typeof converted.allocatedAfter === 'number', 'allocatedAfter missing');
    assert(Array.isArray(converted.lostNodes), 'lostNodes missing');
    assert(Array.isArray(converted.changedNodes), 'changedNodes missing');
    assert(Array.isArray(converted.droppedMasteries), 'droppedMasteries missing');
    assert(converted.lostNodes.length <= 50, 'lostNodes is not capped');
    assert(
      converted.lostNodes.length + (converted.lostNodesOmitted ?? 0) === converted.lostNodeCount,
      'lostNodes + omitted != lostNodeCount',
    );
    assert(converted.keyDeltas && typeof converted.keyDeltas.Life === 'number', 'keyDeltas missing');

    const afterConvert = await treeState(client);
    assert(afterConvert.spec.treeVersion === latest, `after convert tree is ${afterConvert.spec.treeVersion}`);
    assert(afterConvert.spec.specCount === 1, `convert left ${afterConvert.spec.specCount} specs`);
    assert(converted.allocatedAfter === afterConvert.nodeIds.length, `allocatedAfter ${converted.allocatedAfter} != ${afterConvert.nodeIds.length}`);
    const afterSet = new Set(afterConvert.nodeIds);
    const expectedLost = original.nodeIds.filter((id) => !afterSet.has(id));
    assert(expectedLost.length === converted.lostNodeCount, `lostNodeCount ${converted.lostNodeCount} != ${expectedLost.length}`);
    for (const n of converted.lostNodes) {
      assert(expectedLost.includes(n.id), `reported lost node ${n.id} is still allocated or was never allocated`);
      assert(typeof n.name === 'string' && n.name.length > 0, `lost node ${n.id} has no name`);
    }
    assert(afterConvert.className === original.className, 'class changed on convert');
    assert(afterConvert.ascendClassName === original.ascendClassName, 'ascendancy changed on convert');
    log(`PASS: converted ${converted.fromVersion} → ${converted.toVersion}: ${converted.allocatedBefore} → ${converted.allocatedAfter} nodes, ${converted.lostNodeCount} lost, ${converted.droppedMasteryCount} masteries dropped`);

    // 2. Undo restores version, node set, masteries, class and stats bit-exact.
    await call(client, 'undo_last_change');
    assertSameState(await treeState(client), original, 'after undo');
    log('PASS: undo restores tree version, nodes, masteries, jewels, class and stats bit-exact');

    // 3. Convert again → export code → load_build round-trip stays on latest.
    const again = await callJson<ConvertResult>(client, 'convert_tree_to_latest');
    assert(again.status === 'converted' && again.toVersion === latest, `second convert: ${JSON.stringify(again).slice(0, 200)}`);
    const reconverted = await treeState(client);
    assert(
      JSON.stringify(reconverted.nodeIds) === JSON.stringify(afterConvert.nodeIds),
      'convert after undo produced a different node set',
    );
    const code = extractText(await call(client, 'export_build', { format: 'code' }));
    await call(client, 'load_build', { source: code });
    const reloaded = await treeState(client);
    assert(reloaded.spec.treeVersion === latest, `reloaded build is on ${reloaded.spec.treeVersion}`);
    assert(reloaded.spec.specCount === 1, `reloaded build has ${reloaded.spec.specCount} specs`);
    assert(
      JSON.stringify(reloaded.nodeIds) === JSON.stringify(reconverted.nodeIds),
      'export/load round-trip changed the converted node set',
    );
    log('PASS: export code → load_build keeps the latest tree and the converted nodes');

    // 4. Already latest → no-op, nothing pushed to the undo stack.
    const noop = await callJson<ConvertResult>(client, 'convert_tree_to_latest');
    assert(noop.status === 'already-latest', `expected already-latest, got ${noop.status}`);
    assert(noop.treeVersion === latest, `no-op treeVersion ${noop.treeVersion}`);
    const undoEmpty = (await call(client, 'undo_last_change')) as { isError?: boolean; content?: ToolTextContent[] };
    assert(undoEmpty.isError === true, 'no-op convert pushed an undo entry');
    assert(/undo stack is empty/.test(undoEmpty.content?.[0]?.text ?? ''), `unexpected undo error: ${undoEmpty.content?.[0]?.text}`);
    log('PASS: already-latest convert is a no-op with no undo entry');

    // 5. reset_build after convert returns to the original tree.
    await call(client, 'load_build', { source: xml });
    await callJson<ConvertResult>(client, 'convert_tree_to_latest');
    await call(client, 'reset_build');
    assertSameState(await treeState(client), original, 'after reset_build');
    log('PASS: reset_build after convert returns to the original tree');

    // 6. Undo of a convert interleaves correctly with other undo entries.
    await callJson<ConvertResult>(client, 'convert_tree_to_latest');
    await call(client, 'set_config', { options: { enemyIsBoss: 'Pinnacle' } });
    await call(client, 'undo_last_change');
    const stillLatest = await treeState(client);
    assert(stillLatest.spec.treeVersion === latest, 'undoing set_config changed the tree version');
    await call(client, 'undo_last_change');
    assertSameState(await treeState(client), original, 'after config + convert undo');
    log('PASS: convert undo interleaves with a config undo entry');

    // 7. swap_item -> convert -> undo x2: each undo restores its own layer.
    await call(client, 'load_build', { source: xml });
    await call(client, 'swap_item', { slot: 'Ring 1', itemText: RING });
    const afterSwap = await treeState(client);
    assert(afterSwap.stats.Life !== original.stats.Life, 'test ring did not change Life');
    await callJson<ConvertResult>(client, 'convert_tree_to_latest');
    assert((await treeState(client)).spec.treeVersion === latest, 'convert after swap did not reach latest');
    await call(client, 'undo_last_change');
    assertSameState(await treeState(client), afterSwap, 'after undoing convert (ring still equipped)');
    await call(client, 'undo_last_change');
    assertSameState(await treeState(client), original, 'after undoing swap_item');
    log('PASS: swap_item -> convert -> undo x2 restores each layer bit-exact');

    // 8. Masteries + tattoo on 3_24 (fixture spec 1).
    const masteryXml = readFileSync(MASTERY_FIXTURE, 'utf8');
    await call(client, 'load_build', { source: masteryXml });
    const m0 = await treeState(client);
    assert(m0.spec.treeVersion === '3_24', `mastery fixture loaded on ${m0.spec.treeVersion}`);
    assert(m0.spec.specCount === 2, `mastery fixture has ${m0.spec.specCount} specs`);
    const key = (m: { nodeId: number; effectId: number }): string => `{${m.nodeId},${m.effectId}}`;
    const origMasteries = m0.spec.masteryEffects.match(/\{\d+,\d+\}/g) ?? [];
    assert(
      origMasteries.length === 4 && origMasteries.includes(key(GONE_MASTERY)) && origMasteries.includes(key(MOVED_MASTERY)),
      `fixture masteries: ${m0.spec.masteryEffects}`,
    );
    assert(m0.spec.overrides === TATTOO, `fixture tattoo: ${m0.spec.overrides}`);
    const mc = await callJson<ConvertResult>(client, 'convert_tree_to_latest');
    assert(mc.status === 'converted' && mc.fromVersion === '3_24' && mc.toVersion === latest, `mastery convert: ${mc.fromVersion} -> ${mc.toVersion}`);
    const dropped = mc.droppedMasteries ?? [];
    assert(mc.droppedMasteryCount === dropped.length + (mc.droppedMasteriesOmitted ?? 0), 'droppedMasteryCount mismatch');
    for (const d of dropped) {
      assert(origMasteries.includes(key(d)), `reported dropped ${key(d)} was not a fixture selection`);
      assert(typeof d.name === 'string' && typeof d.effect === 'string', `${key(d)} lacks name/effect text`);
    }
    onFixtureData(`${key(GONE_MASTERY)} and ${key(MOVED_MASTERY)} are exactly the dropped masteries`, () => {
      for (const want of [GONE_MASTERY, MOVED_MASTERY]) {
        const reported = dropped.find((d) => d.nodeId === want.nodeId);
        assert(reported && reported.effectId === want.effectId, `${key(want)} not reported dropped: ${JSON.stringify(dropped)}`);
      }
      assert(dropped.length === 2, `expected exactly the 2 fixture masteries dropped, got ${JSON.stringify(dropped)}`);
    });
    const m1 = await treeState(client);
    const afterMasteries: string[] = m1.spec.masteryEffects.match(/\{\d+,\d+\}/g) ?? [];
    const droppedKeys = new Set(dropped.map((d) => `{${d.nodeId},${d.effectId}}`));
    // PoB itself keeps the moved selection (its effect exists elsewhere on 3_29),
    // which is why the report has to check the node's own offer list.
    onFixtureData(`PoB keeps the moved selection ${key(MOVED_MASTERY)} and drops ${key(GONE_MASTERY)}`, () => {
      assert(afterMasteries.includes(key(MOVED_MASTERY)), `PoB no longer keeps ${key(MOVED_MASTERY)}; fixture assumption broken`);
      assert(!afterMasteries.includes(key(GONE_MASTERY)), `${key(GONE_MASTERY)} survived the convert`);
    });
    for (const sel of origMasteries) {
      if (!droppedKeys.has(sel)) {
        assert(afterMasteries.includes(sel), `mastery ${sel} not reported dropped but missing after convert`);
      }
    }
    // The tattoo is either kept or reported dropped (and then really gone).
    const droppedTattoos = mc.droppedTattoos ?? [];
    assert((mc.droppedTattooCount ?? -1) === droppedTattoos.length + (mc.droppedTattoosOmitted ?? 0), 'droppedTattooCount mismatch');
    if (droppedTattoos.length === 0) {
      assert(m1.spec.overrides === TATTOO, `tattoo after convert: ${m1.spec.overrides}`);
    } else {
      assert(
        droppedTattoos.length === 1 && `${droppedTattoos[0].nodeId}=${droppedTattoos[0].name}` === TATTOO,
        `tattoo dropped: ${JSON.stringify(droppedTattoos)}`,
      );
      assert(m1.spec.overrides === '', `tattoo reported dropped but still present: ${m1.spec.overrides}`);
    }
    onFixtureData('the tattoo exists on the latest tree and is kept', () => {
      assert(droppedTattoos.length === 0, `tattoo dropped: ${JSON.stringify(droppedTattoos)}`);
    });
    assert(m1.spec.specCount === 2 && m1.spec.inactive === m0.spec.inactive, 'convert changed the inactive spec');
    await call(client, 'undo_last_change');
    assertSameState(await treeState(client), m0, 'mastery fixture after undo');
    log(`PASS: 3_24 masteries: gone and moved selections reported dropped, kept ones survive (${m1.spec.masteryEffects}), tattoo kept, undo exact`);

    // 9. Secondary ascendancy on 3_28_alternate (fixture spec 2, made active).
    assert(/<Tree activeSpec="1">/.test(masteryXml), 'mastery fixture: unexpected <Tree> tag');
    await call(client, 'load_build', { source: masteryXml.replace('<Tree activeSpec="1">', '<Tree activeSpec="2">') });
    const b0 = await treeState(client);
    assert(b0.spec.treeVersion === '3_28_alternate', `bloodline spec on ${b0.spec.treeVersion}`);
    assert(b0.spec.secondaryAscendClassId === '4', `bloodline spec secondary ascendancy ${b0.spec.secondaryAscendClassId}`);
    const bc = await callJson<ConvertResult>(client, 'convert_tree_to_latest');
    assert(
      bc.status === 'converted' && typeof bc.toVersion === 'string' && bc.toVersion.startsWith(latest),
      `bloodline convert -> ${bc.toVersion}`,
    );
    // 3_29 has no alternate tree, so the alternate spec lands on plain 3_29;
    // a later tree may ship an alternate variant, which PoB's convert keeps.
    onFixtureData(`the 3_28_alternate spec converts to plain ${latest}`, () => {
      assert(bc.toVersion === latest, `bloodline convert -> ${bc.toVersion}`);
    });
    const b1 = await treeState(client);
    assert(b1.spec.treeVersion === bc.toVersion && b1.spec.inactive === b0.spec.inactive, 'bloodline convert: wrong version or touched spec 1');
    // 3_29 supports secondary ascendancies; PoB's own convert would drop it
    // (CreateUndoState reads a field that does not exist), this tool keeps it.
    onFixtureData('the latest tree supports secondary ascendancy 4 (Chaos Bloodline)', () => {
      assert(b1.spec.secondaryAscendClassId === '4', `bloodline lost on convert: ${b1.spec.secondaryAscendClassId}`);
    });
    await call(client, 'undo_last_change');
    assertSameState(await treeState(client), b0, 'bloodline fixture after undo');
    log(`PASS: 3_28_alternate bloodline -> ${bc.toVersion} (secondary ascendancy ${b1.spec.secondaryAscendClassId}); undo restores the 3_28_alternate spec exactly`);

    log('ALL CONVERT-TREE TESTS PASSED');
  } finally {
    await client.close().catch(() => undefined);
    rmSync(configDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[convert-tree-test] FAILED:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
