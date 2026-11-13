/**
 * Startup / configuration / version-awareness tests.
 *
 * Part 1 (always runs, no LuaJIT needed): EngineManager against a temp fake
 *   install with a fake bridge — stale detection, update-in-progress gating,
 *   reload, configure, PoE2 rejection, path prompt.
 * Part 2 (always runs): the BUILT server (dist/server.js) with POB_PATH pointing
 *   at a missing dir and an empty temp config dir — it must complete MCP
 *   initialize, list tools, and return an isError result naming configure_pob_path.
 * Part 3 (needs a real PoB + LuaJIT, else SKIPPED; fails under REQUIRE_POB=1): configure_pob_path → engine
 *   works → config file written → second start finds the saved path → elicitation.
 *
 * Never touches the real user config: POB_MCP_CONFIG_DIR is always a temp dir.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineManager, EngineNotReadyError } from '../src/engine-manager.js';
import { decodeBuildCode, LuaBridge } from '../src/lua-bridge.js';
import { resolveAllPaths } from '../src/paths.js';
import { UserError } from '../src/validation.js';
import { skipOrFail } from './_skip.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const builtServer = path.join(repoRoot, 'dist', 'server.js');
const tmpDirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
const write = (file: string, content: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

function makeFakePoB(version: string, poe2 = false): string {
  const dir = tmp('pob-startup-');
  write(path.join(dir, 'Launch.lua'), '-- fake');
  write(path.join(dir, 'Modules', 'Build.lua'), '-- fake');
  write(path.join(dir, 'GameVersions.lua'), `liveTargetVersion = "${poe2 ? '0_1' : '3_0'}"\n`);
  setManifestVersion(dir, version);
  return dir;
}

let mtimeBump = 0;
function setManifestVersion(dir: string, version: string): void {
  const file = path.join(dir, 'manifest.xml');
  write(file, `<?xml version="1.0"?>\n<PoBVersion>\n\t<Version platform="win32" branch="master" number="${version}"/>\n</PoBVersion>\n`);
  const t = new Date(Date.now() + ++mtimeBump * 10_000); // guarantee a distinct mtime
  utimesSync(file, t, t);
}

/** In-process stand-in for LuaBridge: mirrors its breaker and disposal semantics, no LuaJIT. */
class FakeBridge {
  static instances: FakeBridge[] = [];
  /** When true, start() behaves like a LuaJIT process that dies during init. */
  static crashOnStart = false;
  static exportFails = false;
  static loadFails = false;
  running = false;
  disposed = false;
  crashCount: number;
  xml: string | null = null;
  readonly initialCrashCount: number;
  constructor(_paths: unknown, opts: { initialCrashCount: number }) {
    this.crashCount = this.initialCrashCount = opts.initialCrashCount;
    FakeBridge.instances.push(this);
  }
  starts = 0;
  async start() {
    if (this.disposed) throw new UserError('engine replaced — retry');
    if (this.running) return;
    this.starts++;
    if (this.crashCount >= 3) throw new Error(`Lua engine has crashed ${this.crashCount} times — refusing to restart.`);
    if (FakeBridge.crashOnStart) {
      this.crashCount++;
      throw new Error('Lua bridge exited during init (code=1)');
    }
    this.running = true;
  }
  isRunning() {
    return this.running;
  }
  getCrashCount() {
    return this.crashCount;
  }
  isCircuitOpen() {
    return this.crashCount >= 3;
  }
  async loadBuildXML(xml: string) {
    await this.start();
    if (FakeBridge.loadFails) throw new UserError('this PoB cannot parse the build');
    this.xml = xml;
    return { class: 'Witch', level: 90 };
  }
  async getStats() {
    await this.start();
    return {};
  }
  async send(cmd: { cmd: string }) {
    await this.start();
    if (cmd.cmd === 'exportXML') {
      if (FakeBridge.exportFails) throw new Error('Lua bridge exited unexpectedly');
      return { ok: true, xml: this.xml };
    }
    return { ok: true, stats: {} };
  }
  async dispose() {
    this.running = false;
    this.disposed = true;
  }
  forceKill() {
    this.running = false;
  }
  killProcess() {
    this.running = false;
  }
}

const BUILD_XML = '<PathOfBuilding><Build level="90" className="Witch"/></PathOfBuilding>';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const runningFakes = () => FakeBridge.instances.filter((b) => b.running).length;

function fakeManager(env: NodeJS.ProcessEnv): EngineManager {
  return new EngineManager({
    env,
    bridgeFactory: (p, o) => new FakeBridge(p, o) as unknown as LuaBridge,
    log: () => undefined,
    resolveOptions: { pobCandidates: [], luajitCandidates: [] },
  });
}

async function rejectsWith(p: Promise<unknown>, cls: Function, ...needles: RegExp[]): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof cls, `expected ${cls.name}, got ${String(e)}`);
    for (const n of needles) assert.match((e as Error).message, n);
    return (e as Error).message;
  }
  assert.fail('expected rejection');
}

