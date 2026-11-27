import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { rename as realRename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildIdFor,
  MAX_SAMPLE_BUILDS,
  MAX_SAMPLE_FILE_BYTES,
  MAX_SAMPLE_LABEL,
  MAX_SAMPLES,
  SAMPLE_SNAPSHOT_FORMAT,
  SampleStore,
  sampleSlug,
  type SampleBuild,
  type SampleFile,
  type SampleStoreFsOps,
} from '../src/sample-store.js';
import { UserError } from '../src/validation.js';

/** Unit tests for the community sample store; no PoB or LuaJIT needed. */

const tmpDirs: string[] = [];
function freshStore(ops?: Partial<SampleStoreFsOps>): { store: SampleStore; dir: string; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pob-samples-'));
  tmpDirs.push(root);
  const store = new SampleStore({ ...process.env, POB_MCP_CONFIG_DIR: root }, ops);
  return { store, dir: path.join(root, 'samples'), root };
}

const NOW = '2026-11-27T00:00:00.000Z';
function build(id: string, extra: Partial<SampleBuild> = {}): SampleBuild {
  return { id, source: 'code', code: `code-${id}`, addedAt: NOW, ...extra };
}
function emptyFile(name: string): SampleFile {
  return { version: 1, name, createdAt: NOW, updatedAt: NOW, builds: [] };
}
async function rejects(p: Promise<unknown>, re?: RegExp): Promise<UserError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof UserError, `expected UserError, got ${String(e)}`);
    if (re) assert.match(e.message, re);
    return e;
  }
  return assert.fail('expected a UserError');
}
async function add(store: SampleStore, name: string, ...b: SampleBuild[]): Promise<void> {
  await store.update(
    name,
    (f) => ({ file: { ...(f ?? emptyFile(name)), builds: [...(f?.builds ?? []), ...b] }, result: undefined }),
    { create: true }
  );
}
const hexId = (i: number): string => i.toString(16).padStart(12, '0');

