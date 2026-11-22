import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TOOL_ANNOTATIONS } from '../src/tool-registry.js';
import { setupTestEnv } from './_skip.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'src', 'server.ts');

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface ToolTextContent {
  type: 'text';
  text: string;
}

function extractText(result: unknown): string {
  const r = result as { content?: ToolTextContent[]; isError?: boolean };
  if (r.isError) {
    throw new Error(`Tool returned error: ${r.content?.[0]?.text ?? 'unknown'}`);
  }
  const text = r.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('Expected text content');
  return text;
}

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const xml = readFileSync(fixturePath, 'utf8');

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverPath],
    env: {
      ...process.env,
      POB_PATH: paths.pobPath,
      LUAJIT_PATH: paths.luajitPath,
    } as Record<string, string>,
    stderr: 'inherit',
  });

  const client = new Client({ name: 'pob-mcp-test', version: '0.0.0' });

  try {
    log('Connecting MCP client...');
    await client.connect(transport);
    log('Connected');

    log('Listing tools');
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    log(`Tools: ${names.join(', ')}`);
    assert(names.includes('load_build'), 'load_build missing');
    assert(names.includes('get_stats'), 'get_stats missing');
    assert(names.includes('get_skill_breakdown'), 'get_skill_breakdown missing');
    assert(names.includes('list_equipped_items'), 'list_equipped_items missing');

    log('Test 1: load_build (raw XML)');
    const loadResult = await client.callTool({
      name: 'load_build',
      arguments: { source: xml },
    });
    const loadParsed = JSON.parse(extractText(loadResult)) as Record<string, unknown>;
    assert(loadParsed.status === 'loaded', 'expected status loaded');
    assert(loadParsed.class === 'Witch', `expected Witch, got ${loadParsed.class}`);
    log(`PASS: ${loadParsed.class}/${loadParsed.ascendancy}/${loadParsed.level}`);

    log('Test 2: get_stats (all)');
    const statsResult = await client.callTool({
      name: 'get_stats',
      arguments: {},
    });
    const stats = JSON.parse(extractText(statsResult)) as Record<string, Record<string, unknown>>;
    assert(stats.offense, 'offense missing');
    assert(stats.defense, 'defense missing');
    assert(typeof stats.defense.Life === 'number' && (stats.defense.Life as number) > 0, 'Life should be > 0');
    assert(typeof stats.offense.CombinedDPS === 'number' && (stats.offense.CombinedDPS as number) > 0, 'CombinedDPS > 0');
    log(`PASS: Life=${stats.defense.Life}, CombinedDPS=${stats.offense.CombinedDPS}`);
    // Keys outside the bridge's default stat list come through the category mode too.
    assert(typeof stats.offense.Speed === 'number' && (stats.offense.Speed as number) > 0, 'offense.Speed missing');
    assert(typeof stats.offense.CritChance === 'number' && (stats.offense.CritChance as number) > 0, 'offense.CritChance missing');
    assert(typeof stats.defense.BlockChance === 'number' && (stats.defense.BlockChance as number) > 0, 'defense.BlockChance missing');
    assert(typeof stats.attributes?.Str === 'number' && typeof stats.attributes?.Int === 'number', 'attributes missing');
    assert(typeof stats.charges?.PowerChargesMax === 'number', 'charges.PowerChargesMax missing');
    log('PASS: category stats include keys outside the bridge default list');

    log('Test 3: get_stats (filtered to defense)');
    const defResult = await client.callTool({
      name: 'get_stats',
      arguments: { categories: ['defense'] },
    });
    const defStats = JSON.parse(extractText(defResult)) as Record<string, Record<string, unknown>>;
    assert(Object.keys(defStats).length === 1 && defStats.defense, 'expected only defense');
    log(`PASS: ${Object.keys(defStats.defense).length} defense stats`);

    log('Test 4: get_skill_breakdown (main)');
    const skillResult = await client.callTool({
      name: 'get_skill_breakdown',
      arguments: {},
    });
    const skill = JSON.parse(extractText(skillResult)) as {
      isMainGroup: boolean;
      gems: unknown[];
      activeGem?: { nameSpec?: string };
    };
    assert(skill.isMainGroup === true, 'expected main group');
    assert(Array.isArray(skill.gems) && skill.gems.length > 0, 'expected gems');
    log(`PASS: main skill = ${skill.activeGem?.nameSpec ?? '(unknown)'}, ${skill.gems.length} gems`);

    log('Test 5: list_equipped_items');
    const itemsResult = await client.callTool({
      name: 'list_equipped_items',
      arguments: {},
    });
    const items = JSON.parse(extractText(itemsResult)) as {
      count: number;
      items: Array<{ slot: string; rarity?: string; baseName?: string }>;
    };
    assert(items.count > 0, 'expected at least one equipped item');
    const slots = new Set(items.items.map((i) => i.slot));
    for (const expected of ['Weapon 1', 'Body Armour', 'Helmet', 'Boots', 'Ring 1', 'Ring 2']) {
      assert(slots.has(expected), `missing slot ${expected}`);
    }
    log(`PASS: ${items.count} items across ${slots.size} slots`);

    log('Test 6: load_build with invalid input (error path)');
    const badResult = await client.callTool({
      name: 'load_build',
      arguments: { source: '<not-valid>' },
    });
    const bad = badResult as { isError?: boolean; content?: ToolTextContent[] };
    assert(bad.isError === true, 'expected error response');
    log(`PASS: error reported = ${bad.content?.[0]?.text}`);

    log('Test 7: build code round-trip via load_build');
    const { deflateRawSync } = await import('zlib');
    const code = deflateRawSync(Buffer.from(xml, 'utf8'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const codeResult = await client.callTool({
      name: 'load_build',
      arguments: { source: code },
    });
    const codeParsed = JSON.parse(extractText(codeResult)) as { class?: string };
    assert(codeParsed.class === 'Witch', 'build code load failed');
    log('PASS: build code load');

    log('Test 8: tool annotations');
    const annotated = new Map(tools.tools.map((t) => [t.name, t.annotations]));
    assert(
      JSON.stringify(names) === JSON.stringify(Object.keys(TOOL_ANNOTATIONS).sort()),
      `registered tools and TOOL_ANNOTATIONS differ: ${names.filter((n) => !(n in TOOL_ANNOTATIONS))} / ${Object.keys(TOOL_ANNOTATIONS).filter((n) => !names.includes(n))}`,
    );
    for (const name of names) {
      const a = annotated.get(name);
      assert(a && typeof a.readOnlyHint === 'boolean' && typeof a.destructiveHint === 'boolean', `${name}: missing annotations`);
    }
    for (const name of ['get_stats', 'evaluate_changes', 'simulate_passive_change', 'find_best_next_nodes', 'swap_gem', 'compare_items', 'get_passive_tree']) {
      assert(annotated.get(name)?.readOnlyHint === true && annotated.get(name)?.destructiveHint === false, `${name} should be read-only`);
    }
    for (const name of ['load_build', 'reset_build', 'configure_pob_path', 'reload_engine']) {
      assert(annotated.get(name)?.readOnlyHint === false && annotated.get(name)?.destructiveHint === true, `${name} should be destructive`);
    }
    assert(annotated.get('reset_build')?.idempotentHint === true, 'reset_build is idempotent');
    assert(annotated.get('load_build')?.openWorldHint === true, 'load_build may fetch a URL');
    for (const name of ['swap_item', 'unequip_item', 'set_config', 'convert_tree_to_latest', 'allocate_nodes', 'deallocate_nodes']) {
      assert(annotated.get(name)?.readOnlyHint === false && annotated.get(name)?.destructiveHint === false, `${name} is an undoable change`);
    }
    // undo_last_change discards a change that cannot be redone.
    assert(annotated.get('undo_last_change')?.readOnlyHint === false && annotated.get('undo_last_change')?.destructiveHint === true,
      'undo_last_change should be destructive');
    log(`PASS: ${names.length} tools annotated`);

    log('Test 9: compact JSON output');
    const statsText = extractText(await client.callTool({ name: 'get_stats', arguments: {} }));
    assert(!statsText.includes('\n') && statsText === JSON.stringify(JSON.parse(statsText)), 'get_stats output is not compact JSON');
    log('PASS: no pretty-printing');

    log('Test 10: payload sizes (before = the full shape pretty-printed, as the server returned it before)');
    const text = async (name: string, args: Record<string, unknown> = {}): Promise<string> =>
      extractText(await client.callTool({ name, arguments: args }));
    const pretty = (t: string): number => JSON.stringify(JSON.parse(t), null, 2).length;
    const sizes: Array<{ tool: string; before: number; after: number; min: number }> = [
      { tool: 'get_passive_tree', before: pretty(await text('get_passive_tree', { detail: 'full' })), after: (await text('get_passive_tree')).length, min: 3 },
      { tool: 'list_equipped_items', before: pretty(await text('list_equipped_items', { detail: 'full' })), after: (await text('list_equipped_items')).length, min: 3 },
      { tool: 'list_skill_groups', before: pretty(await text('list_skill_groups', { detail: 'full' })), after: (await text('list_skill_groups')).length, min: 2 },
    ];
    for (const s of sizes) {
      log(`   ${s.tool}: ${s.before} -> ${s.after} bytes (${(s.before / s.after).toFixed(1)}x smaller)`);
      assert(s.before >= s.min * s.after, `${s.tool}: default is only ${(s.before / s.after).toFixed(1)}x smaller (want ${s.min}x)`);
    }
    const fullItems = JSON.parse(await text('list_equipped_items', { detail: 'full' })) as { items: Array<{ slot: string; raw?: string; explicits: Array<{ line: string; crafted: boolean }> }> };
    const compactItems = JSON.parse(await text('list_equipped_items')) as { items: Array<{ slot: string; raw?: string; explicits: Array<{ line: string; crafted?: boolean }> }> };
    const withText = JSON.parse(await text('list_equipped_items', { includeItemText: true })) as { items: Array<{ slot: string; raw?: string }> };
    assert(fullItems.items.every((i) => typeof i.raw === 'string') && compactItems.items.every((i) => i.raw === undefined), 'raw only with detail full');
    assert(withText.items.every((i, n) => i.raw === fullItems.items[n].raw), 'includeItemText adds the same raw text');
    fullItems.items.forEach((item, n) => {
      const lines = compactItems.items[n].explicits;
      assert(JSON.stringify(lines.map((l) => l.line)) === JSON.stringify(item.explicits.map((l) => l.line)), `${item.slot}: explicit lines differ`);
      assert(lines.every((l, k) => (l.crafted === true) === item.explicits[k].crafted), `${item.slot}: crafted flags differ`);
    });
    const groupsCompact = JSON.parse(await text('list_skill_groups')) as { groups: Array<{ supportGems: Array<Record<string, unknown>> }> };
    assert(groupsCompact.groups.every((g) => g.supportGems.every((s) => typeof s.index === 'number' && typeof s.name === 'string' && !('gemId' in s))), 'compact gems');
    log('PASS: compact defaults, full shape on request');

    log('Test 11: get_stats with a stats filter');
    const all = JSON.parse(statsText) as Record<string, Record<string, unknown>>;
    const picked = JSON.parse(await text('get_stats', { stats: ['CombinedDPS', 'Life', 'NotARealStat'] })) as { stats: Record<string, unknown> };
    assert(JSON.stringify(Object.keys(picked.stats)) === '["CombinedDPS","Life","NotARealStat"]', `keys ${Object.keys(picked.stats)}`);
    assert(picked.stats.CombinedDPS === all.offense.CombinedDPS && picked.stats.Life === all.defense.Life, 'filtered values match');
    assert(picked.stats.NotARealStat === null, 'unknown stat is null');
    log('PASS');

    log('Test 12: evaluate_changes through MCP');
    const xmlBefore = await text('export_build', { format: 'xml' });
    const evaluated = JSON.parse(await text('evaluate_changes', {
      variants: [
        { label: 'boss', config: { enemyIsBoss: 'Pinnacle' } },
        { label: 'charges', config: { usePowerCharges: true } },
        { label: 'bad', allocate: ['Not A Real Passive Node'] },
      ],
      stats: ['CombinedDPS', 'Life'],
    })) as { base: Record<string, number>; results: Array<{ label: string; error?: string; delta?: Record<string, number> }> };
    assert(evaluated.results.length === 3 && evaluated.results[2].label === 'bad' && evaluated.results[2].error, 'refused variant listed last');
    assert(evaluated.results[0].delta!.CombinedDPS >= evaluated.results[1].delta!.CombinedDPS, 'ranked by CombinedDPS');
    assert((await text('export_build', { format: 'xml' })) === xmlBefore, 'evaluate_changes changed the build');
    log(`PASS: ${evaluated.results.map((r) => `${r.label}=${r.delta?.CombinedDPS ?? r.error}`).join(', ')}`);

    log('Test 13: input bounds');
    const refused = async (name: string, args: Record<string, unknown>, what: string): Promise<void> => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content?: ToolTextContent[] };
      assert(r.isError === true, `${what} should be refused`);
    };
    const ids51 = Array.from({ length: 51 }, (_, i) => i + 1);
    const ring = 'Rarity: RARE\nBound Ring\nCoral Ring\n+30 to maximum Life';
    await refused('evaluate_changes', { variants: [{ allocate: ids51 }] }, 'evaluate_changes with 51 nodes to allocate');
    await refused('evaluate_changes', { variants: [{ deallocate: ids51 }] }, 'evaluate_changes with 51 nodes to deallocate');
    await refused('evaluate_changes', { variants: [{ items: Array.from({ length: 11 }, () => ({ slot: 'Ring 1', itemText: ring })) }] }, '11 items');
    await refused('evaluate_changes', { variants: [{ items: [{ slot: 'Ring 1', itemText: ring + '\n' + 'x'.repeat(10_000) }] }] }, 'item text over 10 KB');
    await refused('evaluate_changes', { variants: [{ gems: Array.from({ length: 21 }, () => ({ op: 'remove', group: 1, index: 1 })) }] }, '21 gem changes');
    await refused('evaluate_changes', { variants: [{ label: 'x'.repeat(101) }] }, 'a 101-character label');
    await refused('evaluate_changes', { variants: [{ config: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, true])) }] }, '51 config keys');
    await refused('simulate_passive_change', { allocate: ids51 }, 'simulate_passive_change with 51 nodes');
    const atBounds = JSON.parse(await text('evaluate_changes', {
      variants: [{ label: 'x'.repeat(100), items: [{ slot: 'Ring 1', itemText: ring }], gems: [], config: { usePowerCharges: true } }],
    })) as { results: Array<{ error?: string }> };
    assert(atBounds.results[0].error === undefined, `a variant within the bounds failed: ${atBounds.results[0].error}`);
    assert((await text('export_build', { format: 'xml' })) === xmlBefore, 'bounds checks changed the build');
    log('PASS: oversized inputs refused');
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
}

main()
  .then(() => {
    log('ALL MCP TESTS PASSED');
    process.exit(0);
  })
  .catch((error: unknown) => {
    log(`FAILED: ${error instanceof Error ? error.stack : error}`);
    process.exit(1);
  });