// ---------------------------------------------------------------------------
// Part 1 — EngineManager unit tests
// ---------------------------------------------------------------------------

async function part1(): Promise<void> {
  const luajitDir = tmp('lj-fake-');
  const luajit = path.join(luajitDir, process.platform === 'win32' ? 'luajit.exe' : 'luajit');
  writeFileSync(luajit, '');

  log('1a: stale detection + reload against a temp fake install');
  const pob = makeFakePoB('1.0.0');
  const env = { POB_PATH: pob, LUAJIT_PATH: luajit, POB_MCP_CONFIG_DIR: tmp('cfg-') };
  const m = fakeManager(env);
  m.init();
  await m.ensureReady();
  let info = await m.info();
  assert.equal(info.status, 'ready');
  assert.equal(info.pobVersion, '1.0.0');
  assert.equal(info.layout, 'installed');

  setManifestVersion(pob, '1.0.1');
  await rejectsWith(m.ensureReady(), EngineNotReadyError, /updated on disk from 1\.0\.0 to 1\.0\.1/, /reload_engine/);
  info = await m.info();
  assert.equal(info.status, 'stale');
  assert.equal(info.installChangedSinceStart, true);
  assert.equal(info.onDiskVersion, '1.0.1');

  const before = FakeBridge.instances.length;
  const r = await m.reload();
  assert.equal(r.oldVersion, '1.0.0');
  assert.equal(r.newVersion, '1.0.1');
  assert.equal(r.buildReloaded, false);
  await m.ensureReady();
  assert.equal(FakeBridge.instances.length, before + 1, 'reload should create exactly one new bridge');
  assert.ok(FakeBridge.instances[before - 1].disposed, 'old bridge should be disposed');
  assert.equal(FakeBridge.instances.filter((b) => b.running).length, 1, 'exactly one running engine');
  log('PASS 1a');

  log('1b: update being applied (Update/manifest.xml without opFile.txt) blocks tools');
  write(path.join(pob, 'Update', 'manifest.xml'), '<PoBVersion/>');
  await rejectsWith(m.ensureReady(), EngineNotReadyError, /applying an update/);
  assert.equal((await m.info()).status, 'updating');
  write(path.join(pob, 'Update', 'opFile.txt'), 'move "a" "b"'); // staged only → fine
  await m.ensureReady();
  rmSync(path.join(pob, 'Update'), { recursive: true, force: true });
  await m.shutdown();
  log('PASS 1b');

  log('1c: unconfigured → configure() → ready; config persisted; PoE2 rejected');
  const cfgDir = tmp('cfg-');
  const env2 = { POB_PATH: path.join(os.tmpdir(), 'no-such-pob-dir'), POB_MCP_CONFIG_DIR: cfgDir };
  const m2 = fakeManager(env2);
  m2.init();
  await rejectsWith(m2.ensureReady(), EngineNotReadyError, /configure_pob_path/, /not configured/);
  assert.equal((await m2.info()).status, 'unconfigured');
  const poe2 = makeFakePoB('0.22.0', true);
  await rejectsWith(m2.configure(poe2, luajit), UserError, /Path of Exile 2/);
  await rejectsWith(m2.configure(path.join(os.tmpdir(), 'nope-x'), luajit), UserError, /does not exist/);
  assert.ok(!existsSync(path.join(cfgDir, 'config.json')), 'failed configure must not write config');
  const good = makeFakePoB('2.5.0');
  const c = await m2.configure(`"${good}${path.sep}"`, luajit);
  assert.equal(c.pobVersion, '2.5.0');
  assert.match(String(c.warning), /POB_PATH is set/);
  const saved = JSON.parse(readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
  assert.equal(saved.pobPath, path.resolve(good));
  assert.equal(saved.luajitPath, luajit);
  await m2.ensureReady();
  await m2.shutdown();
  log('PASS 1c');

  log('1d: saved config is used on the next start (env unset)');
  const m3 = fakeManager({ POB_MCP_CONFIG_DIR: cfgDir });
  m3.init();
  await m3.ensureReady();
  info = await m3.info();
  assert.equal(info.pobPathSource, 'config');
  assert.equal(info.pobVersion, '2.5.0');
  await m3.shutdown();
  log('PASS 1d');

  log('1e: path prompt (elicitation hook) configures on first unconfigured call');
  const m4 = fakeManager({ POB_PATH: path.join(os.tmpdir(), 'no-such-pob-dir'), POB_MCP_CONFIG_DIR: tmp('cfg-') });
  let prompts = 0;
  m4.setPathPrompt(async () => {
    prompts++;
    await m4.configure(good, luajit);
    return { configured: true };
  });
  await m4.ensureReady();
  assert.equal(prompts, 1);
  await m4.shutdown();
  log('PASS 1e');

  // ---- review items -------------------------------------------------------
  const fresh = (pobDir: string) =>
    fakeManager({ POB_PATH: pobDir, LUAJIT_PATH: luajit, POB_MCP_CONFIG_DIR: tmp('cfg-') });

  log('1f [item 1/10]: reload waits for an in-flight call; queued calls run on the new engine');
  {
    const pobF = makeFakePoB('3.0.0');
    const mf = fresh(pobF);
    await mf.ensureReady();
    const order: string[] = [];
    const seen: string[] = [];
    const call1 = mf.run(async (session) => {
      order.push('call1-start');
      await sleep(150);
      seen.push(String(await session.getStats().then(() => 'ok')));
      order.push('call1-end');
    });
    await sleep(20);
    const reload = mf.reload().then((r) => order.push(`reload-done:${r.newVersion}`));
    await sleep(20);
    const call2 = mf.run(async () => {
      order.push('call2');
      assert.equal(runningFakes(), 1, 'one engine during call2');
    });
    await Promise.all([call1, reload, call2]);
    assert.deepEqual(order, ['call1-start', 'call1-end', 'reload-done:3.0.0', 'call2']);
    assert.deepEqual(seen, ['ok'], 'in-flight call completed on the old engine before the swap');
    assert.equal(runningFakes(), 1, 'exactly one running engine after the swap');
    await mf.shutdown();
    assert.equal(runningFakes(), 0);
  }
  log('PASS 1f');

  log('1g [item 2/3]: configure arguments — strict luajitPath, no env-var expansion');
  {
    const secret = 's3cr3t-value-xyz';
    const cfg = tmp('cfg-');
    const ms = fakeManager({ POB_SECRET_TEST: secret, POB_MCP_CONFIG_DIR: cfg });
    const good2 = makeFakePoB('2.6.0');
    for (const arg of ['%POB_SECRET_TEST%', '$POB_SECRET_TEST', '${POB_SECRET_TEST}']) {
      const text = await rejectsWith(ms.configure(arg, luajit), UserError, /does not exist/);
      assert.ok(text.includes(arg), `literal ${arg} expected in: ${text}`);
      assert.ok(!text.includes(secret), `env value leaked via pobPath ${arg}`);
      const t2 = await rejectsWith(ms.configure(good2, arg), UserError);
      assert.ok(!t2.includes(secret), `env value leaked via luajitPath ${arg}`);
    }
    const evil = path.join(tmp('evil-'), process.platform === 'win32' ? 'calc.exe' : 'sh');
    writeFileSync(evil, '');
    await rejectsWith(ms.configure(good2, evil), UserError, /must start with "luajit"/, /executed/);
    await rejectsWith(ms.configure(good2, luajitDir), UserError, /not a file/);
    await rejectsWith(ms.configure(good2, path.join(luajitDir, 'luajit-missing.exe')), UserError, /does not exist/);
    assert.ok(!existsSync(path.join(cfg, 'config.json')), 'rejected arguments must not be saved');
    const versioned = path.join(tmp('lj-ver-'), 'LuaJIT-2.1.0-beta3.exe');
    writeFileSync(versioned, '');
    const ok = await ms.configure(good2, versioned);
    assert.equal(ok.luajitPath, versioned);
    await ms.shutdown();
  }
  log('PASS 1g');

  log('1h [item 4]: crash breaker survives failed configure and reload; resets only when PoB changes');
  {
    const pobH = makeFakePoB('4.0.0');
    const mh = fresh(pobH);
    FakeBridge.crashOnStart = true;
    try {
      for (let i = 1; i <= 3; i++) {
        await rejectsWith(mh.ensureReady(), EngineNotReadyError, /failed to start/);
      }
      await rejectsWith(mh.ensureReady(), EngineNotReadyError, /crashed 3 times/);
      assert.equal((await mh.info()).circuitOpen, true);
      FakeBridge.crashOnStart = false; // even a now-healthy engine must stay refused
      await rejectsWith(mh.configure(pobH, luajit), UserError, /crashed 3 times/);
      await rejectsWith(mh.ensureReady(), EngineNotReadyError, /crashed 3 times/);
      await rejectsWith(mh.reload(), EngineNotReadyError, /crashed 3 times/);
      await rejectsWith(mh.ensureReady(), EngineNotReadyError, /crashed 3 times/);
      const last = FakeBridge.instances[FakeBridge.instances.length - 1];
      assert.equal(last.initialCrashCount, 3, 'new bridge for the same paths inherits the crash count');
      setManifestVersion(pobH, '4.0.1'); // PoB updated on disk → fresh count
      const r = await mh.reload();
      assert.equal(r.newVersion, '4.0.1');
      await mh.ensureReady();
    } finally {
      FakeBridge.crashOnStart = false;
      await mh.shutdown();
    }
  }
  log('PASS 1h');

  log('1i [item 5]: export failure during reload is reported, reload still happens');
  {
    const pobI = makeFakePoB('5.0.0');
    const mi = fresh(pobI);
    await mi.run((s) => s.loadBuild(BUILD_XML));
    FakeBridge.exportFails = true;
    try {
      const r = await mi.reload();
      assert.equal(r.buildReloaded, false);
      assert.match(String(r.buildExportError), /exited unexpectedly/);
      assert.match(String(r.buildNote), /NOT carried over/);
      await mi.ensureReady();
    } finally {
      FakeBridge.exportFails = false;
      await mi.shutdown();
    }
  }
  log('PASS 1i');

  log('1j [item 7]: build that fails to load on the new engine is returned as an import code');
  {
    const pobJ = makeFakePoB('6.0.0');
    const mj = fresh(pobJ);
    await mj.run((s) => s.loadBuild(BUILD_XML));
    FakeBridge.loadFails = true;
    try {
      const r = await mj.reload();
      assert.equal(r.buildReloaded, false);
      assert.match(String(r.buildError), /cannot parse/);
      assert.ok(r.buildCode, 'buildCode expected');
      assert.equal(decodeBuildCode(r.buildCode!), BUILD_XML);
    } finally {
      FakeBridge.loadFails = false;
      await mj.shutdown();
    }
    // Success path carries the build.
    const mk = fresh(makeFakePoB('6.1.0'));
    await mk.run((s) => s.loadBuild(BUILD_XML));
    const ok = await mk.reload();
    assert.equal(ok.buildReloaded, true);
    assert.equal(ok.build?.class, 'Witch');
    await mk.shutdown();
  }
  log('PASS 1j');

  // ---- review round 2 -----------------------------------------------------
  log('1l [r2 item 1]: crash x3 → PoB updates on disk → reload_engine succeeds with a fresh count');
  {
    const pobL = makeFakePoB('8.0.0');
    const ml = fresh(pobL);
    FakeBridge.crashOnStart = true;
    try {
      for (let i = 1; i <= 3; i++) await rejectsWith(ml.ensureReady(), EngineNotReadyError, /failed to start/);
      FakeBridge.crashOnStart = false;
      setManifestVersion(pobL, '8.0.1'); // the update happens AFTER the crashes, with no swap in between
      const r = await ml.reload();
      assert.equal(r.newVersion, '8.0.1');
      const last = FakeBridge.instances[FakeBridge.instances.length - 1];
      assert.equal(last.initialCrashCount, 0, 'fresh count after the install changed');
      await ml.ensureReady();
      // Bounded reset: three new crashes on the UPDATED install open the breaker again.
      FakeBridge.crashOnStart = true;
      for (let i = 1; i <= 3; i++) await rejectsWith(ml.reload(), EngineNotReadyError, /failed to start/);
      FakeBridge.crashOnStart = false;
      await rejectsWith(ml.reload(), EngineNotReadyError, /crashed 3 times/);
      await rejectsWith(ml.ensureReady(), EngineNotReadyError, /crashed 3 times/);
      assert.equal(FakeBridge.instances[FakeBridge.instances.length - 1].initialCrashCount, 3);
    } finally {
      FakeBridge.crashOnStart = false;
      await ml.shutdown();
    }
    // Same, but a tool call hits the open breaker after the update and before reload.
    const pobL2 = makeFakePoB('8.1.0');
    const ml2 = fresh(pobL2);
    FakeBridge.crashOnStart = true;
    try {
      for (let i = 1; i <= 3; i++) await rejectsWith(ml2.ensureReady(), EngineNotReadyError, /failed to start/);
      FakeBridge.crashOnStart = false;
      setManifestVersion(pobL2, '8.1.1');
      await rejectsWith(ml2.ensureReady(), EngineNotReadyError, /crashed 3 times/);
      const r = await ml2.reload();
      assert.equal(r.newVersion, '8.1.1');
      await ml2.ensureReady();
    } finally {
      FakeBridge.crashOnStart = false;
      await ml2.shutdown();
    }
    // Without an install change the breaker stays open across reload.
    const pobL3 = makeFakePoB('8.2.0');
    const ml3 = fresh(pobL3);
    FakeBridge.crashOnStart = true;
    try {
      for (let i = 1; i <= 3; i++) await rejectsWith(ml3.ensureReady(), EngineNotReadyError, /failed to start/);
      FakeBridge.crashOnStart = false;
      await rejectsWith(ml3.reload(), EngineNotReadyError, /crashed 3 times/);
    } finally {
      FakeBridge.crashOnStart = false;
      await ml3.shutdown();
    }
  }
  log('PASS 1l');

  log('1m [r2 item 4]: get_engine_info never starts or respawns the engine');
  {
    const mm = fresh(makeFakePoB('9.0.0'));
    await mm.run((s) => s.loadBuild(BUILD_XML));
    const bridge = FakeBridge.instances[FakeBridge.instances.length - 1];
    const startsBefore = bridge.starts;
    let info = await mm.info();
    assert.equal((info.build as { class?: string } | null)?.class, 'Witch', 'build shown while the engine is up');
    bridge.running = false; // LuaJIT died
    info = await mm.info();
    assert.equal(info.build, null, 'build info omitted while the engine is down');
    assert.equal(info.status, 'stopped', 'a dead engine is not reported as ready');
    bridge.crashCount = 3; // third crash opened the breaker
    info = await mm.info();
    assert.equal(info.status, 'failed', 'an open breaker is not reported as ready');
    assert.equal(info.circuitOpen, true);
    assert.match(String(info.hint), /crashed 3 times.*reload_engine.*restart the MCP server/, 'breaker-open hint says how to recover');
    assert.equal(bridge.starts, startsBefore, 'info() must not respawn the engine');
    assert.equal(bridge.running, false);
    await mm.shutdown();
  }
  log('PASS 1m');

  log('1n [r2 item 5]: an export error with a build loaded is reported, not "no build loaded"; hasBuild() tells them apart');
  {
    const mn = fresh(makeFakePoB('9.1.0'));
    const session = await mn.ensureReady();
    assert.equal(session.hasBuild(), false, 'hasBuild() is false before any build is loaded');
    await session.loadBuild(BUILD_XML);
    assert.equal(session.hasBuild(), true, 'hasBuild() is true once a build is loaded');
    (session as unknown as { exportXML: () => Promise<string> }).exportXML = async () => {
      throw new Error('Lua bridge exited unexpectedly');
    };
    const r = await mn.reload();
    assert.equal(r.buildReloaded, false);
    assert.match(String(r.buildExportError), /exited unexpectedly/);
    assert.match(String(r.buildNote), /NOT carried over/);
    await mn.shutdown();
    const mn2 = fresh(makeFakePoB('9.1.1'));
    await mn2.ensureReady();
    const r2 = await mn2.reload();
    assert.equal(r2.buildExportError, undefined, 'no build loaded is not an error');
    assert.match(String(r2.buildNote), /No build was loaded/);
    await mn2.shutdown();
  }
  log('PASS 1n');

  log('1n2: the real bridge open-breaker error names both ways to clear it');
  {
    // Constructed with the ledger's count already at the limit: start() throws before spawning anything.
    const open = new LuaBridge({ pobPath: 'x', luajitPath: 'y', bridgeLua: 'z' }, 1000, { initialCrashCount: 3 });
    const text = await rejectsWith(open.start(), Error, /crashed 3 times/);
    assert.match(text, /Restart the MCP server/, 'says a server restart clears it');
    assert.match(text, /update Path of Building and then call reload_engine/, 'says a PoB update + reload_engine clears it');
    assert.doesNotMatch(text, /configure_pob_path/, 'does not offer switching paths as a way round the breaker');
  }
  log('PASS 1n2');

  log('1o [r2 item 9]: a saved luajitPath that fails the tool-argument rules is ignored');
  {
    const R = String.raw;
    const good = makeFakePoB('9.2.0');
    const badFile = path.join(tmp('bad-lj-'), process.platform === 'win32' ? 'calc.exe' : 'sh');
    writeFileSync(badFile, '');
    for (const bad of [badFile, R`\\fake-host\share\luajit.exe`]) {
      const cfg = tmp('cfg-');
      write(path.join(cfg, 'config.json'), JSON.stringify({ pobPath: good, luajitPath: bad }));
      const logs: string[] = [];
      const mo = new EngineManager({
        env: { POB_MCP_CONFIG_DIR: cfg },
        bridgeFactory: (p, o) => new FakeBridge(p, o) as unknown as LuaBridge,
        log: (l) => logs.push(l),
        resolveOptions: { pobCandidates: [], luajitCandidates: [{ label: luajit, resolve: () => luajit }] },
      });
      mo.init();
      await mo.ensureReady();
      const info = await mo.info();
      assert.equal(info.luajitPath, luajit, `fell back to auto-detect for ${bad}`);
      assert.equal(info.luajitPathSource, 'auto-detect');
      assert.ok(logs.some((l) => /ignoring saved luajitPath/.test(l)), logs.join('\n'));
      await mo.shutdown();
    }
    // Warn once per invalid saved value, even across repeated configure_pob_path calls
    // (here LuaJIT can't be auto-detected, so configure fails and the bad config stays).
    const cfg = tmp('cfg-');
    write(path.join(cfg, 'config.json'), JSON.stringify({ pobPath: good, luajitPath: badFile }));
    const logs: string[] = [];
    const mw = new EngineManager({
      env: { POB_MCP_CONFIG_DIR: cfg },
      bridgeFactory: (p, o) => new FakeBridge(p, o) as unknown as LuaBridge,
      log: (l) => logs.push(l),
      resolveOptions: { pobCandidates: [], luajitCandidates: [] },
    });
    mw.init();
    for (let i = 0; i < 3; i++) await rejectsWith(mw.configure(good), UserError, /luajit/i);
    assert.equal(logs.filter((l) => /ignoring saved luajitPath/.test(l)).length, 1, logs.join('\n'));
    await mw.shutdown();
  }
  log('PASS 1o');

  log('1q [PR #3 review]: a saved luajitPath survives configure_pob_path without luajitPath');
  {
    const good = makeFakePoB('9.3.0');
    const custom = path.join(tmp('custom-lj-'), process.platform === 'win32' ? 'luajit.exe' : 'luajit');
    writeFileSync(custom, '');
    const cfg = tmp('cfg-');
    const opts = () => ({
      env: { POB_MCP_CONFIG_DIR: cfg },
      bridgeFactory: (p: unknown, o: unknown) => new FakeBridge(p as never, o as never) as unknown as LuaBridge,
      log: () => {},
      resolveOptions: { pobCandidates: [], luajitCandidates: [] }, // not auto-detectable
    });
    const readSaved = () => JSON.parse(readFileSync(path.join(cfg, 'config.json'), 'utf8'));
    const mq = new EngineManager(opts());
    mq.init();
    await mq.configure(good, custom);
    const first = readSaved().luajitPath;
    assert.ok(first, 'explicit luajitPath is saved');
    await mq.configure(good); // reuses the saved binary
    assert.equal((await mq.info()).luajitPathSource, 'config');
    assert.equal(readSaved().luajitPath, first, 'saved luajitPath kept after a configure without it');
    await mq.shutdown();
    const mq2 = new EngineManager(opts()); // next server start still finds LuaJIT
    mq2.init();
    await mq2.ensureReady();
    assert.equal((await mq2.info()).luajitPathSource, 'config');
    await mq2.shutdown();
  }
  log('PASS 1q');

  log('1p [r2 item 3]: network/device paths refused via configure (incl. elicitation path)');
  {
    const R = String.raw;
    const cfg = tmp('cfg-');
    const mp = fakeManager({ POB_MCP_CONFIG_DIR: cfg });
    const good = makeFakePoB('9.3.0');
    for (const unc of [R`\\fake-host\share\pob`, '//fake-host/share/pob', R`\\?\C:\pob`, R`\\.\pipe\pob`]) {
      await rejectsWith(mp.configure(unc, luajit), UserError, /network and device paths/, /POB_PATH/);
      await rejectsWith(mp.configure(good, unc + '\\luajit.exe'), UserError, /network and device paths/, /LUAJIT_PATH/);
    }
    let prompted = 0;
    mp.setPathPrompt(async () => {
      prompted++;
      try {
        await mp.configure(R`\\fake-host\share\pob`);
        return { configured: true };
      } catch (e) {
        return { configured: false, message: (e as Error).message };
      }
    });
    await rejectsWith(mp.ensureReady(), EngineNotReadyError, /network and device paths/);
    assert.equal(prompted, 1);
    assert.ok(!existsSync(path.join(cfg, 'config.json')));
  }
  log('PASS 1p');
}

/**
 * Real child process (node standing in for LuaJIT) — the reviewer's scenario:
 * a command is in flight when the bridge is disposed. The process must die and
 * the pending call must get the retry UserError.
 */
async function partDispose(): Promise<void> {
  log('1k [item 1/6]: LuaBridge.dispose with a command in flight kills the process');
  const dir = tmp('fake-lj-');
  const script = path.join(dir, 'fake-bridge.cjs');
  writeFileSync(
    script,
    `process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const cmd = JSON.parse(line).cmd;
    if (cmd === "shutdown") { process.stdout.write(JSON.stringify({ ok: true }) + "\\n"); setTimeout(() => process.exit(0), 10); }
    // every other command hangs forever (simulates a long calc)
  }
});
setInterval(() => {}, 1000);
`,
  );
  const paths = { pobPath: dir, luajitPath: process.execPath, bridgeLua: script };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitDead = async (pid: number) => {
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(50);
    return !alive(pid);
  };

  // In flight → hard kill + retry error.
  const b1 = new LuaBridge(paths, 30_000);
  await b1.start();
  const pid1 = b1.getPid()!;
  const pending = b1.send({ cmd: 'getStats' });
  const pendingResult = pending.then(
    () => 'resolved',
    (e: unknown) => e,
  );
  await sleep(50);
  await b1.dispose();
  const err = await pendingResult;
  assert.ok(err instanceof UserError, `pending call should get a UserError, got ${String(err)}`);
  assert.match((err as Error).message, /Retry the call/);
  assert.ok(await waitDead(pid1), 'process with an in-flight command must be killed');
  await rejectsWith(b1.start(), UserError, /Retry the call/); // disposed bridge never respawns

  // Idle → graceful shutdown, process gone.
  const b2 = new LuaBridge(paths, 30_000);
  await b2.start();
  const pid2 = b2.getPid()!;
  await b2.dispose();
  assert.ok(await waitDead(pid2), 'idle process must exit on dispose');

  // forceKill reaches a process even after dispose() started and cleared references.
  const b3 = new LuaBridge(paths, 30_000);
  await b3.start();
  const pid3 = b3.getPid()!;
  void b3.send({ cmd: 'hang' }).catch(() => undefined);
  const d3 = b3.dispose();
  b3.forceKill();
  await d3;
  assert.ok(await waitDead(pid3), 'forceKill must kill the captured process');
  log('PASS 1k');
}

// ---------------------------------------------------------------------------
// Part 2/3 — built server over stdio
// ---------------------------------------------------------------------------

type ToolResult = { isError?: boolean; content?: Array<{ type: string; text?: string }> };
const textOf = (r: unknown) => (r as ToolResult).content?.[0]?.text ?? '';

function serverEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'POB_PATH' && k !== 'LUAJIT_PATH' && k !== 'POB_MCP_CONFIG_DIR') env[k] = v;
  }
  return { ...env, ...extra };
}