async function main(): Promise<void> {
  // ---- slug rules
  assert.equal(sampleSlug('RF Chieftain'), 'rf-chieftain');
  assert.equal(sampleSlug("  Kinetic Blast (3.27) + a_b.c's  "), 'kinetic-blast-3-27-a-b-c-s');
  assert.equal(sampleSlug('x'.repeat(60)), 'x'.repeat(60));
  for (const bad of ['../x', 'a/b', 'a\\b', 'C:\\x', '', '   ', 'x'.repeat(61), 'bad$name', 'tab\there', '...', '---', 'CON', 'com1', 'a\0b', 'née']) {
    assert.throws(() => sampleSlug(bad), UserError, `name ${JSON.stringify(bad)} should be refused`);
  }
  assert.throws(() => sampleSlug(5 as unknown as string), UserError);

  // ---- buildIdFor
  assert.equal(buildIdFor('<PathOfBuilding/>'), buildIdFor('<PathOfBuilding/>'));
  assert.notEqual(buildIdFor('<a/>'), buildIdFor('<b/>'));
  assert.match(buildIdFor('<a/>'), /^[0-9a-f]{12}$/);
  // sha256("abc") = ba7816bf8f01cfea...
  assert.equal(buildIdFor('abc'), 'ba7816bf8f01');

  // ---- round trip: create / get / list / update / delete
  {
    const { store, dir } = freshStore();
    assert.deepEqual(await store.list(), []);
    await rejects(store.get('Nope'), /No sample named "Nope"\. There are no samples yet/);
    await rejects(store.update('Nope', (f) => ({ file: f, result: 1 })), /No sample named/);
    const label = 'L'.repeat(MAX_SAMPLE_LABEL + 50);
    await store.update(
      'My Sample',
      (f) => {
        assert.equal(f, null);
        return {
          file: {
            ...emptyFile('My Sample'),
            builds: [build('aaaaaaaaaaaa', { label, snapshot: { pobVersion: '2.60', format: SAMPLE_SNAPSHOT_FORMAT, data: { a: [1, 2] } } })],
          },
          result: 'ok',
        };
      },
      { create: true }
    );
    const got = await store.get('My Sample');
    assert.equal(got.name, 'My Sample');
    assert.equal(got.builds.length, 1);
    assert.equal(got.builds[0].label?.length, MAX_SAMPLE_LABEL, 'label clipped');
    assert.deepEqual(got.builds[0].snapshot?.data, { a: [1, 2] });
    assert.notEqual(got.updatedAt, NOW, 'store stamps updatedAt');
    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'My Sample');
    assert.equal(listed[0].count, 1);
    assert.equal(listed[0].file, path.join(dir, 'my-sample.json'));
    await add(store, 'My Sample', build('bbbbbbbbbbbb'));
    assert.equal((await store.get('My Sample')).builds.length, 2);
    await rejects(store.get('Other'), /Existing samples: "My Sample"/);
    // update returning null deletes
    assert.equal(await store.update('My Sample', () => ({ file: null, result: 'gone' })), 'gone');
    assert.deepEqual(await store.list(), []);
    await add(store, 'Again', build('cccccccccccc'));
    await store.delete('Again');
    await rejects(store.delete('Again'), /No sample named/);
    assert.deepEqual(readdirSync(dir), []);
  }

  // ---- slug collision between different names
  {
    const { store } = freshStore();
    await add(store, 'RF Chieftain', build('aaaaaaaaaaaa'));
    await rejects(add(store, 'rf-chieftain', build('bbbbbbbbbbbb')), /"RF Chieftain"/);
    await rejects(store.get('rf chieftain'), /"RF Chieftain"/);
    await rejects(store.delete('RF-Chieftain'), /"RF Chieftain"/);
    assert.equal((await store.get('RF Chieftain')).builds.length, 1);
  }

  // ---- caps: refused before writing, file unchanged
  {
    const { store, dir } = freshStore();
    for (let i = 0; i < MAX_SAMPLE_BUILDS; i++) await add(store, 'Full', build(hexId(i)));
    const file = path.join(dir, 'full.json');
    const before = readFileSync(file);
    await rejects(add(store, 'Full', build('ffffffffffff')), /at most 50 builds/);
    assert.ok(before.equals(readFileSync(file)), '51st build leaves the file byte-identical');
    assert.deepEqual(readdirSync(dir), ['full.json']);

    // oversized file
    const big = freshStore();
    await add(big.store, 'Big', build('aaaaaaaaaaaa'));
    const bigFile = path.join(big.dir, 'big.json');
    const bigBefore = readFileSync(bigFile);
    await rejects(
      big.store.update('Big', (f) => ({ file: { ...f!, builds: [build('aaaaaaaaaaaa', { code: 'x'.repeat(MAX_SAMPLE_FILE_BYTES) })] }, result: 0 })),
      /larger than/
    );
    assert.ok(bigBefore.equals(readFileSync(bigFile)));
    assert.deepEqual(readdirSync(big.dir), ['big.json'], 'no tmp left after a refused write');

    // 101st sample
    const many = freshStore();
    for (let i = 0; i < MAX_SAMPLES; i++) {
      await many.store.update(`s${i}`, () => ({ file: emptyFile(`s${i}`), result: 0 }), { create: true });
    }
    assert.equal((await many.store.list()).length, MAX_SAMPLES);
    await rejects(many.store.update('s-extra', () => ({ file: emptyFile('s-extra'), result: 0 }), { create: true }), /At most 100 samples/);
    assert.ok(!existsSync(path.join(many.dir, 's-extra.json')));
    // updating an existing sample at the cap still works
    await add(many.store, 's0', build('aaaaaaaaaaaa'));
  }

  // ---- corrupt / schema-invalid files: UserError naming the path, bytes untouched
  {
    const { store, dir } = freshStore();
    await add(store, 'Good', build('aaaaaaaaaaaa'));
    const cases: Array<[string, string]> = [
      ['broken', '{ not json'],
      ['schema', JSON.stringify({ version: 2, name: 'Schema', builds: [] })],
      ['mismatch', JSON.stringify(emptyFile('Other Name'))],
      ['dupes', JSON.stringify({ ...emptyFile('Dupes'), builds: [build('aaaaaaaaaaaa'), build('aaaaaaaaaaaa')] })],
    ];
    for (const [name, text] of cases) {
      const file = path.join(dir, `${name}.json`);
      writeFileSync(file, text);
      const e1 = await rejects(store.get(name), /not a valid sample/);
      assert.ok(e1.message.includes(file), `error names ${file}`);
      const e2 = await rejects(store.update(name, (f) => ({ file: f ?? emptyFile(name), result: 0 }), { create: true }));
      assert.ok(e2.message.includes(file));
      assert.ok(readFileSync(file).equals(Buffer.from(text)), `${name}: bytes unchanged`);
    }
    const listed = await store.list();
    assert.equal(listed.length, 5);
    const broken = listed.find((l) => l.name === 'broken');
    assert.ok(broken?.error?.includes(path.join(dir, 'broken.json')));
    assert.equal(listed.find((l) => l.name === 'Good')?.error, undefined);
    // delete(name) is the way out
    await store.delete('broken');
    assert.ok(!existsSync(path.join(dir, 'broken.json')));
  }

  // ---- concurrency: parallel appends all land, no tmp files remain
  {
    const { store, dir, root } = freshStore();
    await add(store, 'Race', build(hexId(0)));
    await Promise.all(Array.from({ length: 20 }, (_, i) => add(store, 'Race', build(hexId(i + 1)))));
    const got = await store.get('Race');
    assert.equal(got.builds.length, 21);
    assert.equal(new Set(got.builds.map((b) => b.id)).size, 21);
    // a second instance on the same dir shares the mutex
    const other = new SampleStore({ ...process.env, POB_MCP_CONFIG_DIR: root });
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => add(store, 'Race', build(`a${i}`.padEnd(12, '0')))),
      ...Array.from({ length: 5 }, (_, i) => add(other, 'Race', build(`b${i}`.padEnd(12, '0')))),
    ]);
    assert.equal((await store.get('Race')).builds.length, 31);
    assert.deepEqual(readdirSync(dir), ['race.json']);
    // a failing update does not wedge the queue
    await rejects(
      store.update('Race', () => {
        throw new UserError('boom');
      }),
      /boom/
    );
    assert.equal((await store.get('Race')).builds.length, 31);
  }

  // ---- early sample-count refusal: the callback never runs
  {
    const { store } = freshStore();
    for (let i = 0; i < MAX_SAMPLES; i++) await store.update(`s${i}`, () => ({ file: emptyFile(`s${i}`), result: 0 }), { create: true });
    let called = false;
    await rejects(
      store.update(
        'late',
        () => {
          called = true;
          return { file: emptyFile('late'), result: 0 };
        },
        { create: true }
      ),
      /At most 100 samples/
    );
    assert.equal(called, false, 'callback not invoked for a new sample past the cap');
  }

  // ---- hand-edited files refused on read: too large, too many builds, bad ids
  {
    const { store, dir } = freshStore();
    mkdirSync(dir, { recursive: true });
    const tooMany = { ...emptyFile('Toomany'), builds: Array.from({ length: MAX_SAMPLE_BUILDS + 1 }, (_, i) => build(hexId(i))) };
    const cases: Array<[string, Buffer | string, RegExp]> = [
      ['huge', Buffer.alloc(MAX_SAMPLE_FILE_BYTES + 1, 0x20), /larger than/],
      ['toomany', JSON.stringify(tooMany), /not a valid sample/],
      ['upper', JSON.stringify({ ...emptyFile('Upper'), builds: [build('ABCDEF012345')] }), /not a valid sample/],
      ['short', JSON.stringify({ ...emptyFile('Short'), builds: [build('abc')] }), /not a valid sample/],
    ];
    for (const [name, content, re] of cases) {
      const file = path.join(dir, `${name}.json`);
      writeFileSync(file, content);
      const before = readFileSync(file);
      const e = await rejects(store.get(name), re);
      assert.ok(e.message.includes(file), `${name}: error names the path`);
      await rejects(store.update(name, (f) => ({ file: f, result: 0 }), { create: true }), re);
      assert.ok(before.equals(readFileSync(file)), `${name}: bytes unchanged`);
    }
  }

  // ---- write-side schema check: a caller bug throws a plain Error and writes nothing
  {
    const { store, dir } = freshStore();
    await add(store, 'Valid', build('aaaaaaaaaaaa'));
    const file = path.join(dir, 'valid.json');
    const before = readFileSync(file);
    const plainError = (e: unknown): boolean => e instanceof Error && !(e instanceof UserError);
    const bugs: Array<[string, (f: SampleFile) => SampleFile]> = [
      ['bad id', (f) => ({ ...f, builds: [build('NOT-HEX')] })],
      ['bad source', (f) => ({ ...f, builds: [{ ...build('bbbbbbbbbbbb'), source: 'poe.ninja' as SampleBuild['source'] }] })],
      ['duplicate ids', (f) => ({ ...f, builds: [build('bbbbbbbbbbbb'), build('bbbbbbbbbbbb')] })],
      ['wrong version', (f) => ({ ...f, version: 2 as unknown as 1 })],
    ];
    for (const [what, mutate] of bugs) {
      await assert.rejects(store.update('Valid', (f) => ({ file: mutate(f!), result: 0 })), plainError, `${what}: plain Error`);
      assert.ok(before.equals(readFileSync(file)), `${what}: file unchanged`);
    }
    await assert.rejects(
      store.update('Brand New', () => ({ file: { ...emptyFile('Brand New'), builds: [build('zz')] }, result: 0 }), { create: true }),
      plainError
    );
    assert.deepEqual(readdirSync(dir), ['valid.json'], 'nothing written for a new sample either');
  }

  // ---- a write that fails after its tmp file exists leaves no tmp file; the target stays as it was
  {
    const diskFull: SampleStoreFsOps['rename'] = async () => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    };
    const failing = freshStore({ rename: diskFull });
    await assert.rejects(add(failing.store, 'Doomed', build('aaaaaaaaaaaa')), /disk full/);
    assert.deepEqual(existsSync(failing.dir) ? readdirSync(failing.dir) : [], [], 'failed rename leaves no tmp');

    const { store, dir, root } = freshStore();
    await add(store, 'Keep', build('aaaaaaaaaaaa'));
    const before = readFileSync(path.join(dir, 'keep.json'));
    const failing2 = new SampleStore({ ...process.env, POB_MCP_CONFIG_DIR: root }, { rename: diskFull });
    await assert.rejects(add(failing2, 'Keep', build('bbbbbbbbbbbb')), /disk full/);
    assert.ok(before.equals(readFileSync(path.join(dir, 'keep.json'))), 'old bytes kept');
    assert.deepEqual(readdirSync(dir), ['keep.json']);
  }

  // ---- rename retry: transient EPERM / EBUSY is retried, a persistent one fails and cleans up
  {
    let calls = 0;
    const flaky = freshStore({
      rename: (async (from: string, to: string) => {
        calls++;
        if (calls <= 2) throw Object.assign(new Error('busy'), { code: calls === 1 ? 'EPERM' : 'EBUSY' });
        return realRename(from, to);
      }) as SampleStoreFsOps['rename'],
    });
    await add(flaky.store, 'Flaky', build('aaaaaaaaaaaa'));
    assert.equal(calls, 3, 'two retries then success');
    assert.equal((await flaky.store.get('Flaky')).builds.length, 1);
    assert.deepEqual(readdirSync(flaky.dir), ['flaky.json']);

    let attempts = 0;
    const stuck = freshStore({
      rename: async () => {
        attempts++;
        throw Object.assign(new Error('locked'), { code: 'EPERM' });
      },
    });
    await assert.rejects(add(stuck.store, 'Stuck', build('aaaaaaaaaaaa')), /locked/);
    assert.equal(attempts, 5, 'gives up after 5 attempts');
    assert.deepEqual(readdirSync(stuck.dir), [], 'no tmp left');
  }

  // ---- stale tmp cleanup on first touch
  {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pob-samples-'));
    tmpDirs.push(root);
    const dir = path.join(root, 'samples');
    mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, 'old.json.tmp-123-4');
    const fresh = path.join(dir, 'new.json.tmp-123-5');
    const other = path.join(dir, 'notes.txt');
    for (const f of [stale, fresh, other]) writeFileSync(f, 'x');
    const old = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(stale, old, old);
    utimesSync(other, old, old);
    const store = new SampleStore({ ...process.env, POB_MCP_CONFIG_DIR: root });
    assert.deepEqual(await store.list(), []);
    assert.ok(!existsSync(stale), 'stale tmp removed');
    assert.ok(existsSync(fresh), 'recent tmp kept (a writer may still be running)');
    assert.ok(existsSync(other), 'unrelated files untouched');
  }

  console.log('sample-store tests passed');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });
