import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decodeBuildCode } from '../src/lua-bridge.js';
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

interface DiagnoseResp { checks: Array<{ category: string; severity: string; message: string; suggestion: string }> }
interface UpgradeResp {
  suggestions: Array<{
    slot: string;
    empty: boolean;
    dpsContribution: number;
    ehpContribution: number;
    priority: number;
    suggestedMods: string[];
    currentItemName: string | null;
  }>;
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

  const client = new Client({ name: 'phase7-test', version: '0.0.0' });

  try {
    log('Connecting...');
    await client.connect(transport);
    log('Connected');

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const expected of ['diagnose_build', 'suggest_upgrades', 'export_build', 'snapshot_and_compare', 'reset_build']) {
      assert(tools.includes(expected), `missing tool ${expected}`);
    }
    log(`PASS: phase7 tools registered (total tools: ${tools.length})`);

    log('Loading build');
    await call(client, 'load_build', { source: xml });
    const baseline = await getKeyStats(client);
    log(`Baseline: Life=${baseline.Life}, DPS=${baseline.CombinedDPS}, EHP=${baseline.TotalEHP}`);

    // Test 1: diagnose_build (default = all)
    log('Test 1: diagnose_build (no focus)');
    const diagAll = JSON.parse(extractText(await call(client, 'diagnose_build'), 1)) as DiagnoseResp;
    assert(Array.isArray(diagAll.checks), 'checks should be an array');
    log(`  ${diagAll.checks.length} diagnostics returned`);
    for (const c of diagAll.checks) {
      assert(['critical', 'warning', 'info'].includes(c.severity), `bad severity ${c.severity}`);
      assert(typeof c.message === 'string' && c.message.length > 0, 'empty message');
      assert(typeof c.suggestion === 'string' && c.suggestion.length > 0, 'empty suggestion');
    }
    log('PASS: diagnose_build returns well-formed checks');

    // Test 2: diagnose_build focused on defense
    log('Test 2: diagnose_build (focus=defense)');
    const diagDef = JSON.parse(extractText(await call(client, 'diagnose_build', { focus: 'defense' }), 1)) as DiagnoseResp;
    for (const c of diagDef.checks) {
      assert(c.category === 'defense', `expected defense-only, got category=${c.category}`);
    }
    log(`PASS: ${diagDef.checks.length} defense-only diagnostics`);

    // Test 3: diagnose_build is non-mutating
    log('Test 3: diagnose_build state integrity');
    await call(client, 'diagnose_build');
    await call(client, 'diagnose_build', { focus: 'offense' });
    await call(client, 'diagnose_build', { focus: 'qol' });
    const afterDiag = await getKeyStats(client);
    assert(approxEq(afterDiag.Life, baseline.Life), 'Life unchanged after diagnose');
    assert(approxEq(afterDiag.CombinedDPS, baseline.CombinedDPS), 'DPS unchanged after diagnose');
    log('PASS: diagnose_build is read-only');

    // Test 4: suggest_upgrades (all slots)
    log('Test 4: suggest_upgrades (all slots)');
    const sugAll = JSON.parse(extractText(await call(client, 'suggest_upgrades'), 1)) as UpgradeResp;
    assert(sugAll.suggestions.length >= 5, `expected several slot suggestions, got ${sugAll.suggestions.length}`);
    for (const s of sugAll.suggestions) {
      assert(typeof s.slot === 'string', 'slot string');
      assert(typeof s.priority === 'number', 'priority number');
      assert(Array.isArray(s.suggestedMods), 'suggestedMods array');
    }
    const afterSug = await getKeyStats(client);
    assert(approxEq(afterSug.Life, baseline.Life), 'Life restored after suggest_upgrades');
    assert(approxEq(afterSug.CombinedDPS, baseline.CombinedDPS), `DPS restored after suggest_upgrades (b=${baseline.CombinedDPS}, a=${afterSug.CombinedDPS})`);
    log(`PASS: ${sugAll.suggestions.length} slots ranked, state restored`);

    // Test 5: suggest_upgrades (single slot)
    log('Test 5: suggest_upgrades (single slot Body Armour)');
    const sugSingle = JSON.parse(extractText(await call(client, 'suggest_upgrades', { slot: 'Body Armour' }), 1)) as UpgradeResp;
    assert(sugSingle.suggestions.length === 1, `expected 1, got ${sugSingle.suggestions.length}`);
    assert(sugSingle.suggestions[0].slot === 'Body Armour', 'slot match');
    log(`  Body Armour DPS contribution: ${sugSingle.suggestions[0].dpsContribution}`);
    log('PASS: single-slot suggest works');

    // Test 6: export_build (summary)
    log('Test 6: export_build (summary)');
    const summary = extractText(await call(client, 'export_build'));
    assert(/Witch/i.test(summary) || /Occultist/i.test(summary), `summary missing class: ${summary.slice(0, 80)}`);
    assert(/Life:/.test(summary), 'summary missing Life');
    assert(/Combined DPS:/.test(summary), 'summary missing DPS');
    log('PASS: summary contains class, life, DPS');

    // Test 7: export_build (xml round-trip)
    log('Test 7: export_build (xml)');
    const exportedXML = extractText(await call(client, 'export_build', { format: 'xml' }));
    assert(exportedXML.startsWith('<?xml') || exportedXML.startsWith('<PathOfBuilding'), `not XML: ${exportedXML.slice(0, 50)}`);
    assert(/<Build/.test(exportedXML), 'xml missing Build element');
    log(`PASS: XML returned (${exportedXML.length} bytes)`);

