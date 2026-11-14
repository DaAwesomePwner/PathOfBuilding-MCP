/**
 * generate_trade_search / search_trade_mods: URL shape, weighted query, weight
 * adjustments surviving the filter cap, required mods, min override, input
 * errors, the bridge's copy of PoB's pseudoMap / ignoredStats still matching
 * the installed TradeQueryGenerator.lua, and the build left unchanged.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupTestEnv } from './_skip.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'src', 'server.ts');
const bridgePath = path.resolve(testDir, '..', 'lua', 'bridge.lua');
const LEAGUE = 'Settlers of Kalguur';
const SEARCH_PREFIX = 'https://www.pathofexile.com/trade/search/Settlers%20of%20Kalguur?q=';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface ToolResp { content?: Array<{ type: string; text: string }>; isError?: boolean }
interface Filter { tradeId: string; text: string; weight: number; source: string; mappedFrom?: string }
interface Search {
  url: string; filters: Filter[]; minWeightedSum: number; pobDefaultMinWeightedSum: number; itemCategory: string;
  droppedByCap: { count: number }; statWeights: { stat: string; weight: number }[]; calcSeconds: number;
  filterBudget: number; capLifted: boolean;
}
interface Query {
  query: {
    stats: { type: string; value?: { min?: number }; filters: { id: string; value?: { weight?: number; min?: number } }[] }[];
    status: { option: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filters: Record<string, any>;
  };
  sort: Record<string, string>;
}
const FIRE_RES_EXPLICIT = 'explicit.stat_3372524247';
const FIRE_RES_PSEUDO = 'pseudo.pseudo_total_fire_resistance';
const ALL_ELE_RES = 'explicit.stat_2901986750';
const ALL_ATTRIBUTES = 'explicit.stat_1379411836';
interface TradeMod {
  tradeId: string; text: string; type: string; preferred?: boolean; preferredTradeId?: string; weightable?: boolean; preferredTradeIds?: string[];
}

/** The `local <name> = { ... }` table literal that starts after `from` in Lua source (braces balanced, none in strings). */
function luaTable(source: string, name: string, from = 0): string {
  const start = source.indexOf(`local ${name} = {`, from);
  assert(start >= 0, `local ${name} table not found`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`local ${name} table is not closed`);
}
/** `["<digits>"] = "<string>"` entries of a Lua table literal, sorted by key. */
function luaStringEntries(table: string): [string, string][] {
  return [...table.matchAll(/\["(\d+)"\]\s*=\s*"([^"]*)"/g)].map((m): [string, string] => [m[1], m[2]]).sort();
}
/** `["<digits>"] =` keys of a Lua table literal, sorted. */
function luaKeys(table: string): string[] {
  return [...table.matchAll(/\["(\d+)"\]\s*=/g)].map((m) => m[1]).sort();
}
/** FinishQuery's element lists for PoB's hybrid resistance / attribute hashes; the bridge repeats them. */
const IGNORED_ELEMENT_LINES = [
  'local resElements = { "fire", "cold", "lightning", "chaos" }',
  'local attributeElements = { "dexterity", "strength", "intelligence" }',
];
/** FinishQuery's hybrid stat names, each hashed straight into ignoredStats; the bridge repeats them. */
const IGNORED_FORMAT_CALLS = [
  'string.format("%s_and_%s_damage_resistance_%%", elem1, elem2)',
  'string.format("base_%s_and_%s", elem1, elem2)',
  'string.format("additional_%s_and_%s", elem1, elem2)',
];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The source of a Lua function, from its `function`/`local function` line to the next top-level one. */
function luaFunctionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert(start >= 0, `${header} not found`);
  const next = source.slice(start + header.length).search(/\r?\n(local )?function /);
  return next < 0 ? source.slice(start) : source.slice(start, start + header.length + next);
}
/** Read-only: the installed PoB's TradeQueryGenerator.lua (installed layout or source clone). */
function pobGeneratorSource(pobPath: string): string {
  const file = [path.join(pobPath, 'Classes', 'TradeQueryGenerator.lua'), path.join(pobPath, 'src', 'Classes', 'TradeQueryGenerator.lua')]
    .find((f) => existsSync(f));
  assert(file, `TradeQueryGenerator.lua not found under ${pobPath}`);
  return readFileSync(file, 'utf8');
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
    assert(base.capLifted === true, 'PoB\'s 36-filter cap should be lifted so the full weight list comes back');
    assert(base.filterBudget === 34 && weights.filters.length === 34 && base.droppedByCap.count > 0, 'the cap is hit: budget full, some dropped');
    assert(q.query.status.option === 'available' && q.query.filters.type_filters.filters.category.option === 'armour.helmet', 'defaults');
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

    log('Test 4b: single-resistance adjustments target PoB\'s pseudo total');
    const fire = await search({ weightAdjustments: [{ tradeId: FIRE_RES_EXPLICIT, weight: 2.5 }] });
    const fireFilters = decodeQuery(fire.url).query.stats[0].filters.filter((f) => /stat_3372524247$|pseudo_total_fire_resistance$/.test(f.id));
    assert(fireFilters.length === 1 && fireFilters[0].id === FIRE_RES_PSEUDO && fireFilters[0].value?.weight === 2.5, `one fire-res filter: ${JSON.stringify(fireFilters)}`);
    assert(fire.filters.find((f) => f.tradeId === FIRE_RES_PSEUDO)?.mappedFrom === FIRE_RES_EXPLICIT, 'response says which id was mapped');
    await userError('generate_trade_search', {
      slot: 'Helmet', league: LEAGUE, weightAdjustments: [{ tradeId: FIRE_RES_EXPLICIT, weight: 1 }, { tradeId: FIRE_RES_PSEUDO, weight: 2 }],
    }, /more than once/);
    log('PASS');

    log('Test 4c0: bridge pseudoMap / ignoredStats match the installed TradeQueryGenerator.lua');
    const pobSource = pobGeneratorSource(paths.pobPath);
    const bridgeSource = readFileSync(bridgePath, 'utf8');
    const finishQuery = luaFunctionBody(pobSource, 'function TradeQueryGeneratorClass:FinishQuery()');
    const bridgeIgnoredFn = luaFunctionBody(bridgeSource, 'local function tradeIgnoredFor(id)');
    const pobPseudo = luaStringEntries(luaTable(finishQuery, 'pseudoMap'));
    const bridgePseudo = luaStringEntries(luaTable(bridgeSource, 'TRADE_PSEUDO_MAP'));
    assert(pobPseudo.length === 7, `PoB's pseudoMap should have 7 entries: ${JSON.stringify(pobPseudo)}`);
    assert(JSON.stringify(pobPseudo) === JSON.stringify(bridgePseudo),
      `TRADE_PSEUDO_MAP drifted from PoB's pseudoMap:\n  PoB    ${JSON.stringify(pobPseudo)}\n  bridge ${JSON.stringify(bridgePseudo)}`);
    const pobIgnored = luaKeys(luaTable(finishQuery, 'ignoredStats'));
    const bridgeIgnored = luaKeys(luaTable(bridgeSource, 'TRADE_IGNORED_LITERAL'));
    assert(pobIgnored.length === 3 && JSON.stringify(pobIgnored) === JSON.stringify(bridgeIgnored),
      `TRADE_IGNORED_LITERAL drifted from PoB's ignoredStats: PoB ${pobIgnored}, bridge ${bridgeIgnored}`);
    for (const line of IGNORED_ELEMENT_LINES) {
      assert(finishQuery.includes(line) && bridgeIgnoredFn.includes(line), `hybrid ignoredStats element list drifted (PoB FinishQuery / bridge): ${line}`);
    }
    for (const call of IGNORED_FORMAT_CALLS) {
      // PoB: `stats = { <call> }` then `ignoredStats[tostring(HashStats(stats))] = true`; bridge: `add(HashStats({ <call> }), ...)`.
      const feedsIgnored = new RegExp(`${escapeRe(call)}\\s*\\}\\s*\\n\\s*ignoredStats\\[tostring\\(HashStats\\(stats\\)\\)\\] = true`);
      assert(feedsIgnored.test(finishQuery), `PoB FinishQuery no longer hashes ${call} into ignoredStats`);
      assert(bridgeIgnoredFn.includes(`add(HashStats({ ${call} })`), `bridge tradeIgnoredFor no longer hashes ${call}`);
    }
    log(`PASS: ${pobPseudo.length} pseudoMap entries, ${pobIgnored.length} literal ignored stats, hybrid patterns match`);

    log('Test 4c1: every single resistance / attribute id maps to its pseudo total');
    const mapped = pobPseudo.map(([hash, pseudo], i) => ({ from: `explicit.stat_${hash}`, to: pseudo, weight: 1.5 + i }));
    const all7 = await search({ weightAdjustments: mapped.map((m) => ({ tradeId: m.from, weight: m.weight })) });
    const all7q = decodeQuery(all7.url).query.stats[0].filters;
    for (const m of mapped) {
      const hash = m.from.slice('explicit.stat_'.length);
      const hits = all7q.filter((f) => f.id === m.to || f.id.endsWith(`.stat_${hash}`));
      assert(hits.length === 1 && hits[0].id === m.to && hits[0].value?.weight === m.weight, `${m.from}: one ${m.to} filter: ${JSON.stringify(hits)}`);
      const f = all7.filters.find((x) => x.tradeId === m.to);
      assert(f?.mappedFrom === m.from && f.weight === m.weight, `${m.from}: response filter ${JSON.stringify(f)}`);
    }
    log('PASS');

    log('Test 4c2: all / hybrid resistance and attribute ids are refused as weights, accepted as required mods');
    await userError('generate_trade_search', { slot: 'Ring 1', league: LEAGUE, weightAdjustments: [{ tradeId: ALL_ELE_RES, weight: 1 }] },
      /cannot weigh explicit\.stat_2901986750.*pseudo_total_fire_resistance, pseudo\.pseudo_total_cold_resistance, pseudo\.pseudo_total_lightning_resistance.*requiredMods/);
    await userError('generate_trade_search', { slot: 'Ring 1', league: LEAGUE, weightAdjustments: [{ tradeId: ALL_ATTRIBUTES, weight: 1 }] },
      /pseudo_total_strength, pseudo\.pseudo_total_dexterity, pseudo\.pseudo_total_intelligence/);
    const ringRes = await ok<{ mods: TradeMod[] }>('search_trade_mods', { slot: 'Ring 1', query: 'resistances', limit: 100 });
    const fireCold = ringRes.mods.find((m) => m.text === '+#% to Fire and Cold Resistances' && m.type === 'Explicit');
    assert(fireCold?.weightable === false && JSON.stringify(fireCold.preferredTradeIds) === JSON.stringify([FIRE_RES_PSEUDO, 'pseudo.pseudo_total_cold_resistance']),
      `hybrid resistance is marked unweightable with its totals: ${JSON.stringify(fireCold)}`);
    assert(ringRes.mods.find((m) => m.tradeId === ALL_ELE_RES)?.weightable === false, 'all elemental resistances marked unweightable');
    assert(ringRes.mods.filter((m) => m.weightable === false).every((m) => (m.preferredTradeIds?.length ?? 0) >= 2), 'unweightable entries name their totals');
    assert(ringRes.mods.filter((m) => m.preferred).every((m) => m.weightable === undefined), 'pseudo totals stay weightable');
    await userError('generate_trade_search', { slot: 'Ring 1', league: LEAGUE, weightAdjustments: [{ tradeId: fireCold.tradeId, weight: 1 }] },
      /pseudo_total_fire_resistance, pseudo\.pseudo_total_cold_resistance already count it/);
    const amuletAttr = await ok<{ mods: TradeMod[] }>('search_trade_mods', { slot: 'Amulet', query: 'strength and dexterity', limit: 100 });
    const strDex = amuletAttr.mods.find((m) => m.type === 'Explicit');
    assert(strDex?.weightable === false && JSON.stringify(strDex.preferredTradeIds) === '["pseudo.pseudo_total_strength","pseudo.pseudo_total_dexterity"]',
      `hybrid attribute is marked unweightable: ${JSON.stringify(strDex)}`);
    await userError('generate_trade_search', { slot: 'Amulet', league: LEAGUE, weightAdjustments: [{ tradeId: strDex.tradeId, weight: 1 }] },
      /pseudo_total_strength, pseudo\.pseudo_total_dexterity already count it/);
    const reqIgnored = await ok<Search>('generate_trade_search', {
      slot: 'Ring 1', league: LEAGUE, requiredMods: [{ tradeId: ALL_ELE_RES, min: 10 }, { tradeId: fireCold.tradeId }, { tradeId: ALL_ATTRIBUTES }],
    });
    const reqAnd = decodeQuery(reqIgnored.url).query.stats.find((g) => g.type === 'and')?.filters.map((f) => f.id) ?? [];
    assert([ALL_ELE_RES, fireCold.tradeId, ALL_ATTRIBUTES].every((id) => reqAnd.includes(id)), `required ids kept exactly: ${reqAnd}`);
    log('PASS');

    log('Test 4c: PoB dialog options on Body Armour');
    const opts = await ok<Search>('generate_trade_search', {
      slot: 'Body Armour', league: LEAGUE, tradeType: 'securable', influences: ['shaper', 'elder'], includeMirrored: false,
      maxPrice: { amount: 5, currency: 'divine' }, maxLevel: 80, sockets: 6, links: 6,
    });
    const oq = decodeQuery(opts.url).query;
    assert(oq.status.option === 'securable', 'tradeType');
    assert(oq.filters.trade_filters.filters.price.option === 'divine' && oq.filters.trade_filters.filters.price.max === 5, 'maxPrice + currency');
    assert(oq.filters.req_filters.filters.lvl.max === 80, 'maxLevel');
    const sock = oq.filters.socket_filters.filters;
    assert(sock.sockets.min === 6 && sock.sockets.max === 6 && sock.links.min === 6 && sock.links.max === 6, 'sockets + links');
    assert(oq.filters.misc_filters.filters.mirrored === false, 'includeMirrored false');
    const infl = oq.stats.find((g) => g.type === 'and')?.filters.map((f) => f.id) ?? [];
    assert(infl.includes('pseudo.pseudo_has_shaper_influence') && infl.includes('pseudo.pseudo_has_elder_influence'), `influences: ${infl}`);
    assert(opts.filterBudget === 27 && oq.stats[0].filters.length <= 27, `budget shrinks with every extra filter: ${opts.filterBudget}`);
    log('PASS');

    log('Test 4d: weapon and flask slots');
    const wand = await ok<Search>('generate_trade_search', { slot: 'Weapon 1', league: LEAGUE, maxPrice: { amount: 50 } });
    const wq = decodeQuery(wand.url).query;
    assert(wq.filters.type_filters.filters.category.option === 'weapon.wand', `weapon category: ${wand.itemCategory}`);
    const price = wq.filters.trade_filters.filters.price;
    assert(price.max === 50 && price.option === undefined, 'chaos-equivalent price has no currency option');
    const flask = await ok<Search>('generate_trade_search', { slot: 'Flask 1', league: LEAGUE });
    assert(decodeQuery(flask.url).query.filters.type_filters.filters.category.option === 'flask' && flask.filters.length > 0, 'flask search');
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
    for (const league of ['.', '..', ' . ']) await userError('generate_trade_search', { slot: 'Helmet', league }, /league/);
    await userError('generate_trade_search', { slot: 'Helmet', league: LEAGUE, includeTalisman: true }, /includeTalisman true only applies to Amulet/);
    await userError('generate_trade_search', { slot: 'Ring 1', league: LEAGUE, includeEldritch: 'keepRegular' }, /includeEldritch "keepRegular" only applies/);
    await userError('generate_trade_search', { slot: 'Ring 1', league: LEAGUE, includeEldritch: 'keepRegularPresence' }, /only applies/);
    await userError('generate_trade_search', { slot: 'Helmet', league: LEAGUE, includeEldritch: 'keepRegular', influences: ['hunter'] }, /influences/);
    await userError('generate_trade_search', { slot: 'Ring 1', league: LEAGUE, links: 4 }, /links is not available/);
    await userError('generate_trade_search', { slot: 'Flask 1', league: LEAGUE, sockets: 1 }, /sockets is not available/);
    log('PASS');

    log('Test 6b: off-slot options that change nothing are accepted');
    for (const includeEldritch of ['copyCurrent', 'remove']) {
      const noop = await ok<Search>('generate_trade_search', { slot: 'Ring 1', league: LEAGUE, realm: 'xbox', includeTalisman: false, includeEldritch });
      assert(noop.url === xbox.url, `Ring 1 with includeTalisman false / includeEldritch ${includeEldritch} should equal the default search`);
    }
    log('PASS');

    log('Test 6c: weight 0 on an id PoB leaves out of the weights changes nothing');
    const zeroIgnored = await ok<Search>('generate_trade_search', {
      slot: 'Ring 1', league: LEAGUE, realm: 'xbox', weightAdjustments: [{ tradeId: ALL_ELE_RES, weight: 0 }, { tradeId: ALL_ATTRIBUTES, weight: 0 }],
    });
    assert(zeroIgnored.url === xbox.url && zeroIgnored.filterBudget === xbox.filterBudget, 'weight 0 on ignored ids should equal the default search');
    assert(!zeroIgnored.filters.some((f) => f.source !== 'pob'), 'nothing is added or pinned');
    log('PASS');

    log('Test 7: search_trade_mods');
    const mods = await ok<{ total: number; mods: { tradeId: string; text: string; type: string }[] }>('search_trade_mods', { slot: 'Helmet', query: 'LIFE', limit: 100 });
    assert(mods.mods.length > 0 && mods.mods.every((m) => /life/i.test(m.text)), 'every result mentions life');
    assert(mods.mods.every((m) => /^[a-z]+\.[a-z0-9_]+(\|[a-z0-9_]+)?$/.test(m.tradeId)), 'valid trade ids');
    assert(mods.mods.some((m) => m.tradeId === lifeId && m.type === 'Explicit'), '+# to maximum Life is listed');
    assert(mods.mods.some((m) => m.type === 'Pseudo'), 'pseudo stats are listed');
    const fireMods = await ok<{ mods: { tradeId: string; preferred?: boolean; preferredTradeId?: string }[] }>(
      'search_trade_mods', { slot: 'Helmet', query: 'fire resistance', limit: 100 });
    assert(fireMods.mods[0]?.tradeId === FIRE_RES_PSEUDO && fireMods.mods[0].preferred === true, `pseudo total first: ${JSON.stringify(fireMods.mods[0])}`);
    assert(fireMods.mods.find((m) => m.tradeId === FIRE_RES_EXPLICIT)?.preferredTradeId === FIRE_RES_PSEUDO, 'explicit fire res points at the pseudo id');
    const few = await ok<{ mods: unknown[]; total: number }>('search_trade_mods', { slot: 'Helmet', query: 'life', limit: 3 });
    assert(few.mods.length === 3 && few.total === mods.total, 'limit caps the list, total does not change');
    log('PASS');

    log('Test 7b: ids from search_trade_mods are accepted by generate_trade_search');
    let unweightable = 0;
    for (const query of ['life', 'resistance', 'attack speed']) {
      const found = await ok<{ mods: TradeMod[] }>('search_trade_mods', { slot: 'Gloves', query, limit: 10 });
      assert(found.mods.length > 0, `search_trade_mods found nothing for "${query}" on Gloves`);
      // Every id as a required mod; weightable ids also as weights (one per filter they land on).
      const targets = new Set<string>();
      const weightAdjustments = found.mods.filter((m) => {
        const target = m.preferredTradeId ?? m.tradeId;
        if (m.weightable === false || targets.has(target)) return false;
        targets.add(target);
        return true;
      }).map((m) => ({ tradeId: m.tradeId, weight: 1 }));
      unweightable += found.mods.filter((m) => m.weightable === false).length;
      const r = await call('generate_trade_search', {
        slot: 'Gloves', league: LEAGUE, requiredMods: found.mods.map((m) => ({ tradeId: m.tradeId })), weightAdjustments,
      });
      assert(!r.isError, `"${query}" ids should be accepted: ${text(r)}`);
      const gq = decodeQuery((JSON.parse(text(r)) as Search).url).query;
      const required = gq.stats.find((g) => g.type === 'and')?.filters.map((f) => f.id) ?? [];
      assert(found.mods.every((m) => required.includes(m.tradeId)), `"${query}": every id is a required mod`);
      assert([...targets].every((id) => gq.stats[0].filters.some((f) => f.id === id)), `"${query}": every weightable id is weighted`);
    }
    assert(unweightable > 0, 'the queries should cover at least one unweightable id');
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
