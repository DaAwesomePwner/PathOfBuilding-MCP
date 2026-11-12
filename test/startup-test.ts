/**
 * Startup / configuration / version-awareness tests.
 *
 * Part 1 (always runs, no LuaJIT needed): EngineManager against a temp fake
 *   install with a fake bridge — stale detection, update-in-progress gating,
 *   reload, configure, PoE2 rejection, path prompt.
 * Part 2 (always runs): the BUILT server (dist/server.js) with POB_PATH pointing
 *   at a missing dir and an empty temp config dir — it must complete MCP
 *   initialize, list tools, and return an isError result naming configure_pob_path.
 * Part 3 (needs a real PoB + LuaJIT, else SKIPPED): configure_pob_path → engine
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
import type { LuaBridge } from '../src/lua-bridge.js';
import { resolveAllPaths } from '../src/paths.js';
import { UserError } from '../src/validation.js';

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

class FakeBridge {
  static instances: FakeBridge[] = [];
  running = false;
  disposed = false;
  constructor() {
    FakeBridge.instances.push(this);
  }
  async start() {
    if (this.disposed) throw new Error('disposed bridge restarted');
    this.running = true;
  }
  isRunning() {
    return this.running;
  }
  getCrashCount() {
    return 0;
  }
  isCircuitOpen() {
    return false;
  }
  async dispose() {
    this.running = false;
    this.disposed = true;
  }
  killProcess() {
    this.running = false;
  }
}

function fakeManager(env: NodeJS.ProcessEnv): EngineManager {
  return new EngineManager({
    env,
    bridgeFactory: () => new FakeBridge() as unknown as LuaBridge,
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
  const env = serverEnv({ POB_PATH: path.join(os.tmpdir(), 'no-such-pob-dir'), POB_MCP_CONFIG_DIR: cfgDir });
  await withServer(env, async (client) => {
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

    const rl = await client.callTool({ name: 'reload_engine', arguments: {} });
    assert.ok(!(rl as ToolResult).isError, textOf(rl));
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
