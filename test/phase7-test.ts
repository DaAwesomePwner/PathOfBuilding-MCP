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
    priority: number | null;
    note?: string;
    kind?: string;
    suggestedMods?: Array<{ mod: string; weight: number }>;
    modsError?: string;
    error?: string;
    currentItemName: string | null;
  }>;
  modsNote?: string;
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
    const diagReply = (await call(client, 'diagnose_build')) as { content: ToolTextContent[] };
    assert(diagReply.content.length === 1, `diagnose_build returns one content part, got ${diagReply.content.length}`);
    const diagAll = JSON.parse(extractText(diagReply)) as DiagnoseResp;
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
    const diagDef = JSON.parse(extractText(await call(client, 'diagnose_build', { focus: 'defense' }))) as DiagnoseResp;
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
    const xmlBeforeSug = extractText(await call(client, 'export_build', { format: 'xml' }));
    const sugReply = (await call(client, 'suggest_upgrades')) as { content: ToolTextContent[] };
    assert(sugReply.content.length === 1, `suggest_upgrades returns one content part, got ${sugReply.content.length}`);
    const sugAll = JSON.parse(extractText(sugReply)) as UpgradeResp;
    assert(sugAll.suggestions.every((s) => !('currentItem' in s)), 'suggest_upgrades leaves out the full item');
    log(`  suggest_upgrades reply: ${sugReply.content[0].text.length} bytes`);
    assert(extractText(await call(client, 'export_build', { format: 'xml' })) === xmlBeforeSug, 'export changed after suggest_upgrades');
    assert(sugAll.suggestions.length >= 5, `expected several slot suggestions, got ${sugAll.suggestions.length}`);
    assert(sugAll.suggestions.some((s) => s.dpsContribution > 0), 'no slot contributes DPS');
    for (const s of sugAll.suggestions) {
      assert(typeof s.slot === 'string', 'slot string');
      assert(typeof s.priority === 'number' || (s.priority === null && typeof s.note === 'string'), 'priority number, or null with a note');
      if (s.suggestedMods !== undefined) {
        assert(s.suggestedMods.every((m) => typeof m.mod === 'string' && typeof m.weight === 'number' && m.weight > 0), 'suggestedMods are {mod, weight}');
      }
    }
    const withMods = sugAll.suggestions.filter((s) => s.suggestedMods !== undefined);
    assert(withMods.length === 3 && withMods.every((s, i) => s === sugAll.suggestions[i]), 'the 3 highest-priority slots get PoB-weighted mods');
    assert(typeof sugAll.modsNote === 'string', 'modsNote names the slots without suggested mods');
    log(`  suggested mods for ${withMods.map((s) => s.slot).join(', ')}`);
    const sugRanked = sugAll.suggestions.filter((s) => !s.empty && s.priority !== null);
    assert(['gear', 'flask', 'treeJewel'].every((k) => sugAll.suggestions.some((s) => s.kind === k)), 'gear, flask and tree jewel slots are listed');
    for (let i = 1; i < sugRanked.length; i++) {
      assert(sugRanked[i - 1].priority! >= sugRanked[i].priority!, 'suggest_upgrades is not sorted by priority (highest first)');
    }
    const afterSug = await getKeyStats(client);
    assert(approxEq(afterSug.Life, baseline.Life), 'Life restored after suggest_upgrades');
    assert(approxEq(afterSug.CombinedDPS, baseline.CombinedDPS), `DPS restored after suggest_upgrades (b=${baseline.CombinedDPS}, a=${afterSug.CombinedDPS})`);
    log(`PASS: ${sugAll.suggestions.length} slots ranked, state restored`);

    // Test 5: suggest_upgrades (single slot)
    log('Test 5: suggest_upgrades (single slot Body Armour)');
    const sugSingle = JSON.parse(extractText(await call(client, 'suggest_upgrades', { slot: 'Body Armour' }))) as UpgradeResp;
    assert(sugSingle.suggestions.length === 1, `expected 1, got ${sugSingle.suggestions.length}`);
    assert(sugSingle.suggestions[0].slot === 'Body Armour', 'slot match');
    assert((sugSingle.suggestions[0].suggestedMods?.length ?? 0) > 0 && sugSingle.modsNote === undefined, 'the given slot gets suggested mods');
    log(`  Body Armour DPS contribution: ${sugSingle.suggestions[0].dpsContribution}`);
    log('PASS: single-slot suggest works');

    // Test 5b: modsNote counts only the slots the trade generator was run for
    // (an empty flask slot carries its own modsError and is not one of them).
    log('Test 5b: suggest_upgrades modsNote with an unsupported slot');
    assert(!(await call(client, 'unequip_item', { slot: 'Flask 5' }) as { isError?: boolean }).isError, 'unequip Flask 5');
    const sugTen = JSON.parse(extractText(await call(client, 'suggest_upgrades', { modSlots: 10 }))) as UpgradeResp;
    const emptyFlask = sugTen.suggestions.find((s) => s.slot === 'Flask 5');
    assert(emptyFlask?.empty && /Empty flask slot/.test(emptyFlask.modsError ?? '') && emptyFlask.suggestedMods === undefined, 'empty flask slot: modsError, no query');
    const queried = sugTen.suggestions.filter((s) => s.suggestedMods !== undefined || (s.modsError !== undefined && !/Empty flask slot/.test(s.modsError))).length;
    assert(queried === 10, `10 slots queried, got ${queried}`);
    assert(/suggestedMods were computed for 10 supported slot\(s\) only/.test(sugTen.modsNote ?? ''), `modsNote counts queried slots only: ${sugTen.modsNote}`);
    assert(sugTen.suggestions.every((s) => !('modsQueried' in s)), 'the internal modsQueried marker is left out');
    assert(!(await call(client, 'undo_last_change') as { isError?: boolean }).isError, 'undo the unequip');
    log('PASS: modsNote counts queried slots only');

    // Test 5c: modsNote says which slots a larger modSlots reaches and which
    // only `slot` reaches (empty or unmeasured jewel / abyssal sockets).
    log('Test 5c: suggest_upgrades modsNote with an empty jewel socket');
    const noteParts = (r: UpgradeResp) => {
      const open = r.suggestions.filter((s) => s.error === undefined && s.suggestedMods === undefined && s.modsError === undefined);
      const sockets = open.filter((s) => s.priority === null && (s.kind === 'treeJewel' || s.kind === 'abyssal')).length;
      return { reachable: open.length - sockets, sockets };
    };
    const def = noteParts(sugAll);
    assert(def.reachable > 0 && new RegExp(`pass a larger modSlots \\(or slot\\) for the other ${def.reachable} ranked or listed slot\\(s\\)`).test(sugAll.modsNote ?? ''),
      `default modsNote names the slots a larger modSlots reaches: ${sugAll.modsNote}`);
    assert(!(await call(client, 'allocate_nodes', { nodes: [26725] }) as { isError?: boolean }).isError, 'allocate the empty socket 26725');
    const sugSocket = JSON.parse(extractText(await call(client, 'suggest_upgrades', { modSlots: 10 }))) as UpgradeResp;
    const emptySocket = sugSocket.suggestions.find((s) => s.slot === 'Jewel 26725');
    assert(emptySocket?.empty && emptySocket.priority === null && emptySocket.suggestedMods === undefined, 'the empty socket is listed without a query');
    const withSocket = noteParts(sugSocket);
    assert(withSocket.sockets >= 1 && new RegExp(`pass slot for the ${withSocket.sockets} empty or unmeasured jewel / abyssal socket\\(s\\), which modSlots never reaches`)
      .test(sugSocket.modsNote ?? ''), `modsNote names the sockets only slot reaches: ${sugSocket.modsNote}`);
    assert(withSocket.reachable > 0 || !/larger modSlots/.test(sugSocket.modsNote ?? ''), 'no larger-modSlots advice when nothing is left for it');
    assert(!(await call(client, 'undo_last_change') as { isError?: boolean }).isError, 'undo the allocation');
    log('PASS: modsNote separates modSlots and slot');

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