async function withServer<T>(
  env: Record<string, string>,
  fn: (client: Client) => Promise<T>,
  elicit?: (params: unknown) => { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string> },
): Promise<T> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [builtServer], env, stderr: 'pipe' });
  const stderr: string[] = [];
  transport.stderr?.on('data', (d: Buffer) => stderr.push(d.toString()));
  const client = new Client(
    { name: 'pob-startup-test', version: '0.0.0' },
    { capabilities: elicit ? { elicitation: { form: {} } } : {} },
  );
  if (elicit) client.setRequestHandler(ElicitRequestSchema, async (req) => elicit(req.params));
  try {
    await client.connect(transport);
    return await fn(client);
  } catch (e) {
    console.log(`--- server stderr ---\n${stderr.join('')}`);
    throw e;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function part2(): Promise<void> {
  log('2: build, then start dist/server.js with a missing POB_PATH');
  execFileSync(process.execPath, [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  assert.ok(existsSync(builtServer), 'dist/server.js missing after build');

  const cfgDir = tmp('cfg-');
  const secret = 's3cr3t-e2e-value';
  const env = serverEnv({
    POB_PATH: path.join(os.tmpdir(), 'no-such-pob-dir'),
    POB_MCP_CONFIG_DIR: cfgDir,
    POB_SECRET_TEST: secret,
  });
  await withServer(env, async (client) => {
    // Item 3: tool arguments are never env-expanded, so the env value can't leak.
    const leak = await client.callTool({ name: 'configure_pob_path', arguments: { pobPath: '%POB_SECRET_TEST%' } });
    assert.equal((leak as ToolResult).isError, true);
    assert.ok(textOf(leak).includes('%POB_SECRET_TEST%'), textOf(leak));
    assert.ok(!textOf(leak).includes(secret), 'env value leaked through configure_pob_path');
    // Round 2 item 3: network/device paths are refused at the MCP boundary.
    for (const args of [
      { pobPath: String.raw`\\no-such-host-pobmcp\share\pob` },
      { pobPath: makeFakePoB('1.2.3'), luajitPath: String.raw`\\no-such-host-pobmcp\share\luajit.exe` },
      { pobPath: '//no-such-host-pobmcp/share/pob' },
    ]) {
      const unc = await client.callTool({ name: 'configure_pob_path', arguments: args });
      assert.equal((unc as ToolResult).isError, true);
      assert.match(textOf(unc), /network and device paths/, textOf(unc));
    }
    assert.ok(!existsSync(path.join(cfgDir, 'config.json')), 'refused paths must not be saved');
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['configure_pob_path', 'get_engine_info', 'reload_engine', 'load_build', 'get_stats']) {
      assert.ok(names.includes(n), `tool ${n} missing`);
    }
    const r = await client.callTool({ name: 'get_stats', arguments: {} });
    assert.equal((r as ToolResult).isError, true, 'engine tool should error while unconfigured');
    assert.match(textOf(r), /configure_pob_path/);
    assert.match(textOf(r), /no-such-pob-dir/);
    const info = JSON.parse(textOf(await client.callTool({ name: 'get_engine_info', arguments: {} })));
    assert.equal(info.status, 'unconfigured');
    const scen = await client.callTool({ name: 'list_scenarios', arguments: {} });
    assert.ok(!(scen as ToolResult).isError, 'static tools still work while unconfigured');
  });
  log(`PASS 2 (${'tools listed, isError mentions configure_pob_path'})`);
}

/** LuaJIT processes running THIS checkout's bridge.lua (null when it can't be determined). */
function countBridgeProcesses(): number | null {
  const bridge = path.join(repoRoot, 'lua', 'bridge.lua').toLowerCase();
  try {
    let lines: string[];
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='luajit.exe'\" | ForEach-Object { $_.CommandLine }"],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      );
      lines = out.split(/\r?\n/);
    } else {
      lines = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8', timeout: 10_000 }).split('\n');
    }
    return lines.filter((l) => l.toLowerCase().includes(bridge)).length;
  } catch {
    return null;
  }
}

