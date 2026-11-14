// Crash breaker and crash recovery, against real LuaJIT engine processes.
// Engines are killed from outside (an unexpected exit) or through the
// test-only fault seam (LuaBridge `testFaults` → POB_MCP_TEST_FAULTS in the
// child only). Every process started here is reaped before the test ends.
//
//   1. Three unexpected exits with many successful commands in between open
//      the breaker: the next call fails with the circuit-open message and no
//      process is started.
//   2. A command timeout kills the engine and counts as a strike.
//   3. EngineManager: reload_engine / configure_pob_path for the same paths
//      keep the count; the breaker refuses them; a changed install clears it.
//   4. Crash after committed changes (swap_item, unequip_item, set_config,
//      convert_tree_to_latest): the restarted engine holds the post-change
//      build (export and stats); reset_build returns to the loaded build.
//   5. A rejected load_build followed by a crash restores the previously
//      accepted build with its committed changes, minus undone ones, never
//      the rejected one.
//   6. A startup that hangs or fails leaves no live process; the next start
//      fails cleanly and the breaker eventually refuses to start at all.
//   7. The restart notice: told once, names the restored build, the cleared
//      undo history and the kept stat snapshots; undo afterwards says why it
//      is empty; new changes undo normally.
//   8. convert_tree_to_latest interrupted by a crash or a timeout with the new
//      spec active: no rollback on (or respawn into) a fresh engine during the
//      call; the next call restores the pre-conversion build. Likewise a
//      what-if probe whose engine dies is not restored onto a fresh engine.
//   9. POB_MCP_TEST_FAULTS in the server's own environment never reaches the
//      engine; only the LuaBridge option sets it.
//  10. swap_item / set_config / convert_tree_to_latest whose engine dies right
//      after applying the change: the call fails, no undo entry or journal
//      entry is left, the restarted engine does not have the change (the
//      notice says so truthfully), and a retry applies it exactly once.
//  11. load_build after a crash: a successful load skips replaying the old
//      build and carries the strike in an engineRestart note (once); a
//      rejected load puts the last committed build back.
//  12. A restore that fails is reported as failed again at a later crash
//      (never as "no build"); reset_build still recovers.
//  13. A change the engine applied whose call then failed with the engine
//      alive is committed anyway: the error says so, undo reverts it, and a
//      later crash restores it.
//  14. reset_build after a crash: blank respawn, no replay, the original
//      build, a one-time engineRestart note.
//  11 and 14 check the commands actually sent, so a skipped replay is proven.
//  15. Engine swap export after a crash whose restart replay kills the engine
//      again: the last accepted build is carried with a note naming the
//      missing change (no engine stderr in it), one more strike, no live
//      process; with the breaker then open, no process is started at all.
//   3 also: an engine swap with the breaker open carries the last accepted
//      build with a note naming the committed changes it lacks.
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { BuildSession, EngineRestartedError } from '../src/build-session.js';
import { EngineManager } from '../src/engine-manager.js';
import { LuaBridge, Stats } from '../src/lua-bridge.js';
import { UserError } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

const log = (msg: string): void => console.log(`[crash-recovery-test] ${msg}`);
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const RING_A = `Rarity: RARE
Crash Recovery Ring
Coral Ring
Item Level: 63
LevelReq: 64
Implicits: 1
+30 to maximum Life
+150 to maximum Life
+30% to all Elemental Resistances`;

const bridges: LuaBridge[] = [];
const tempDirs: string[] = [];
const { paths, fixturePath } = setupTestEnv();
const occXml = readFileSync(fixturePath, 'utf8');
const badXml = occXml.replace(/treeVersion="3_13"/g, 'treeVersion="9_99"');

