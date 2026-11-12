import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupTestEnv } from './_skip.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'src', 'server.ts');

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface ToolTextContent { type: 'text'; text: string }

function extractText(result: unknown): string {
  const r = result as { content?: ToolTextContent[]; isError?: boolean };
  if (r.isError) throw new Error(`Tool returned error: ${r.content?.[0]?.text ?? 'unknown'}`);
  return r.content?.[0]?.text ?? '';
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return client.callTool({ name, arguments: args });
}

function approxEq(a: unknown, b: unknown, tol = 1e-3): boolean {
  const an = Number(a);
  const bn = Number(b);
  if (!Number.isFinite(an) || !Number.isFinite(bn)) return a === b;
  return Math.abs(an - bn) <= tol * Math.max(1, Math.abs(an), Math.abs(bn));
}

async function getKeyStats(client: Client): Promise<{ Life: number; CombinedDPS: number; TotalEHP: number }> {
  const stats = JSON.parse(extractText(await call(client, 'get_stats'))) as Record<string, Record<string, number>>;
  return {
    Life: stats.defense?.Life ?? 0,
    CombinedDPS: stats.offense?.CombinedDPS ?? 0,
    TotalEHP: stats.defense?.TotalEHP ?? 0,
  };
}

interface OrganizedConfig {
  sections: Record<string, Array<{ key: string; label: string; type: string; value: unknown; validValues?: unknown[] }>>;
  raw: Record<string, unknown>;
}

