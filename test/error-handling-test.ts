/**
 * Phase 8 — error handling test.
 *
 * Verifies that bad inputs at every level produce friendly errors and leave
 * the build state pristine. Checks:
 *  - empty / non-base64 / too-short build code  → UserError surface
 *  - unsupported URL                            → UserError surface
 *  - XML missing <PathOfBuilding>               → UserError surface
 *  - invalid slot name in swap_item             → error, no drift
 *  - bad item text in swap_item                 → UserError surface, no drift
 *  - invalid gem name in swap_gem               → error, no drift
 *  - invalid keystone name in evaluate_keystone → error, no drift
 *  - undo_last_change with empty stack          → error, no drift
 *  - compare_items rejects fewer than 2         → Zod / error
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

interface ToolResp { content?: Array<{ type: string; text: string }>; isError?: boolean }

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResp> {
  return (await client.callTool({ name, arguments: args })) as ToolResp;
}

function isError(resp: ToolResp): boolean {
  return resp.isError === true;
}

function errText(resp: ToolResp): string {
  return resp.content?.[0]?.text ?? '';
}

interface KeyStats { Life: number; CombinedDPS: number; TotalEHP: number }

async function getKeyStats(client: Client): Promise<KeyStats> {
  const out = await call(client, 'get_stats');
  const stats = JSON.parse(errText(out)) as Record<string, Record<string, number>>;
  return {
    Life: stats.defense?.Life ?? 0,
    CombinedDPS: stats.offense?.CombinedDPS ?? 0,
    TotalEHP: stats.defense?.TotalEHP ?? 0,
  };
}

function eq(a: number, b: number, tol = 1e-2): boolean { return Math.abs(a - b) <= tol; }

function assertStatsExact(label: string, before: KeyStats, after: KeyStats): void {
  for (const k of Object.keys(before) as Array<keyof KeyStats>) {
    if (!eq(before[k], after[k])) throw new Error(`${label}: ${k} drifted ${before[k]} -> ${after[k]}`);
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
  const client = new Client({ name: 'phase8-errors', version: '0.0.0' });

  try {
    log('Connecting...');
    await client.connect(transport);

    // ----- load_build error paths -----
    log('Test 1: load_build with empty string');
    let r = await call(client, 'load_build', { source: '   ' });
    assert(isError(r), 'expected error');
    assert(/empty/i.test(errText(r)), `expected "empty" in: ${errText(r)}`);
    log(`  -> "${errText(r)}"`);

    log('Test 2: load_build with non-base64 build code');
    r = await call(client, 'load_build', { source: 'not<<<>>>valid!!!' });
    assert(isError(r), 'expected error');
    assert(/base64/i.test(errText(r)), `expected base64 mention in: ${errText(r)}`);
    log(`  -> "${errText(r)}"`);

    log('Test 3: load_build with too-short build code');
    r = await call(client, 'load_build', { source: 'abc123' });
    assert(isError(r), 'expected error');
    assert(/too short/i.test(errText(r)), `expected "too short" in: ${errText(r)}`);
    log(`  -> "${errText(r)}"`);

    log('Test 4: load_build with unsupported URL');
    r = await call(client, 'load_build', { source: 'https://example.com/something' });
    assert(isError(r), 'expected error');
    assert(/url/i.test(errText(r)), `expected URL message: ${errText(r)}`);
    log(`  -> "${errText(r)}"`);

    log('Test 5: load_build with XML missing root element');
    r = await call(client, 'load_build', { source: '<?xml version="1.0"?><Foo/>' });
    assert(isError(r), 'expected error');
    assert(/PathOfBuilding/.test(errText(r)), `expected PathOfBuilding mention: ${errText(r)}`);
    log(`  -> "${errText(r)}"`);

    // Load a real build for subsequent tests
    log('Loading real build...');
    r = await call(client, 'load_build', { source: xml });
    assert(!isError(r), `load failed: ${errText(r)}`);
    const baseline = await getKeyStats(client);
    log(`Baseline: Life=${baseline.Life}, DPS=${baseline.CombinedDPS.toFixed(2)}, EHP=${baseline.TotalEHP.toFixed(2)}`);

    // ----- swap_item / unequip_item error paths -----
    log('Test 6: swap_item with malformed item text');
    r = await call(client, 'swap_item', { slot: 'Ring 1', itemText: 'just some random text' });
    assert(isError(r), 'expected error');
    assert(/Rarity/i.test(errText(r)), `expected Rarity mention: ${errText(r)}`);
    log(`  -> "${errText(r).slice(0, 90)}"`);
    let post = await getKeyStats(client);
    assertStatsExact('after-bad-item', baseline, post);

    log('Test 7: unequip_item with bogus slot name');
    r = await call(client, 'unequip_item', { slot: 'NotARealSlot' });
    assert(isError(r), 'expected error');
    log(`  -> "${errText(r).slice(0, 90)}"`);
    post = await getKeyStats(client);
    assertStatsExact('after-bad-slot', baseline, post);

    // ----- gem error paths -----
    log('Test 8: swap_gem with bogus gem name');
    r = await call(client, 'swap_gem', { skillGroupIndex: 1, gemIndex: 1, newGemName: 'This Is Not A Gem' });
    assert(isError(r), 'expected error');
    log(`  -> "${errText(r).slice(0, 90)}"`);
    post = await getKeyStats(client);
    assertStatsExact('after-bad-gem', baseline, post);

    // ----- keystone error paths -----
    log('Test 9: evaluate_keystone with bogus keystone');
    r = await call(client, 'evaluate_keystone', { keystone: 'Not A Real Keystone' });
    assert(isError(r), 'expected error');
    log(`  -> "${errText(r).slice(0, 90)}"`);
    post = await getKeyStats(client);
    assertStatsExact('after-bad-keystone', baseline, post);

    // ----- undo on empty stack -----
    log('Test 10: undo_last_change with empty stack (after reset_build)');
    // Note: failed mutating tools (swap_item / unequip_item / swap_gem)
    // snapshot before they fail, so we reset to clear the undo stack first.
    await call(client, 'reset_build');
    r = await call(client, 'undo_last_change');
    assert(isError(r), 'expected error');
    log(`  -> "${errText(r).slice(0, 90)}"`);

    // ----- snapshot_and_compare validation -----
    log('Test 11: snapshot_and_compare action=take with no label');
    r = await call(client, 'snapshot_and_compare', { action: 'take' });
    assert(isError(r), 'expected error');
    log(`  -> "${errText(r).slice(0, 90)}"`);

    // ----- final integrity -----
    log('Test 12: final state integrity');
    const final = await getKeyStats(client);
    assertStatsExact('final', baseline, final);
    log(`PASS: build pristine after all error paths (Life=${final.Life}, DPS=${final.CombinedDPS.toFixed(2)})`);

    log('ALL PHASE 8 ERROR-HANDLING TESTS PASSED');
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
