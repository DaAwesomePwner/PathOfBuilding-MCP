import { Buffer } from 'buffer';
import { readFileSync } from 'fs';
import { deflateRawSync } from 'zlib';
import { decodeBuildCode, LuaBridge } from '../src/lua-bridge.js';
import { setupTestEnv } from './_skip.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function expectRejects(fn: () => Promise<unknown> | unknown, message: string): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(message);
}

function encodeBuildCode(xml: string): string {
  return deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const xml = readFileSync(fixturePath, 'utf8');
  const bridge = new LuaBridge(paths, 60000);

  try {
    log('Test 1: Spawn and init');
    await bridge.start();
    assert(bridge.isRunning(), 'Bridge should be running after start');
    log('PASS: Bridge started');

    log('Test 2: Verify data');
    const data = await bridge.verifyData();
    assert(data.treeNodes > 0, 'Passive tree data should be loaded');
    assert(data.gemsLoaded, 'Gem data should be loaded');
    assert(data.itemBasesLoaded, 'Item base data should be loaded');
    log(`PASS: Data verified (${data.treeNodes} tree nodes)`);

    log('Test 3: Load XML');
    const info = await bridge.loadBuildXML(xml, 'OccVortex');
    assert(info.class === 'Witch', `Expected Witch, got ${info.class}`);
    assert(info.ascendancy === 'Occultist', `Expected Occultist, got ${info.ascendancy}`);
    assert(info.level === 99, `Expected level 99, got ${info.level}`);
    const versions = info as unknown as { treeVersion?: unknown; latestTreeVersion?: unknown };
    assert(versions.treeVersion === '3_13', `Expected treeVersion 3_13, got ${versions.treeVersion}`);
    assert(typeof versions.latestTreeVersion === 'string', 'latestTreeVersion should be reported');
    log('PASS: XML loaded');

    log('Test 4: Get stats');
    const stats = await bridge.getStats();
    assert(Object.prototype.hasOwnProperty.call(stats, 'Life'), 'Stats should include Life');
    assert(Object.prototype.hasOwnProperty.call(stats, 'CombinedDPS'), 'Stats should include CombinedDPS');
    assert(Number(stats.Life ?? 0) > 0, `Expected non-zero Life, got ${stats.Life}`);
    log(`PASS: Stats retrieved (Life=${stats.Life}, CombinedDPS=${stats.CombinedDPS})`);

    log('Test 5: Build code round-trip');
    const code = encodeBuildCode(xml);
    assert(decodeBuildCode(code) === xml, 'Build code round-trip should preserve XML');
    log('PASS: Build code round-trip');

    log('Test 6: Error handling');
    await expectRejects(() => bridge.loadBuildCode(''), 'Empty build code should reject');
    await expectRejects(() => bridge.loadBuildXML('<not-valid'), 'Malformed XML should reject');
    // Passes the bridge's shape check but PoB itself fails to parse it.
    await expectRejects(
      () => bridge.loadBuildXML('<PathOfBuilding><Build level="1"></PathOfBuilding>'),
      'XML that PoB cannot parse should reject',
    );
    await expectRejects(
      () => bridge.loadBuildXML(xml.replace(/treeVersion="3_13"/g, 'treeVersion="9_99"')),
      'A tree version this PoB does not know should reject',
    );
    log('PASS: Error handling');

    log('Test 7: Auto-restart');
    await bridge.loadBuildXML(xml, 'OccVortex restart source');
    log('Build loaded for restart test, killing process...');
    bridge.killProcess();
    log('Process killed, requesting stats (should trigger restart)...');
    const restartedStats = await bridge.getStats();
    assert(Number(restartedStats.Life ?? 0) > 0, 'Auto-restart should reload build and return stats');
    log('PASS: Auto-restart');

    // The fixture's item ids have a gap (1-7, 9-19), and PoB gives a new item
    // the lowest free id. The first equip after a fresh load must select the
    // item it just added, not the one with the highest id (a jewel, which the
    // Helmet slot rejects and so ends up empty).
    log('Test 7b: equipItem selects the item it added (id gap in fixture)');
    type SlotItem = { itemId: number; raw?: string | null; baseName?: string };
    const getHelmet = async (): Promise<SlotItem> =>
      (await bridge.send<{ ok: true; item: SlotItem }>({ cmd: 'getItemInSlot', slot: 'Helmet' })).item;
    const helmetBefore = await getHelmet();
    assert(helmetBefore.itemId !== 0 && !!helmetBefore.raw, 'Fixture should have a helmet equipped');
    await bridge.send({ cmd: 'equipItem', slot: 'Helmet', itemText: helmetBefore.raw });
    const helmetAfter = await getHelmet();
    assert(helmetAfter.itemId !== 0, 'Helmet slot should not be empty after equipItem');
    assert(helmetAfter.itemId !== helmetBefore.itemId, 'equipItem should select the newly added item');
    assert(
      helmetAfter.baseName === helmetBefore.baseName && helmetAfter.raw === helmetBefore.raw,
      `Helmet slot should hold the equipped item, got ${helmetAfter.baseName}`,
    );
    log(`PASS: equipItem selected new item id ${helmetAfter.itemId} (was ${helmetBefore.itemId})`);

    log('Test 8: Shutdown');
    await bridge.shutdown();
    assert(!bridge.isRunning(), 'Bridge should not be running after shutdown');
    log('PASS: Shutdown');
  } finally {
    bridge.killProcess();
  }
}

main().then(() => {
  log('ALL TESTS PASSED');
  process.exit(0);
}).catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
