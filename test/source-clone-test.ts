/**
 * Source-clone layout test.
 *
 * Always runs: the working directory LuaJIT is spawned in, for temp
 * directories shaped like each PoB layout (no LuaJIT needed).
 *
 * Runs only when POB_SOURCE_PATH points at a clone of the Path of Building
 * Community repository (Lua under src/, libraries under runtime/): boots the
 * bridge against it, loads test/fixtures/OccVortex.xml twice, and checks that
 * stats come back, PoB reports no error popup, the write guard never fired
 * (dev mode autosave is switched off rather than blocked) and the clone is
 * unchanged on disk. Make a clone with:
 *   git clone --depth 1 https://github.com/PathOfBuildingCommunity/PathOfBuilding <dir>
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveLuaJIT, LuaJITNotFoundError } from '../src/luajit-paths.js';
import { bridgeLuaPath } from '../src/paths.js';
import { bridgeWorkingDir, LuaBridge } from '../src/lua-bridge.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function touch(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '-- stub\n');
}

function sameDir(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function workingDirChoice(): void {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-layout-'));
  try {
    log('Working dir 1: installed layout spawns from the install root');
    const installed = path.join(root, 'installed');
    touch(path.join(installed, 'Launch.lua'));
    touch(path.join(installed, 'Modules', 'Build.lua'));
    assert(sameDir(bridgeWorkingDir(installed), installed), `installed layout: got ${bridgeWorkingDir(installed)}`);
    log('PASS');

    log('Working dir 2: source clone spawns from src/');
    const clone = path.join(root, 'clone');
    touch(path.join(clone, 'src', 'Launch.lua'));
    touch(path.join(clone, 'src', 'Modules', 'Build.lua'));
    touch(path.join(clone, 'runtime', 'lua', 'xml.lua'));
    assert(
      sameDir(bridgeWorkingDir(clone), path.join(clone, 'src')),
      `source layout: got ${bridgeWorkingDir(clone)}`,
    );
    log('PASS');

    log('Working dir 3: a flat install that also has a src/ folder stays flat');
    const both = path.join(root, 'both');
    touch(path.join(both, 'Launch.lua'));
    touch(path.join(both, 'Modules', 'Build.lua'));
    touch(path.join(both, 'src', 'Launch.lua'));
    touch(path.join(both, 'src', 'Modules', 'Build.lua'));
    assert(sameDir(bridgeWorkingDir(both), both), `flat+src layout: got ${bridgeWorkingDir(both)}`);
    log('PASS');

    log('Working dir 4: an unrecognised directory keeps the given path');
    const other = path.join(root, 'other');
    mkdirSync(other);
    assert(sameDir(bridgeWorkingDir(other), other), `unrecognised dir: got ${bridgeWorkingDir(other)}`);
    log('PASS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type Listing = Map<string, string>;

/** Every file and directory under `dir` (except .git) with size and mtime. */
function listTree(dir: string): Listing {
  const out: Listing = new Map();
  const walk = (current: string, rel: string): void => {
    for (const name of readdirSync(current)) {
      if (rel === '' && name === '.git') continue;
      const full = path.join(current, name);
      const key = rel ? `${rel}/${name}` : name;
      const st = statSync(full);
      if (st.isDirectory()) {
        out.set(key, 'dir');
        walk(full, key);
      } else {
        out.set(key, `${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(dir, '');
  return out;
}

function diffListings(before: Listing, after: Listing): string[] {
  const problems: string[] = [];
  for (const [k, v] of before) {
    if (!after.has(k)) problems.push(`removed ${k}`);
    else if (after.get(k) !== v) problems.push(`changed ${k}`);
  }
  for (const k of after.keys()) if (!before.has(k)) problems.push(`created ${k}`);
  return problems;
}

async function cloneIntegration(clone: string): Promise<void> {
  const resolved = path.resolve(clone);
  let luajitPath: string;
  try {
    luajitPath = resolveLuaJIT(resolved).luajitPath;
  } catch (e) {
    if (e instanceof LuaJITNotFoundError) {
      console.log(`SKIPPED (clone integration): ${e.message}`);
      return;
    }
    throw e;
  }
  const xml = readFileSync(path.join(testDir, 'fixtures', 'OccVortex.xml'), 'utf8');

  assert(
    sameDir(bridgeWorkingDir(resolved), path.join(resolved, 'src')),
    `POB_SOURCE_PATH=${resolved} is not a source clone (expected src/Launch.lua and src/Modules/Build.lua)`,
  );
  const before = listTree(resolved);
  const bridge = new LuaBridge({ pobPath: resolved, luajitPath, bridgeLua: bridgeLuaPath() }, 180_000);
  try {
    log('Clone 1: bridge boots against the source clone');
    await bridge.start();
    assert(bridge.isRunning(), 'Bridge should be running after start');
    const data = await bridge.verifyData();
    assert(data.treeNodes > 0 && data.gemsLoaded, 'Tree and gem data should be loaded from the clone');
    log(`PASS: booted (${data.treeNodes} tree nodes)`);

    log('Clone 2: build loads and stats come back');
    const info = await bridge.loadBuildXML(xml, 'OccVortex');
    assert(info.class === 'Witch', `Expected Witch, got ${info.class}`);
    const stats = await bridge.getStats();
    assert(typeof stats.Life === 'number' && stats.Life > 0, `Expected Life > 0, got ${String(stats.Life)}`);
    log(`PASS: loaded, Life=${stats.Life}`);

    log('Clone 3: a second load also succeeds (no dev-autosave popup from the switch)');
    const again = await bridge.loadBuildXML(xml, 'OccVortex');
    assert(again.class === 'Witch', `Expected Witch on reload, got ${again.class}`);
    const stats2 = await bridge.getStats();
    assert(typeof stats2.Life === 'number' && stats2.Life > 0, `Expected Life > 0 on reload, got ${String(stats2.Life)}`);
    log('PASS: second load succeeded');

    log('Clone 4: the write guard never fired');
    const stderr = bridge.getStderr();
    assert(!/blocked .* inside PoB install/.test(stderr), `Bridge tried to write inside the clone:\n${stderr}`);
    log('PASS: no blocked writes');
  } finally {
    await bridge.dispose();
  }

  log('Clone 5: the clone is unchanged on disk');
  const problems = diffListings(before, listTree(resolved));
  assert(problems.length === 0, `Clone changed on disk:\n  ${problems.join('\n  ')}`);
  log('PASS: clone untouched');
}

async function main(): Promise<void> {
  workingDirChoice();

  const clone = process.env.POB_SOURCE_PATH;
  if (!clone || !clone.trim()) {
    console.log('SKIPPED (clone integration): POB_SOURCE_PATH is not set');
    return;
  }
  await cloneIntegration(clone.trim());
  log('All source-clone tests passed');
}

main().catch((e) => {
  console.error(`FAILED: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