async function part3(): Promise<void> {
  let real: { pobPath: string; luajitPath: string; version: string | null };
  try {
    const p = resolveAllPaths();
    real = { pobPath: p.pobPath, luajitPath: p.luajitPath, version: p.pobInfo.version };
  } catch (e) {
    console.log(`SKIPPED part 3 (no real PoB/LuaJIT): ${(e as Error).message.split('\n')[0]}`);
    return;
  }
  const fixture = readFileSync(path.join(testDir, 'fixtures', 'OccVortex.xml'), 'utf8');
  const cfgDir = tmp('cfg-');
  const missing = path.join(os.tmpdir(), 'no-such-pob-dir');

  log(`3a: configure_pob_path → ${real.pobPath} (PoB ${real.version})`);
  await withServer(serverEnv({ POB_PATH: missing, POB_MCP_CONFIG_DIR: cfgDir }), async (client) => {
    const poe2 = process.env.APPDATA ? path.join(process.env.APPDATA, 'Path of Building Community (PoE2)') : '';
    if (poe2 && existsSync(poe2)) {
      const r = await client.callTool({ name: 'configure_pob_path', arguments: { pobPath: poe2, luajitPath: real.luajitPath } });
      assert.equal((r as ToolResult).isError, true);
      assert.match(textOf(r), /Path of Exile 2/);
    }
    const r = await client.callTool({
      name: 'configure_pob_path',
      arguments: { pobPath: real.pobPath, luajitPath: real.luajitPath },
    });
    assert.ok(!(r as ToolResult).isError, textOf(r));
    const c = JSON.parse(textOf(r));
    assert.equal(c.pobVersion, real.version);
    const saved = JSON.parse(readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
    assert.equal(saved.pobPath, real.pobPath);

    const load = await client.callTool({ name: 'load_build', arguments: { source: fixture } });
    assert.ok(!(load as ToolResult).isError, textOf(load));
    const info = JSON.parse(textOf(await client.callTool({ name: 'get_engine_info', arguments: {} })));
    assert.equal(info.status, 'ready');
    assert.equal(info.pobVersion, real.version);
    assert.equal(info.installChangedSinceStart, false);
    assert.equal(info.build?.class, 'Witch');
    log(`  engine info: PoB ${info.pobVersion}, layout ${info.layout}`);

    // Item 1: a running engine call and reload_engine at the same time.
    const diagP = client.callTool({ name: 'diagnose_build', arguments: {} });
    await sleep(30);
    const rlP = client.callTool({ name: 'reload_engine', arguments: {} });
    const [diag, rl] = await Promise.all([diagP, rlP]);
    assert.ok(!(diag as ToolResult).isError, `concurrent call failed: ${textOf(diag)}`);
    assert.ok(!(rl as ToolResult).isError, textOf(rl));
    const procs = countBridgeProcesses();
    if (procs !== null) assert.equal(procs, 1, `expected exactly one LuaJIT bridge process, found ${procs}`);
    log(`  concurrent diagnose_build + reload_engine ok; bridge processes: ${procs ?? 'n/a'}`);
    const rj = JSON.parse(textOf(rl));
    assert.equal(rj.buildReloaded, true);
    assert.equal(rj.undoHistoryCleared, true);
    const stats = await client.callTool({ name: 'get_stats', arguments: { categories: ['defense'] } });
    assert.ok(!(stats as ToolResult).isError, textOf(stats));
  });
  log('PASS 3a');

  log('3b: second start with only the temp config dir finds the saved path');
  await withServer(serverEnv({ POB_MCP_CONFIG_DIR: cfgDir }), async (client) => {
    const r = await client.callTool({ name: 'get_stats', arguments: {} });
    assert.ok(!(r as ToolResult).isError && JSON.parse(textOf(r)).defense, `expected stats from a booted engine, got: ${textOf(r)}`);
    const info = JSON.parse(textOf(await client.callTool({ name: 'get_engine_info', arguments: {} })));
    assert.equal(info.status, 'ready');
    assert.equal(info.pobPathSource, 'config');
    assert.equal(info.pobPath, real.pobPath);
  });
  log('PASS 3b');

  log('3c: elicitation — client supplies the path when asked');
  const cfg3 = tmp('cfg-');
  let asked = 0;
  await withServer(
    serverEnv({ POB_PATH: missing, POB_MCP_CONFIG_DIR: cfg3 }),
    async (client) => {
      const r = await client.callTool({ name: 'get_stats', arguments: {} });
      assert.ok(!(r as ToolResult).isError && JSON.parse(textOf(r)).defense, textOf(r));
      assert.equal(asked, 1);
      assert.ok(existsSync(path.join(cfg3, 'config.json')));
    },
    () => {
      asked++;
      return { action: 'accept', content: { pobPath: real.pobPath, luajitPath: real.luajitPath } };
    },
  );
  log('PASS 3c');

  log('3d: elicitation declined → actionable error');
  await withServer(
    serverEnv({ POB_PATH: missing, POB_MCP_CONFIG_DIR: tmp('cfg-') }),
    async (client) => {
      const r = await client.callTool({ name: 'get_stats', arguments: {} });
      assert.equal((r as ToolResult).isError, true);
      assert.match(textOf(r), /declined/);
      assert.match(textOf(r), /configure_pob_path/);
    },
    () => ({ action: 'decline' }),
  );
  log('PASS 3d');
}

async function main(): Promise<void> {
  await part1();
  await partDispose();
  await part2();
  await part3();
}

main()
  .then(() => {
    log('ALL STARTUP TESTS PASSED');
  })
  .catch((e: unknown) => {
    log(`FAILED: ${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });
