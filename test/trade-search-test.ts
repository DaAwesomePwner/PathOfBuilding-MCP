/**
 * generate_trade_search / search_trade_mods: URL shape, weighted query, weight
 * adjustments surviving the filter cap, required mods, min override, input
 * errors, and the build left unchanged.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupTestEnv } from './_skip.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'src', 'server.ts');
const LEAGUE = 'Settlers of Kalguur';
const SEARCH_PREFIX = 'https://www.pathofexile.com/trade/search/Settlers%20of%20Kalguur?q=';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface ToolResp { content?: Array<{ type: string; text: string }>; isError?: boolean }
interface Filter { tradeId: string; text: string; weight: number; source: string }
interface Search {
  url: string; filters: Filter[]; minWeightedSum: number; pobDefaultMinWeightedSum: number;
  droppedByCap: { count: number }; statWeights: { stat: string; weight: number }[]; calcSeconds: number;
}
interface Query {
  query: { stats: { type: string; value?: { min?: number }; filters: { id: string; value?: { weight?: number; min?: number } }[] }[] };
  sort: Record<string, string>;
}

let client: Client;
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResp> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as ToolResp;
}
const text = (r: ToolResp) => r.content?.[0]?.text ?? '';
async function ok<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await call(name, args);
  assert(!r.isError, `${name} failed: ${text(r)}`);
  return JSON.parse(text(r)) as T;
}
async function userError(name: string, args: Record<string, unknown>, expect: RegExp): Promise<void> {
  const r = await call(name, args);
  assert(r.isError, `${name} ${JSON.stringify(args).slice(0, 120)} should fail`);
  assert(!text(r).startsWith('Internal error'), `expected a user error, got: ${text(r)}`);
  assert(expect.test(text(r)), `error text ${JSON.stringify(text(r))} should match ${expect}`);
}
function decodeQuery(url: string, prefix = SEARCH_PREFIX): Query {
  assert(url.startsWith(prefix), `url should start with ${prefix}: ${url.slice(0, 120)}`);
  return JSON.parse(decodeURIComponent(url.slice(prefix.length))) as Query;
}
const search = (args: Record<string, unknown>) => ok<Search>('generate_trade_search', { slot: 'Helmet', league: LEAGUE, ...args });

async function keyState(): Promise<string> {
  const stats = await ok<Record<string, Record<string, number>>>('get_stats');
  const exported = await call('export_build', { format: 'xml' });
  assert(!exported.isError, `export_build failed: ${text(exported)}`);
  const xml = text(exported);
  return JSON.stringify([stats.defense?.Life, stats.offense?.CombinedDPS, stats.defense?.TotalEHP, xml]);
}

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-trade-'));
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverPath],
    env: { ...process.env, POB_PATH: paths.pobPath, LUAJIT_PATH: paths.luajitPath, POB_MCP_CONFIG_DIR: configDir } as Record<string, string>,
    stderr: 'ignore',
  });
  client = new Client({ name: 'pob-mcp-trade-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    await ok('load_build', { source: readFileSync(fixturePath, 'utf8') });
    const before = await keyState();

    log('Test 1: default search for Helmet');
    const base = await search({});
    const q = decodeQuery(base.url);
    const weights = q.query.stats[0];
    assert(weights.type === 'weight', 'first stat group should be the weight group');
    assert(q.sort['statgroup.0'] === 'desc', 'sorted by weighted sum, highest first');
    assert(weights.filters.length > 0 && weights.filters.length <= 36, `filters: ${weights.filters.length}`);
    assert(weights.filters.every((f) => typeof f.value?.weight === 'number' && f.value.weight !== 0), 'every filter has a weight');
    assert(weights.filters.filter((f) => f.value!.weight! > 0).length >= weights.filters.length / 2, 'weights are mostly positive');
    assert(base.filters.every((f) => f.source === 'pob' && f.text.length > 0), 'PoB filters carry text');
    assert(weights.value?.min === base.minWeightedSum && base.minWeightedSum === base.pobDefaultMinWeightedSum, 'default min is PoB\'s');
    assert(base.statWeights.map((w) => w.stat).join() === 'FullDPS,TotalEHP', 'PoB default stat weights');
    log(`PASS: ${weights.filters.length} filters, ${base.droppedByCap.count} dropped by cap, ${base.calcSeconds}s`);

    log('Test 2: realm xbox, Ring 1');
    const xbox = await ok<Search>('generate_trade_search', { slot: 'Ring 1', league: LEAGUE, realm: 'xbox' });
    decodeQuery(xbox.url, 'https://www.pathofexile.com/trade/search/xbox/Settlers%20of%20Kalguur?q=');
    log('PASS');

    log('Test 3: statWeights change the weights');
    const life = await search({ statWeights: [{ stat: 'Life', weight: 1 }] });
    assert(JSON.stringify(life.filters) !== JSON.stringify(base.filters), 'Life-only weights should differ from the default');
    assert(life.filters.some((f) => /maximum Life/.test(f.text)), 'Life weighting should weigh a maximum Life mod');
    log('PASS');

    log('Test 4: weightAdjustments add / replace / remove and survive the cap');
    const replaced = base.filters[0];
    const removed = base.filters[1];
    const added = 'pseudo.pseudo_total_fire_resistance';
    const adjusted = await search({
      weightAdjustments: [
        { tradeId: replaced.tradeId, weight: 0.0123 },
        { tradeId: removed.tradeId, weight: 0 },
        { tradeId: added, weight: 0.0042 },
      ],
    });
    const aq = decodeQuery(adjusted.url).query.stats[0].filters;
    assert(aq.length <= 36, 'still within the cap');
    assert(aq.find((f) => f.id === replaced.tradeId)?.value?.weight === 0.0123, 'replaced weight applies');
    assert(!aq.some((f) => f.id === removed.tradeId), 'weight 0 removes the filter');
    assert(aq.find((f) => f.id === added)?.value?.weight === 0.0042, 'added filter present even with the lowest weight');
    assert(adjusted.filters.find((f) => f.tradeId === added)?.source === 'added', 'added source');
    assert(adjusted.filters.find((f) => f.tradeId === replaced.tradeId)?.source === 'adjusted', 'adjusted source');
    log('PASS');

    log('Test 5: requiredMods and minWeightedSum');
    const lifeId = 'explicit.stat_3299347043';
    const req = await search({ requiredMods: [{ tradeId: lifeId, min: 70 }, { tradeId: 'pseudo.pseudo_total_life' }], minWeightedSum: 123.5 });
    const rq = decodeQuery(req.url).query;
    const and = rq.stats.find((s) => s.type === 'and');
    assert(and?.filters.some((f) => f.id === lifeId && f.value?.min === 70), 'required mod with min in an "and" group');
    assert(and?.filters.some((f) => f.id === 'pseudo.pseudo_total_life' && f.value === undefined), 'required mod without min');
    assert(rq.stats[0].value?.min === 123.5 && req.minWeightedSum === 123.5, 'min override applies');
    assert(rq.stats[0].filters.length + 2 <= 36, 'required mods count toward the cap');
    log('PASS');

    log('Test 6: input errors are user errors');
    await userError('generate_trade_search', { slot: 'Helmet', league: LEAGUE, statWeights: [{ stat: 'NoSuchStat', weight: 1 }] }, /Unknown stat weight.*Valid stats:.*FullDPS/);
    await userError('generate_trade_search', { slot: 'Helmet', league: LEAGUE, weightAdjustments: [{ tradeId: 'explicit stat"}', weight: 1 }] }, /Invalid trade stat id/);
    await userError('generate_trade_search', { slot: 'Helmet', league: LEAGUE, requiredMods: [{ tradeId: 'explicit.stat_1' }] }, /Unknown trade stat id/);
    await userError('generate_trade_search', { slot: 'Jewel 26725', league: LEAGUE }, /Unsupported slot.*Helmet/);
    await userError('generate_trade_search', { slot: 'Helmet', league: 'a/b' }, /league/);
    await userError('generate_trade_search', { slot: 'Helmet', league: '   ' }, /league/);
    await userError('search_trade_mods', { slot: 'Nope', query: 'life' }, /Unsupported slot/);
    log('PASS');

    log('Test 7: search_trade_mods');
    const mods = await ok<{ total: number; mods: { tradeId: string; text: string; type: string }[] }>('search_trade_mods', { slot: 'Helmet', query: 'LIFE', limit: 100 });
    assert(mods.mods.length > 0 && mods.mods.every((m) => /life/i.test(m.text)), 'every result mentions life');
    assert(mods.mods.every((m) => /^[a-z]+\.[a-z0-9_]+(\|[a-z0-9_]+)?$/.test(m.tradeId)), 'valid trade ids');
    assert(mods.mods.some((m) => m.tradeId === lifeId && m.type === 'Explicit'), '+# to maximum Life is listed');
    assert(mods.mods.some((m) => m.type === 'Pseudo'), 'pseudo stats are listed');
    const few = await ok<{ mods: unknown[]; total: number }>('search_trade_mods', { slot: 'Helmet', query: 'life', limit: 3 });
    assert(few.mods.length === 3 && few.total === mods.total, 'limit caps the list, total does not change');
    log('PASS');

    log('Test 8: build unchanged');
    assert((await keyState()) === before, 'Life/CombinedDPS/TotalEHP or export changed after trade searches');
    const undo = await call('undo_last_change');
    assert(undo.isError, 'trade searches must not push undo entries');
    log('PASS');
    log('ALL TRADE SEARCH TESTS PASSED');
  } finally {
    await client.close().catch(() => undefined);
    rmSync(configDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
