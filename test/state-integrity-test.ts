/**
 * Phase 8 — state integrity stress test.
 *
 * Goals:
 *  - undo stack survives many sequential mutations and returns build exactly
 *    to original state when unwound
 *  - reset_build returns to exact original after diverse mutations
 *  - find_best_next_nodes leaves zero stat drift
 *  - compare_items leaves zero stat drift
 *  - simulate_scenario leaves zero stat drift
 */
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

function extractText(result: unknown, idx = 0): string {
  const r = result as { content?: ToolTextContent[]; isError?: boolean };
  if (r.isError) throw new Error(`Tool returned error: ${r.content?.[0]?.text ?? 'unknown'}`);
  return r.content?.[idx]?.text ?? '';
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return client.callTool({ name, arguments: args });
}

interface KeyStats { Life: number; CombinedDPS: number; TotalEHP: number; EnergyShield: number }

async function getKeyStats(client: Client): Promise<KeyStats> {
  const stats = JSON.parse(extractText(await call(client, 'get_stats'))) as Record<string, Record<string, number>>;
  return {
    Life: stats.defense?.Life ?? 0,
    EnergyShield: stats.defense?.EnergyShield ?? 0,
    CombinedDPS: stats.offense?.CombinedDPS ?? 0,
    TotalEHP: stats.defense?.TotalEHP ?? 0,
  };
}

function eq(a: number, b: number, tol = 1e-2): boolean {
  return Math.abs(a - b) <= tol;
}

