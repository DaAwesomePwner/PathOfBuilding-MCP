# Standalone MCP Server Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert this repo from "upstream PoB fork + mcp-server bolted on" into a standalone `pob-mcp-server` that depends on the user's external Path of Building Community install at `%APPDATA%\Path of Building Community\`.

**Architecture:** A new `src/paths.ts` module centralizes install/luajit discovery (env var override → AppData auto-detect → PATH fallback → typed error). `LuaBridge` and tests consume `ResolvedPaths` instead of computing a `repoRoot` from a parent directory. After all call sites are converted, the upstream PoB tree is deleted and `mcp-server/*` is promoted to repo root with `git mv`, preserving history. Tests skip gracefully (exit 0) when `POB_PATH` cannot be resolved.

**Tech Stack:** TypeScript (Node ≥20), `@modelcontextprotocol/sdk`, Zod, `tsx`, LuaJIT 5.1, Path of Building Community.

**Spec:** `docs/superpowers/specs/2026-05-20-mcp-server-extraction-design.md`

---

## Preconditions

Before starting:

- You have Path of Building Community installed locally. On Windows, it lives at `%APPDATA%\Path of Building Community\`. Verify with: `dir "%APPDATA%\Path of Building Community\src\HeadlessWrapper.lua"` — the file must exist.
- LuaJIT 5.1 is available either at `<POB_PATH>/runtime/luajit{,.exe}` or on PATH. Verify with: `luajit -v` printing `LuaJIT 2.x …`.
- You're on the `master` branch of this repo with a clean working tree (`git status` shows nothing to commit).

If any of these fails, fix it before starting — the plan assumes a green baseline.

---

## Task 1: Add `paths.ts` module

**Files:**
- Create: `mcp-server/src/paths.ts`
- Create: `mcp-server/test/paths-test.ts`

This is a pure-unit-testable module: no LuaJIT spawn, no network. We keep it inside `mcp-server/` for now and will be moved to root in Task 11.

- [ ] **Step 1: Write the failing unit test**

Create `mcp-server/test/paths-test.ts`:

```ts
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PoBInstallNotFoundError,
  LuaJITNotFoundError,
  resolvePoBPath,
  resolveLuaJITPath,
} from '../src/paths.js';

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function makeFakePoBInstall(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pob-fake-'));
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'HeadlessWrapper.lua'), '-- fake');
  return dir;
}

