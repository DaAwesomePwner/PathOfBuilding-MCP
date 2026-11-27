// Community samples (src/community-samples.ts): add_sample_builds,
// list_samples, remove_sample_builds and freshSampleSnapshots, on the sample
// store in a temporary POB_MCP_CONFIG_DIR.
//
//   0. Refusals before any engine start: 21 builds in one call, a bad source,
//      a 51st build in a sample.
//   1. Add 3 builds (raw XML, build code, build code) and one PoB refuses:
//      3 added with class / ascendancy / main skill / level, 1 `failed` with
//      its reason, one temporary engine; the live build, undo depth and crash
//      journal unchanged.
//   2. Duplicates (same XML as raw XML and as a code) are reported, not added,
//      and start no engine.
//   3. list_samples: all / sample / sample + build / + slot (item text that
//      swap_item accepts, for a gear slot and a tree jewel); bad lookups refused.
//      compareSnapshot without itemText has no item text.
//   4. freshSampleSnapshots: stale snapshots (other pobVersion / format) are
//      re-read in one temporary engine and saved; a build PoB now refuses is
//      dropped from the result but kept in the file.
//   5. A temporary engine that crashes or times out fails add_sample_builds
//      with nothing saved; the live engine keeps working with no strike.
//      With the live crash breaker open the call is refused naming the tool.
//   6. remove_sample_builds: unknown id refused with nothing changed, ids
//      removed, deleteSample removes the file.
//   7. Over MCP: the three tools are reachable and reply compact JSON.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { BuildSession } from '../src/build-session.js';
import { encodeBuildCode } from '../src/build-source.js';
import { addSampleBuilds, freshSampleSnapshots, listSamples, removeSampleBuilds } from '../src/community-samples.js';
import { TemporaryEngineError } from '../src/compare-builds.js';
import { EngineManager } from '../src/engine-manager.js';
import { LuaBridge } from '../src/lua-bridge.js';
import { buildIdFor, SAMPLE_SNAPSHOT_FORMAT, SampleStore } from '../src/sample-store.js';
import { UserError } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

// Always a fresh directory: these tests write sample files.
process.env.POB_MCP_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-samples-'));

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'src', 'server.ts');

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function expectError<T extends Error>(p: Promise<unknown>, cls: new (...a: never[]) => T, pattern: RegExp, label: string): Promise<T> {
  try {
    await p;
  } catch (e) {
    assert(e instanceof cls, `${label}: expected ${cls.name}, got ${String(e)}`);
    assert(pattern.test(e.message), `${label}: unexpected message: ${e.message}`);
    return e;
  }
  throw new Error(`${label}: expected an error`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** JSON with object keys sorted (Lua's pairs() order is not stable across processes). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const RING = `Rarity: RARE
Sample Ring
Coral Ring
Item Level: 63
Implicits: 1
+30 to maximum Life
+150 to maximum Life
+30% to all Elemental Resistances`;
const TREE_SOCKET = 36634; // holds the fixture's Cataclysm Stone
const BAD_XML = '<PathOfBuilding><Build level="1"';
const SAMPLE = 'Test Sample';

interface BuildRow { id: string; label?: string; class: string | null; ascendancy: string | null; mainSkill: string | null; level: number | null; stale?: boolean }
interface AddResult { sample: string; count: number; added: BuildRow[]; duplicates: Array<{ id: string; label?: string }>; failed: Array<{ index: number; label?: string; error: string }> }

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const fixtureXml = readFileSync(fixturePath, 'utf8').trim();
  const masteriesXml = readFileSync(path.join(path.dirname(fixturePath), 'ConvertTreeMasteries.xml'), 'utf8').trim();
  const itemSetsXml = readFileSync(path.join(path.dirname(fixturePath), 'OccVortexItemSets.xml'), 'utf8').trim();

  const temp: Array<{ bridge: LuaBridge; pid?: number }> = [];
  const engine = new EngineManager({
    temporaryBridgeFactory: (p, o) => {
      const bridge = new LuaBridge(p, o.timeoutMs, { testFaults: o.testFaults });
      const rec: { bridge: LuaBridge; pid?: number } = { bridge };
      temp.push(rec);
      const start = bridge.start.bind(bridge);
      bridge.start = async () => {
        try {
          await start();
        } finally {
          rec.pid = bridge.getPid() ?? rec.pid;
        }
      };
      return bridge;
    },
  });
  const store = new SampleStore();
  const sampleFile = path.join(store.dir, 'test-sample.json');
  const run = <T>(fn: (s: BuildSession) => Promise<T>): Promise<T> => engine.run(fn);
  const add = (args: { sample: string; builds: Array<{ source: string; label?: string }> }, opts = {}): Promise<AddResult> =>
    run(() => addSampleBuilds(engine, store, args, opts)) as unknown as Promise<AddResult>;
  const list = (args: { sample?: string; build?: string; slot?: string } = {}): Promise<Record<string, unknown>> => listSamples(engine, store, args);
  const liveBridge = (s: BuildSession): LuaBridge => (s as unknown as { bridge: LuaBridge }).bridge;
  const liveState = (): Promise<string> =>
    run(async (s) => JSON.stringify([await s.exportXML(), s.undoStackDepth(), liveBridge(s).getRecoveryState(), liveBridge(s).getSpawnCount()]));
  const allTempDead = async (label: string): Promise<void> => {
    assert(engine.temporaryEngineCount() === 0, `${label}: a temporary engine is still registered`);
    for (const t of temp) {
      assert(!t.bridge.isRunning(), `${label}: a temporary bridge still runs`);
      if (t.pid !== undefined) assert(await waitDead(t.pid), `${label}: temporary LuaJIT process ${t.pid} is still alive`);
    }
  };

  try {
    await run(async (s) => {
      await s.loadBuild(fixtureXml);
      await s.loadBuild(await s.exportXML());
    });
    // B: the fixture with a ring swapped and a config option set.
    const codeB = await run(async (s) => {
      await s.swapItemWithDiff('Ring 1', RING);
      await s.setConfigWithUndo({ usePowerCharges: true });
      const code = await s.exportBuild('code');
      await s.undoLastChange();
      await s.undoLastChange();
      return code;
    });
    const stateBefore = await liveState();
    const codeC = encodeBuildCode(masteriesXml);

    log('Test 0: refusals before any engine start');
    const many = Array.from({ length: 21 }, () => ({ source: codeB }));
    await expectError(add({ sample: SAMPLE, builds: many }), UserError, /1-20 builds/, '21 builds');
    await expectError(add({ sample: SAMPLE, builds: [{ source: 'https://poe.ninja/builds/x' }] }), UserError, /^builds\[0\]\.source: Unsupported build URL host/, 'poe.ninja link');
    await expectError(add({ sample: 'bad/name', builds: [{ source: codeB }] }), UserError, /may only contain/, 'bad sample name');
    await store.update('Full Sample', () => ({
      file: {
        version: 1, name: 'Full Sample', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        builds: Array.from({ length: 50 }, (_, i) => ({ id: i.toString(16).padStart(12, '0'), source: 'code' as const, code: 'x', addedAt: '2026-01-01T00:00:00.000Z' })),
      },
      result: null,
    }), { create: true });
    await expectError(add({ sample: 'Full Sample', builds: [{ source: codeB }] }), UserError, /at most 50 builds: "Full Sample" has 50/, '51st build');
    assert(temp.length === 0, `a refused call started ${temp.length} temporary engine(s)`);
    assert(!existsSync(sampleFile), 'a refused call created the sample');
    log('PASS');

    log('Test 1: add 3 builds and one Path of Building refuses');
    let t0 = Date.now();
    const added = await add({
      sample: SAMPLE,
      builds: [
        { source: fixtureXml, label: 'Occ Vortex XML' },
        { source: codeB, label: 'with ring' },
        { source: codeC },
        { source: BAD_XML, label: 'broken' },
      ],
    });
    log(`  add_sample_builds: ${Date.now() - t0} ms`);
    assert(added.sample === SAMPLE && added.count === 3 && added.added.length === 3 && added.duplicates.length === 0, `add: ${JSON.stringify(added)}`);
    assert(added.failed.length === 1 && added.failed[0].index === 3 && added.failed[0].label === 'broken' &&
      /could not load the builds\[3\] build: Invalid Path of Building XML/.test(added.failed[0].error), `failed: ${JSON.stringify(added.failed)}`);
    const [rowA, rowB, rowC] = added.added;
    assert(rowA.id === buildIdFor(fixtureXml) && rowA.label === 'Occ Vortex XML', `row A: ${JSON.stringify(rowA)}`);
    for (const r of added.added) {
      assert(r.class === 'Witch' && r.ascendancy === 'Occultist' && typeof r.mainSkill === 'string' && r.mainSkill.length > 0 && typeof r.level === 'number' && r.level > 0,
        `summary: ${JSON.stringify(r)}`);
    }
    assert(rowB.label === 'with ring' && rowC.label === undefined && new Set([rowA.id, rowB.id, rowC.id]).size === 3, 'ids / labels');
    assert(temp.length === 1, `temporary engines: ${temp.length}`);
    await allTempDead('after add');
    assert((await liveState()) === stateBefore, 'add_sample_builds changed the live build, undo depth or journal');
    const saved = JSON.parse(readFileSync(sampleFile, 'utf8')) as { builds: Array<{ id: string; source: string; code: string; snapshot: { pobVersion: string; format: number; data: { items: Array<{ slot: string; text?: string }> } } }> };
    assert(saved.builds.map((b) => b.source).join() === 'xml,code,code', `sources: ${saved.builds.map((b) => b.source)}`);
    assert(saved.builds.every((b) => b.snapshot.format === SAMPLE_SNAPSHOT_FORMAT && b.snapshot.pobVersion === (engine.pobVersion() ?? 'unknown')), 'snapshot version / format');
    assert(saved.builds[0].snapshot.data.items.length > 5 && saved.builds[0].snapshot.data.items.every((i) => typeof i.text === 'string' && i.text.startsWith('Rarity:')),
      'snapshot items carry their text');
    log('PASS');

    log('Test 2: duplicates are reported, not added');
    const dup = await add({ sample: SAMPLE, builds: [{ source: fixtureXml, label: 'again' }, { source: encodeBuildCode(fixtureXml) }] });
    assert(dup.count === 3 && dup.added.length === 0 && dup.failed.length === 0, `dup: ${JSON.stringify(dup)}`);
    assert(dup.duplicates.length === 2 && dup.duplicates.every((d) => d.id === rowA.id) && dup.duplicates[0].label === 'again', `duplicates: ${JSON.stringify(dup.duplicates)}`);
    assert(temp.length === 1, 'duplicates started a temporary engine');
    log('PASS');

    log('Test 3: list_samples');
    const all = (await list()) as { samples: Array<{ name: string; count: number; updatedAt: string; ascendancies: Array<{ name: string; count: number }>; mainSkills: unknown[]; error?: string }> };
    const mine = all.samples.find((x) => x.name === SAMPLE);
    assert(all.samples.length === 2 && mine && mine.count === 3 && mine.updatedAt, `all samples: ${JSON.stringify(all)}`);
    assert(JSON.stringify(mine.ascendancies) === '[{"name":"Occultist","count":3}]' && mine.mainSkills.length >= 1, `top: ${JSON.stringify(mine)}`);
    const one = (await list({ sample: SAMPLE })) as { count: number; builds: Array<BuildRow & { addedAt: string }> };
    assert(one.count === 3 && one.builds.length === 3 && one.builds.every((b) => b.addedAt && !b.stale && b.class === 'Witch'), `sample: ${JSON.stringify(one)}`);
    const full = (await list({ sample: 'Full Sample' })) as { builds: BuildRow[] };
    assert(full.builds.length === 50 && full.builds.every((b) => b.stale === true && b.class === null), 'builds without a snapshot are stale');
    const detail = (await list({ sample: SAMPLE, build: rowB.id })) as { build: BuildRow & { source: string }; items: Array<{ slot: string; name: string | null; base: string | null; rarity: string | null }> };
    assert(detail.build.id === rowB.id && detail.build.source === 'code', `build: ${JSON.stringify(detail.build)}`);
    const ringRow = detail.items.find((i) => i.slot === 'Ring 1');
    assert(ringRow && ringRow.name === 'Sample Ring' && ringRow.base === 'Coral Ring' && ringRow.rarity === 'RARE', `ring row: ${JSON.stringify(ringRow)}`);
    assert(!JSON.stringify(detail).includes('Rarity:'), 'items without `slot` carry no item text');
    const ring = (await list({ sample: SAMPLE, build: rowB.id.toUpperCase(), slot: 'ring 1' })) as { item: { slot: string; itemText: string } };
    assert(ring.item.slot === 'Ring 1' && ring.item.itemText.startsWith('Rarity: RARE') && ring.item.itemText.includes('+150 to maximum Life'), `ring text: ${JSON.stringify(ring.item)}`);
    const jewel = (await list({ sample: SAMPLE, build: rowA.id, slot: `Jewel ${TREE_SOCKET}` })) as { item: { slot: string; itemText: string; note?: string } };
    assert(jewel.item.slot === `Tree jewel ${TREE_SOCKET}` && jewel.item.itemText.includes('Cataclysm Stone') && /swap_item takes this slot as "Jewel 36634"/.test(jewel.item.note ?? ''),
      `jewel text: ${JSON.stringify(jewel.item)}`);
    await run(async (s) => {
      const r = (await s.swapItemWithDiff('Ring 1', ring.item.itemText)) as unknown as { diff?: Record<string, { delta?: number }> };
      assert(r, 'swap_item result');
      const equipped = await s.getItemInSlot('Ring 1');
      assert(equipped && String(equipped.name).startsWith('Sample Ring') && String(equipped.raw).includes('+150 to maximum Life'), `swap_item equipped: ${JSON.stringify(equipped)}`);
      await s.undoLastChange();
      await s.swapItemWithDiff(`Jewel ${TREE_SOCKET}`, jewel.item.itemText);
      await s.undoLastChange();
    });
    assert((await liveState()) === stateBefore, 'the swap_item checks were not undone');
    await expectError(list({ sample: SAMPLE, build: 'ffffffffffff' }), UserError, /has no build "ffffffffffff"\. Its builds: /, 'unknown build');
    await expectError(list({ sample: SAMPLE, build: rowB.id, slot: 'Ring 9' }), UserError, /no item in slot "Ring 9"/, 'unknown slot');
    await expectError(list({ build: rowB.id }), UserError, /`build` needs `sample`/, 'build without sample');
    await expectError(list({ sample: 'Nope' }), UserError, /No sample named "Nope"/, 'unknown sample');
    const liveSnap = await run((s) => s.compareSnapshot<{ items: Array<Record<string, unknown>> }>(['Life']));
    assert(liveSnap.items.length > 5 && liveSnap.items.every((i) => !('text' in i)), 'compareSnapshot without itemText carries item text');
    log('PASS');

    log('Test 4: freshSampleSnapshots refreshes stale snapshots and saves them');
    const before = JSON.parse(readFileSync(sampleFile, 'utf8')) as { builds: Array<Record<string, unknown> & { id: string; snapshot?: { pobVersion: string; format: number; data: unknown } }> };
    const originalData = before.builds.map((b) => canonical(b.snapshot?.data));
    before.builds[0].snapshot!.pobVersion = '0.0.1-old';
    before.builds[1].snapshot!.format = 0;
    const badId = 'abcabcabcabc';
    before.builds.push({ id: badId, label: 'now refused', source: 'code', code: encodeBuildCode(BAD_XML), addedAt: '2026-01-01T00:00:00.000Z' });
    writeFileSync(sampleFile, JSON.stringify(before));
    const staleList = (await list({ sample: SAMPLE })) as { builds: BuildRow[] };
    assert(staleList.builds.map((b) => b.stale === true).join() === 'true,true,false,true', `stale flags: ${JSON.stringify(staleList.builds)}`);
    const created = temp.length;
    t0 = Date.now();
    const freshed = await run(() => freshSampleSnapshots(engine, store, SAMPLE));
    log(`  freshSampleSnapshots: ${Date.now() - t0} ms`);
    assert(temp.length === created + 1, `one temporary engine for the refresh (${temp.length - created})`);
    assert(freshed.builds.map((b) => b.id).join() === [rowA.id, rowB.id, rowC.id].join(), `builds: ${freshed.builds.map((b) => b.id)}`);
    assert(freshed.dropped.length === 1 && freshed.dropped[0].id === badId && freshed.dropped[0].label === 'now refused' &&
      /Invalid Path of Building XML/.test(freshed.dropped[0].error), `dropped: ${JSON.stringify(freshed.dropped)}`);
    assert(freshed.builds.every((b) => b.snapshot.items.length > 5 && b.snapshot.items.every((i) => typeof i.text === 'string')), 'fresh snapshots carry item text');
    const after = JSON.parse(readFileSync(sampleFile, 'utf8')) as typeof before;
    assert(after.builds.length === 4 && after.builds[3].id === badId && after.builds[3].snapshot === undefined, 'the refused build stays in the file');
    const version = engine.pobVersion() ?? 'unknown';
    for (let i = 0; i < 3; i++) {
      assert(after.builds[i].snapshot!.pobVersion === version && after.builds[i].snapshot!.format === SAMPLE_SNAPSHOT_FORMAT, `build ${i} not refreshed`);
      assert(canonical(after.builds[i].snapshot!.data) === originalData[i], `build ${i}: the re-read snapshot differs from the first read`);
    }
    assert(JSON.stringify(freshed.file.builds.map((b) => b.id)) === JSON.stringify(after.builds.map((b) => b.id)), 'returned file');
    await allTempDead('after refresh');
    assert((await liveState()) === stateBefore, 'freshSampleSnapshots changed the live build');
    // Nothing stale but the refused build: it is tried again, the others kept.
    const again = await run(() => freshSampleSnapshots(engine, store, SAMPLE));
    assert(again.builds.length === 3 && again.dropped.length === 1 && temp.length === created + 2, 'second refresh');
    // Drop the refused build again for the next tests.
    await removeSampleBuilds(store, { sample: SAMPLE, ids: [badId] });
    const quiet = await run(() => freshSampleSnapshots(engine, store, SAMPLE));
    assert(quiet.builds.length === 3 && quiet.dropped.length === 0 && temp.length === created + 2, 'nothing stale: no temporary engine');
    log('PASS');

    log('Test 5: the temporary engine crashes or hangs; breaker open');
    const strikes = (): Promise<string> =>
      run(async () => JSON.stringify([(await engine.info()).crashCount,
        (engine as unknown as { ledger: { initialCount(p: string, l: string): number } }).ledger.initialCount(paths.pobPath, paths.luajitPath)]));
    const strikesBefore = await strikes();
    assert(strikesBefore === '[0,0]', `strikes before: ${strikesBefore}`);
    const fileBefore = readFileSync(sampleFile, 'utf8');
    const temporaryOnly = (e: Error, label: string): void => {
      assert(!/strike|next tool call|restarts the engine|comparison/i.test(e.message), `${label}: wrong wording: ${e.message}`);
      assert(/not a crash of the main engine/.test(e.message), `${label}: does not say the main engine is unaffected: ${e.message}`);
    };
    temporaryOnly(await expectError(add({ sample: SAMPLE, builds: [{ source: itemSetsXml }] }, { testFaults: 'exitOn_compareSnapshot' }), TemporaryEngineError,
      /temporary Path of Building engine started for the sample builds stopped while reading the builds\[0\] build/, 'crash'), 'crash');
    await expectError(add({ sample: 'Crash Sample', builds: [{ source: itemSetsXml }] }, { testFaults: 'exitOn_loadXML' }), TemporaryEngineError,
      /stopped while loading the builds\[0\] build/, 'crash on load, new sample');
    await allTempDead('after crash');
    t0 = Date.now();
    temporaryOnly(await expectError(add({ sample: SAMPLE, builds: [{ source: itemSetsXml }] }, { testFaults: 'hangOn_compareSnapshot', timeoutMs: 8_000 }), TemporaryEngineError,
      /Lua bridge timeout after 8000ms on cmd "compareSnapshot" \(its process was killed\)/, 'timeout'), 'timeout');
    assert(Date.now() - t0 < 30_000, 'timeout took too long');
    await allTempDead('after timeout');
    assert(readFileSync(sampleFile, 'utf8') === fileBefore, 'a failed add changed the sample file');
    assert(!existsSync(path.join(store.dir, 'crash-sample.json')), 'a failed add created a sample');
    assert((await strikes()) === strikesBefore, `live strikes changed: ${await strikes()}`);
    assert((await liveState()) === stateBefore, 'temporary engine failures changed the live build');
    const createdBefore = temp.length;
    await run(async (s) => {
      const b = liveBridge(s);
      const real = b.getCrashCount.bind(b);
      b.getCrashCount = () => 3;
      try {
        await expectError(addSampleBuilds(engine, store, { sample: SAMPLE, builds: [{ source: itemSetsXml }] }), UserError, /^add_sample_builds is refused: .*crash breaker is open/, 'breaker open');
      } finally {
        b.getCrashCount = real;
      }
    });
    assert(temp.length === createdBefore, 'the breaker refusal started a temporary engine');
    log('PASS');

    log('Test 6: remove_sample_builds');
    const fileNow = readFileSync(sampleFile, 'utf8');
    await expectError(removeSampleBuilds(store, { sample: SAMPLE, ids: [rowA.id, 'ffffffffffff'] }), UserError, /no build "ffffffffffff"; nothing was removed/, 'unknown id');
    await expectError(removeSampleBuilds(store, { sample: SAMPLE, ids: [rowA.id], deleteSample: true }), UserError, /either `ids`/, 'ids and deleteSample');
    await expectError(removeSampleBuilds(store, { sample: SAMPLE }), UserError, /either `ids`/, 'neither');
    assert(readFileSync(sampleFile, 'utf8') === fileNow, 'a refused removal changed the file');
    const removed = await removeSampleBuilds(store, { sample: SAMPLE, ids: [rowC.id.toUpperCase()] });
    assert(JSON.stringify(removed) === JSON.stringify({ sample: SAMPLE, removed: [rowC.id], count: 2 }), `removed: ${JSON.stringify(removed)}`);
    assert(((await list({ sample: SAMPLE })) as { builds: BuildRow[] }).builds.map((b) => b.id).join() === `${rowA.id},${rowB.id}`, 'remaining builds');
    const deleted = await removeSampleBuilds(store, { sample: SAMPLE, deleteSample: true });
    assert(deleted.deleted === true && !existsSync(sampleFile), 'deleteSample');
    assert(((await list()) as { samples: Array<{ name: string }> }).samples.map((x) => x.name).join() === 'Full Sample', 'deleted sample still listed');
    await expectError(removeSampleBuilds(store, { sample: SAMPLE, deleteSample: true }), UserError, /No sample named/, 'delete twice');
    assert((await liveState()) === stateBefore, 'sample tools changed the live build');
    log('PASS');
  } finally {
    await engine.shutdown();
    engine.killProcess();
  }

  log('Test 7: the tools over MCP');
  const mcpDir = mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-samples-mcp-'));
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverPath],
    env: { ...process.env, POB_PATH: paths.pobPath, LUAJIT_PATH: paths.luajitPath, POB_MCP_CONFIG_DIR: mcpDir } as Record<string, string>,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'pob-mcp-samples-test', version: '0.0.0' });
  const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    const r = (await client.callTool({ name, arguments: args })) as { content?: Array<{ text?: string }>; isError?: boolean };
    return { text: r.content?.[0]?.text ?? '', isError: r.isError === true };
  };
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ['add_sample_builds', 'list_samples', 'remove_sample_builds']) assert(byName.has(name), `${name} not registered`);
    assert(byName.get('list_samples')?.annotations?.readOnlyHint === true, 'list_samples read-only');
    assert(byName.get('remove_sample_builds')?.annotations?.destructiveHint === true, 'remove_sample_builds destructive');
    const a = byName.get('add_sample_builds')?.annotations;
    assert(a?.readOnlyHint === false && a.destructiveHint === false && a.idempotentHint === true && a.openWorldHint === true, `add annotations: ${JSON.stringify(a)}`);
    const tooMany = await call('add_sample_builds', { sample: 'MCP', builds: Array.from({ length: 21 }, () => ({ source: fixtureXml })) });
    assert(tooMany.isError, '21 builds over MCP accepted');
    const r1 = await call('add_sample_builds', { sample: 'MCP', builds: [{ source: fixtureXml, label: 'one' }] });
    assert(!r1.isError && !r1.text.includes('\n'), `add over MCP: ${r1.text.slice(0, 300)}`);
    const parsed = JSON.parse(r1.text) as AddResult;
    assert(parsed.count === 1 && parsed.added[0].ascendancy === 'Occultist', `add over MCP: ${r1.text.slice(0, 300)}`);
    const r2 = await call('list_samples', { sample: 'MCP', build: parsed.added[0].id, slot: 'Body Armour' });
    assert(!r2.isError && (JSON.parse(r2.text) as { item: { itemText: string } }).item.itemText.startsWith('Rarity:'), `list over MCP: ${r2.text.slice(0, 300)}`);
    const r3 = await call('remove_sample_builds', { sample: 'MCP', deleteSample: true });
    assert(!r3.isError && JSON.parse(r3.text).deleted === true, `remove over MCP: ${r3.text}`);
    assert(!existsSync(path.join(mcpDir, 'samples', 'mcp.json')), 'MCP sample not deleted');
    log('PASS');
  } finally {
    await client.close();
  }

  console.log('\nALL COMMUNITY SAMPLES TESTS PASSED');
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  log(`FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
