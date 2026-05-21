import { readFileSync } from 'fs';
import { BuildSession } from '../src/build-session.js';
import { LuaBridge } from '../src/lua-bridge.js';
import { setupTestEnv } from './_skip.js';

const ALT_RING_RAW = `Rarity: RARE
Gloom Hold
Coral Ring
Unique ID: efc86ac7b5df717bfdbaea47dd45f77c40526efae46a3900b62c776bb4d6e160
Item Level: 63
LevelReq: 64
Implicits: 1
+30 to maximum Life
+7 to maximum Energy Shield
+78 to maximum Life
Regenerate 13.4 Life per second
+23 to maximum Mana
+23% to Cold Resistance
{crafted}+15% to Fire and Chaos Resistances`;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function expectRejects(fn: () => Promise<unknown>, msg: string): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function approxEqual(a: unknown, b: unknown, tolerance = 1e-6): boolean {
  const an = typeof a === 'number' ? a : Number(a);
  const bn = typeof b === 'number' ? b : Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) {
    return Math.abs(an - bn) <= tolerance * Math.max(1, Math.abs(an), Math.abs(bn));
  }
  return a === b;
}

function statsClose(a: Record<string, unknown>, b: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    if (!approxEqual(a[key], b[key], 1e-4)) {
      log(`  Mismatch on ${key}: ${a[key]} vs ${b[key]}`);
      return false;
    }
  }
  return true;
}

const COMPARE_KEYS = ['Life', 'Mana', 'EnergyShield', 'CombinedDPS', 'TotalEHP', 'FireResist', 'ColdResist', 'LightningResist'];

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const xml = readFileSync(fixturePath, 'utf8');
  const bridge = new LuaBridge(paths, 60_000);
  const session = new BuildSession(bridge);

  try {
    log('Test 1: Load build');
    const info = await session.loadBuild(xml);
    assert(info.class === 'Witch', `Expected Witch, got ${info.class}`);
    assert(info.ascendancy === 'Occultist', `Expected Occultist, got ${info.ascendancy}`);
    assert(info.level === 99, `Expected level 99, got ${info.level}`);
    log(`PASS: Loaded ${info.class}/${info.ascendancy}/${info.level}`);

    log('Test 2: Get stats');
    const baselineStats = await session.getStats();
    assert(Number(baselineStats.Life ?? 0) > 0, 'Life should be > 0');
    assert(Number(baselineStats.CombinedDPS ?? 0) > 0, 'CombinedDPS should be > 0');
    log(`PASS: Life=${baselineStats.Life}, CombinedDPS=${baselineStats.CombinedDPS}`);

    log('Test 3: Snapshot/restore item (Ring 1)');
    const ringSnap = await session.snapshotSlot('Ring 1');
    assert(ringSnap.itemText !== null, 'Ring 1 should be equipped');
    await session.equipItem('Ring 1', ALT_RING_RAW);
    const swappedStats = await session.getStats();
    assert(
      !statsClose(swappedStats, baselineStats, ['Life']),
      'Stats should change after swapping Ring 1',
    );
    await session.restoreSlot(ringSnap);
    const restoredStats = await session.getStats();
    assert(
      statsClose(restoredStats, baselineStats, COMPARE_KEYS),
      'Stats should match baseline after restoring Ring 1',
    );
    log('PASS: Item snapshot/restore round-trip');

    log('Test 4: withTemporaryChange (item swap)');
    const tempStats = await session.withTemporaryChange(async (b) => {
      await b.send({ cmd: 'equipItem', slot: 'Ring 1', itemText: ALT_RING_RAW });
      return await b.getStats();
    });
    assert(
      !statsClose(tempStats, baselineStats, ['Life']),
      'withTemporaryChange should observe swapped stats',
    );
    const afterTempStats = await session.getStats();
    assert(
      statsClose(afterTempStats, baselineStats, COMPARE_KEYS),
      'After withTemporaryChange, stats must match baseline',
    );
    log('PASS: withTemporaryChange round-trip');

    log('Test 5: withTemporaryChange error safety');
    await expectRejects(
      () =>
        session.withTemporaryChange(async (b) => {
          await b.send({ cmd: 'equipItem', slot: 'Ring 1', itemText: ALT_RING_RAW });
          throw new Error('synthetic failure');
        }),
      'withTemporaryChange should re-throw inner error',
    );
    const afterErrStats = await session.getStats();
    assert(
      statsClose(afterErrStats, baselineStats, COMPARE_KEYS),
      'State must be restored even when changeFn throws',
    );
    log('PASS: Error safety honored finally restore');

    log('Test 6: Serial lock');
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => session.getStats()),
    );
    for (const s of concurrent) {
      assert(
        approxEqual(s.Life, baselineStats.Life, 1e-4),
        `Concurrent getStats Life mismatch: ${s.Life} vs ${baselineStats.Life}`,
      );
    }
    log('PASS: 5 concurrent getStats serialized successfully');

    log('Test 7: Undo stack');
    await session.pushUndo();
    await session.equipItem('Ring 1', ALT_RING_RAW);
    await session.pushUndo();
    await session.unequipItem('Ring 1');
    const noRingStats = await session.getStats();
    assert(
      !statsClose(noRingStats, baselineStats, ['Life']),
      'Stats should differ after unequipping Ring 1',
    );
    await session.undoLastChange(); // undo unequip → restores swapped state
    const undoneOnceStats = await session.getStats();
    assert(
      !statsClose(undoneOnceStats, noRingStats, ['Life']),
      'Undo should change state away from unequipped',
    );
    await session.undoLastChange(); // undo swap → restores baseline
    const undoneTwiceStats = await session.getStats();
    assert(
      statsClose(undoneTwiceStats, baselineStats, COMPARE_KEYS),
      'After two undos, state should match baseline',
    );
    assert(session.undoStackDepth() === 0, 'Undo stack should be empty');
    log('PASS: Undo stack works across multiple operations');

    log('Test 8: Reset build');
    await session.unequipItem('Ring 1');
    await session.unequipItem('Ring 2');
    const mutatedStats = await session.getStats();
    assert(
      !statsClose(mutatedStats, baselineStats, ['Life']),
      'Stats should differ after mutation',
    );
    await session.resetBuild();
    const resetStats = await session.getStats();
    assert(
      statsClose(resetStats, baselineStats, COMPARE_KEYS),
      'After resetBuild, stats must match baseline',
    );
    log('PASS: resetBuild fully restored original state');

    log('Test 9: Labeled snapshots and diff');
    await session.takeSnapshot('before');
    await session.equipItem('Ring 1', ALT_RING_RAW);
    await session.takeSnapshot('after');
    const diff = session.diffSnapshots('before', 'after');
    const diffKeys = Object.keys(diff);
    assert(diffKeys.length > 0, 'Diff should report at least one delta');
    assert('Life' in diff || 'CombinedDPS' in diff, 'Diff should include Life or CombinedDPS');
    for (const [key, delta] of Object.entries(diff)) {
      assert(
        approxEqual(toNum(delta.after) - toNum(delta.before), delta.delta, 1e-6),
        `Delta math wrong for ${key}`,
      );
    }
    await session.restoreSlot({ slot: 'Ring 1', itemText: ringSnap.itemText, itemId: null });
    log(`PASS: ${diffKeys.length} stats changed`);
  } finally {
    bridge.killProcess();
  }
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return 0;
}

main()
  .then(() => {
    log('ALL SESSION TESTS PASSED');
    process.exit(0);
  })
  .catch((error: unknown) => {
    log(`FAILED: ${error instanceof Error ? error.stack : error}`);
    process.exit(1);
  });