function assertStatsExact(label: string, before: KeyStats, after: KeyStats): void {
  for (const k of Object.keys(before) as Array<keyof KeyStats>) {
    if (!eq(before[k], after[k])) {
      throw new Error(`${label}: ${k} drifted ${before[k]} -> ${after[k]}`);
    }
  }
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
  const client = new Client({ name: 'phase8-integrity', version: '0.0.0' });

  try {
    log('Connecting...');
    await client.connect(transport);
    log('Loading build');
    await call(client, 'load_build', { source: xml });
    const baseline = await getKeyStats(client);
    log(`Baseline: Life=${baseline.Life}, DPS=${baseline.CombinedDPS.toFixed(2)}, EHP=${baseline.TotalEHP.toFixed(2)}`);

    // -----------------------------------------------------------------
    // Test 1: 10 sequential set_config + 10 undo
    // -----------------------------------------------------------------
    log('Test 1: 10 sequential set_config + 10 undo round-trip');
    const cycle: Array<Record<string, unknown>> = [
      { enemyIsBoss: 'Pinnacle' },
      { usePowerCharges: true },
      { useFrenzyCharges: true },
      { useEnduranceCharges: true },
      { buffOnslaught: true },
      { buffFortification: true },
      { buffMassiveShrine: true },
      { buffLesserMassiveShrine: true },
      { conditionFullLife: true },
      { conditionLowLife: true },
    ];
    for (const opts of cycle) {
      await call(client, 'set_config', { options: opts });
    }
    // Guard against silent no-ops: every key must have landed in PoB's config.
    const rawCfg = (JSON.parse(extractText(await call(client, 'get_config'))) as { raw: Record<string, unknown> }).raw;
    for (const [key, value] of Object.entries(Object.assign({}, ...cycle) as Record<string, unknown>)) {
      assert(rawCfg[key] === value, `set_config ${key} did not take effect: expected ${JSON.stringify(value)}, got ${JSON.stringify(rawCfg[key])}`);
    }
    for (let i = 0; i < cycle.length; i++) {
      await call(client, 'undo_last_change');
    }
    const afterUndoStack = await getKeyStats(client);
    assertStatsExact('undo-stack', baseline, afterUndoStack);
    log('PASS: 10x set_config + 10x undo returns to baseline exactly');

    // -----------------------------------------------------------------
    // Test 2: reset_build after diverse changes
    // -----------------------------------------------------------------
    log('Test 2: diverse mutations + reset_build');
    await call(client, 'set_config', { options: { enemyIsBoss: 'Pinnacle' } });
    await call(client, 'set_config', { options: { buffMassiveShrine: true } });
    await call(client, 'unequip_item', { slot: 'Ring 1' });
    const afterDiverse = await getKeyStats(client);
    assert(
      !eq(afterDiverse.Life, baseline.Life) || !eq(afterDiverse.CombinedDPS, baseline.CombinedDPS),
      'mutations should have changed something',
    );
    await call(client, 'reset_build');
    const afterReset = await getKeyStats(client);
    assertStatsExact('reset_build', baseline, afterReset);
    log('PASS: reset_build after diverse mutations returns to baseline exactly');

    // -----------------------------------------------------------------
    // Test 3: compare_items state integrity
    // -----------------------------------------------------------------
    log('Test 3: compare_items state integrity');
    const r1Resp = JSON.parse(
      extractText(await call(client, 'get_item_in_slot', { slot: 'Ring 1' })),
    ) as { item: { raw?: string } | null };
    assert(r1Resp.item?.raw, 'Ring 1 should have an item');
    const original = r1Resp.item.raw;
    const candidates = [
      original.replace(/^Rarity: .*/m, 'Rarity: Magic'),
      original.replace(/^Rarity: .*/m, 'Rarity: Rare'),
    ];
    await call(client, 'compare_items', { slot: 'Ring 1', items: candidates });
    const afterCompare = await getKeyStats(client);
    assertStatsExact('compare_items', baseline, afterCompare);
    log('PASS: compare_items leaves zero drift');

    // -----------------------------------------------------------------
    // Test 4: simulate_scenario state integrity
    // -----------------------------------------------------------------
    log('Test 4: simulate_scenario state integrity (uber_boss)');
    await call(client, 'simulate_scenario', { scenario: 'uber_boss' });
    const afterSim = await getKeyStats(client);
    assertStatsExact('simulate_scenario', baseline, afterSim);
    log('PASS: simulate_scenario leaves zero drift');

    // -----------------------------------------------------------------
    // Test 5: find_best_next_nodes integrity (lighter scan, count=5)
    // -----------------------------------------------------------------
    log('Test 5: find_best_next_nodes(count=5) integrity');
    await call(client, 'find_best_next_nodes', { count: 5 });
    const afterFindBest = await getKeyStats(client);
    assertStatsExact('find_best_next_nodes', baseline, afterFindBest);
    log('PASS: find_best_next_nodes leaves zero drift');

    // -----------------------------------------------------------------
    // Test 6: snapshot/diff cumulative
    // -----------------------------------------------------------------
    log('Test 6: snapshot_and_compare across multiple changes');
    await call(client, 'snapshot_and_compare', { action: 'take', label: 'pre' });
    await call(client, 'set_config', { options: { buffMassiveShrine: true } });
    await call(client, 'set_config', { options: { buffLesserMassiveShrine: true } });
    await call(client, 'snapshot_and_compare', { action: 'take', label: 'post' });
    const cmpResp = JSON.parse(
      extractText(await call(client, 'snapshot_and_compare', { action: 'compare', labelA: 'pre', labelB: 'post' })),
    ) as { diff: Record<string, { delta: number }> };
    const lifeDelta = cmpResp.diff?.Life?.delta ?? 0;
    assert(lifeDelta !== 0, `cumulative diff should show non-zero Life delta; got diff: ${JSON.stringify(cmpResp.diff).slice(0, 200)}`);
    log(`  pre→post Life delta = ${lifeDelta.toFixed(2)}`);
    // Undo both
    await call(client, 'undo_last_change');
    await call(client, 'undo_last_change');
    const afterDualUndo = await getKeyStats(client);
    assertStatsExact('dual-undo', baseline, afterDualUndo);
    log('PASS: snapshot/diff + 2x undo returns to baseline');

    // -----------------------------------------------------------------
    // Test 7: batched snapshotAllItems via withTemporaryChange round-trip
    // -----------------------------------------------------------------
    log('Test 7: batched snapshotAllItems via withTemporaryChange round-trip');
    // simulate_scenario uses withTemporaryChange which exercises the batched path.
    const before = await getKeyStats(client);
    await call(client, 'simulate_scenario', { scenario: 'uber_boss' });
    const after = await getKeyStats(client);
    assert(eq(after.Life, before.Life), 'batched snapshot path must restore Life exactly');
    assert(eq(after.CombinedDPS, before.CombinedDPS), 'batched snapshot path must restore DPS exactly');
    assert(eq(after.TotalEHP, before.TotalEHP), 'batched snapshot path must restore EHP exactly');
    log('PASS: batched snapshot/restore preserves Life, DPS, EHP exactly');

    log('ALL PHASE 8 INTEGRITY TESTS PASSED');
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
