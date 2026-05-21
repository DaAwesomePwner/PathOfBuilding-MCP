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
      withEnv(
        { POB_PATH: undefined, APPDATA: '/nope/does/not/exist', HOME: '/nope/does/not/exist' },
        () => {
          try {
            resolvePoBPath();
            log('PoBInstallNotFoundError message contains POB_PATH hint', false, 'did not throw');
          } catch (e) {
            const msg = (e as Error).message;
            const ok = msg.includes('POB_PATH') && msg.includes('Path of Building Community');
            log('PoBInstallNotFoundError message contains POB_PATH hint', ok, ok ? '' : msg);
          }
        },
      );
    } catch (e) {
      log('PoBInstallNotFoundError message contains POB_PATH hint', false, String(e));
    }
  }

  // Test: resolvePaths() returns a bridgeLua that exists on disk
  {
    const fake = makeFakePoBInstall();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lj-'));
    const fakeLua = path.join(dir, 'fake-luajit');
    writeFileSync(fakeLua, '#!/bin/sh\n');
    try {
      const { resolvePaths } = await import('../src/paths.js');
      withEnv({ POB_PATH: fake, LUAJIT_PATH: fakeLua }, () => {
        const result = resolvePaths();
        assert.equal(result.pobPath, path.resolve(fake));
        assert.equal(result.luajitPath, fakeLua);
        assert.ok(existsSync(result.bridgeLua), `bridgeLua should exist: ${result.bridgeLua}`);
        assert.ok(
          result.bridgeLua.endsWith(path.join('lua', 'bridge.lua')),
          `bridgeLua should end with lua/bridge.lua, got ${result.bridgeLua}`,
        );
      });
      log('resolvePaths() bridgeLua resolves to an existing file', true);
    } catch (e) {
      log('resolvePaths() bridgeLua resolves to an existing file', false, String(e));
    } finally {
      rmSync(fake, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
