// Runs test/compound-assign-test.lua (unit tests for lua/compound-assign.lua,
// the compound assignment rewrite for PoB 2.68+ sources) under LuaJIT. Needs
// LuaJIT only, not a PoB install.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuaJITNotFoundError, resolveLuaJIT } from '../src/luajit-paths.js';
import { skipOrFail } from './_skip.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(testDir, '..', 'lua', 'compound-assign.lua');
const testLua = path.resolve(testDir, 'compound-assign-test.lua');

let luajitPath: string;
try {
  // LUAJIT_PATH or the probe table; the PoB path only adds <pob>/runtime probes.
  luajitPath = resolveLuaJIT(process.env.POB_PATH ?? '').luajitPath;
} catch (e) {
  if (e instanceof LuaJITNotFoundError) {
    skipOrFail('', e.message);
    process.exit(0);
  }
  throw e;
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-compound-'));
let status: number | null = 1;
try {
  const res = spawnSync(luajitPath, [testLua, modulePath, scratch], { encoding: 'utf8', timeout: 60_000 });
  process.stdout.write(res.stdout ?? '');
  process.stderr.write(res.stderr ?? '');
  if (res.error) throw res.error;
  status = res.status;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (status !== 0) {
  console.error(`FAILED: compound-assign-test.lua exited with ${status}`);
  process.exit(1);
}
console.log('PASSED: compound assignment rewrite');
