/**
 * Config-key validation: every config option sent to the engine is checked
 * against PoB's own config metadata, and presets/aliases only use real keys.
 */
import { readFileSync } from 'fs';
import { BuildSession, BUFF_KEY_MAP } from '../src/build-session.js';
import { LuaBridge } from '../src/lua-bridge.js';
import { UserError } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function expectUserError(fn: () => Promise<unknown>, contains: string[], msg: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    assert(e instanceof UserError, `${msg}: expected UserError, got ${e instanceof Error ? e.stack : e}`);
    for (const c of contains) {
      assert(e.message.includes(c), `${msg}: error message should include "${c}", got: ${e.message}`);
    }
    return;
  }
  throw new Error(`${msg}: expected rejection, but call succeeded`);
}

const STAT_KEYS = ['Life', 'CombinedDPS', 'TotalEHP', 'EnergyShield'];

function sameStats(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return STAT_KEYS.every((k) => Math.abs(Number(a[k] ?? 0) - Number(b[k] ?? 0)) <= 1e-6 * Math.max(1, Math.abs(Number(a[k] ?? 0))));
}

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const xml = readFileSync(fixturePath, 'utf8');
  const bridge = new LuaBridge(paths, 60_000);
  const session = new BuildSession(bridge);

  try {
    await session.loadBuild(xml);
    const metadata = await session.getConfigMetadata();
    const validKeys = new Set(metadata.map((m) => m.var));
    assert(validKeys.size > 100, `engine should expose many config options, got ${validKeys.size}`);

    log('Test 1: every scenario preset key exists in engine metadata');
    const scenarios = BuildSession.listScenarios();
    assert(scenarios.length > 0, 'expected scenario presets');
    for (const sc of scenarios) {
      for (const key of Object.keys(sc.options)) {
        assert(validKeys.has(key), `scenario "${sc.name}" uses key "${key}" which PoB does not define`);
      }
    }
    log(`PASS: ${scenarios.length} presets use only real keys`);

    log('Test 2: every buff alias target exists in engine metadata');
    for (const [alias, target] of Object.entries(BUFF_KEY_MAP)) {
      assert(validKeys.has(target), `buff alias "${alias}" -> "${target}" is not a PoB config key`);
    }
    log(`PASS: ${Object.keys(BUFF_KEY_MAP).length} aliases map to real keys`);

    log('Test 3: setConfigWithUndo / setConfig / simulateConfig reject unknown keys without side effects');
    const baseStats = await session.getStats();
    const baseDepth = session.undoStackDepth();
    const baseCfg = await session.snapshotConfig();
    await expectUserError(
      () => session.setConfigWithUndo({ conditionOnslaught: true }),
      ['conditionOnslaught', 'buffOnslaught'],
      'setConfigWithUndo(dead key)',
    );
    await expectUserError(
      () => session.setConfigWithUndo({ usePowerCharges: true, totallyBogusKey: 1 }),
      ['totallyBogusKey'],
      'setConfigWithUndo(valid+unknown)',
    );
    await expectUserError(() => session.setConfig({ buffFortify: true }), ['buffFortify', 'buffFortification'], 'setConfig(dead key)');
    await expectUserError(() => session.simulateConfig({ conditionPinned: true }), ['conditionPinned'], 'simulateConfig(dead key)');
    await expectUserError(() => session.toggleBuffs({ pinned: true }), ['pinned'], 'toggleBuffs(pinned: no PoB equivalent)');
    assert(session.undoStackDepth() === baseDepth, 'undo depth must be unchanged after rejected calls');
    assert(sameStats(await session.getStats(), baseStats), 'stats must be unchanged after rejected calls');
    const afterCfg = await session.snapshotConfig();
    assert(JSON.stringify(afterCfg) === JSON.stringify(baseCfg), 'config must be unchanged after rejected calls');
    log('PASS: unknown keys rejected, state + undo stack untouched');

    log('Test 4: wrong value types rejected');
    await expectUserError(() => session.setConfigWithUndo({ usePowerCharges: 'yes' }), ['usePowerCharges'], 'check with string');
    await expectUserError(() => session.setConfigWithUndo({ enemyIsBoss: 'Nope' }), ['enemyIsBoss', 'Pinnacle'], 'list with bad value');
    assert(session.undoStackDepth() === baseDepth, 'undo depth unchanged after type rejections');
    log('PASS: type mismatches rejected');

    log('Test 5: valid key still works, changes config, pushes undo');
    const meta = metadata.find((m) => m.var === 'enemyIsBoss');
    assert(meta?.type === 'list', 'enemyIsBoss should be a list option');
    const res = await session.setConfigWithUndo({ enemyIsBoss: 'Uber', buffFortification: true });
    assert(session.undoStackDepth() === baseDepth + 1, 'valid change should push one undo entry');
    const cfg = await session.snapshotConfig();
    assert(cfg.input.enemyIsBoss === 'Uber', `enemyIsBoss should be Uber, got ${cfg.input.enemyIsBoss}`);
    assert(cfg.input.buffFortification === true, 'buffFortification should be true');
    assert(res.before && res.after, 'diff result expected');
    await session.undoLastChange();
    assert(session.undoStackDepth() === baseDepth, 'undo pops the entry');
    assert(sameStats(await session.getStats(), baseStats), 'stats restored after undo');
    log('PASS: valid config applies and is undoable');

    log('Test 6: aliases and scenarios still run');
    await session.toggleBuffs({ onslaught: true, fortify: true, flasks: true, unholyMight: true });
    await session.simulateScenario('mapping');
    const cmp = await session.compareScenarios(['mapping', 'no_buffs', 'uber_boss']);
    assert(cmp.scenarios.length === 3, 'compareScenarios should return 3 results');
    assert(sameStats(await session.getStats(), baseStats), 'probe operations must leave stats unchanged');
    log('PASS: aliases + scenarios apply and restore');

    log('Test 7: metadata cache refreshes on build reload');
    await session.loadBuild(xml);
    const metadata2 = await session.getConfigMetadata();
    assert(metadata2.length === metadata.length, 'metadata should be available after reload');
    await expectUserError(() => session.setConfig({ bogusAfterReload: 1 }), ['bogusAfterReload'], 'validation after reload');
    log('PASS: validation works after reload');
  } finally {
    bridge.killProcess();
  }
}

main()
  .then(() => {
    log('ALL CONFIG-KEY TESTS PASSED');
    process.exit(0);
  })
  .catch((error: unknown) => {
    log(`FAILED: ${error instanceof Error ? error.stack : error}`);
    process.exit(1);
  });