function log(name: string, ok: boolean, msg = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${msg ? ` (${msg})` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  // Test: POB_PATH override wins when valid
  {
    const fake = makeFakePoBInstall();
    try {
      withEnv({ POB_PATH: fake }, () => {
        const resolved = resolvePoBPath();
        assert.equal(resolved, path.resolve(fake));
      });
      log('POB_PATH override accepted when valid', true);
    } catch (e) {
      log('POB_PATH override accepted when valid', false, String(e));
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  }

  // Test: POB_PATH throws PoBInstallNotFoundError when invalid
  {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'pob-empty-'));
    try {
      withEnv({ POB_PATH: empty }, () => {
        assert.throws(() => resolvePoBPath(), PoBInstallNotFoundError);
      });
      log('Invalid POB_PATH throws PoBInstallNotFoundError', true);
    } catch (e) {
      log('Invalid POB_PATH throws PoBInstallNotFoundError', false, String(e));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }

  // Test: LUAJIT_PATH override accepted when file exists
  {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lj-'));
    const fake = path.join(dir, 'fake-luajit');
    writeFileSync(fake, '#!/bin/sh\n');
    try {
      withEnv({ LUAJIT_PATH: fake }, () => {
        const resolved = resolveLuaJITPath(dir);
        assert.equal(resolved, fake);
      });
      log('LUAJIT_PATH override accepted when file exists', true);
    } catch (e) {
      log('LUAJIT_PATH override accepted when file exists', false, String(e));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Test: LUAJIT_PATH throws when file does not exist
  {
    try {
      withEnv({ LUAJIT_PATH: '/nonexistent/luajit-xyz' }, () => {
        assert.throws(() => resolveLuaJITPath('/tmp'), LuaJITNotFoundError);
      });
      log('Nonexistent LUAJIT_PATH throws LuaJITNotFoundError', true);
    } catch (e) {
      log('Nonexistent LUAJIT_PATH throws LuaJITNotFoundError', false, String(e));
    }
  }

  // Test: error message lists probed paths and platform install hints
  {
    try {
      withEnv({ POB_PATH: undefined, APPDATA: '/nope/does/not/exist' }, () => {
        try {
          resolvePoBPath();
          log('PoBInstallNotFoundError message contains POB_PATH hint', false, 'did not throw');
        } catch (e) {
          const msg = (e as Error).message;
          const ok = msg.includes('POB_PATH') && msg.includes('Path of Building Community');
          log('PoBInstallNotFoundError message contains POB_PATH hint', ok, ok ? '' : msg);
        }
      });
    } catch (e) {
      log('PoBInstallNotFoundError message contains POB_PATH hint', false, String(e));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run from repo root: `cd mcp-server && tsx test/paths-test.ts`

Expected: failure because `src/paths.ts` doesn't exist yet — TypeScript or runtime error like `Cannot find module '../src/paths.js'`.

- [ ] **Step 3: Implement `src/paths.ts`**

Create `mcp-server/src/paths.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class PoBInstallNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoBInstallNotFoundError';
  }
}

export class LuaJITNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LuaJITNotFoundError';
  }
}

export interface ResolvedPaths {
  pobPath: string;
  luajitPath: string;
  bridgeLua: string;
}

function defaultPoBCandidates(): string[] {
  const candidates: string[] = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'Path of Building Community'));
  }
  if (process.platform === 'darwin') {
    candidates.push(
      path.join(os.homedir(), 'Library', 'Application Support', 'Path of Building Community'),
    );
  }
  if (process.platform === 'linux') {
    candidates.push(path.join(os.homedir(), '.local', 'share', 'Path of Building Community'));
  }
  return candidates;
}

function isValidPoBInstall(dir: string): boolean {
  return existsSync(path.join(dir, 'src', 'HeadlessWrapper.lua'));
}

export function resolvePoBPath(): string {
  const probed: string[] = [];

  if (process.env.POB_PATH) {
    const abs = path.resolve(process.env.POB_PATH);
    probed.push(abs);
    if (isValidPoBInstall(abs)) return abs;
    throw new PoBInstallNotFoundError(
      `POB_PATH=${process.env.POB_PATH} does not look like a Path of Building install ` +
        `(missing src/HeadlessWrapper.lua at ${abs}). Point POB_PATH at the directory ` +
        `containing src/HeadlessWrapper.lua.`,
    );
  }

  for (const candidate of defaultPoBCandidates()) {
    probed.push(candidate);
    if (isValidPoBInstall(candidate)) return candidate;
  }

  throw new PoBInstallNotFoundError(
    `Could not find a Path of Building Community install. Probed:\n` +
      probed.map((p) => `  - ${p}`).join('\n') +
      `\n\nSet POB_PATH to your install directory. Typical locations:\n` +
      `  Windows: %APPDATA%\\Path of Building Community\n` +
      `  macOS:   ~/Library/Application Support/Path of Building Community\n` +
      `  Linux:   ~/.local/share/Path of Building Community`,
  );
}

export function resolveLuaJITPath(pobPath: string): string {
  const isWin = process.platform === 'win32';
  const exe = isWin ? 'luajit.exe' : 'luajit';

  if (process.env.LUAJIT_PATH) {
    if (existsSync(process.env.LUAJIT_PATH)) return process.env.LUAJIT_PATH;
    throw new LuaJITNotFoundError(
      `LUAJIT_PATH=${process.env.LUAJIT_PATH} does not exist.`,
    );
  }

  const probed: string[] = [];
  for (const candidate of [
    path.join(pobPath, 'runtime', exe),
    path.join(pobPath, 'runtime', 'bin', exe),
  ]) {
    probed.push(candidate);
    if (existsSync(candidate)) return candidate;
  }

  try {
    const which = isWin ? 'where' : 'which';
    const out = execFileSync(which, [isWin ? 'luajit' : 'luajit'], { encoding: 'utf-8' })
      .trim()
      .split(/\r?\n/)[0];
    if (out && existsSync(out)) return out;
    probed.push(`${exe} on PATH (${which} luajit returned: ${out || '<empty>'})`);
  } catch {
    probed.push(`${exe} on PATH (not found)`);
  }

  throw new LuaJITNotFoundError(
    `Could not find a luajit executable. Probed:\n` +
      probed.map((p) => `  - ${p}`).join('\n') +
      `\n\nInstall LuaJIT 5.1:\n` +
      `  Windows (scoop):  scoop install luajit\n` +
      `  Windows (winget): winget install LuaJIT.LuaJIT\n` +
      `  macOS (brew):     brew install luajit\n` +
      `  Linux (apt):      sudo apt-get install luajit\n` +
      `Or set LUAJIT_PATH to a luajit binary.`,
  );
}

export function resolvePaths(): ResolvedPaths {
  const pobPath = resolvePoBPath();
  const luajitPath = resolveLuaJITPath(pobPath);
  // bridge.lua is shipped with this package. From dev (src/paths.ts) or build
  // (dist/paths.js), it sits at ../lua/bridge.lua relative to this module.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bridgeLua = path.resolve(here, '..', 'lua', 'bridge.lua');
  return { pobPath, luajitPath, bridgeLua };
}
```

- [ ] **Step 4: Re-run the test and confirm it passes**

Run: `cd mcp-server && tsx test/paths-test.ts`

Expected output: five `PASS:` lines, exit code 0.

- [ ] **Step 5: Add `test:paths` script and commit**

Edit `mcp-server/package.json` — add to `scripts` (before `test:all`):

```json
    "test:paths": "tsx test/paths-test.ts",
```

Update the `test:all` chain to include it at the front:

```json
    "test:all": "npm run test:paths && npm run test:bridge && npm run test:session && npm run test:server && npm run test:phase3 && npm run test:phase4 && npm run test:phase5 && npm run test:phase6 && npm run test:phase7 && npm run test:integrity && npm run test:errors"
```

Run: `cd mcp-server && npm run test:paths`. Expected: same five `PASS:` lines.

Commit:

```bash
git add mcp-server/src/paths.ts mcp-server/test/paths-test.ts mcp-server/package.json
git commit -m "feat(mcp): add paths module for install/luajit discovery"
```

---

## Task 2: Refactor `LuaBridge` to take `ResolvedPaths`

**Files:**
- Modify: `mcp-server/src/lua-bridge.ts:84-406`

The constructor changes from `(repoRoot, luajitPath?, timeoutMs?)` to `(paths: ResolvedPaths, timeoutMs?)`. `findLuaJITPath()` is deleted (moved to `paths.ts`). `spawnProcess()` uses `paths.bridgeLua` and `paths.pobPath`.

- [ ] **Step 1: Write the failing integration check**

The existing `bridge-test.ts` exercises `LuaBridge` end-to-end. We'll temporarily run it after the refactor to verify the new constructor works — but tests still use the old signature, so we need an adapter test first.

Add this test fragment to `mcp-server/test/paths-test.ts` at the bottom of `main()`, just before the final closing brace:

```ts
  // Test: ResolvedPaths.bridgeLua points at lua/bridge.lua next to this package
  {
    try {
      const { resolvePaths } = await import('../src/paths.js');
      const fake = makeFakePoBInstall();
      const dir = mkdtempSync(path.join(os.tmpdir(), 'lj-'));
      const fakeLua = path.join(dir, process.platform === 'win32' ? 'luajit.exe' : 'luajit');
      writeFileSync(fakeLua, '#!/bin/sh\n');
      try {
        withEnv({ POB_PATH: fake, LUAJIT_PATH: fakeLua }, () => {
          const p = resolvePaths();
          assert.equal(p.pobPath, path.resolve(fake));
          assert.equal(p.luajitPath, fakeLua);
          assert.ok(
            p.bridgeLua.endsWith(path.join('lua', 'bridge.lua')),
            `bridgeLua should end with lua/bridge.lua, got ${p.bridgeLua}`,
          );
        });
        log('resolvePaths() returns pobPath, luajitPath, bridgeLua', true);
      } finally {
        rmSync(fake, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    } catch (e) {
      log('resolvePaths() returns pobPath, luajitPath, bridgeLua', false, String(e));
    }
  }
```

Run: `cd mcp-server && tsx test/paths-test.ts`. The new test passes (the others remain green).

- [ ] **Step 2: Refactor `lua-bridge.ts`**

Edit `mcp-server/src/lua-bridge.ts`:

At the top of the file, add the import:

```ts
import { ResolvedPaths } from './paths.js';
```

Replace the entire `LuaBridge` class declaration and constructor (lines ~84-103 — the block starting with `export class LuaBridge {` through the constructor body). The new version:

```ts
export class LuaBridge {
  private process: ChildProcess | null = null;
  private readonly pobPath: string;
  private readonly luajitPath: string;
  private readonly bridgeLua: string;
  private readonly timeoutMs: number;
  private readonly stderrLines: string[] = [];
  private pending: PendingRequest | null = null;
  private lastLoadedXML: { xml: string; name?: string } | null = null;
  private starting: Promise<void> | null = null;
  private readyResolve: { resolve: () => void; reject: (err: Error) => void; timeout: NodeJS.Timeout } | null = null;
  private stdoutBuffer = '';
  private crashCount = 0;
  private readonly maxCrashes = 3;

  constructor(paths: ResolvedPaths, timeoutMs = 30_000) {
    this.pobPath = paths.pobPath;
    this.luajitPath = paths.luajitPath;
    this.bridgeLua = paths.bridgeLua;
    this.timeoutMs = timeoutMs;
  }
```

Replace the `spawnProcess()` method body — find `private async spawnProcess(): Promise<void> {` and update the first few lines (the `bridgePath` and `srcCwd` derivation). The new top of the method:

```ts
  private async spawnProcess(): Promise<void> {
    const bridgePath = this.bridgeLua;
    const srcCwd = path.join(this.pobPath, 'src');

    this.stderrLines.length = 0;
    this.stdoutBuffer = '';
    const proc = spawn(this.luajitPath, [bridgePath, this.pobPath], {
      cwd: srcCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = proc;
    // … rest of method unchanged …
```

(Keep everything from `proc.stderr?.setEncoding('utf8');` onward exactly as it was.)

Delete the `findLuaJITPath()` method entirely (the block starting `private findLuaJITPath(): string {` through its closing brace).

Remove the now-unused imports at the top of the file: `import { existsSync } from 'fs';` — only if nothing else in the file uses it. (Check with: search for `existsSync` in the file; if it's gone, drop the import.)

- [ ] **Step 3: Update the one server call site**

Edit `mcp-server/src/server.ts` around line 147:

Replace:

```ts
const bridge = new LuaBridge(REPO_ROOT, LUAJIT_PATH, 60_000);
```

with (and add the import + replace `resolveRepoRoot`/`REPO_ROOT`/`LUAJIT_PATH` constants):

```ts
import { resolvePaths, PoBInstallNotFoundError, LuaJITNotFoundError } from './paths.js';
```

Replace the entire `resolveRepoRoot` function and the `REPO_ROOT` / `LUAJIT_PATH` consts (lines ~13-41) with:

```ts
// ---------------------------------------------------------------------------
// Path / config resolution
// ---------------------------------------------------------------------------

import type { ResolvedPaths } from './paths.js';

function resolvePathsOrExit(): ResolvedPaths {
  try {
    return resolvePaths();
  } catch (e) {
    if (e instanceof PoBInstallNotFoundError || e instanceof LuaJITNotFoundError) {
      process.stderr.write(`pob-mcp-server: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}

const PATHS = resolvePathsOrExit();
```

And change the bridge construction (line ~147) from:

```ts
const bridge = new LuaBridge(REPO_ROOT, LUAJIT_PATH, 60_000);
```

to:

```ts
const bridge = new LuaBridge(PATHS, 60_000);
```

Also remove the now-unused imports at the top of `server.ts`: `existsSync` from `fs`, `path`, and `fileURLToPath` from `url` — *only* if no other code in the file uses them. Verify by searching the file.

- [ ] **Step 4: Update the two test call sites that use `LuaBridge` directly**

These will get fully replaced in Task 4. For now, just make them compile against the new constructor so we can run the existing tests.

Edit `mcp-server/test/bridge-test.ts` lines ~32-51. Replace the local `findLuaJIT` function and the bridge instantiation:

Find:

```ts
function findLuaJIT(): string {
  const override = process.env.LUAJIT_PATH;
  if (override) {
    return override;
  }
  try {
    return execFileSync('which', ['luajit'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('luajit was not found on PATH. Set LUAJIT_PATH or install luajit.');
  }
}
```

Delete it. Then find:

```ts
async function main(): Promise<void> {
  const luajitPath = findLuaJIT();
  const xml = readFileSync(fixturePath, 'utf8');
  const bridge = new LuaBridge(repoRoot, luajitPath, 60000);
```

Replace with:

```ts
import { resolvePaths } from '../src/paths.js';

async function main(): Promise<void> {
  process.env.POB_PATH = process.env.POB_PATH ?? repoRoot;
  const paths = resolvePaths();
  const xml = readFileSync(fixturePath, 'utf8');
  const bridge = new LuaBridge(paths, 60000);
```

(Hoist the `import` to the top of the file alongside the other imports — TypeScript allows it anywhere but it's clearer at the top.)

Also remove the unused `import { execFileSync } from 'child_process';` near the top.

Apply the same change to `mcp-server/test/session-test.ts` lines ~40-74.

- [ ] **Step 5: Run the existing tests to confirm nothing regressed**

```bash
cd mcp-server && npm run test:paths && npm run test:bridge && npm run test:session
```

Expected: all three pass. `test:bridge` and `test:session` use the in-repo PoB (via `POB_PATH=repoRoot` set inside the tests).

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/lua-bridge.ts mcp-server/src/server.ts mcp-server/test/bridge-test.ts mcp-server/test/session-test.ts mcp-server/test/paths-test.ts
git commit -m "refactor(mcp): thread ResolvedPaths through LuaBridge"
```

---

## Task 3: Add `_skip.ts` test helper

**Files:**
- Create: `mcp-server/test/_skip.ts`

A small helper that every test imports for `paths` resolution + graceful skip. Eliminates the per-test `repoRoot` / `findLuaJIT` / `fixturePath` boilerplate.

- [ ] **Step 1: Write a sanity test**

Add the following to `mcp-server/test/paths-test.ts` at the bottom of `main()`:

```ts
  // Test: setupTestEnv() returns paths and fixturePath
  {
    try {
      const fake = makeFakePoBInstall();
      const dir = mkdtempSync(path.join(os.tmpdir(), 'lj-'));
      const fakeLua = path.join(dir, process.platform === 'win32' ? 'luajit.exe' : 'luajit');
      writeFileSync(fakeLua, '#!/bin/sh\n');
      try {
        withEnv({ POB_PATH: fake, LUAJIT_PATH: fakeLua }, () => {
          // dynamic import so the env vars are seen
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          return import('./_skip.js').then(({ setupTestEnv }) => {
            const env = setupTestEnv();
            assert.equal(env.paths.pobPath, path.resolve(fake));
            assert.ok(env.fixturePath.endsWith(path.join('fixtures', 'OccVortex.xml')));
          });
        });
        log('setupTestEnv returns paths and fixturePath', true);
      } finally {
        rmSync(fake, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    } catch (e) {
      log('setupTestEnv returns paths and fixturePath', false, String(e));
    }
  }
```

Run: `cd mcp-server && tsx test/paths-test.ts`. The new test fails because `_skip.ts` doesn't exist yet.

- [ ] **Step 2: Create `_skip.ts`**

Create `mcp-server/test/_skip.ts`:

```ts
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
```

- [ ] **Step 3: Run the test, confirm it passes**

Run: `cd mcp-server && tsx test/paths-test.ts`. Expected: all prior `PASS:` lines plus the new one.

- [ ] **Step 4: Commit**

```bash
git add mcp-server/test/_skip.ts mcp-server/test/paths-test.ts
git commit -m "test(mcp): add _skip helper for graceful test skipping"
```

---

## Task 4: Vendor the test fixture

**Files:**
- Create: `mcp-server/test/fixtures/OccVortex.xml`

All 10 integration tests currently load `<repoRoot>/spec/TestBuilds/3.13/OccVortex.xml`. We're about to delete `spec/`, so copy the fixture into the package.

- [ ] **Step 1: Copy the fixture**

```bash
mkdir -p mcp-server/test/fixtures
cp spec/TestBuilds/3.13/OccVortex.xml mcp-server/test/fixtures/OccVortex.xml
```

Verify the copy exists: `ls -la mcp-server/test/fixtures/OccVortex.xml` — expected to show roughly a 27 KB file.

- [ ] **Step 2: Commit**

```bash
git add mcp-server/test/fixtures/OccVortex.xml
git commit -m "test(mcp): vendor OccVortex fixture for standalone build"
```

---

## Task 5: Convert all integration tests to `_skip.ts`

**Files (all under `mcp-server/test/`):**
- Modify: `bridge-test.ts`
- Modify: `session-test.ts`
- Modify: `server-test.ts`
- Modify: `phase3-test.ts`, `phase4-test.ts`, `phase5-test.ts`, `phase6-test.ts`, `phase7-test.ts`
- Modify: `state-integrity-test.ts`
- Modify: `error-handling-test.ts`

Each test currently begins with the same boilerplate (`repoRoot = path.resolve(testDir, '..', '..')`, `fixturePath = path.join(repoRoot, 'spec', …)`, a local `findLuaJIT()`). Replace that boilerplate with `setupTestEnv()`.

There are two flavors of test:

- **Direct LuaBridge tests** (`bridge-test.ts`, `session-test.ts`): instantiate `new LuaBridge(paths, …)` directly.
- **Spawned-server tests** (the rest): spawn `dist/server.js` as a subprocess and pass `POB_PATH` / `LUAJIT_PATH` via the child's env.

We handle both forms below.

- [ ] **Step 1: Convert `bridge-test.ts` (direct flavor)**

Edit `mcp-server/test/bridge-test.ts`. Replace the file's top section (everything from the imports through the `findLuaJIT` function — roughly lines 1-42) with:

```ts
import { Buffer } from 'buffer';
import { readFileSync } from 'fs';
import { deflateRawSync } from 'zlib';
import { decodeBuildCode, LuaBridge } from '../src/lua-bridge.js';
import { setupTestEnv } from './_skip.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function expectRejects(fn: () => Promise<unknown> | unknown, message: string): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(message);
}

function encodeBuildCode(xml: string): string {
  return deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
```

Then find:

```ts
async function main(): Promise<void> {
  const luajitPath = findLuaJIT();
  const xml = readFileSync(fixturePath, 'utf8');
  const bridge = new LuaBridge(repoRoot, luajitPath, 60000);
```

Replace with:

```ts
async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const xml = readFileSync(fixturePath, 'utf8');
  const bridge = new LuaBridge(paths, 60000);
```

Also remove (from this file) the `import { execFileSync } from 'child_process';` and `import path from 'path';` and `import { fileURLToPath } from 'url';` lines — they're no longer needed. Check by searching the file; only delete if unreferenced.

Run: `cd mcp-server && npm run test:bridge`. With `POB_PATH` unset, expected output starts with `SKIPPED:`. With `POB_PATH=<this repo root>` set, expected: all original `PASS:` lines.

- [ ] **Step 2: Convert `session-test.ts` (direct flavor)**

Same pattern as Task 5 Step 1. Replace the top boilerplate (imports through `findLuaJIT`) and the bridge construction inside `main()`:

Replace boilerplate with:

```ts
import { readFileSync } from 'fs';
import { LuaBridge } from '../src/lua-bridge.js';
import { BuildSession } from '../src/build-session.js';
import { setupTestEnv } from './_skip.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
```

Replace the bridge/session construction inside `main()`:

```ts
async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const xml = readFileSync(fixturePath, 'utf8');
  const bridge = new LuaBridge(paths, 60_000);
  const session = new BuildSession(bridge);
```

Remove any unused imports. Run `npm run test:session` to confirm.

- [ ] **Step 3: Convert each spawned-server test**

Repeat this sub-procedure for each of:
- `server-test.ts`
- `phase3-test.ts`
- `phase4-test.ts`
- `phase5-test.ts`
- `phase6-test.ts`
- `phase7-test.ts`
- `state-integrity-test.ts`
- `error-handling-test.ts`

For each file, replace the imports + boilerplate (`testDir`, `repoRoot`, `fixturePath`, `findLuaJIT`) with:

```ts
import { setupTestEnv } from './_skip.js';
```

Keep all other imports that the file already had (`spawn`, `readFileSync`, etc.).

Then inside `main()` (or whichever function first uses the paths), find the existing line(s) like:

```ts
env: { ...process.env, POB_PATH: repoRoot, LUAJIT_PATH: findLuaJIT() } as Record<string, string>,
```

Replace with — at the top of `main()`:

```ts
const { paths, fixturePath } = setupTestEnv();
```

And update the env block:

```ts
env: { ...process.env, POB_PATH: paths.pobPath, LUAJIT_PATH: paths.luajitPath } as Record<string, string>,
```

For each file, after the edit, run that test alone:

```bash
cd mcp-server && npm run test:<phase_or_name>
```

Expected: `PASS:` lines as before, given `POB_PATH=<repo root>` (because the in-repo PoB tree still exists at this point).

- [ ] **Step 4: Run the full test suite as a final verification**

```bash
cd mcp-server && POB_PATH="$(cd .. && pwd)" npm run test:all
```

(On Windows PowerShell: `$env:POB_PATH = (Resolve-Path ..).Path; npm run test:all`)

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/test
git commit -m "test(mcp): route all tests through setupTestEnv helper"
```

---

## Task 6: Update `lua-bridge.ts` `existsSync` import (cleanup verification)

**Files:**
- Modify: `mcp-server/src/lua-bridge.ts` (top imports only)

Verification step — ensure no dead imports remain after the refactor.

- [ ] **Step 1: Inspect imports**

Open `mcp-server/src/lua-bridge.ts` and confirm:

- `import { existsSync } from 'fs';` is **removed** if `existsSync` is no longer referenced (it was only used by `findLuaJITPath`, which is gone).
- `import path from 'path';` — keep if `path.join` is still used (it is, inside `spawnProcess` for the `srcCwd`).
- All other imports are still referenced.

If you find dead imports, delete them.

- [ ] **Step 2: Build to verify**

```bash
cd mcp-server && npm run build
```

Expected: clean compile, no TypeScript errors. The `dist/` directory updates.

- [ ] **Step 3: Commit only if anything changed**

If imports were trimmed:

```bash
git add mcp-server/src/lua-bridge.ts
git commit -m "chore(mcp): drop dead imports after LuaBridge refactor"
```

Otherwise skip the commit.

---

## Task 7: Move `plans/` and the build-instructions doc to `docs/history/`

**Files:**
- Move: `plans/phase*.md` → `docs/history/phase*.md`
- Move: `pob-mcp-build-instructions-v2.md` → `docs/history/pob-mcp-build-instructions-v2.md`
- Create: `docs/history/README.md`

This is bookkeeping before the destructive Task 9. We move first so the history files don't get caught in any wildcard delete by accident.

- [ ] **Step 1: Create the history directory and move the docs**

```bash
mkdir -p docs/history
git mv plans/phase3.md docs/history/phase3.md
git mv plans/phase4.md docs/history/phase4.md
git mv plans/phase5.md docs/history/phase5.md
git mv plans/phase6.md docs/history/phase6.md
git mv plans/phase7.md docs/history/phase7.md
git mv pob-mcp-build-instructions-v2.md docs/history/pob-mcp-build-instructions-v2.md
```

If any of the listed `plans/phase*.md` filenames doesn't exist, first list what's in `plans/`:

```bash
ls plans/
```

— and `git mv` whatever's actually there.

Then remove the now-empty `plans/` directory:

```bash
rmdir plans/
```

- [ ] **Step 2: Add `docs/history/README.md`**

Create `docs/history/README.md`:

```markdown
# Historical design docs

These documents capture the design rationale and phase plans from the original
build-out of `pob-mcp-server` while it lived inside a fork of the Path of
Building Community repo. They reference the pre-extraction repo layout (paths
like `mcp-server/src/...`) and should not be taken as the current architecture.

Kept for provenance and decision history.
```

- [ ] **Step 3: Commit**

```bash
git add docs/history/
git commit -m "docs(history): archive original design docs under docs/history"
```

---

## Task 8: Add MIT `LICENSE`

**Files:**
- Create: `mcp-server/LICENSE`

The upstream `LICENSE.md` belongs to PoB and will be deleted in Task 9. We need our own license. We place it under `mcp-server/` for now so it gets promoted to root in Task 10.

- [ ] **Step 1: Create `mcp-server/LICENSE`**

Create `mcp-server/LICENSE` with MIT text (substitute the actual year and author when prompted; use `2026` and `dap` as placeholders if unsure):

```
MIT License

Copyright (c) 2026 dap

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Commit**

```bash
git add mcp-server/LICENSE
git commit -m "docs(license): add MIT license for mcp-server code"
```

---

## Task 9: Delete the upstream PoB tree

**Files (all deleted from repo root):**

This is the destructive step. Tasks 1-8 have already converted the code, vendored the fixture, archived the design docs, and added our license. Nothing the mcp-server *needs* lives outside `mcp-server/` anymore.

- [ ] **Step 1: Verify the working tree is clean**

```bash
git status
```

Expected: `working tree clean` (or only the new `mcp-server/` content visible if you haven't yet committed Tasks 1-8 — in which case finish those first).

- [ ] **Step 2: List `docs/` to identify what to keep vs delete**

Critical pre-flight: `docs/` contains **both** upstream PoB docs (rundown.md, addingMods.md, …) **and** our spec/plan + history under `docs/superpowers/` and `docs/history/`. Do **not** `git rm -r docs`. Instead, list what's there and delete file-by-file:

```bash
ls docs/
```

Anything that is NOT `superpowers` or `history` is upstream PoB docs. Delete only those.

- [ ] **Step 3: Delete upstream directories and files**

```bash
git rm -r src runtime spec tests
git rm runtime-win32.zip
git rm Dockerfile docker-compose.yml
git rm manifest.xml manifest.cfg update_manifest.py fix_ascendancy_positions.py
git rm CHANGELOG.md changelog.txt CONTRIBUTING.md LICENSE.md README.md RELEASE.md help.txt
```

Then delete upstream PoB doc files specifically (substitute the names you saw in Step 2 — typical list):

```bash
git rm docs/rundown.md docs/addingMods.md docs/addingSkills.md docs/calcOffence.md docs/modSyntax.md
git rm -r docs/Skills docs/img
```

Then delete the Windows binaries at the repo root (expand to the actual file list you have):

```bash
git rm "Path of Building.exe" Update.exe SimpleGraphic.dll SimpleGraphic
git rm *.dll
```

If any of those paths doesn't exist, `git rm` will error — just remove that path from the command. The intent is: every top-level file/dir except `mcp-server/`, `docs/history/`, `docs/superpowers/`, `CLAUDE.md`, and `.git/` must be gone.

Verify with `ls`:

```bash
ls
```

Expected output (order may differ): `CLAUDE.md  docs  mcp-server` (plus dotfiles like `.git`, `.gitignore`). And `ls docs/` should show only `history  superpowers`.

- [ ] **Step 4: Commit the destructive change**

```bash
git commit -m "chore(repo): remove upstream Path of Building tree"
```

Do **not** continue past this commit until tests still work — but tests now require `POB_PATH` to be set to the user's external install. Verify:

```bash
cd mcp-server && npm run test:bridge
```

With `POB_PATH` unset, expected: `SKIPPED: …`.
With `POB_PATH="%APPDATA%\Path of Building Community"` (PowerShell: `$env:POB_PATH = "$env:APPDATA\Path of Building Community"`), expected: original `PASS:` lines.

If the test fails because `POB_PATH` resolves but Lua errors out (e.g., file-not-found inside the bridge), STOP. The problem is most likely that the user's install layout differs from what we expected — re-read `paths.ts`'s validation logic and adjust.

---

## Task 10: Promote `mcp-server/*` to repo root

**Files:**
- Move: every file/dir under `mcp-server/` → repo root.

- [ ] **Step 1: Move with `git mv`**

```bash
git mv mcp-server/src src
git mv mcp-server/lua lua
git mv mcp-server/test test
git mv mcp-server/package.json package.json
git mv mcp-server/package-lock.json package-lock.json
git mv mcp-server/tsconfig.json tsconfig.json
git mv mcp-server/README.md README.md
git mv mcp-server/GETTING_STARTED.md GETTING_STARTED.md
git mv mcp-server/TROUBLESHOOTING.md TROUBLESHOOTING.md
git mv mcp-server/LICENSE LICENSE
```

Confirm `mcp-server/` is now empty (or close to it):

```bash
ls mcp-server/
```

Remove any leftover artifacts (e.g., `node_modules/`):

```bash
rm -rf mcp-server/node_modules
rmdir mcp-server/
```

- [ ] **Step 2: Add a root `.gitignore`**

Create `.gitignore` at the repo root:

```
node_modules/
dist/
*.tgz
```

(If a `.gitignore` already exists from the upstream tree and survived Task 9, edit it to contain just those three lines.)

- [ ] **Step 3: Verify the layout**

```bash
ls
```

Expected output (order may differ): `.gitignore  CLAUDE.md  GETTING_STARTED.md  LICENSE  README.md  TROUBLESHOOTING.md  docs  lua  package-lock.json  package.json  src  test  tsconfig.json`.

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore(repo): promote mcp-server contents to repo root"
```

---

## Task 11: Update `package.json` for the new layout

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json` (if needed)

Now that `src/` is at the repo root (no longer under `mcp-server/`), the `bin` path collapses from `./dist/src/server.js` to `./dist/server.js`. We also flip `private: false` and add publish metadata.

- [ ] **Step 1: Rewrite `package.json`**

Replace the entire file with:

```json
{
  "name": "pob-mcp-server",
  "version": "0.1.0",
  "description": "MCP server exposing Path of Building Community's calculation engine to LLM clients.",
  "type": "module",
  "bin": { "pob-mcp": "./dist/server.js" },
  "main": "./dist/server.js",
  "files": [
    "dist/",
    "lua/",
    "README.md",
    "GETTING_STARTED.md",
    "TROUBLESHOOTING.md",
    "LICENSE"
  ],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc && chmod +x dist/server.js || true",
    "start": "node dist/server.js",
    "dev": "tsx src/server.ts",
    "prepublishOnly": "npm run build",
    "test:paths": "tsx test/paths-test.ts",
    "test:bridge": "tsx test/bridge-test.ts",
    "test:session": "tsx test/session-test.ts",
    "test:server": "tsx test/server-test.ts",
    "test:phase3": "tsx test/phase3-test.ts",
    "test:phase4": "tsx test/phase4-test.ts",
    "test:phase5": "tsx test/phase5-test.ts",
    "test:phase6": "tsx test/phase6-test.ts",
    "test:phase7": "tsx test/phase7-test.ts",
    "test:integrity": "tsx test/state-integrity-test.ts",
    "test:errors": "tsx test/error-handling-test.ts",
    "test:all": "npm run test:paths && npm run test:bridge && npm run test:session && npm run test:server && npm run test:phase3 && npm run test:phase4 && npm run test:phase5 && npm run test:phase6 && npm run test:phase7 && npm run test:integrity && npm run test:errors"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/dap/pob-mcp-server.git"
  },
  "bugs": { "url": "https://github.com/dap/pob-mcp-server/issues" },
  "homepage": "https://github.com/dap/pob-mcp-server#readme",
  "license": "MIT",
  "keywords": [
    "mcp",
    "model-context-protocol",
    "path-of-building",
    "poe",
    "llm",
    "anthropic",
    "claude"
  ],
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/node": "^22.15.3",
    "tsx": "^4.19.4",
    "typescript": "^5.8.3"
  }
}
```

Note: `chmod +x` is wrapped with `|| true` so the build doesn't fail on Windows where chmod isn't available. The bin will still work on Windows because npm uses the package.json bin field directly.

If the actual GitHub repo URL is not `github.com/dap/pob-mcp-server`, replace those three URL strings with the real ones.

- [ ] **Step 2: Verify `tsconfig.json`**

Open `tsconfig.json`. Confirm:

- `"rootDir": "./src"` (already correct from before — the relative directory layout under the moved files is unchanged)
- `"outDir": "./dist"`
- `"include"` (if present) lists `["src/**/*"]`

If anything points at `mcp-server/...`, update it. If the config already uses bare relative paths (which the original did), no change is needed.

- [ ] **Step 3: Reinstall deps + build**

```bash
rm -rf node_modules
npm install
npm run build
```

Expected: clean build with no TypeScript errors. `dist/server.js` exists.

Inspect with: `ls dist/` — expected to contain `server.js`, `build-session.js`, `lua-bridge.js`, `paths.js`, `timing.js`, `validation.js` (and their `.d.ts` files).

- [ ] **Step 4: Smoke-test the built server**

With `POB_PATH` pointing at your real install:

```bash
node dist/server.js
```

Expected: the process starts and waits on stdin (it's an MCP stdio server). After ~2 seconds, send `Ctrl+C`. No errors on stderr.

With `POB_PATH` unset and no AppData install present:

Expected: stderr prints the friendly `PoBInstallNotFoundError` message; process exits 1.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "build(pkg): set publish metadata and root-relative paths"
```

---

## Task 12: Rewrite `README.md`

**Files:**
- Overwrite: `README.md`

The existing `README.md` came from `mcp-server/README.md`. It's mostly correct but references nested paths. Replace it with a top-level, install-from-npm-oriented README.

- [ ] **Step 1: Replace `README.md`**

Overwrite `README.md` with:

````markdown
# pob-mcp-server

An MCP server that exposes [Path of Building Community](https://pathofbuilding.community/)'s build-planning and calculation engine to LLM clients (Claude Desktop, Claude Code, and other [MCP](https://modelcontextprotocol.io/) hosts).

The server runs PoB's real Lua calculation engine in headless mode and surfaces 33 tools for inspecting builds, swapping items and gems, manipulating the passive tree, simulating "what-ifs," and comparing alternatives.

## Prerequisites

1. **Path of Building Community** installed locally. On Windows the installer places it at `%APPDATA%\Path of Building Community\`. Download from <https://pathofbuilding.community/>.
2. **Node.js ≥ 20**.
3. **LuaJIT 5.1** — either bundled in your PoB install at `<POB_PATH>/runtime/luajit{,.exe}`, or on `PATH`, or pointed to by `LUAJIT_PATH`. PoB's own GUI uses an embedded `lua51.dll` and does **not** ship a standalone `luajit` executable on most platforms; you may need to install one:
   - Windows (scoop): `scoop install luajit`
   - Windows (winget): `winget install LuaJIT.LuaJIT`
   - macOS (Homebrew): `brew install luajit`
   - Linux (apt): `sudo apt-get install luajit`

## Quick start

Run via npx (no install):

```bash
npx -y pob-mcp-server
```

Then wire it into your MCP client. **Claude Desktop** — edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pob": {
      "command": "npx",
      "args": ["-y", "pob-mcp-server"],
      "env": {
        "POB_PATH": "C:\\Users\\you\\AppData\\Roaming\\Path of Building Community"
      }
    }
  }
}
```

**Claude Code** — `claude mcp add pob -- npx -y pob-mcp-server` and set `POB_PATH` in your environment.

If your PoB install is at the default `%APPDATA%\Path of Building Community\` location on Windows, the server auto-detects it and `POB_PATH` is optional.

## Configuration

| Env var       | Purpose                                                                                     | Default |
|---------------|---------------------------------------------------------------------------------------------|---------|
| `POB_PATH`    | Path to your PoB install. Validated by checking for `src/HeadlessWrapper.lua` inside.        | Auto-detected on Windows (`%APPDATA%\Path of Building Community`), macOS, and Linux. |
| `LUAJIT_PATH` | Absolute path to a `luajit` binary. Overrides install/PATH detection.                       | Auto-detected. |
| `POB_TIMING`  | When set to `1`, prints per-command timing to stderr (useful for debugging).                | unset |

## Tools

The server exposes 33 MCP tools across seven categories. See [`GETTING_STARTED.md`](./GETTING_STARTED.md) for a narrative tour with examples. Highlights:

- **Build I/O:** `load_build`, `export_build` (XML or PoB build code, round-trip lossless).
- **Inspection:** `get_stats`, `get_items`, `get_skills`, `get_passive_summary`, `describe_build`.
- **Item ops:** `swap_item`, `unequip_item`, `compare_items`, `find_optimal_links`.
- **Gem ops:** `swap_gem`, `add_support_gem`, `find_optimal_support_links`.
- **Tree ops:** `simulate_passive_change`, `find_path_to_node`.
- **Config:** `get_config`, `set_config`, `evaluate_scenario`.
- **State:** `snapshot_build`, `restore_build`, `undo_last_change`, `reset_build`.
- **Analysis:** `diagnose_build`, `suggest_upgrades`.

## Troubleshooting

See [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md). Common issues:

- **PoBInstallNotFoundError** — set `POB_PATH`.
- **LuaJITNotFoundError** — install LuaJIT 5.1 or set `LUAJIT_PATH`.
- **Bridge timeout / crash** — see the troubleshooting doc; the server includes a three-strike circuit breaker that requires a process restart on repeated crashes.

## Development

```bash
git clone https://github.com/dap/pob-mcp-server.git
cd pob-mcp-server
npm install
npm run build
```

Run tests against your local PoB install:

```bash
# Windows PowerShell
$env:POB_PATH = "$env:APPDATA\Path of Building Community"
npm run test:all
```

If `POB_PATH` is unset and auto-detect fails, the integration tests print `SKIPPED:` and exit 0.

Single test file:

```bash
tsx test/bridge-test.ts
```

CI: a GitHub Actions workflow is not yet wired up — contributions welcome.

## License

MIT — see [`LICENSE`](./LICENSE). Path of Building Community remains under its own license at your install.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): rewrite README for standalone npm package"
```

---

## Task 13: Update `GETTING_STARTED.md`

**Files:**
- Modify: `GETTING_STARTED.md`

The existing `GETTING_STARTED.md` (originally `mcp-server/GETTING_STARTED.md`) has a setup section that assumes you ran `cd mcp-server` first. The tool walkthroughs themselves are unchanged.

- [ ] **Step 1: Open `GETTING_STARTED.md` and locate the setup section**

It should be near the top — search for any of `cd mcp-server`, `Quick Start`, `Installation`, or `Setup`.

- [ ] **Step 2: Replace the setup section**

Replace whatever setup text exists with:

```markdown
## Setup

This server requires:

1. **Path of Building Community** installed locally (download from <https://pathofbuilding.community/>). On Windows the default install path is `%APPDATA%\Path of Building Community\`.
2. **Node.js 20+**.
3. **LuaJIT 5.1** on `PATH` or pointed to by `LUAJIT_PATH`. PoB Community does not always bundle a standalone `luajit` binary; if the server reports `LuaJITNotFoundError`, install LuaJIT (see [`README.md`](./README.md#prerequisites)).

To run the server in your MCP client, add this to `claude_desktop_config.json` (Claude Desktop) or run `claude mcp add` (Claude Code):

```json
{
  "mcpServers": {
    "pob": {
      "command": "npx",
      "args": ["-y", "pob-mcp-server"],
      "env": {
        "POB_PATH": "C:\\Users\\you\\AppData\\Roaming\\Path of Building Community"
      }
    }
  }
}
```

`POB_PATH` is optional if your install is at the default Windows location.
```

Leave the rest of the document (the tool tour) intact. Skim it once and adjust any other `cd mcp-server` references you find to the new flat layout.

- [ ] **Step 3: Commit**

```bash
git add GETTING_STARTED.md
git commit -m "docs(getting-started): update setup section for standalone install"
```

---

## Task 14: Update `TROUBLESHOOTING.md`

**Files:**
- Modify: `TROUBLESHOOTING.md`

Add two new entries at the top of the document for the new error classes.

- [ ] **Step 1: Add new top entries**

Open `TROUBLESHOOTING.md`. Add the following two sections at the top (just after the title), keeping all existing content below:

````markdown
## `PoBInstallNotFoundError`

The server cannot find your Path of Building install. The error message lists every path that was probed. Fix it by setting `POB_PATH`:

- **Windows PowerShell**: `$env:POB_PATH = "$env:APPDATA\Path of Building Community"`
- **Windows cmd**: `set POB_PATH=%APPDATA%\Path of Building Community`
- **MCP client config** (preferred for Claude Desktop/Code): add `POB_PATH` to the server's `env` block.

Validate the install by checking for the headless entry point:

```bash
# Windows
dir "%APPDATA%\Path of Building Community\src\HeadlessWrapper.lua"
# macOS / Linux
ls "$POB_PATH/src/HeadlessWrapper.lua"
```

If the file does not exist, your install is incomplete or it is a *source clone* (no compiled binaries). The standalone server expects a compiled PoB Community install.

## `LuaJITNotFoundError`

PoB Community ships an embedded `lua51.dll` for its own GUI but does not generally bundle a standalone `luajit` executable. Install one:

- Windows (scoop): `scoop install luajit`
- Windows (winget): `winget install LuaJIT.LuaJIT`
- macOS (brew): `brew install luajit`
- Linux (apt): `sudo apt-get install luajit`

Or set `LUAJIT_PATH=/path/to/luajit` (the path must be a binary that exists, not just a directory).
````

Leave the rest of the document unchanged. Skim any existing references to paths like `mcp-server/src/...` and update them to the new flat layout (e.g., `src/...`).

- [ ] **Step 2: Commit**

```bash
git add TROUBLESHOOTING.md
git commit -m "docs(troubleshooting): document PoB/LuaJIT install errors"
```

---

## Task 15: Rewrite `CLAUDE.md`

**Files:**
- Overwrite: `CLAUDE.md`

The current `CLAUDE.md` describes a dual-project repo. Replace it with single-project guidance.

- [ ] **Step 1: Overwrite `CLAUDE.md`**

Overwrite `CLAUDE.md` with:

````markdown
# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working on this repository.

## What this repo is

`pob-mcp-server` — a TypeScript/Node MCP server that exposes the [Path of Building Community](https://pathofbuilding.community/) calculation engine to LLM clients. The server spawns a LuaJIT subprocess that runs PoB's real engine in headless mode and drives it via JSON over stdio.

PoB itself is an **external runtime dependency**. The user's PoB install at `%APPDATA%\Path of Building Community\` (or platform equivalent) provides `src/HeadlessWrapper.lua`, the calculation modules, and the lua libraries. This repo owns only the Node server, the Lua bridge adapter, and tests.

## Common commands

```bash
npm install
npm run build         # tsc to dist/, marks dist/server.js executable
npm run dev           # tsx src/server.ts (no build needed)
npm run start         # node dist/server.js (built artifacts)

# Tests — POB_PATH must point at a real PoB install, or each integration test prints SKIPPED and exits 0.
npm run test:paths    # unit tests for paths.ts (no LuaJIT needed)
npm run test:bridge   # ~10s, Lua bridge round-trip — run first when debugging
npm run test:session
npm run test:server
npm run test:phase3   # item swap / compare
npm run test:phase4   # passive tree
npm run test:phase5   # gems
npm run test:phase6   # config / scenarios
npm run test:phase7   # diagnostics / upgrades / export / snapshots
npm run test:integrity  # bit-exact snapshot/restore stress
npm run test:errors   # input validation paths
npm run test:all      # everything (~3 min)
```

Single test: `tsx test/<file>.ts` — they're plain Node scripts.

Env vars:
- `POB_PATH` — path to PoB install. Defaults: `%APPDATA%\Path of Building Community` on Windows, `~/Library/Application Support/Path of Building Community` on macOS, `~/.local/share/Path of Building Community` on Linux.
- `LUAJIT_PATH` — path to a `luajit` binary. Probes `<POB_PATH>/runtime/luajit{,.exe}` and PATH if unset.
- `POB_TIMING=1` — per-command timing on stderr.

## Architecture

```
Claude Desktop  <-stdio MCP->  pob-mcp-server  <-stdio JSON->  bridge.lua (LuaJIT)
                                                                       |
                                                                       v
                                                       <POB_PATH>/src, runtime/lua/, …
```

| Layer | File | Job |
|---|---|---|
| Path resolution | `src/paths.ts` | `resolvePoBPath()` + `resolveLuaJITPath()` — env var, auto-detect, error. Single source of truth for install discovery. |
| Lua bridge | `lua/bridge.lua` | Boots PoB via `HeadlessWrapper.lua`, reads JSON commands from stdin, dispatches to `build.itemsTab`, `build.skillsTab`, `build.spec`, `build.configTab`. Knows nothing about MCP. |
| BuildSession | `src/build-session.ts` | TS class owning the LuaJIT subprocess. Snapshot/restore, undo stack, `withTemporaryChange`, async mutex, build-code/URL/XML loading, higher-level workflows. |
| MCP server | `src/server.ts` | Registers 33 tools via `@modelcontextprotocol/sdk`, validates with Zod + `UserError`, formats responses. |

## Non-negotiable invariants

- **One LuaJIT process per session.** Engine boot is ~2s; pre-warmed on startup.
- **Serial execution via async mutex.** PoB is single-threaded with shared globals. Two ops at once corrupts state.
- **Snapshot-and-restore for "what-if" queries.** Every `simulate_*`, `compare_*`, `find_*`, `evaluate_*` wraps its probe in a `try/finally` snapshot/restore pair. Must restore bit-exact (`Life`, `CombinedDPS`, `TotalEHP` spot-checked in `state-integrity-test.ts`).
- **Three-strike crash circuit breaker.** After 3 unexpected LuaJIT exits, the server refuses respawns. Don't disable — it prevents silent respawn loops.
- **Mutations push to the undo stack.** `swap_item`, `unequip_item`, `swap_gem`, `set_config`, and the commit-variant of `simulate_passive_change` push. `undo_last_change` pops; `reset_build` reverts to the originally-loaded XML.
- **Error classification.** User-input errors (bad slot, unknown gem) → `UserError`, surfaced verbatim. Anything else → "Internal error: ... try reset_build".

## Adding a tool

1. Extend `lua/bridge.lua` with a new dispatch case.
2. Expose it in `BuildSession` (route mutations through `withLock`, push to undo stack as needed).
3. Register a Zod-validated entry in `src/server.ts`.

All 33 existing tools follow this pattern.

## Conventions

- **Item text format** in MCP tools comes from PoB's "Copy item" (right-click) — must start with a `Rarity:` line. The server validates strictly.
- **Build code round-trip is lossless.** `export_build({format:"code"})` produces a base64 zlib string that `load_build` accepts back. Same for `xml`.

## Reference files

- [`README.md`](./README.md) — installation, configuration, tool catalog.
- [`GETTING_STARTED.md`](./GETTING_STARTED.md) — narrative tour with examples.
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — error catalog and fixes.
- [`docs/history/`](./docs/history/) — original design rationale and phase plans, pre-extraction.
````

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): rewrite for standalone repo"
```

---

## Task 16: Final verification

**Files:** none — verification only.

- [ ] **Step 1: Clean rebuild**

```bash
rm -rf node_modules dist *.tgz
npm install
npm run build
```

Expected: clean install + build, no warnings about path resolution or missing files.

- [ ] **Step 2: Run unit tests (no PoB required)**

```bash
npm run test:paths
```

Expected: every `PASS:` line, exit 0.

- [ ] **Step 3: Run full integration suite against the real install**

PowerShell:

```powershell
$env:POB_PATH = "$env:APPDATA\Path of Building Community"
npm run test:all
```

Bash:

```bash
POB_PATH="$HOME/.local/share/Path of Building Community" npm run test:all
```

Expected: every test passes. Total time ~3 minutes.

- [ ] **Step 4: Negative-path verification**

In a shell where `POB_PATH` is unset and no AppData install exists (or temporarily rename the AppData folder if you're on Windows with one):

```bash
npm run test:bridge
```

Expected: `SKIPPED: Could not find a Path of Building Community install. Probed: …` and exit 0.

- [ ] **Step 5: Smoke-test the published package shape**

```bash
npm pack
```

Inspect the produced tarball name (e.g., `pob-mcp-server-0.1.0.tgz`) and verify its contents:

```bash
tar -tzf pob-mcp-server-0.1.0.tgz | head -40
```

Expected: every entry under `package/` is in `dist/`, `lua/`, `README.md`, `GETTING_STARTED.md`, `TROUBLESHOOTING.md`, or `LICENSE`. **No** `test/`, `src/`, `node_modules/`, `docs/`, or upstream-PoB files.

Then run from the tarball:

```bash
npx ./pob-mcp-server-0.1.0.tgz
```

Expected: the server starts and waits on stdin. Send `Ctrl+C` and confirm no stderr errors (except the expected "Lua bridge exited" on shutdown, which is fine).

Clean up:

```bash
rm pob-mcp-server-0.1.0.tgz
```

- [ ] **Step 6: Final commit (only if anything stage-changed during verification)**

If verification left any uncommitted changes (e.g., you fixed something inline), commit them now with a focused message. Otherwise, skip.

- [ ] **Step 7: Out-of-scope reminder**

`npm publish` is intentionally **not** part of this plan. Trigger it manually when you're ready and confident the npm package name is available (or scope it under `@dap/`):

```bash
npm publish --access public
```

---

## Out of Scope (do not attempt as part of this plan)

- Publishing to npm.
- Setting up GitHub Actions CI.
- Adding new MCP tools or features.
- Bundling LuaJIT or shimming `lua51.dll` via FFI.
- Cross-platform install autodetect beyond the documented platform defaults.
- Refactoring any code not directly related to install/path decoupling.
