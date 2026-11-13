import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LuaJITNotFoundError,
  PoBInstallNotFoundError,
  ResolvedPaths,
  resolvePaths,
} from '../src/paths.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

export interface TestEnv {
  paths: ResolvedPaths;
  fixturePath: string;
}

/** True when REQUIRE_POB=1: missing PoB / LuaJIT / POB_SOURCE_PATH must fail, not skip. */
export function pobRequired(): boolean {
  return process.env.REQUIRE_POB === '1';
}

/**
 * Called wherever a test would skip because PoB, LuaJIT or POB_SOURCE_PATH is
 * missing. Normally prints `SKIPPED<label>: <reason>` and returns, so the caller
 * skips. With REQUIRE_POB=1 prints a FAILED line naming what was missing and
 * exits 1 instead.
 */
export function skipOrFail(label: string, reason: string): void {
  if (pobRequired()) {
    console.error(`FAILED${label}: REQUIRE_POB=1 is set but a prerequisite is missing: ${reason}`);
    process.exit(1);
  }
  console.log(`SKIPPED${label}: ${reason}`);
}

/**
 * Resolves paths for an integration test. If POB_PATH (or autodetect) can't
 * find a PoB install or LuaJIT, prints a SKIP line and exits 0 so the test
 * runner moves on — or exits 1 when REQUIRE_POB=1.
 */
export function setupTestEnv(): TestEnv {
  let paths: ResolvedPaths;
  try {
    paths = resolvePaths();
  } catch (e) {
    if (e instanceof PoBInstallNotFoundError || e instanceof LuaJITNotFoundError) {
      skipOrFail('', e.message);
      process.exit(0);
    }
    throw e;
  }
  return {
    paths,
    fixturePath: path.join(testDir, 'fixtures', 'OccVortex.xml'),
  };
}
