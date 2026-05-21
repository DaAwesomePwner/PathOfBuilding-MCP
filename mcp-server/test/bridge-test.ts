import { Buffer } from 'buffer';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { deflateRawSync } from 'zlib';
import { decodeBuildCode, LuaBridge } from '../src/lua-bridge.js';
import { resolvePaths } from '../src/paths.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const fixturePath = path.join(repoRoot, 'spec', 'TestBuilds', '3.13', 'OccVortex.xml');

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
  process.env.POB_PATH = process.env.POB_PATH ?? repoRoot;
  const paths = resolvePaths();
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
    log('PASS: Error handling');

    log('Test 7: Auto-restart');
    await bridge.loadBuildXML(xml, 'OccVortex restart source');
    log('Build loaded for restart test, killing process...');
    bridge.killProcess();
    log('Process killed, requesting stats (should trigger restart)...');
    const restartedStats = await bridge.getStats();
    assert(Number(restartedStats.Life ?? 0) > 0, 'Auto-restart should reload build and return stats');
    log('PASS: Auto-restart');

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
