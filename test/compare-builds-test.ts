// compare_builds (src/compare-builds.ts): the loaded build against another
// build evaluated in a short-lived second engine.
//
//   1. B = the fixture with a 2-point notable allocated, a ring swapped, a
//      support gem replaced (apply_changes) and a config option set, exported
//      as a build code and undone. The comparison reports exactly those
//      changes; B's stats are the numbers the live engine showed while B was
//      applied, A's the live build's.
//   2. The live build's export, undo depth and crash journal are unchanged;
//      the temporary engine's process is gone and none is left alive.
//   3. `against`: two external builds give the same comparison.
//   4. Bad sources are UserErrors (bad code, XML Path of Building refuses).
//   5. A temporary engine that crashes, hangs (timeout) or fails to start
//      fails the call with a TemporaryEngineError; the live engine keeps
//      working with no strike, its crash ledger entry unchanged.
//   6. Concurrency: engine tools run while a comparison's temporary engine is
//      up (they are not blocked for its whole duration); two comparisons at
//      once never have two temporary engines alive.
import { mkdtempSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { BuildSession } from '../src/build-session.js';
import { compareBuilds, COMPARE_STAT_KEYS, KEY_STATS, TemporaryEngineError } from '../src/compare-builds.js';
import { EngineManager } from '../src/engine-manager.js';
import { LuaBridge, Stats } from '../src/lua-bridge.js';
import { UserError } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

process.env.POB_MCP_CONFIG_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-compare-'));

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const MAIN_GROUP = 5; // Vortex
const RING = `Rarity: RARE
Compare Ring
Coral Ring
Item Level: 63
Implicits: 1
+30 to maximum Life
+150 to maximum Life
+30% to all Elemental Resistances`;

interface StatRow { a: unknown; b: unknown; delta?: number; pct?: number }
interface Comparison {
  a: string;
  b: string;
  meta: { a: Record<string, unknown>; b: Record<string, unknown>; differs: string[] };
  stats: Record<string, StatRow>;
  statsUnchanged: number;
  tree: {
    points: { a: number; b: number };
    sameNodes: number;
    onlyA: Record<string, unknown>;
    onlyB: { notables?: Array<{ id: number; name: string }>; keystones?: unknown[]; masteries?: unknown[]; normal?: number; jewelSockets?: number };
  };
  items: { same: string[]; changed: Array<Record<string, unknown>>; onlyA: unknown[]; onlyB: unknown[] };
  gems: { mainSkill: { a: unknown; b: unknown }; sameGroups: number; changed: Array<Record<string, unknown>>; onlyA: unknown[]; onlyB: unknown[] };
  config: { changed: Record<string, { a: unknown; b: unknown }> };
}

async function expectError<T extends Error>(p: Promise<unknown>, cls: new (...a: never[]) => T, pattern: RegExp, label: string): Promise<T> {
  try {
    await p;
  } catch (e) {
    assert(e instanceof cls, `${label}: expected ${cls.name}, got ${String(e)}`);
    assert(pattern.test(e.message), `${label}: unexpected message: ${e.message}`);
    return e;
  }
  throw new Error(`${label}: expected an error`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const fixtureXml = readFileSync(fixturePath, 'utf8');

  // Every temporary engine: its pid once started; never two alive at once.
  const temp: Array<{ bridge: LuaBridge; pid?: number }> = [];
  // Created inside the temporary-engine mutex, so created and not yet disposed = alive.
  const count = { alive: 0, max: 0 };
  const engine = new EngineManager({
    temporaryBridgeFactory: (p, o) => {
      const bridge = new LuaBridge(p, o.timeoutMs, { testFaults: o.testFaults });
      const rec: { bridge: LuaBridge; pid?: number } = { bridge };
      temp.push(rec);
      count.alive++;
      count.max = Math.max(count.max, count.alive);
      const start = bridge.start.bind(bridge);
      bridge.start = async () => {
        try {
          await start();
        } finally {
          rec.pid = bridge.getPid() ?? rec.pid;
        }
      };
      const dispose = bridge.dispose.bind(bridge);
      bridge.dispose = async () => {
        await dispose();
        count.alive--;
      };
      return bridge;
    },
  });
  const run = <T>(fn: (s: BuildSession) => Promise<T>): Promise<T> => engine.run(fn);
  const compare = (args: { source: string; against?: string }, opts = {}): Promise<Comparison> =>
    run((s) => compareBuilds(engine, s, args, opts)) as unknown as Promise<Comparison>;
  const liveBridge = (s: BuildSession): LuaBridge => (s as unknown as { bridge: LuaBridge }).bridge;
  const allTempDead = async (label: string): Promise<void> => {
    assert(engine.temporaryEngineCount() === 0, `${label}: a temporary engine is still registered`);
    for (const t of temp) {
      assert(!t.bridge.isRunning(), `${label}: a temporary bridge still runs`);
      if (t.pid !== undefined) assert(await waitDead(t.pid), `${label}: temporary LuaJIT process ${t.pid} is still alive`);
    }
  };
  const statKeys = [...COMPARE_STAT_KEYS];
  const liveStats = (): Promise<Stats> => run(async (s) => (await s.probe({ stats: statKeys, variants: [] })).base as Stats);
  const liveState = (): Promise<string> =>
    run(async (s) => JSON.stringify([await s.exportXML(), s.undoStackDepth(), liveBridge(s).getRecoveryState(), liveBridge(s).getSpawnCount()]));

  try {
    // Primed as build-edit-test does: the fixture, then its own export, so the
    // export of B differs from A only by the changes made.
    await run(async (s) => {
      await s.loadBuild(fixtureXml);
      await s.loadBuild(await s.exportXML());
    });
    const statsA = await liveStats();

    log('Test 1: B = A + a notable, a ring, a support gem and a config option');
    const groupsBefore = await run((s) => liveBridge(s).send<{ groups: Array<{ gems: Array<{ name: string; isSupport: boolean }> }> }>({ cmd: 'getSocketGroups' }));
    const replaced = groupsBefore.groups[MAIN_GROUP - 1].gems[1];
    assert(replaced.isSupport && replaced.name !== 'Elemental Focus', `group ${MAIN_GROUP} gem 2: ${JSON.stringify(replaced)}`);
    const target = await run(async (s) => {
      const r = await liveBridge(s).send<{ nodes: Array<{ id: number; name: string; type: string; points: number; nodes: number[]; fallback?: string }> }>({
        cmd: 'probe', candidates: 'allocate', maxPoints: 2,
      });
      const t = r.nodes.find((c) => c.type === 'Notable' && c.points === 2 && !c.fallback);
      assert(t, 'a 2-point notable');
      return t;
    });
    const { statsB, codeB } = await run(async (s) => {
      await s.allocateNodes([target.id]);
      await s.swapItemWithDiff('Ring 1', RING);
      await s.applyChanges({ gems: [{ op: 'set', group: MAIN_GROUP, index: 2, name: 'Elemental Focus' }] });
      await s.setConfigWithUndo({ usePowerCharges: true });
      const stats = (await s.probe({ stats: statKeys, variants: [] })).base as Stats;
      const code = await s.exportBuild('code');
      for (let i = 0; i < 4; i++) await s.undoLastChange();
      return { statsB: stats, codeB: code };
    });
    assert(JSON.stringify(await liveStats()) === JSON.stringify(statsA), 'undo did not return to A');
    const stateBefore = await liveState();

    let t0 = Date.now();
    const cmp = await compare({ source: codeB });
    log(`  compare_builds: ${Date.now() - t0} ms, ${JSON.stringify(cmp).length} bytes`);
    assert(cmp.a === 'loaded build' && cmp.b === 'source', 'side labels');
    assert(cmp.meta.differs.length === 0, `meta differs: ${JSON.stringify(cmp.meta)}`);
    for (const key of KEY_STATS) assert(key in cmp.stats, `key stat ${key} missing`);
    let numeric = 0;
    for (const [key, row] of Object.entries(cmp.stats)) {
      assert(Object.is(row.a ?? null, statsA[key] ?? null), `${key}: a ${String(row.a)} != live A ${String(statsA[key])}`);
      assert(Object.is(row.b ?? null, statsB[key] ?? null), `${key}: b ${String(row.b)} != live B ${String(statsB[key])}`);
      if (typeof row.a === 'number' && typeof row.b === 'number') {
        numeric++;
        assert(Math.abs((row.delta ?? NaN) - (row.b - row.a)) <= Math.max(0.01, Math.abs(row.b - row.a) * 1e-3), `${key}: delta ${row.delta}`);
      }
    }
    for (const key of statKeys) {
      if (!(key in cmp.stats)) assert(Object.is(statsA[key] ?? null, statsB[key] ?? null), `${key} differs but is not reported`);
    }
    assert(numeric > 5 && (cmp.stats.CombinedDPS.delta ?? 0) !== 0 && (cmp.stats.Life.delta ?? 0) > 0, `stat deltas: ${JSON.stringify(cmp.stats)}`);
    log(`  CombinedDPS ${String(cmp.stats.CombinedDPS.a)} -> ${String(cmp.stats.CombinedDPS.b)} (${cmp.stats.CombinedDPS.pct}%), Life ${String(cmp.stats.Life.a)} -> ${String(cmp.stats.Life.b)}`);

    assert(JSON.stringify(cmp.tree.onlyA) === '{}', `tree onlyA: ${JSON.stringify(cmp.tree.onlyA)}`);
    assert(cmp.tree.points.b - cmp.tree.points.a === target.nodes.length, `points ${JSON.stringify(cmp.tree.points)} for ${target.nodes.length} nodes`);
    assert(cmp.tree.onlyB.notables?.some((n) => n.id === target.id && n.name === target.name), `the notable is not listed: ${JSON.stringify(cmp.tree.onlyB)}`);
    const listedB = (cmp.tree.onlyB.notables?.length ?? 0) + (cmp.tree.onlyB.keystones?.length ?? 0) + (cmp.tree.onlyB.masteries?.length ?? 0) +
      (cmp.tree.onlyB.normal ?? 0) + (cmp.tree.onlyB.jewelSockets ?? 0);
    assert(listedB === target.nodes.length, `onlyB lists ${listedB} nodes, want ${target.nodes.length}: ${JSON.stringify(cmp.tree.onlyB)}`);

    assert(cmp.items.onlyA.length === 0 && cmp.items.onlyB.length === 0, `items on one side: ${JSON.stringify(cmp.items)}`);
    assert(cmp.items.changed.length === 1 && cmp.items.changed[0].slot === 'Ring 1', `changed items: ${JSON.stringify(cmp.items.changed)}`);
    const ring = cmp.items.changed[0];
    assert(String(ring.b).startsWith('Compare Ring') && (ring.modsOnlyB as string[]).includes('+150 to maximum Life'), `ring: ${JSON.stringify(ring)}`);
    assert(cmp.items.same.length > 5, 'unchanged slots listed as same');

    assert(cmp.gems.onlyA.length === 0 && cmp.gems.onlyB.length === 0, `groups on one side: ${JSON.stringify(cmp.gems)}`);
    assert(cmp.gems.changed.length === 1, `changed groups: ${JSON.stringify(cmp.gems.changed)}`);
    const g = cmp.gems.changed[0];
    assert(JSON.stringify(g.supportsAdded) === '["Elemental Focus"]' && JSON.stringify(g.supportsRemoved) === JSON.stringify([replaced.name]),
      `gem change: ${JSON.stringify(g)}`);
    assert(g.gemChanges === undefined, `unexpected gem level changes: ${JSON.stringify(g)}`);
    assert(cmp.gems.mainSkill.a === cmp.gems.mainSkill.b, 'main skill');

    assert(JSON.stringify(Object.keys(cmp.config.changed)) === '["usePowerCharges"]' && cmp.config.changed.usePowerCharges.b === true,
      `config: ${JSON.stringify(cmp.config)}`);
    log('PASS: the comparison reports exactly the changes, with the live engine\'s numbers');

    log('Test 2: live build, undo and journal unchanged; no temporary engine left');
    assert((await liveState()) === stateBefore, 'compare_builds changed the live build, undo depth or journal');
    assert(temp.length === 1 && temp[0].pid !== undefined, `temporary engines: ${temp.length}`);
    await allTempDead('after compare');
    log('PASS');

    log('Test 3: against (two external builds, one temporary engine)');
    const codeA = await run((s) => s.exportBuild('code'));
    const ext = await compare({ source: codeB, against: codeA });
    assert(ext.a === 'against', 'side a label');
    const strip = (c: Comparison): string => JSON.stringify({ ...c, a: undefined });
    assert(strip(ext) === strip(cmp), `against differs:\n${strip(ext)}\n${strip(cmp)}`);
    assert((temp.length as number) === 2, 'one temporary engine for both builds');
    await allTempDead('after against');
    assert((await liveState()) === stateBefore, 'against changed the live build');
    log('PASS');

    log('Test 4: bad sources');
    await expectError(compare({ source: 'definitely not a build' }), UserError, /^source: /, 'bad code');
    await expectError(compare({ source: codeB, against: 'x' }), UserError, /^against: /, 'bad against');
    await expectError(compare({ source: '<PathOfBuilding><Build level="1"' }), UserError, /could not load the source build: Invalid Path of Building XML/, 'truncated XML');
    await allTempDead('after bad sources');
    assert((await liveState()) === stateBefore, 'bad sources changed the live build');
    log('PASS');

    log('Test 5: the temporary engine crashes, hangs, fails to start');
    const strikes = (): Promise<string> =>
      run(async () => JSON.stringify([(await engine.info()).crashCount,
        (engine as unknown as { ledger: { initialCount(p: string, l: string): number } }).ledger.initialCount(paths.pobPath, paths.luajitPath)]));
    const strikesBefore = await strikes();
    assert(strikesBefore === '[0,0]', `strikes before: ${strikesBefore}`);
    await expectError(compare({ source: codeB }, { testFaults: 'exitOn_compareSnapshot' }), TemporaryEngineError, /temporary Path of Building engine stopped while reading the source build/, 'crash');
    await allTempDead('after crash');
    t0 = Date.now();
    await expectError(compare({ source: codeB }, { testFaults: 'hangOn_compareSnapshot', timeoutMs: 8_000 }), TemporaryEngineError, /stopped while reading the source build \(Lua bridge timeout/, 'timeout');
    assert(Date.now() - t0 < 30_000, 'timeout took too long');
    await allTempDead('after timeout');
    await expectError(compare({ source: codeB }, { testFaults: 'failOnStart' }), TemporaryEngineError, /could not start/, 'startup failure');
    await allTempDead('after startup failure');
    assert((await strikes()) === strikesBefore, `live strikes changed: ${await strikes()}`);
    assert((await liveState()) === stateBefore, 'temporary engine failures changed the live build');
    assert(JSON.stringify(await liveStats()) === JSON.stringify(statsA), 'live engine stats changed');
    log('PASS: call errors; live engine fine, no strike');

    log('Test 6: concurrency');
    const done: string[] = [];
    const slowCompare = compare({ source: codeB }).then((r) => {
      done.push('compare');
      return r;
    });
    const others = Promise.all([
      run((s) => s.getStats()).then(() => done.push('get_stats')),
      run((s) => s.probe({ stats: ['Life'], variants: [{ config: { usePowerCharges: true } }] })).then(() => done.push('probe')),
    ]);
    const [again] = await Promise.all([slowCompare, others]);
    assert(done.indexOf('get_stats') < done.indexOf('compare') && done.indexOf('probe') < done.indexOf('compare'),
      `engine tools waited for the comparison: ${done.join(', ')}`);
    assert(strip(again) === strip(cmp), 'concurrent compare differs');
    const pair = await Promise.all([compare({ source: codeB }), compare({ source: codeB, against: codeA })]);
    assert(strip(pair[0]) === strip(cmp) && strip(pair[1]) === strip(cmp), 'parallel compares differ');
    assert(count.max === 1 && count.alive === 0, `${count.max} temporary engines were alive at once (${count.alive} now)`);
    await allTempDead('after concurrency');
    assert((await liveState()) === stateBefore, 'concurrency changed the live build');
    log('PASS');

    console.log('\nALL COMPARE BUILDS TESTS PASSED');
  } finally {
    await engine.shutdown();
    engine.killProcess();
  }
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  log(`FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