function newBridge(timeoutMs = 120_000, testFaults?: string, initialCrashCount?: number): LuaBridge {
  const b = new LuaBridge(paths, timeoutMs, { testFaults, initialCrashCount });
  bridges.push(b);
  return b;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Kill the engine process from outside, as a crash would, and wait until the bridge saw the exit. */
async function crash(bridge: LuaBridge): Promise<number> {
  const pid = bridge.getPid();
  assert(pid !== undefined && bridge.isRunning(), 'engine should be running before the crash');
  process.kill(pid, 'SIGKILL');
  await waitFor(() => !bridge.isRunning() && !pidAlive(pid), `engine ${pid} to exit`);
  return pid;
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

async function expectRestart(label: string, p: Promise<unknown>, ...needles: RegExp[]): Promise<string> {
  const e = await rejection(p);
  assert(e instanceof EngineRestartedError, `${label}: expected the restart notice, got ${e.constructor.name}: ${e.message}`);
  for (const n of needles) assert(n.test(e.message), `${label}: notice "${e.message}" does not match ${n}`);
  return e.message;
}

// --- build comparison (export modulo PoB's own re-normalisation on save/load)

/** Node lists and the tree URL follow Lua table order, which a reload or spec rebuild reshuffles. */
function sortNodeLists(xml: string): string {
  return xml
    .replace(/ nodes="([\d,]*)"/g, (_m, list: string) => ` nodes="${list.split(',').map(Number).sort((x, y) => x - y).join(',')}"`)
    .replace(/<URL>[\s\S]*?<\/URL>/g, '<URL/>');
}

/**
 * Same as item-restore-test's canonicalXml: attributes sorted per tag, runs of
 * self-closing siblings (except <Gem/>) sorted, top-level sections sorted.
 * Items keep their order and text.
 */
function canonicalXml(xml: string): string {
  const lines = sortNodeLists(xml)
    .split('\n')
    .map((line) =>
      line.replace(/<(\w+)((?:\s+\w+="[^"]*")+)\s*(\/?)>/g, (_m, tag: string, attrList: string, close: string) =>
        `<${tag} ${[...attrList.matchAll(/\w+="[^"]*"/g)].map((m) => m[0]).sort().join(' ')}${close}>`),
    );
  const out: string[] = [];
  let run: string[] = [];
  let runKey: string | null = null;
  const flush = (): void => {
    out.push(...run.sort());
    run = [];
  };
  for (const line of lines) {
    const m = /^(\s*)<(\w+)\b[^>]*\/>\s*$/.exec(line);
    const key = m && m[2] !== 'Gem' ? m[1] : null;
    if (key === null || key !== runKey) flush();
    runKey = key;
    if (key === null) out.push(line);
    else run.push(line);
  }
  flush();
  const blocks: string[][] = [];
  const head: string[] = [];
  const tail: string[] = [];
  for (const line of out) {
    if (/^<\/PathOfBuilding>/.test(line) || tail.length > 0) tail.push(line);
    else if (/^\t<\w/.test(line)) blocks.push([line]);
    else if (blocks.length > 0) blocks[blocks.length - 1].push(line);
    else head.push(line);
  }
  blocks.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return [...head, ...blocks.flat(), ...tail].join('\n');
}

interface State {
  xml: string;
  stats: Pick<Stats, 'Life' | 'CombinedDPS' | 'TotalEHP'>;
}

async function state(session: BuildSession): Promise<State> {
  const s = await session.getStats();
  return { xml: await session.exportXML(), stats: { Life: s.Life, CombinedDPS: s.CombinedDPS, TotalEHP: s.TotalEHP } };
}

function assertSame(label: string, actual: State, expected: State): void {
  for (const k of ['Life', 'CombinedDPS', 'TotalEHP'] as const) {
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

/** A session on a build already in PoB's re-read form (loading a fresh XML is not byte-idempotent once). */
async function primedSession(bridge: LuaBridge): Promise<{ session: BuildSession; base: State }> {
  const session = new BuildSession(bridge);
  await session.loadBuild(occXml);
  await session.loadBuild(await session.exportXML());
  return { session, base: await state(session) };
}

// ---------------------------------------------------------------------------

async function test1Breaker(): Promise<void> {
  log('Test 1: three unexpected exits with successes in between open the breaker');
  const bridge = newBridge();
  const session = new BuildSession(bridge);
  await session.loadBuild(occXml);
  for (let strike = 1; strike <= 3; strike++) {
    for (let i = 0; i < 8; i++) await session.getStats(); // more than the old 5-success amnesty
    await crash(bridge);
    assert(bridge.getCrashCount() === strike, `strike ${strike}: count is ${bridge.getCrashCount()}`);
    if (strike < 3) {
      await expectRestart(`after strike ${strike}`, session.getStats(), new RegExp(`strike ${strike} of 3`));
    }
  }
  const spawns = bridge.getSpawnCount();
  for (let i = 0; i < 2; i++) {
    const e = await rejection(session.getStats());
    assert(e instanceof UserError && /crashed 3 times/.test(e.message) && /reload_engine/.test(e.message), `circuit open expected: ${e.message}`);
  }
  assert(bridge.isCircuitOpen() && bridge.getSpawnCount() === spawns && bridge.getPid() === undefined, 'no process may be started once the breaker is open');
  log('PASS 1');
}

async function test2Timeout(): Promise<void> {
  log('Test 2: a command timeout kills the engine and counts as a strike');
  const bridge = newBridge(120_000, 'hangOn_getSkillBreakdown');
  const { session, base } = await primedSession(bridge);
  const pid = bridge.getPid()!;
  const e = await rejection(bridge.send({ cmd: 'getSkillBreakdown' }, 1_500));
  assert(/timeout after 1500ms/.test(e.message) && /strike 1 of 3/.test(e.message), `timeout error: ${e.message}`);
  assert(bridge.getCrashCount() === 1, `timeout must count: ${bridge.getCrashCount()}`);
  await waitFor(() => !pidAlive(pid), 'the hung engine to be killed');
  await expectRestart('after the timeout', session.getStats(), /strike 1 of 3/, /build was restored/);
  assertSame('after the timeout restart', await state(session), base);
  log('PASS 2');
}

function makeFakeInstall(version: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pob-crash-'));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, 'Modules'));
  writeFileSync(path.join(dir, 'Launch.lua'), '-- fake');
  writeFileSync(path.join(dir, 'Modules', 'Build.lua'), '-- fake');
  writeFileSync(path.join(dir, 'GameVersions.lua'), 'liveTargetVersion = "3_0"\n');
  setVersion(dir, version, 1);
  return dir;
}

function setVersion(dir: string, version: string, bump: number): void {
  const file = path.join(dir, 'manifest.xml');
  writeFileSync(file, `<?xml version="1.0"?>\n<PoBVersion>\n\t<Version platform="win32" branch="master" number="${version}"/>\n</PoBVersion>\n`);
  const t = new Date(Date.now() + bump * 10_000);
  utimesSync(file, t, t);
}

async function test3Manager(): Promise<void> {
  log('Test 3: engine swaps keep the count; a changed install clears it');
  // The manager fingerprints a temp stand-in install (so "PoB changed on disk"
  // can be simulated without touching the real one); its bridges run the real engine.
  const fake = makeFakeInstall('9.0.0');
  const cfg = mkdtempSync(path.join(os.tmpdir(), 'pob-crash-cfg-'));
  tempDirs.push(cfg);
  const made: LuaBridge[] = [];
  const m = new EngineManager({
    env: { POB_PATH: fake, LUAJIT_PATH: paths.luajitPath, POB_MCP_CONFIG_DIR: cfg },
    bridgeFactory: (_p, o) => {
      const b = newBridge(120_000, undefined, o.initialCrashCount);
      made.push(b);
      return b;
    },
    log: () => undefined,
    resolveOptions: { pobCandidates: [], luajitCandidates: [] },
  });
  try {
    m.init();
    await m.run((s) => s.loadBuild(occXml));
    await crash(made[0]);
    await expectRestart('manager, strike 1', m.run((s) => s.getStats()), /strike 1 of 3/);
    await m.run((s) => s.swapItemWithDiff('Ring 1', RING_A));
    await crash(made[0]);
    const r1 = await m.reload();
    assert(r1.buildReloaded, 'reload must carry the build over from a crashed engine');
    const ring = await m.run((s) => s.getItemInSlot('Ring 1'));
    assert(String(ring?.raw).includes('Crash Recovery Ring'), `the committed swap must be carried over: ${ring?.raw}`);
    assert((await m.info()).crashCount === 2, 'reload_engine with the same paths keeps the count');
    await m.configure(fake, paths.luajitPath);
    assert((await m.info()).crashCount === 2, 'configure_pob_path with the same paths keeps the count');
    const live = made[made.length - 1];
    await m.run((s) => s.setConfigWithUndo({ usePowerCharges: true })); // committed on the live engine only
    await crash(live);
    const spawned = made.length;
    const open = await rejection(m.run((s) => s.getStats()));
    assert(open instanceof UserError && /crashed 3 times/.test(open.message), `circuit-open expected: ${open.message}`);
    assert((await m.info()).circuitOpen === true, 'info reports the open breaker');
    const refused = await rejection(m.reload());
    assert(/crashed 3 times/.test(refused.message), `reload must stay refused: ${refused.message}`);
    assert(made.slice(spawned).every((b) => b.getSpawnCount() === 0), 'no engine process may start while the breaker is open');
    setVersion(fake, '9.0.1', 2); // the install changed on disk → fresh count
    const r2 = await m.reload();
    assert(r2.buildReloaded && (await m.info()).crashCount === 0, `fresh count after the install changed: ${JSON.stringify(await m.info())}`);
    assert(/WITHOUT the 1 committed change/.test(String(r2.buildNote)), `the carried build must say what it lacks: ${r2.buildNote}`);
    const carried = await m.run((s) => s.getItemInSlot('Ring 1'));
    assert(String(carried?.raw).includes('Crash Recovery Ring'), 'the last accepted build (with the earlier swap) is carried');
    const stats = await m.run((s) => s.getStats());
    assert(Number(stats.Life) > 0, 'engine usable after the reset');
  } finally {
    await m.shutdown();
  }
  log('PASS 3');
}

async function test4And7Committed(): Promise<void> {
  log('Test 4 + 7: crash after committed changes; the restart notice and undo afterwards');
  const bridge = newBridge();
  const { session, base } = await primedSession(bridge);
  await session.swapItemWithDiff('Ring 1', RING_A);
  await session.unequipItemWithDiff('Ring 2');
  await session.setConfigWithUndo({ usePowerCharges: true });
  const conv = await session.convertTreeToLatest();
  assert(conv.converted, 'the fixture (3_13) should convert');
  await session.takeSnapshot('before-crash');
  const committed = await state(session);
  await crash(bridge);
  const notice = await expectRestart('first call after the crash', session.getStats(),
    /restarted/, /strike 1 of 3/, /build was restored as it was after the last committed change/,
    /Undo history was cleared \(4 entries\)/, /reset_build still returns to the originally loaded build/,
    /Labelled stat snapshots \(1\) are kept/, /retry it/);
  log(`  notice: ${notice}`);
  assertSame('restarted engine', await state(session), committed); // told once: this call succeeds
  assert((await session.getBuildInfo()).treeVersion === conv.toVersion, 'build info follows the restored build');
  assert(session.getSnapshot('before-crash') !== null, 'labelled stat snapshots are kept');
  const undoErr = await rejection(session.undoLastChange());
  assert(undoErr instanceof UserError && /undo stack is empty/.test(undoErr.message) && /restarted after a crash/.test(undoErr.message), `undo after restart: ${undoErr.message}`);
  await session.setConfigWithUndo({ usePowerCharges: false }); // new history works normally
  await session.undoLastChange();
  assertSame('new change + undo after the restart', await state(session), committed);
  await session.resetBuild();
  assertSame('reset_build after the restart', await state(session), base);
  log('PASS 4 + 7');
}

async function test5Rejected(): Promise<void> {
  log('Test 5: a rejected load_build then a crash restores the accepted build');
  const bridge = newBridge();
  const { session } = await primedSession(bridge);
  await session.swapItemWithDiff('Ring 1', RING_A);
  await session.setConfigWithUndo({ usePowerCharges: true });
  await session.unequipItemWithDiff('Amulet');
  await session.undoLastChange(); // undone changes are not restored after a crash
  await session.undoLastChange();
  const accepted = await state(session);
  const loadErr = await rejection(session.loadBuild(badXml));
  assert(/previously loaded build is still active/.test(loadErr.message), `rejected load: ${loadErr.message}`);
  assert(bridge.getRecoveryXML() !== badXml, 'a rejected build must never be recorded for recovery');
  await crash(bridge);
  await expectRestart('after the crash', session.getStats(), /build was restored/);
  assert((await session.getBuildInfo()).treeVersion === '3_13', 'the accepted build (3_13) is back');
  assertSame('restored accepted build', await state(session), accepted);
  log('PASS 5');
}

async function test6Startup(): Promise<void> {
  log('Test 6: a hung or failed startup leaves no live process');
  const hung = newBridge(3_000, 'hangOnStart');
  for (let strike = 1; strike <= 3; strike++) {
    const starting = hung.start();
    await waitFor(() => hung.getPid() !== undefined, 'the engine to spawn');
    const pid = hung.getPid()!;
    const e = await rejection(starting);
    assert(/init timeout/.test(e.message), `startup timeout expected: ${e.message}`);
    await waitFor(() => !pidAlive(pid), `hung engine ${pid} to be killed`);
    assert(!hung.isRunning() && hung.getPid() === undefined && hung.getCrashCount() === strike, `after hung start ${strike}: count ${hung.getCrashCount()}`);
  }
  const open = await rejection(hung.start());
  assert(open instanceof UserError && /crashed 3 times/.test(open.message) && hung.getPid() === undefined, `breaker after failed starts: ${open.message}`);

  const failing = newBridge(60_000, 'failOnStart');
  const e = await rejection(failing.start());
  assert(/exited during init/.test(e.message) && /strike 1 of 3/.test(e.message), `failed start: ${e.message}`);
  assert(!failing.isRunning() && failing.getPid() === undefined, 'failed start leaves no process');
  log('PASS 6');
}

async function test8Convert(): Promise<void> {
  log('Test 8: convert_tree_to_latest interrupted mid-conversion is not rolled back onto a fresh engine');
  for (const [fault, timeoutMs] of [['convertExitsAfterSwap', 120_000], ['convertHangsAfterSwap', 15_000]] as const) {
    const bridge = newBridge(timeoutMs, fault);
    const { session } = await primedSession(bridge);
    await session.swapItemWithDiff('Ring 1', RING_A);
    const committed = await state(session);
    const spawns = bridge.getSpawnCount();
    const e = await rejection(session.convertTreeToLatest());
    assert(!(e instanceof UserError) && /exited unexpectedly|timeout/.test(e.message), `${fault}: ${e.message}`);
    assert(bridge.getSpawnCount() === spawns && !bridge.isRunning(), `${fault}: no engine may be started during the failed call`);
    assert(bridge.getCrashCount() === 1, `${fault}: one strike, got ${bridge.getCrashCount()}`);
    await expectRestart(`${fault}: next call`, session.getStats(), /build was restored/, /Undo history was cleared \(1 entry\)/);
    assert((await session.getBuildInfo()).treeVersion === '3_13', `${fault}: the pre-conversion tree is back`);
    assertSame(`${fault}: restored build`, await state(session), committed);
  }
  // Same rule for what-if probes: the restore after a probe whose engine died
  // must not run on (or start) a fresh engine.
  const bridge = newBridge(120_000, 'exitOn_equipItem');
  const { session, base } = await primedSession(bridge);
  const spawns = bridge.getSpawnCount();
  const e = await rejection(session.compareItems('Ring 1', [RING_A]));
  assert(!(e instanceof UserError) && /stopped during this call/.test(e.message), `probe restore on a dead engine: ${e.message}`);
  assert(bridge.getSpawnCount() === spawns && !bridge.isRunning(), 'no engine may be started during the failed probe');
  await expectRestart('after the probe crash', session.getStats(), /build was restored/);
  assertSame('after the probe crash', await state(session), base);
  log('PASS 8');
}

async function test9Env(): Promise<void> {
  log('Test 9: POB_MCP_TEST_FAULTS from the server environment never reaches the engine');
  const previous = process.env.POB_MCP_TEST_FAULTS;
  process.env.POB_MCP_TEST_FAULTS = 'exitOn_getStats';
  try {
    const plain = newBridge();
    await plain.loadBuildXML(occXml);
    assert(Number((await plain.getStats()).Life) > 0, 'environment faults must be ignored');
    await plain.shutdown();
  } finally {
    if (previous === undefined) delete process.env.POB_MCP_TEST_FAULTS;
    else process.env.POB_MCP_TEST_FAULTS = previous;
  }
  const faulty = newBridge(120_000, 'exitOn_getStats');
  await faulty.loadBuildXML(occXml);
  const e = await rejection(faulty.getStats());
  assert(/exited unexpectedly/.test(e.message), `the option must reach the engine: ${e.message}`);
  log('PASS 9');
}

async function test10FailedCommit(): Promise<void> {
  log('Test 10: a change whose call failed after the engine applied it is never replayed');
  const cases: Array<[string, (s: BuildSession) => Promise<unknown>]> = [
    ['swap_item', (s) => s.swapItemWithDiff('Ring 1', RING_A)],
    ['set_config', (s) => s.setConfigWithUndo({ usePowerCharges: true })],
    ['convert_tree_to_latest', (s) => s.convertTreeToLatest()],
  ];
  for (const [name, change] of cases) {
    const bridge = newBridge(120_000, 'exitAfterChange');
    const { session, base } = await primedSession(bridge);
    const e = await rejection(change(session));
    assert(!(e instanceof UserError) && /exited unexpectedly/.test(e.message), `${name}: ${e.message}`);
    assert(session.undoStackDepth() === 0 && bridge.committedCount() === 0, `${name}: nothing may be committed for a failed call`);
    bridge.setTestFaults(undefined);
    await expectRestart(`${name}: next call`, session.getStats(),
      /A change whose call failed when the engine stopped was not kept/, /There was no undo history to keep/);
    assertSame(`${name}: restarted engine without the change`, await state(session), base);
    await change(session); // the retry applies it exactly once
    const once = await state(session);
    assert(session.undoStackDepth() === 1 && bridge.committedCount() === 1, `${name}: one committed change after the retry`);
    if (name === 'swap_item') {
      assert((once.xml.match(/Crash Recovery Ring/g) ?? []).length === 1, `${name}: the ring must exist exactly once`);
    }
    await crash(bridge); // and a later crash replays it exactly once
    await expectRestart(`${name}: after the retry`, session.getStats(), /build was restored/);
    assertSame(`${name}: replayed once`, await state(session), once);
  }
  log('PASS 10');
}

/** Record the name of every command the bridge sends from now on (including its own replay). */
function recordCommands(bridge: LuaBridge, badXmlText = badXml): string[] {
  const sent: string[] = [];
  const b = bridge as unknown as { send: (cmd: { cmd?: string; xml?: string }, t?: number) => Promise<unknown> };
  const real = b.send.bind(bridge);
  b.send = (cmd, t) => {
    sent.push(String(cmd?.cmd) + (cmd?.cmd === 'loadXML' && cmd.xml === badXmlText ? ':rejected' : ''));
    return real(cmd, t);
  };
  return sent;
}

async function test11LoadAfterCrash(): Promise<void> {
  log('Test 11: load_build after a crash skips the replay; a rejected one restores the committed build');
  const bridge = newBridge();
  const { session } = await primedSession(bridge);
  await session.swapItemWithDiff('Ring 1', RING_A);
  const committed = await state(session);
  const sent = recordCommands(bridge);
  await crash(bridge);
  await rejection(session.loadBuild(badXml));
  // Blank respawn, the rejected load first, then the committed build put back.
  assert(JSON.stringify(sent) === JSON.stringify(['loadXML:rejected', 'loadXML', 'equipItem', 'getBuildInfo']), `commands after a crash + rejected load: ${sent}`);
  await expectRestart('after a rejected load', session.getStats(), /strike 1 of 3/, /build was restored/);
  assertSame('rejected load after a crash', await state(session), committed);

  await crash(bridge);
  bridge.setTestFaults('exitOn_equipItem'); // replaying the committed swap would now kill the engine
  const spawns = bridge.getSpawnCount();
  sent.length = 0;
  const info = await session.loadBuild(occXml);
  assert(JSON.stringify(sent) === JSON.stringify(['loadXML']), `a load after a crash sends only the load: ${sent}`);
  assert(/stopped unexpectedly/.test(info.engineRestart ?? '') && /strike 2 of 3/.test(info.engineRestart ?? ''), `load note: ${info.engineRestart}`);
  assert(bridge.getCrashCount() === 2 && bridge.getSpawnCount() === spawns + 1, 'the load must not replay the old build');
  assert((await session.getBuildInfo()).engineRestart === undefined, 'the note is not cached in the build info');
  await session.getStats(); // no notice afterwards: it was given once, in the load result
  assert((await session.loadBuild(occXml)).engineRestart === undefined, 'the note is given once');
  bridge.setTestFaults(undefined);
  log('PASS 11');
}

async function test12LostRestore(): Promise<void> {
  log('Test 12: a failed restore stays reported as failed; reset_build recovers');
  const bridge = newBridge();
  const { session, base } = await primedSession(bridge);
  await session.swapItemWithDiff('Ring 1', RING_A);
  await crash(bridge);
  bridge.setTestFaults('failOn_equipItem');
  await expectRestart('restore fails', session.getStats(), /could NOT be fully restored/, /replaying committed change 1 of 1 \(equipItem\)/);
  await crash(bridge);
  const again = await expectRestart('a later crash', session.getStats(), /could NOT be fully restored/, /already lost at an earlier restart/);
  assert(!/No build was loaded/.test(again), 'a lost build is not reported as no build');
  await session.resetBuild();
  assertSame('reset_build after a lost restore', await state(session), base);
  log('PASS 12');
}

async function test13AppliedButFailed(): Promise<void> {
  log('Test 13: a change applied before its call failed (engine alive) is committed and said so');
  const cases: Array<[string, (s: BuildSession) => Promise<unknown>]> = [
    ['swap_item', (s) => s.swapItemWithDiff('Ring 1', RING_A)],
    ['set_config', (s) => s.setConfigWithUndo({ usePowerCharges: true })],
    ['convert_tree_to_latest', (s) => s.convertTreeToLatest()],
  ];
  for (const [name, change] of cases) {
    const bridge = newBridge(120_000, 'failAfterChange');
    const { session, base } = await primedSession(bridge);
    const e = await rejection(change(session));
    assert(!(e instanceof UserError) && /test fault/.test(e.message) && /WAS applied/.test(e.message) && /undo_last_change/.test(e.message), `${name}: ${e.message}`);
    assert(bridge.isRunning() && session.undoStackDepth() === 1 && bridge.committedCount() === 1, `${name}: the applied change is committed`);
    const applied = await state(session);
    assert(canonicalXml(applied.xml) !== canonicalXml(base.xml), `${name}: the export must show the change`);
    await session.undoLastChange();
    assert(bridge.committedCount() === 0, `${name}: undo drops it from the journal`);
    assertSame(`${name}: undone`, await state(session), base);
  }
  // A later crash restores it.
  const bridge = newBridge(120_000, 'failAfterChange');
  const { session } = await primedSession(bridge);
  await rejection(session.swapItemWithDiff('Ring 1', RING_A));
  const applied = await state(session);
  assert(applied.xml.includes('Crash Recovery Ring'), 'the swap is in the live build');
  bridge.setTestFaults(undefined);
  await crash(bridge);
  await expectRestart('crash after an applied-but-failed swap', session.getStats(), /build was restored/, /Undo history was cleared \(1 entry\)/);
  assertSame('restored with the applied change', await state(session), applied);
  log('PASS 13');
}

async function test14ResetAfterCrash(): Promise<void> {
  log('Test 14: reset_build after a crash: no replay, the original build, a one-time note');
  const bridge = newBridge();
  const { session, base } = await primedSession(bridge);
  await session.swapItemWithDiff('Ring 1', RING_A);
  const sent = recordCommands(bridge);
  await crash(bridge);
  bridge.setTestFaults('exitOn_equipItem'); // a replay of the swap would kill the engine
  const info = await session.resetBuild();
  assert(JSON.stringify(sent) === JSON.stringify(['loadXML']), `reset after a crash sends only the load: ${sent}`);
  assert(/stopped unexpectedly/.test(info.engineRestart ?? '') && /strike 1 of 3/.test(info.engineRestart ?? ''), `reset note: ${info.engineRestart}`);
  assert(bridge.getCrashCount() === 1, 'no strike from the reset');
  assertSame('reset_build after a crash', await state(session), base); // no notice: given once, in the reset result
  assert((await session.resetBuild()).engineRestart === undefined, 'the note is given once');
  bridge.setTestFaults(undefined);
  log('PASS 14');
}

async function test15SwapExportReplayCrash(): Promise<void> {
  log('Test 15: engine-swap export when the restart replay crashes, then with the breaker open');
  const bridge = newBridge();
  const { session } = await primedSession(bridge);
  const accepted = bridge.getRecoveryXML();
  assert(accepted !== null, 'a build was accepted');
  await session.swapItemWithDiff('Ring 1', RING_A);
  await crash(bridge); // strike 1
  bridge.setTestFaults('exitOn_equipItem'); // replaying the committed swap kills the restarted engine
  const spawns = bridge.getSpawnCount();
  const r1 = await session.exportForEngineSwap();
  assert(r1.xml === accepted, 'the carried XML must be the last accepted build');
  assert(/failed again while being restarted/.test(r1.note ?? '') && /WITHOUT the 1 committed change made since that load/.test(r1.note ?? ''), `note: ${r1.note}`);
  assert(!/Stderr|exited|code=/.test(r1.note ?? ''), `engine details must stay out of the note: ${r1.note}`);
  assert(bridge.getCrashCount() === 2, `exactly one more strike, got ${bridge.getCrashCount()}`);
  assert(bridge.getSpawnCount() === spawns + 1 && !bridge.isRunning() && bridge.getPid() === undefined, 'the restarted engine is gone');

  // Third strike the same way, then the breaker is open: no process may start.
  await session.exportForEngineSwap();
  assert(bridge.isCircuitOpen() && bridge.getPid() === undefined, `breaker open after strike 3 (${bridge.getCrashCount()})`);
  const openSpawns = bridge.getSpawnCount();
  const r2 = await session.exportForEngineSwap();
  assert(r2.xml === accepted && /not restarted again after too many crashes/.test(r2.note ?? '') && /WITHOUT the 1 committed change/.test(r2.note ?? ''), `breaker-open note: ${r2.note}`);
  assert(bridge.getSpawnCount() === openSpawns && bridge.getPid() === undefined && bridge.getCrashCount() === 3, 'no process may start with the breaker open');
  log('PASS 15');
}

async function main(): Promise<void> {
  // The cases share nothing but the read-only fixture: each starts its own
  // engines with its own strike count. They run in three lanes of similar
  // length so the file takes about a third of the time; log lines of
  // different lanes interleave. (Test 9 sets POB_MCP_TEST_FAULTS in this
  // process's environment for a moment; the bridge strips it for every child,
  // so the other lanes' engines never see it.)
  const lanes: Array<Array<() => Promise<void>>> = [
    // test8 has a 15 s boot and command timeout, so it does not start at the busiest moment.
    [test3Manager, test8Convert, test5Rejected, test9Env],
    [test10FailedCommit, test13AppliedButFailed, test4And7Committed, test6Startup],
    [test11LoadAfterCrash, test12LostRestore, test15SwapExportReplayCrash, test1Breaker, test2Timeout, test14ResetAfterCrash],
  ];
  try {
    const outcomes = await Promise.allSettled(lanes.map(async (lane) => {
      for (const test of lane) await test();
    }));
    const failures = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    for (const f of failures.slice(1)) console.error('FAIL (another lane):', f.reason instanceof Error ? f.reason.stack ?? f.reason.message : f.reason);
    if (failures.length > 0) throw failures[0].reason;
  } finally {
    const pids = bridges.map((b) => b.getPid()).filter((p): p is number => p !== undefined);
    for (const b of bridges) await b.dispose().catch(() => undefined);
    for (const pid of pids) await waitFor(() => !pidAlive(pid), `engine ${pid} to be reaped`).catch(() => log(`WARNING: ${pid} still alive`));
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  }
  log('ALL CRASH RECOVERY TESTS PASSED');
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error('FAIL:', err instanceof Error ? err.stack ?? err.message : err);
    for (const b of bridges) b.forceKill();
    process.exit(1);
  },
);