async function getRawConfig(client: Client): Promise<Record<string, unknown>> {
  const cfg = JSON.parse(extractText(await call(client, 'get_config'))) as OrganizedConfig;
  return cfg.raw;
}

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const xml = readFileSync(fixturePath, 'utf8');
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverPath],
    env: { ...process.env, POB_PATH: paths.pobPath, LUAJIT_PATH: paths.luajitPath } as Record<string, string>,
    stderr: 'inherit',
  });

  const client = new Client({ name: 'phase6-test', version: '0.0.0' });

  try {
    log('Connecting...');
    await client.connect(transport);
    log('Connected');

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const expected of [
      'get_config', 'set_config', 'list_scenarios', 'simulate_scenario', 'compare_scenarios', 'toggle_buffs',
    ]) {
      assert(tools.includes(expected), `missing tool ${expected}`);
    }
    log(`PASS: phase6 tools registered (total tools: ${tools.length})`);

    log('Loading build');
    await call(client, 'load_build', { source: xml });
    const baseline = await getKeyStats(client);
    log(`Baseline: Life=${baseline.Life}, DPS=${baseline.CombinedDPS}, EHP=${baseline.TotalEHP}`);

    // Test 1: get_config
    log('Test 1: get_config');
    const cfg = JSON.parse(extractText(await call(client, 'get_config'))) as OrganizedConfig;
    assert(typeof cfg.sections === 'object', 'sections should be an object');
    const sectionNames = Object.keys(cfg.sections);
    assert(sectionNames.length > 0, `expected at least one section, got ${sectionNames.length}`);
    let totalEntries = 0;
    let foundEnemyIsBoss = false;
    for (const entries of Object.values(cfg.sections)) {
      totalEntries += entries.length;
      if (entries.some((e) => e.key === 'enemyIsBoss')) foundEnemyIsBoss = true;
    }
    assert(totalEntries > 20, `expected many config entries, got ${totalEntries}`);
    assert(foundEnemyIsBoss, 'expected enemyIsBoss in metadata');
    log(`PASS: ${sectionNames.length} sections, ${totalEntries} entries (enemyIsBoss present)`);

    // Test 2: list_scenarios
    log('Test 2: list_scenarios');
    const scenariosList = JSON.parse(extractText(await call(client, 'list_scenarios'))) as {
      count: number;
      scenarios: Array<{ name: string; description: string; options: Record<string, unknown> }>;
    };
    assert(scenariosList.count >= 5, `expected >=5 scenarios, got ${scenariosList.count}`);
    const scenarioNames = scenariosList.scenarios.map((s) => s.name);
    for (const expected of ['mapping', 'pinnacle_boss', 'uber_boss', 'no_buffs']) {
      assert(scenarioNames.includes(expected), `missing scenario ${expected}`);
    }
    log(`PASS: scenarios=[${scenarioNames.join(',')}]`);

    // Test 3: simulate_scenario — pinnacle_boss
    log('Test 3: simulate_scenario (pinnacle_boss)');
    const pinnacleSim = JSON.parse(extractText(await call(client, 'simulate_scenario', { scenario: 'pinnacle_boss' }))) as {
      scenario: string;
      description: string;
      keyDeltas: Record<string, number>;
    };
    assert(pinnacleSim.scenario === 'pinnacle_boss', 'scenario should match');
    log(`  pinnacle_boss deltas: ${JSON.stringify(pinnacleSim.keyDeltas)}`);
    const afterSim = await getKeyStats(client);
    assert(approxEq(afterSim.Life, baseline.Life), 'Life should restore');
    assert(approxEq(afterSim.CombinedDPS, baseline.CombinedDPS), `DPS should restore (got ${afterSim.CombinedDPS}, baseline ${baseline.CombinedDPS})`);
    assert(approxEq(afterSim.TotalEHP, baseline.TotalEHP), 'EHP should restore');
    log('PASS: simulate_scenario restores state');

    // Test 4: simulate_scenario — invalid
    log('Test 4: simulate_scenario (invalid name)');
    const badSim = await call(client, 'simulate_scenario', { scenario: 'definitely_not_a_scenario' });
    assert(isError(badSim), 'invalid scenario should error');
    const afterBad = await getKeyStats(client);
    assert(approxEq(afterBad.Life, baseline.Life), 'state should be unaffected');
    log('PASS: invalid scenario rejected');

    // Test 5: compare_scenarios
    log('Test 5: compare_scenarios (mapping vs pinnacle_boss vs uber_boss)');
    const compareResp = JSON.parse(extractText(await call(client, 'compare_scenarios', {
      scenarios: ['mapping', 'pinnacle_boss', 'uber_boss'],
    }))) as {
      baseline: Record<string, number>;
      scenarios: Array<{ scenario: string; keyDeltas: Record<string, number>; keyStats: Record<string, number> }>;
    };
    assert(compareResp.scenarios.length === 3, `expected 3 results, got ${compareResp.scenarios.length}`);
    assert(compareResp.scenarios[0].scenario === 'mapping', 'first should be mapping');
    log(`  mapping DPS=${compareResp.scenarios[0].keyStats.CombinedDPS.toFixed(0)} Δ=${compareResp.scenarios[0].keyDeltas.CombinedDPS.toFixed(0)}`);
    log(`  pinnacle DPS=${compareResp.scenarios[1].keyStats.CombinedDPS.toFixed(0)} Δ=${compareResp.scenarios[1].keyDeltas.CombinedDPS.toFixed(0)}`);
    log(`  uber DPS=${compareResp.scenarios[2].keyStats.CombinedDPS.toFixed(0)} Δ=${compareResp.scenarios[2].keyDeltas.CombinedDPS.toFixed(0)}`);
    const afterCompare = await getKeyStats(client);
    assert(approxEq(afterCompare.Life, baseline.Life), 'Life restored after compare');
    assert(approxEq(afterCompare.CombinedDPS, baseline.CombinedDPS), 'DPS restored after compare');
    assert(approxEq(afterCompare.TotalEHP, baseline.TotalEHP), 'EHP restored after compare');
    log('PASS: compare_scenarios restores state');

    // Test 6: toggle_buffs (temporary, with friendly aliases)
    log('Test 6: toggle_buffs ({onslaught:false, fortify:false})');
    const buffResp = JSON.parse(extractText(await call(client, 'toggle_buffs', {
      buffs: { onslaught: false, fortify: false },
    }))) as { keyDeltas: Record<string, number> };
    log(`  buff toggle deltas: ${JSON.stringify(buffResp.keyDeltas)}`);
    const afterBuffs = await getKeyStats(client);
    assert(approxEq(afterBuffs.Life, baseline.Life), 'Life restored after toggle_buffs');
    assert(approxEq(afterBuffs.CombinedDPS, baseline.CombinedDPS), 'DPS restored after toggle_buffs');
    assert(approxEq(afterBuffs.TotalEHP, baseline.TotalEHP), 'EHP restored after toggle_buffs');
    log('PASS: toggle_buffs restores state');

    // Test 7: Config aliasing safety — full snapshot/restore round-trip
    log('Test 7: config aliasing safety (snapshot, mutate, verify exact match)');
    const cfgBefore = await getRawConfig(client);
    await call(client, 'simulate_scenario', { scenario: 'uber_boss' });
    const cfgAfter = await getRawConfig(client);
    const cfgKeys = new Set([...Object.keys(cfgBefore), ...Object.keys(cfgAfter)]);
    for (const k of cfgKeys) {
      assert(JSON.stringify(cfgBefore[k]) === JSON.stringify(cfgAfter[k]),
        `config key "${k}" drifted: ${JSON.stringify(cfgBefore[k])} → ${JSON.stringify(cfgAfter[k])}`);
    }
    log(`PASS: ${cfgKeys.size} config keys preserved exactly`);

    // Test 8: set_config (permanent, with undo)
    log('Test 8: set_config (permanent enemyIsBoss="None") + undo');
    const setResp = JSON.parse(extractText(await call(client, 'set_config', {
      options: { enemyIsBoss: 'None' },
    }))) as { keyDeltas: Record<string, number> };
    log(`  permanent set deltas: ${JSON.stringify(setResp.keyDeltas)}`);
    const afterSet = await getKeyStats(client);
    assert(!approxEq(afterSet.CombinedDPS, baseline.CombinedDPS), `set_config should change DPS (baseline=${baseline.CombinedDPS}, after=${afterSet.CombinedDPS})`);
    const cfgAfterSet = await getRawConfig(client);
    assert(cfgAfterSet.enemyIsBoss === 'None', `enemyIsBoss should be "None", got ${cfgAfterSet.enemyIsBoss}`);
    log('  applied; now undoing');
    await call(client, 'undo_last_change');
    const afterUndo = await getKeyStats(client);
    const cfgAfterUndo = await getRawConfig(client);
    log(`  afterUndo: Life=${afterUndo.Life}, DPS=${afterUndo.CombinedDPS}, EHP=${afterUndo.TotalEHP}, enemyIsBoss=${cfgAfterUndo.enemyIsBoss}`);
    assert(cfgAfterUndo.enemyIsBoss !== 'None', `enemyIsBoss should be reverted from "None", got ${cfgAfterUndo.enemyIsBoss}`);
    assert(approxEq(afterUndo.Life, baseline.Life), 'Life should restore via undo');
    assert(approxEq(afterUndo.CombinedDPS, baseline.CombinedDPS), `DPS should restore via undo (baseline=${baseline.CombinedDPS}, after=${afterUndo.CombinedDPS})`);
    log('PASS: set_config + undo round-trip');

    // Test 9: set_config with an unknown key is rejected (a silent no-op hides typos)
    log('Test 9: set_config with unknown key');
    const cfgBeforeBad = await getRawConfig(client);
    const badResp = await call(client, 'set_config', {
      options: { someUnknownConfigKey: 'value' },
    });
    assert(isError(badResp), 'unknown config keys should be rejected');
    const badText = (badResp as { content?: ToolTextContent[] }).content?.[0]?.text ?? '';
    assert(badText.includes('someUnknownConfigKey'), `error should name the bad key, got: ${badText}`);
    const cfgAfterBad = await getRawConfig(client);
    assert(JSON.stringify(cfgBeforeBad) === JSON.stringify(cfgAfterBad), 'rejected set_config must not change config');
    log('PASS: unknown config key rejected without side effects');

    // Test 10: compare_scenarios with too few scenarios — Zod should reject
    log('Test 10: compare_scenarios with 1 scenario (should reject)');
    const bad1 = await call(client, 'compare_scenarios', { scenarios: ['mapping'] });
    assert(isError(bad1), 'Zod should reject 1-scenario list');
    log('PASS: validation rejects single-scenario compare');

    // Final integrity
    log('Test 11: final state integrity');
    const final = await getKeyStats(client);
    assert(
      approxEq(final.Life, baseline.Life)
        && approxEq(final.CombinedDPS, baseline.CombinedDPS)
        && approxEq(final.TotalEHP, baseline.TotalEHP),
      `final state should match baseline: ${JSON.stringify({ baseline, final })}`,
    );
    log('PASS: build pristine after all phase 6 operations');
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

main()
  .then(() => {
    log('ALL PHASE 6 TESTS PASSED');
    process.exit(0);
  })
  .catch((error: unknown) => {
    log(`FAILED: ${error instanceof Error ? error.stack : error}`);
    process.exit(1);
  });
