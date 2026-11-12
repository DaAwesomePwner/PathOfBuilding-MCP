import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, configFilePath, loadConfig, saveConfig } from '../src/config-store.js';
import { normalizeUserPath } from '../src/path-utils.js';
import {
  LuaJITNotFoundError,
  luajitProbeCandidates,
  PoBInstallNotFoundError,
  pobProbeCandidates,
  resolveLuaJIT,
  resolveLuaJITPath,
  resolvePaths,
  resolvePoB,
  resolvePoBPath,
} from '../src/paths.js';
import { detectUpdateState, fingerprintInstall, inspectPoBInstall, installChanged } from '../src/pob-install.js';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'luajit.exe' : 'luajit';
const REAL_POE1 = process.env.APPDATA ? path.join(process.env.APPDATA, 'Path of Building Community') : '';
const REAL_POE2 = process.env.APPDATA ? path.join(process.env.APPDATA, 'Path of Building Community (PoE2)') : '';
const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

async function withEnv(env: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Fake PoE1 install. layout 'installed' = flattened (Windows installer); 'source' = git clone. */
function makeFakePoB(opts: { layout?: 'installed' | 'source'; version?: string; manifestExtra?: string } = {}): string {
  const dir = tmp('pob-fake-');
  const base = opts.layout === 'source' ? path.join(dir, 'src') : dir;
  write(path.join(base, 'Launch.lua'), '-- fake');
  write(path.join(base, 'Modules', 'Build.lua'), '-- fake');
  write(path.join(base, 'GameVersions.lua'), 'liveTargetVersion = "3_0"\n');
  write(
    path.join(dir, 'manifest.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<PoBVersion>\n\t<Version platform="win32" branch="master" number="${opts.version ?? '9.8.7'}"/>\n${opts.manifestExtra ?? ''}</PoBVersion>\n`,
  );
  return dir;
}

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL: ${name} (${e instanceof Error ? e.message : String(e)})`);
  }
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------- PoB validation
  await test('POB_PATH override accepted when valid (installed layout, version read)', async () => {
    const fake = makeFakePoB();
    await withEnv({ POB_PATH: fake }, () => {
      const r = resolvePoB();
      assert.equal(r.info.dir, path.resolve(fake));
      assert.equal(r.source, 'env');
      assert.equal(r.info.layout, 'installed');
      assert.equal(r.info.version, '9.8.7');
      assert.equal(resolvePoBPath(), path.resolve(fake));
    });
  });

  await test('source-clone layout (src/Launch.lua + src/Modules/Build.lua) accepted', () => {
    const fake = makeFakePoB({ layout: 'source', version: '2.0.0' });
    const r = inspectPoBInstall(fake);
    assert.ok(r.ok);
    assert.equal(r.ok && r.info.layout, 'source');
    assert.equal(r.ok && r.info.version, '2.0.0');
  });

  await test('Launch.lua without Modules/Build.lua is rejected', () => {
    const dir = tmp('pob-launch-only-');
    write(path.join(dir, 'Launch.lua'), '-- fake');
    const r = inspectPoBInstall(dir);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.reason === 'not-pob' && r.message.includes('Modules/Build.lua'), JSON.stringify(r));
  });

  await test('invalid POB_PATH throws without falling back to auto-detect', async () => {
    const empty = tmp('pob-empty-');
    await withEnv({ POB_PATH: empty }, () => {
      assert.throws(() => resolvePoBPath(), (e: unknown) => {
        assert.ok(e instanceof PoBInstallNotFoundError);
        assert.match(e.message, /POB_PATH/);
        assert.match(e.message, /auto-detection was skipped/);
        assert.match(e.message, /configure_pob_path/);
        return true;
      });
    });
  });

  await test('PoE2 marker in manifest.xml is rejected with a PoE2-specific message', () => {
    const fake = makeFakePoB({
      manifestExtra: '\t<Source part="default" url="https://raw.githubusercontent.com/PathOfBuildingCommunity/PathOfBuilding-PoE2/{branch}/"/>\n',
    });
    const r = inspectPoBInstall(fake);
    assert.ok(!r.ok && r.reason === 'poe2' && /Path of Exile 2/.test(r.message), JSON.stringify(r));
  });

  await test('PoE2 GameVersions.lua ("0_x" tree versions) is rejected', () => {
    const fake = makeFakePoB({ layout: 'source' });
    write(path.join(fake, 'src', 'GameVersions.lua'), 'legacyTargetVersion = "0_0"\nliveTargetVersion = "0_1"\n');
    const r = inspectPoBInstall(fake);
    assert.ok(!r.ok && r.reason === 'poe2', JSON.stringify(r));
  });

  await test('real PoE2 install (if present) is rejected; real PoE1 install (if present) accepted', () => {
    if (REAL_POE2 && existsSync(REAL_POE2)) {
      const r = inspectPoBInstall(REAL_POE2);
      assert.ok(!r.ok && r.reason === 'poe2', `PoE2 dir not rejected: ${JSON.stringify(r)}`);
    } else console.log('  (no PoE2 install here — skipped)');
    if (REAL_POE1 && existsSync(REAL_POE1)) {
      const r = inspectPoBInstall(REAL_POE1);
      assert.ok(r.ok, `PoE1 dir rejected: ${JSON.stringify(r)}`);
      assert.match(r.ok ? r.info.version ?? '' : '', /^\d+\.\d+\.\d+/);
    } else console.log('  (no PoE1 install here — skipped)');
  });

  // ---------------------------------------------------------------- env-value edge cases
  await test('normalizeUserPath: quotes, trailing separators, ~, %VAR% and $VAR', () => {
    const base = path.resolve(tmp('pob-norm-'));
    const env = { ...process.env, POBTESTVAR: base, HOME: base, USERPROFILE: base };
    assert.equal(normalizeUserPath(`"${base}${path.sep}"`, env), base);
    assert.equal(normalizeUserPath(`'${base}${path.sep}${path.sep}'`, env), base);
    assert.equal(normalizeUserPath(`  ${base}  `, env), base);
    assert.equal(normalizeUserPath('%POBTESTVAR%/sub', env), path.join(base, 'sub'));
    assert.equal(normalizeUserPath('$POBTESTVAR/sub', env), path.join(base, 'sub'));
    assert.equal(normalizeUserPath('${POBTESTVAR}/sub', env), path.join(base, 'sub'));
    assert.equal(normalizeUserPath('~/sub', env), path.join(base, 'sub'));
    assert.equal(normalizeUserPath('~', env), base);
    assert.equal(normalizeUserPath('""', env), null);
    const root = path.parse(base).root;
    assert.equal(normalizeUserPath(root, env), root);
  });

  await test('quoted POB_PATH with trailing separator resolves', async () => {
    const fake = makeFakePoB();
    await withEnv({ POB_PATH: `"${fake}${path.sep}"` }, () => {
      assert.equal(resolvePoBPath(), path.resolve(fake));
    });
  });

  // ---------------------------------------------------------------- resolution order / probes
  await test('saved config path used when POB_PATH is unset', () => {
    const fake = makeFakePoB();
    const r = resolvePoB({ env: {}, savedPoBPath: fake, pobCandidates: [] });
    assert.equal(r.source, 'config');
    assert.equal(r.info.dir, path.resolve(fake));
  });

  await test('POB_PATH wins over saved config', () => {
    const a = makeFakePoB({ version: '1.0.0' });
    const b = makeFakePoB({ version: '2.0.0' });
    const r = resolvePoB({ env: { POB_PATH: a }, savedPoBPath: b, pobCandidates: [] });
    assert.equal(r.info.version, '1.0.0');
    assert.equal(r.source, 'env');
  });

  await test('stale saved path falls through to auto-detect probes', () => {
    const fake = makeFakePoB();
    const r = resolvePoB({
      env: {},
      savedPoBPath: path.join(os.tmpdir(), 'definitely-not-here-pob'),
      pobCandidates: [{ label: fake, resolve: () => fake }],
    });
    assert.equal(r.source, 'auto-detect');
  });

  await test('not-found error lists every probe (saved, fixed, registry-style)', () => {
    const missing = path.join(os.tmpdir(), 'nope-pob-probe');
    try {
      resolvePoB({
        env: {},
        savedPoBPath: path.join(os.tmpdir(), 'nope-saved'),
        pobCandidates: [
          { label: missing, resolve: () => missing },
          { label: 'registry HKCU\\Fake InstallLocation', resolve: () => null },
        ],
      });
      assert.fail('did not throw');
    } catch (e) {
      assert.ok(e instanceof PoBInstallNotFoundError, String(e));
      for (const needle of ['nope-saved', missing, 'registry HKCU\\Fake InstallLocation', 'configure_pob_path', 'Path of Building Community']) {
        assert.ok(e.message.includes(needle), `message missing "${needle}":\n${e.message}`);
      }
    }
  });

  await test('probe tables cover the documented locations', () => {
    const lin = pobProbeCandidates('linux', { HOME: '/h' }).map((c) => c.label);
    assert.ok(lin.includes(path.join('/h', '.local', 'share', 'Path of Building Community')), lin.join('|'));
    assert.ok(lin.some((l) => l.includes('community.pathofbuilding.PathOfBuilding')), lin.join('|'));
    assert.ok(lin.includes('/opt/path-of-building'));
    const mac = pobProbeCandidates('darwin', { HOME: '/h' }).map((c) => c.label);
    assert.ok(mac[0].includes(path.join('Library', 'Application Support', 'Path of Building Community')));
    const winEnv = { APPDATA: 'C:\\A', ProgramData: 'C:\\PD', LOCALAPPDATA: 'C:\\L', USERPROFILE: 'C:\\U' };
    const win = pobProbeCandidates('win32', winEnv).map((c) => c.label);
    assert.ok(win[0].endsWith('Path of Building Community'));
    assert.ok(win.some((l) => l.startsWith('registry HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Path of Building Community')));
    assert.ok(win.some((l) => l.startsWith('registry HKLM\\')));
    assert.ok(win.some((l) => l.endsWith('Path of Building') && l.includes('PD')));
    assert.ok(win.some((l) => l.includes(path.join('Programs', 'Path of Building Community'))));
    const lj = luajitProbeCandidates('C:\\pob', 'win32', winEnv).map((c) => c.label);
    assert.ok(lj.some((l) => l.includes(path.join('Programs', 'LuaJIT', 'bin', 'luajit.exe'))), lj.join('|'));
    assert.ok(lj.some((l) => l.includes(path.join('scoop', 'shims', 'luajit.exe'))), lj.join('|'));
    assert.ok(lj.some((l) => l.includes('PATH')));
  });

  await test('Windows registry probe finds the installer location (if installed)', () => {
    if (!IS_WIN) return console.log('  (not Windows — skipped)');
    const reg = pobProbeCandidates('win32', process.env).find((c) => c.label.startsWith('registry HKCU'));
    const found = reg?.resolve() ?? null;
    if (!found) return console.log('  (no HKCU uninstall key — skipped)');
    assert.ok(inspectPoBInstall(found).ok, `registry location not a valid install: ${found}`);
  });

  // ---------------------------------------------------------------- LuaJIT
  await test('LUAJIT_PATH file, folder, folder/bin, quoted forms accepted', async () => {
    const dir = tmp('lj-');
    const exe = path.join(dir, EXE);
    writeFileSync(exe, '');
    const binDir = tmp('lj-bin-');
    write(path.join(binDir, 'bin', EXE), '');
    for (const [value, expected] of [
      [exe, exe],
      [dir, exe],
      [`"${dir}${path.sep}"`, exe],
      [binDir, path.join(binDir, 'bin', EXE)],
    ] as const) {
      const r = resolveLuaJIT('/nowhere', { env: { LUAJIT_PATH: value } });
      assert.equal(r.luajitPath, path.resolve(expected), `LUAJIT_PATH=${value}`);
      assert.equal(r.source, 'env');
    }
  });

  await test('nonexistent LUAJIT_PATH throws LuaJITNotFoundError', async () => {
    await withEnv({ LUAJIT_PATH: '/nonexistent/luajit-xyz' }, () => {
      assert.throws(() => resolveLuaJITPath('/tmp'), LuaJITNotFoundError);
    });
  });

  await test('LuaJIT not-found error lists probes and says the installer has no luajit.exe', () => {
    try {
      resolveLuaJIT('/nowhere', {
        env: {},
        savedLuaJITPath: '/saved/luajit',
        luajitCandidates: [{ label: '/probe/luajit', resolve: () => '/probe/luajit' }],
      });
      assert.fail('did not throw');
    } catch (e) {
      assert.ok(e instanceof LuaJITNotFoundError);
      for (const needle of ['/saved/luajit', '/probe/luajit', 'does NOT include luajit.exe', 'configure_pob_path']) {
        assert.ok(e.message.includes(needle), `missing "${needle}"`);
      }
    }
  });

  await test('saved LuaJIT path used before probes', () => {
    const dir = tmp('lj-saved-');
    writeFileSync(path.join(dir, EXE), '');
    const r = resolveLuaJIT('/nowhere', { env: {}, savedLuaJITPath: dir, luajitCandidates: [] });
    assert.equal(r.source, 'config');
  });

  // ---------------------------------------------------------------- combined
  await test('resolvePaths() bridgeLua resolves to an existing file', async () => {
    const fake = makeFakePoB();
    const dir = tmp('lj-');
    const fakeLua = path.join(dir, 'fake-luajit');
    writeFileSync(fakeLua, '#!/bin/sh\n');
    await withEnv({ POB_PATH: fake, LUAJIT_PATH: fakeLua }, () => {
      const result = resolvePaths();
      assert.equal(result.pobPath, path.resolve(fake));
      assert.equal(result.luajitPath, path.resolve(fakeLua));
      assert.ok(existsSync(result.bridgeLua), `bridgeLua should exist: ${result.bridgeLua}`);
      assert.ok(result.bridgeLua.endsWith(path.join('lua', 'bridge.lua')));
    });
  });

  await test('setupTestEnv returns paths and fixturePath', async () => {
    const fake = makeFakePoB();
    const dir = tmp('lj-');
    const fakeLua = path.join(dir, EXE);
    writeFileSync(fakeLua, '');
    await withEnv({ POB_PATH: fake, LUAJIT_PATH: fakeLua }, async () => {
      const { setupTestEnv } = await import('./_skip.js');
      const env = setupTestEnv();
      assert.equal(env.paths.pobPath, path.resolve(fake));
      assert.ok(env.fixturePath.endsWith(path.join('fixtures', 'OccVortex.xml')));
    });
  });

  // ---------------------------------------------------------------- config store
  await test('config dir: override env, per-platform default, save/load round-trip, corrupt file', () => {
    const d = tmp('cfg-');
    assert.equal(configDir({ POB_MCP_CONFIG_DIR: d }), path.resolve(d));
    if (IS_WIN) assert.equal(configDir({ APPDATA: 'C:\\A' }), path.join('C:\\A', 'pob-mcp-server'));
    else if (process.platform === 'linux') {
      assert.equal(configDir({ XDG_CONFIG_HOME: '/x', HOME: '/h' }), path.join('/x', 'pob-mcp-server'));
      assert.equal(configDir({ HOME: '/h' }), path.join('/h', '.config', 'pob-mcp-server'));
    }
    const env = { POB_MCP_CONFIG_DIR: path.join(d, 'nested') };
    assert.deepEqual(loadConfig(env), {});
    const file = saveConfig({ pobPath: '/p', luajitPath: '/l', pobVersion: '1.2.3' }, env);
    assert.equal(file, configFilePath(env));
    assert.deepEqual(loadConfig(env), { pobPath: '/p', luajitPath: '/l', pobVersion: '1.2.3' });
    writeFileSync(file, '{not json');
    assert.deepEqual(loadConfig(env), {});
  });

  // ---------------------------------------------------------------- update state / fingerprint
  await test('update state: none / staged (opFile.txt) / applying (Update/manifest.xml only)', () => {
    const fake = makeFakePoB();
    assert.equal(detectUpdateState(fake), 'none');
    write(path.join(fake, 'Update', 'manifest.xml'), '<PoBVersion/>');
    write(path.join(fake, 'Update', 'opFile.txt'), 'move "a" "b"');
    assert.equal(detectUpdateState(fake), 'staged');
    rmSync(path.join(fake, 'Update', 'opFile.txt'));
    assert.equal(detectUpdateState(fake), 'applying');
    rmSync(path.join(fake, 'Update', 'manifest.xml'));
    write(path.join(fake, 'Update', 'opFileRuntime.txt'), 'start "x"');
    assert.equal(detectUpdateState(fake), 'applying');
  });

  await test('fingerprint changes when manifest.xml version changes', () => {
    const fake = makeFakePoB({ version: '1.0.0' });
    const a = fingerprintInstall(fake);
    assert.equal(a.version, '1.0.0');
    assert.equal(installChanged(a, fingerprintInstall(fake)), false);
    write(path.join(fake, 'manifest.xml'), '<PoBVersion><Version number="1.0.1"/></PoBVersion>');
    const b = fingerprintInstall(fake);
    assert.equal(b.version, '1.0.1');
    assert.equal(installChanged(a, b), true);
  });
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    if (failures > 0) {
      console.log(`${failures} test(s) FAILED`);
      process.exit(1);
    }
    console.log('ALL PATHS TESTS PASSED');
  });
