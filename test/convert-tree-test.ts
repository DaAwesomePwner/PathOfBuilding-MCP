// Integration test for convert_tree_to_latest: OccVortex.xml is saved on tree
// 3_13, so it is converted to the engine's latest tree, undone, reconverted,
// exported and reloaded, and reset.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupTestEnv } from './_skip.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'src', 'server.ts');
const FIXTURE_TREE_VERSION = '3_13';

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

/** Last entry of PoB's treeVersionList (GameVersions.lua) = latestTreeVersion. */
function engineLatestTreeVersion(pobPath: string): string {
  const candidates = [path.join(pobPath, 'GameVersions.lua'), path.join(pobPath, 'src', 'GameVersions.lua')];
  for (const file of candidates) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const list = /treeVersionList\s*=\s*\{([^}]*)\}/.exec(text);
    assert(list, `treeVersionList not found in ${file}`);
    const versions = [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert(versions.length > 0, `treeVersionList is empty in ${file}`);
    return versions[versions.length - 1];
  }
  throw new Error(`GameVersions.lua not found under ${pobPath}`);
}

interface SpecInfo {
  specCount: number;
  activeSpec: string;
  treeVersion: string;
  classId: string;
  ascendClassId: string;
  secondaryAscendClassId: string;
  nodes: string;
  masteryEffects: string;
  sockets: string;
}

function attr(tag: string, name: string): string {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? '';
}

function sortedList(raw: string, re: RegExp): string {
  return [...raw.matchAll(re)].map((m) => m[0]).sort().join(',');
}

/** The active <Spec> of an exported build, with lists normalised to sorted order. */
function parseSpec(xml: string): SpecInfo {
  const tree = /<Tree\b([^>]*)>([\s\S]*?)<\/Tree>/.exec(xml);
  assert(tree, 'exported XML has no <Tree> element');
  const activeSpec = attr(tree[1], 'activeSpec') || '1';
  const specs = [...tree[2].matchAll(/<Spec\b([^>]*)>([\s\S]*?)<\/Spec>/g)];
  assert(specs.length > 0, 'exported XML has no <Spec> element');
  const [, specTag, body] = specs[Number(activeSpec) - 1];
  const sockets = [...body.matchAll(/<Socket\b([^>]*)\/>/g)]
    .map((m) => `${attr(m[1], 'nodeId')}=${attr(m[1], 'itemId')}`)
    .filter((s) => !s.endsWith('=0'))
    .sort()
    .join(',');
  return {
    specCount: specs.length,
    activeSpec,
    treeVersion: attr(specTag, 'treeVersion'),
    classId: attr(specTag, 'classId'),
    ascendClassId: attr(specTag, 'ascendClassId'),
    secondaryAscendClassId: attr(specTag, 'secondaryAscendClassId'),
    nodes: sortedList(attr(specTag, 'nodes'), /\d+/g),
    masteryEffects: sortedList(attr(specTag, 'masteryEffects'), /\{\d+,\d+\}/g),
    sockets,
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
  droppedMasteries?: unknown[];
  droppedMasteriesOmitted?: number;
  keyDeltas?: Record<string, number>;
}

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const xml = readFileSync(fixturePath, 'utf8');
  const latest = engineLatestTreeVersion(paths.pobPath);
  assert(latest !== FIXTURE_TREE_VERSION, `engine latest tree is the fixture's own version ${latest}`);
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
    log('PASS: convert undo interleaves with other undo entries');

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
