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

/**
 * Resolves paths for an integration test. If POB_PATH (or autodetect) can't
 * find a PoB install, prints a SKIP line and exits 0 so the test runner moves on.
 */
export function setupTestEnv(): TestEnv {
  let paths: ResolvedPaths;
  try {
    paths = resolvePaths();
  } catch (e) {
    if (e instanceof PoBInstallNotFoundError || e instanceof LuaJITNotFoundError) {
      console.log(`SKIPPED: ${e.message}`);
      process.exit(0);
    }
    throw e;
  }
  return {
    paths,
    fixturePath: path.join(testDir, 'fixtures', 'OccVortex.xml'),
  };
}
