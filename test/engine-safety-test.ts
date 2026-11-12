/**
 * Engine safety test — exercises lua/bridge.lua against the real PoB install:
 *  - passive tree alloc/dealloc -> restoreTreeFromList round-trip is exact
 *  - the install write guard blocks io.open(write)/os.remove/os.rename while
 *    reads keep working (probes only use non-existent file names, so the test
 *    is harmless even if the guard is broken)
 *  - timeless jewel data loads and the install's TimelessJewelData files are
 *    unchanged afterwards
 *  - Inflate matches Node's zlib on real jewel data
 *  - failing loads return errors and the engine recovers
 *  - getBuildInfo reports treeVersion / latestTreeVersion
 *  - Lua print() cannot corrupt the JSON protocol
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { inflateSync } from 'zlib';
import { LuaBridge, Stats } from '../src/lua-bridge.js';
import { UserError } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function expectError(fn: () => Promise<unknown>, msg: string): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error(msg);
}

const LETHAL_PRIDE = `Rarity: UNIQUE
Lethal Pride
Timeless Jewel
League: Legion
Limited to: 1 Historic
Radius: Large
Implicits: 0
Commanded leadership over 10000 warriors under Kaom
Passives in radius are Conquered by the Karui
Historic`;

const HEROIC_TRAGEDY = `Rarity: UNIQUE
Heroic Tragedy
Timeless Jewel
Limited to: 1 Historic
Radius: Large
Implicits: 0
Remembrancing 5000 songworthy deeds by the line of Vorana
Passives in radius are Conquered by the Kalguur
Historic`;

// Allocated jewel socket in the OccVortex fixture.
const JEWEL_SLOT = 'Jewel 36634';
const EXACT_KEYS = ['Life', 'CombinedDPS', 'TotalEHP'] as const;

interface FileSig { size: number; mtimeMs: number }
type DirSnapshot = Map<string, FileSig>;

function snapshotDir(dir: string): DirSnapshot {
  const out: DirSnapshot = new Map();
  for (const name of readdirSync(dir)) {
    const st = statSync(path.join(dir, name));
    if (st.isFile()) out.set(name, { size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

function diffDir(before: DirSnapshot, after: DirSnapshot): string[] {
  const problems: string[] = [];
  for (const [name, sig] of before) {
    const now = after.get(name);
    if (!now) problems.push(`${name} disappeared`);
    else if (now.size !== sig.size || now.mtimeMs !== sig.mtimeMs) {
      problems.push(`${name} changed (size ${sig.size} -> ${now.size}, mtime ${sig.mtimeMs} -> ${now.mtimeMs})`);
    }
  }
  for (const name of after.keys()) {
    if (!before.has(name)) problems.push(`${name} was created`);
  }
  return problems;
}

function statsDiffer(a: Stats, b: Stats): boolean {
  return ['Life', 'CombinedDPS', 'TotalEHP', 'EnergyShield'].some((k) => a[k] !== b[k]);
}

interface GuardResult { opened: boolean; result?: boolean; message?: string | null; bytesRead?: number }
interface TreeNode { id: number; type: string; isAscendancy: boolean; isMastery: boolean }

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const xml = readFileSync(fixturePath, 'utf8');
  const install = paths.pobPath;
  const jewelDir = path.join(install, 'Data', 'TimelessJewelData');
  assert(existsSync(jewelDir), `Expected ${jewelDir} to exist`);

  const tag = `pob-mcp-guard-probe-${process.pid}-${Date.now()}`;
  const probeFiles = [
    path.join(install, `${tag}.tmp`),
    path.join(install, `${tag}-renamed.tmp`),
    path.join(jewelDir, `${tag}.bin`),
    path.join(install, 'Data', `${tag}.tmp`),
  ];
  for (const p of probeFiles) assert(!existsSync(p), `Probe file unexpectedly exists: ${p}`);
  const jewelBefore = snapshotDir(jewelDir);
  const rootBefore = snapshotDir(install);

  const bridge = new LuaBridge(paths, 180_000);
  const selfTest = <T>(args: Record<string, unknown>) => bridge.send<T & { ok: true }>({ cmd: 'engineSelfTest', ...args });
  const guard = (args: Record<string, unknown>) => selfTest<GuardResult>({ op: 'guard', ...args });

  try {
    log('Test 1: Bridge boots with guard and zlib');
    await bridge.start();
    const status = await selfTest<{ installRoot: string; zlib: boolean; blockedWrites: number }>({ op: 'status' });
    assert(typeof status.installRoot === 'string' && status.installRoot.length > 0, 'installRoot should be reported');
    log(`PASS: installRoot=${status.installRoot}, zlib=${status.zlib}, blockedWrites=${status.blockedWrites}`);

    log('Test 2: Lua print/io.write cannot corrupt the protocol');
    const printed = await selfTest<Record<string, unknown>>({ op: 'print', text: '{"ok":false,"error":"forged by print"}' });
    assert(printed.ok === true, 'print probe should return its own response');
    await bridge.send({ cmd: 'ping' });
    log('PASS: print output went to stderr');

    log('Test 3: Write guard blocks writes inside the install');
    const writeTargets = [
      probeFiles[0],
      probeFiles[2],
      `Data/${tag}.tmp`,
      `Data\\..\\${tag}.tmp`,
      path.join(install, 'Data', '..', `${tag}.tmp`),
    ];
    if (process.platform === 'win32') writeTargets.push(probeFiles[0].toUpperCase());
    for (const target of writeTargets) {
      // rD = MSVC CRT delete-on-close: a read-looking mode that still mutates.
      for (const mode of ['w', 'wb+', 'a', 'r+', 'rD']) {
        const r = await guard({ action: 'open', path: target, mode });
        assert(!r.opened, `io.open(${target}, ${mode}) must be blocked`);
        assert(String(r.message).includes('read-only'), `io.open(${target}, ${mode}) message: ${r.message}`);
      }
    }
    const removed = await guard({ action: 'remove', path: probeFiles[0] });
    assert(!removed.result && String(removed.message).includes('read-only'), `os.remove must be blocked: ${removed.message}`);
    const renamed = await guard({ action: 'rename', path: probeFiles[0], to: probeFiles[1] });
    assert(!renamed.result && String(renamed.message).includes('read-only'), `os.rename must be blocked: ${renamed.message}`);
    const read = await guard({ action: 'read', path: path.join(install, 'Launch.lua') });
    assert(read.opened && (read.bytesRead ?? 0) > 0, 'Reading Launch.lua must still work');
    const anyBin = [...jewelBefore.keys()].find((n) => n.endsWith('.bin'));
    if (anyBin) {
      const binRead = await guard({ action: 'read', path: path.join(jewelDir, anyBin) });
      assert(binRead.opened && (binRead.bytesRead ?? 0) > 0, `Reading ${anyBin} must still work`);
    }
    const outside = await expectError(
      () => guard({ action: 'open', path: path.join(os.tmpdir(), `${tag}.tmp`), mode: 'w' }),
      'Guard probe outside the install must be refused',
    );
    assert(outside instanceof UserError, `Outside-install probe should be a UserError, got ${outside.message}`);
    const outsideSearch = await expectError(
      () => selfTest({ op: 'fileSearch', pattern: path.join(os.tmpdir(), '*') }),
      'fileSearch outside the install must be refused',
    );
    assert(outsideSearch instanceof UserError, `Outside-install fileSearch should be a UserError, got ${outsideSearch.message}`);
    for (const p of probeFiles) assert(!existsSync(p), `Guard failed: ${p} was created`);
    log('PASS: io.open(write)/os.remove/os.rename blocked, reads work');

    log('Test 4: Inflate/Deflate');
    const z = await selfTest<{ available: boolean; roundTrip?: boolean; version?: string }>({
      op: 'zlib',
      text: 'Path of Building '.repeat(200),
    });
    if (process.platform === 'win32' && existsSync(path.join(install, 'zlib1.dll'))) {
      assert(z.available, 'zlib1.dll ships with the install, so Inflate must be available');
    }
    if (z.available) {
      assert(z.roundTrip === true, 'Deflate -> Inflate should round-trip');
      const zipName = [...jewelBefore.keys()].filter((n) => n.endsWith('.zip')).sort()[0];
      assert(zipName, 'Expected at least one single-file jewel .zip');
      const expected = inflateSync(readFileSync(path.join(jewelDir, zipName)));
      const got = await selfTest<{ inflatedSize: number; inflatedHead: string }>({
        op: 'zlib',
        file: path.join(jewelDir, zipName),
      });
      assert(got.inflatedSize === expected.length, `${zipName}: Lua inflated ${got.inflatedSize} bytes, Node ${expected.length}`);
      assert(got.inflatedHead === expected.subarray(0, 64).toString('hex'), `${zipName}: inflated bytes differ from Node`);
      log(`PASS: zlib ${z.version}; ${zipName} inflates to ${got.inflatedSize} bytes, identical to Node`);
    } else {
      log('NOTE: zlib unavailable on this platform; Inflate returns nil and jewel data is not loaded');
    }

    log('Test 5: NewFileSearch sees install files');
    const binNames = [...jewelBefore.keys()].filter((n) => n.endsWith('.bin')).sort();
    const search = await selfTest<{ files: Array<{ name: string; size: number; modified: number }> }>({
      op: 'fileSearch',
      pattern: path.join(jewelDir, '*.bin'),
    });
    if (process.platform === 'win32') {
      assert(
        JSON.stringify(search.files.map((f) => f.name).sort()) === JSON.stringify(binNames),
        `NewFileSearch *.bin mismatch: ${search.files.map((f) => f.name)} vs ${binNames}`,
      );
      for (const f of search.files) {
        const sig = jewelBefore.get(f.name)!;
        assert(f.size === sig.size, `${f.name}: size ${f.size} vs ${sig.size}`);
        assert(Math.abs(f.modified * 1000 - sig.mtimeMs) < 2000, `${f.name}: mtime ${f.modified} vs ${sig.mtimeMs / 1000}`);
      }
    }
    log(`PASS: NewFileSearch found ${search.files.length} .bin files`);

    log('Test 5b: Failed load with no previous build says so');
    const bootFailure = await expectError(
      () => bridge.loadBuildXML(xml.replace(/treeVersion="3_13"/g, 'treeVersion="9_99"'), 'future'),
      'Unknown tree version must fail',
    );
    assert(/no build loaded/.test(bootFailure.message), `Expected "no build loaded" in: ${bootFailure.message}`);
    log('PASS: failure without a previous build reports that no build is loaded');

    log('Test 6: getBuildInfo exposes tree versions');
    const info = (await bridge.loadBuildXML(xml, 'OccVortex')) as Record<string, unknown>;
    assert(info.treeVersion === '3_13', `Expected treeVersion 3_13, got ${info.treeVersion}`);
    assert(typeof info.latestTreeVersion === 'string' && /^\d+_\d+/.test(info.latestTreeVersion), `Bad latestTreeVersion ${info.latestTreeVersion}`);
    const info2 = (await bridge.send<{ info: Record<string, unknown> }>({ cmd: 'getBuildInfo' })).info;
    assert(info2.treeVersion === info.treeVersion && info2.latestTreeVersion === info.latestTreeVersion, 'getBuildInfo should match loadXML info');
    log(`PASS: treeVersion=${info.treeVersion}, latestTreeVersion=${info.latestTreeVersion}`);

    log('Test 7: Tree alloc/dealloc -> restoreTreeFromList round-trip');
    const baseIds = (await bridge.send<{ nodeIds: number[] }>({ cmd: 'getAllocatedNodes' })).nodeIds.slice().sort((a, b) => a - b);
    const baseStats = await bridge.getStats();
    const allocated = (await bridge.send<{ nodes: TreeNode[] }>({ cmd: 'getAllocatedNodesDetailed' })).nodes;
    const reachable = (await bridge.send<{ nodes: TreeNode[] }>({ cmd: 'getReachableNodes' })).nodes;
    const toAlloc = reachable.find((n) => n.type === 'Notable') ?? reachable[0];
    assert(toAlloc, 'Expected a reachable node');
    const masteryIds = new Set(allocated.filter((n) => n.isMastery).map((n) => n.id));
    // Pick a regular node whose removal does not drop any mastery (mastery
    // selections are out of scope for the tree snapshot).
    let removedId: number | null = null;
    for (const cand of allocated.filter((n) => (n.type === 'Notable' || n.type === 'Normal') && !n.isAscendancy)) {
      await bridge.send({ cmd: 'deallocNode', nodeId: cand.id });
      const after = (await bridge.send<{ nodeIds: number[] }>({ cmd: 'getAllocatedNodes' })).nodeIds;
      const afterSet = new Set(after);
      const lostMastery = [...masteryIds].some((id) => !afterSet.has(id));
      if (!lostMastery && after.length < baseIds.length) {
        removedId = cand.id;
        break;
      }
      await bridge.send({ cmd: 'restoreTreeFromList', nodeIds: baseIds });
    }
    assert(removedId !== null, 'Expected a deallocatable node that keeps masteries');
    await bridge.send({ cmd: 'allocNode', nodeId: toAlloc.id });
    const mutatedIds = (await bridge.send<{ nodeIds: number[] }>({ cmd: 'getAllocatedNodes' })).nodeIds;
    assert(mutatedIds.includes(toAlloc.id) && !mutatedIds.includes(removedId), 'Tree should be mutated before restore');
    const restored = await bridge.send<{ stats: Stats }>({ cmd: 'restoreTreeFromList', nodeIds: baseIds });
    const restoredIds = (await bridge.send<{ nodeIds: number[] }>({ cmd: 'getAllocatedNodes' })).nodeIds.slice().sort((a, b) => a - b);
    assert(JSON.stringify(restoredIds) === JSON.stringify(baseIds), `Allocated set differs after restore (${restoredIds.length} vs ${baseIds.length})`);
    const restoredStats = await bridge.getStats();
    for (const k of EXACT_KEYS) {
      assert(restoredStats[k] === baseStats[k], `${k} after restore: ${restoredStats[k]} vs ${baseStats[k]}`);
      assert(restored.stats[k] === baseStats[k], `${k} in restore response: ${restored.stats[k]} vs ${baseStats[k]}`);
    }
    const restoredInfo = (await bridge.send<{ info: Record<string, unknown> }>({ cmd: 'getBuildInfo' })).info;
    assert(restoredInfo.class === 'Witch' && restoredInfo.ascendancy === 'Occultist', 'Class/ascendancy must survive restore');
    log(`PASS: alloc ${toAlloc.id} + dealloc ${removedId} restored exactly (${baseIds.length} nodes, Life=${baseStats.Life})`);

    log('Test 7b: Restore with a node PoB cannot allocate is non-fatal');
    // A neighbour of a reachable node is two steps from the tree: listed alone
    // it is disconnected, so PoB prunes it during the restore.
    const reachableIds = new Set(reachable.map((n) => n.id));
    const baseSet = new Set(baseIds);
    let orphanId: number | null = null;
    for (const r of reachable) {
      const nodeInfo = (await bridge.send<{ node: { linked: number[] } | null }>({ cmd: 'getNodeInfo', nodeId: r.id })).node;
      const cand = nodeInfo?.linked.find((id) => !baseSet.has(id) && !reachableIds.has(id));
      if (cand !== undefined) {
        const candInfo = (await bridge.send<{ node: TreeNode | null }>({ cmd: 'getNodeInfo', nodeId: cand })).node;
        if (candInfo && (candInfo.type === 'Normal' || candInfo.type === 'Notable') && !candInfo.isAscendancy) {
          orphanId = cand;
          break;
        }
      }
    }
    assert(orphanId !== null, 'Expected a node two steps away from the tree');
    const partial = await bridge.send<{ ok: boolean; missingNodeIds?: number[]; stats: Stats }>({
      cmd: 'restoreTreeFromList',
      nodeIds: [...baseIds, orphanId],
    });
    assert(partial.ok === true, 'Restore with an unallocatable node must still succeed');
    assert(
      Array.isArray(partial.missingNodeIds) && partial.missingNodeIds.includes(orphanId),
      `missingNodeIds should report ${orphanId}, got ${JSON.stringify(partial.missingNodeIds)}`,
    );
    const partialIds = (await bridge.send<{ nodeIds: number[] }>({ cmd: 'getAllocatedNodes' })).nodeIds.slice().sort((a, b) => a - b);
    assert(JSON.stringify(partialIds) === JSON.stringify(baseIds), 'The rest of the tree must be restored');
    for (const k of EXACT_KEYS) {
      assert(partial.stats[k] === baseStats[k], `${k} after partial restore: ${partial.stats[k]} vs ${baseStats[k]}`);
    }
    const clean = await bridge.send<{ missingNodeIds?: number[] }>({ cmd: 'restoreTreeFromList', nodeIds: baseIds });
    assert(clean.missingNodeIds === undefined, 'A full restore must not report missing nodes');
    log(`PASS: node ${orphanId} reported in missingNodeIds, rest of tree restored`);

    log('Test 8: Timeless jewel data loads without touching the install');
    const blockedBefore = (await selfTest<{ blockedWrites: number }>({ op: 'status' })).blockedWrites;
    const emptyStats = (await bridge.send<{ stats: Stats }>({ cmd: 'unequipItem', slot: JEWEL_SLOT })).stats;
    for (const [label, itemText] of [['Lethal Pride', LETHAL_PRIDE], ['Heroic Tragedy', HEROIC_TRAGEDY]] as const) {
      const s = (await bridge.send<{ stats: Stats }>({ cmd: 'equipItem', slot: JEWEL_SLOT, itemText })).stats;
      if (z.available) {
        assert(statsDiffer(s, emptyStats), `${label}: stats unchanged — timeless jewel data did not load`);
      }
      log(`  ${label}: Life ${emptyStats.Life} -> ${s.Life}, CombinedDPS ${emptyStats.CombinedDPS} -> ${s.CombinedDPS}`);
    }
    const jewelXml = (await bridge.send<{ xml: string }>({ cmd: 'exportXML' })).xml;
    assert(jewelXml.includes('Heroic Tragedy'), 'Exported XML should contain the timeless jewel');
    const reloadInfo = await bridge.loadBuildXML(jewelXml, 'Timeless');
    assert(reloadInfo.class === 'Witch', 'Build with a timeless jewel should load');
    const blockedAfter = (await selfTest<{ blockedWrites: number; lastBlocked: string | null }>({ op: 'status' }));
    const jewelProblems = diffDir(jewelBefore, snapshotDir(jewelDir));
    assert(jewelProblems.length === 0, `TimelessJewelData changed: ${jewelProblems.join('; ')}`);
    log(`PASS: TimelessJewelData unchanged (${jewelBefore.size} files); writes blocked during load: ${blockedAfter.blockedWrites - blockedBefore}`);

    log('Test 9: Failing loads return errors and the engine recovers');
    await bridge.loadBuildXML(xml, 'OccVortex');
    const goodStats = await bridge.getStats();
    // Mutate build A so we can tell "A as the caller left it" from a fresh A.
    await bridge.send({ cmd: 'unequipItem', slot: 'Ring 1' });
    const stateA = await bridge.getStats();
    const infoA = (await bridge.send<{ info: Record<string, unknown> }>({ cmd: 'getBuildInfo' })).info;
    assert(stateA.Life !== goodStats.Life, 'Unequipping Ring 1 should change Life');
    const malformed = await expectError(
      () => bridge.loadBuildXML('<PathOfBuilding><Build level="1"></PathOfBuilding>', 'bad'),
      'Malformed XML must fail',
    );
    assert(/Path of Building/.test(malformed.message), `Unexpected malformed error: ${malformed.message}`);
    assert(!/Press Enter/.test(malformed.message), 'GUI hints should be stripped from the error');
    const unknownTree = await expectError(
      () => bridge.loadBuildXML(xml.replace(/treeVersion="3_13"/g, 'treeVersion="9_99"'), 'future'),
      'Unknown tree version must fail',
    );
    assert(!(unknownTree instanceof UserError), 'PoB load failures are internal errors');
    assert(/tree/i.test(unknownTree.message), `Unexpected unknown-tree error: ${unknownTree.message}`);
    for (const err of [malformed, unknownTree]) {
      assert(/previously loaded build is still active/.test(err.message), `Error should say A is still active: ${err.message}`);
    }
    await bridge.send({ cmd: 'ping' });
    const afterFailure = await bridge.getStats();
    for (const k of EXACT_KEYS) {
      assert(afterFailure[k] === stateA[k], `${k} after failed loads: ${afterFailure[k]} vs build A ${stateA[k]}`);
    }
    const infoAfter = (await bridge.send<{ info: Record<string, unknown> }>({ cmd: 'getBuildInfo' })).info;
    assert(JSON.stringify(infoAfter) === JSON.stringify(infoA), `Build info changed: ${JSON.stringify(infoAfter)} vs ${JSON.stringify(infoA)}`);
    const ring = (await bridge.send<{ item: { itemId: number } }>({ cmd: 'getItemInSlot', slot: 'Ring 1' })).item;
    assert(ring.itemId === 0, 'The unequipped Ring 1 must stay unequipped (A restored as left)');
    await bridge.loadBuildXML(xml, 'OccVortex');
    const recovered = await bridge.getStats();
    for (const k of EXACT_KEYS) {
      assert(recovered[k] === goodStats[k], `${k} after recovery: ${recovered[k]} vs ${goodStats[k]}`);
    }
    log(`PASS: errors surfaced (${unknownTree.message.slice(0, 80)}...), valid load recovered`);

    log('Test 10: Install untouched');
    // imgui.ini is rewritten by the desktop app itself if the user has it open.
    const rootProblems = diffDir(rootBefore, snapshotDir(install)).filter((p) => !p.startsWith('imgui.ini'));
    assert(rootProblems.length === 0, `Install root changed: ${rootProblems.join('; ')}`);
    assert(diffDir(jewelBefore, snapshotDir(jewelDir)).length === 0, 'TimelessJewelData changed');
    log('PASS: no files created, modified or removed');

    await bridge.shutdown();
  } finally {
    bridge.killProcess();
    // Only reached if the guard was broken: never leave probe files behind.
    for (const p of probeFiles) {
      if (existsSync(p)) rmSync(p);
    }
  }
}

main().then(() => {
  log('ALL ENGINE SAFETY TESTS PASSED');
  process.exit(0);
}).catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