    // Test 8: export_build (code round-trip)
    log('Test 8: export_build (code) round-trip');
    const code = extractText(await call(client, 'export_build', { format: 'code' }));
    assert(code.length > 100, 'code too short');
    const decoded = decodeBuildCode(code);
    assert(decoded.startsWith('<?xml') || decoded.startsWith('<PathOfBuilding'), 'decoded code is not XML');
    log(`PASS: code (${code.length} chars) round-trips to XML`);

    // Test 9: snapshot_and_compare workflow
    log('Test 9: snapshot_and_compare (take/list/compare)');
    await call(client, 'snapshot_and_compare', { action: 'take', label: 'baseline' });
    const list1 = JSON.parse(extractText(await call(client, 'snapshot_and_compare', { action: 'list' }))) as { snapshots: string[] };
    assert(list1.snapshots.includes('baseline'), 'baseline label saved');

    // Make a permanent change
    await call(client, 'set_config', { options: { enemyIsBoss: 'None' } });
    await call(client, 'snapshot_and_compare', { action: 'take', label: 'after_config' });
    const compareResp = JSON.parse(extractText(await call(client, 'snapshot_and_compare', {
      action: 'compare', labelA: 'baseline', labelB: 'after_config',
    }))) as { from: string; to: string; diff: Record<string, { delta: number }> };
    assert(compareResp.diff.CombinedDPS && compareResp.diff.CombinedDPS.delta !== 0, 'expected DPS delta');
    log(`  DPS delta baseline→after_config: ${compareResp.diff.CombinedDPS.delta}`);

    // Compare with "current" — must not leave an extra label in `list`
    const listBefore = JSON.parse(extractText(await call(client, 'snapshot_and_compare', { action: 'list' }))) as { snapshots: string[] };
    const compareCurrent = JSON.parse(extractText(await call(client, 'snapshot_and_compare', {
      action: 'compare', labelA: 'baseline', labelB: 'current',
    }))) as { diff: Record<string, { delta: number }> };
    assert(compareCurrent.diff.CombinedDPS && compareCurrent.diff.CombinedDPS.delta !== 0, 'live current diff');
    const listAfter = JSON.parse(extractText(await call(client, 'snapshot_and_compare', { action: 'list' }))) as { snapshots: string[] };
    assert(JSON.stringify(listAfter.snapshots) === JSON.stringify(listBefore.snapshots), `compare against "current" changed the snapshot list: ${JSON.stringify(listBefore.snapshots)} -> ${JSON.stringify(listAfter.snapshots)}`);
    // ...including when the diff throws (unknown labelA)
    const badCurrent = await call(client, 'snapshot_and_compare', { action: 'compare', labelA: 'no_such_label', labelB: 'current' });
    assert(badCurrent.isError === true, 'compare of unknown labelA against current should error');
    const listAfterBad = JSON.parse(extractText(await call(client, 'snapshot_and_compare', { action: 'list' }))) as { snapshots: string[] };
    assert(JSON.stringify(listAfterBad.snapshots) === JSON.stringify(listBefore.snapshots), `failed compare against "current" changed the snapshot list: ${JSON.stringify(listAfterBad.snapshots)}`);
    log('PASS: snapshot_and_compare workflow (no leftover label after compare against "current")');

    // Test 10: undo_last_change reverts the set_config
    log('Test 10: undo last change');
    await call(client, 'undo_last_change');
    const afterUndo = await getKeyStats(client);
    assert(approxEq(afterUndo.CombinedDPS, baseline.CombinedDPS), `undo should restore DPS (b=${baseline.CombinedDPS} a=${afterUndo.CombinedDPS})`);
    log('PASS: undo_last_change works');

    // Test 11: reset_build after multiple changes
    log('Test 11: reset_build after several mutations');
    await call(client, 'set_config', { options: { enemyIsBoss: 'None' } });
    await call(client, 'set_config', { options: { useFrenzyCharges: false } });
    const resetResp = JSON.parse(extractText(await call(client, 'reset_build'))) as { class: string; level: number };
    assert(resetResp.class && resetResp.level, 'reset returns build info');
    const afterReset = await getKeyStats(client);
    assert(approxEq(afterReset.Life, baseline.Life), 'Life restored by reset');
    assert(approxEq(afterReset.CombinedDPS, baseline.CombinedDPS), `DPS restored by reset (b=${baseline.CombinedDPS} a=${afterReset.CombinedDPS})`);
    assert(approxEq(afterReset.TotalEHP, baseline.TotalEHP), 'EHP restored by reset');
    log('PASS: reset_build returns to original');

    // Test 12: undo_last_change after reset throws
    log('Test 12: undo_last_change with empty stack');
    const emptyUndo = await call(client, 'undo_last_change');
    assert(isError(emptyUndo), 'undo on empty stack should error');
    log('PASS: empty undo errors cleanly');

    // Test 13: snapshot_and_compare validation
    log('Test 13: snapshot_and_compare validation');
    const badTake = await call(client, 'snapshot_and_compare', { action: 'take' });
    assert(isError(badTake), 'take without label should error');
    const badCompare = await call(client, 'snapshot_and_compare', { action: 'compare', labelA: 'baseline' });
    assert(isError(badCompare), 'compare without labelB should error');
    log('PASS: validation rejects missing args');

    // Test 14: final state integrity
    log('Test 14: final state integrity');
    const final = await getKeyStats(client);
    assert(
      approxEq(final.Life, baseline.Life)
        && approxEq(final.CombinedDPS, baseline.CombinedDPS)
        && approxEq(final.TotalEHP, baseline.TotalEHP),
      `final mismatch: ${JSON.stringify({ baseline, final })}`,
    );
    log('PASS: build pristine after all phase 7 operations');
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

main()
  .then(() => {
    log('ALL PHASE 7 TESTS PASSED');
    process.exit(0);
  })
  .catch((e: unknown) => {
    console.error('FAILED:', e);
    process.exit(1);
  });
