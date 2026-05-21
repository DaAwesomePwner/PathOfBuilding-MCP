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

interface ToolTextContent {
  type: 'text';
  text: string;
}

function extractText(result: unknown): string {
  const r = result as { content?: ToolTextContent[]; isError?: boolean };
  if (r.isError) {
    throw new Error(`Tool returned error: ${r.content?.[0]?.text ?? 'unknown'}`);
  }
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

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const xml = readFileSync(fixturePath, 'utf8');
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverPath],
    env: { ...process.env, POB_PATH: paths.pobPath, LUAJIT_PATH: paths.luajitPath } as Record<string, string>,
    stderr: 'inherit',
  });

  const client = new Client({ name: 'phase4-test', version: '0.0.0' });

  try {
    log('Connecting...');
    await client.connect(transport);
    log('Connected');

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const expected of [
      'get_passive_tree', 'simulate_passive_change', 'find_best_next_nodes',
      'find_worst_allocated_nodes', 'evaluate_keystone',
    ]) {
      assert(tools.includes(expected), `missing tool ${expected}`);
    }
    log(`PASS: phase4 tools registered (total tools: ${tools.length})`);

    log('Loading build');
    await call(client, 'load_build', { source: xml });
    const baseline = await getKeyStats(client);
    log(`Baseline: Life=${baseline.Life}, DPS=${baseline.CombinedDPS}, EHP=${baseline.TotalEHP}`);

    // Test 1: get_passive_tree
    log('Test 1: get_passive_tree');
    const tree = JSON.parse(extractText(await call(client, 'get_passive_tree'))) as {
      allocatedNodes: Array<{ id: number; name: string; isKeystone: boolean; isNotable: boolean; alloc: boolean }>;
      keystones: Array<{ id: number; name: string }>;
      notables: Array<{ id: number; name: string }>;
      summary: {
        totalPoints: number;
        ascendancyPoints: number;
        maxNormalPoints: number;
        counts: Record<string, number>;
        className: string;
        ascendClassName: string;
      };
    };
    assert(tree.allocatedNodes.length > 50, `expected many allocated nodes, got ${tree.allocatedNodes.length}`);
    assert(tree.summary.totalPoints > 0, 'totalPoints should be positive');
    assert(tree.summary.ascendancyPoints > 0, 'ascendancyPoints should be positive');
    assert(tree.summary.className === 'Witch', `expected Witch, got ${tree.summary.className}`);
    assert(tree.summary.ascendClassName === 'Occultist', `expected Occultist, got ${tree.summary.ascendClassName}`);
    assert(tree.allocatedNodes.every((n) => n.alloc === true), 'all allocated nodes should have alloc=true');
    log(`PASS: ${tree.allocatedNodes.length} allocated, ${tree.keystones.length} keystones, ${tree.notables.length} notables, points=${tree.summary.totalPoints}/${tree.summary.maxNormalPoints}`);

    const firstKeystone = tree.keystones[0];

    // Test 2: simulate_passive_change — deallocate one notable, expect stat change + tree restored
    log('Test 2: simulate_passive_change (deallocate a notable)');
    const aNotable = tree.notables[0];
    assert(aNotable, 'expected at least one notable');
    const simResp = JSON.parse(
      extractText(await call(client, 'simulate_passive_change', { deallocate: [aNotable.id] })),
    ) as { valid: boolean; keyDeltas: Record<string, number> };
    log(`Simulated removal of "${aNotable.name}": deltas=${JSON.stringify(simResp.keyDeltas)} valid=${simResp.valid}`);
    const afterSim = await getKeyStats(client);
    assert(approxEq(afterSim.Life, baseline.Life), `Life should restore: baseline=${baseline.Life}, after=${afterSim.Life}`);
    assert(approxEq(afterSim.CombinedDPS, baseline.CombinedDPS), `DPS should restore`);
    log('PASS: tree restored exactly after simulation');

    // Test 3: simulate by node name
    log('Test 3: simulate_passive_change (by node name)');
    const simNamed = JSON.parse(
      extractText(await call(client, 'simulate_passive_change', { deallocate: [aNotable.name] })),
    ) as { valid: boolean; keyDeltas: Record<string, number> };
    log(`Name-based dealloc of "${aNotable.name}": deltas=${JSON.stringify(simNamed.keyDeltas)}`);
    const afterNamed = await getKeyStats(client);
    assert(approxEq(afterNamed.Life, baseline.Life), 'state should restore');
    log('PASS: name resolution works');

    // Test 4: simulate with unknown name (error)
    log('Test 4: simulate_passive_change with unknown name');
    const unknownResp = await call(client, 'simulate_passive_change', { allocate: ['Definitely Not A Real Node Name'] });
    assert(isError(unknownResp), 'unknown name should error');
    const afterUnknown = await getKeyStats(client);
    assert(approxEq(afterUnknown.Life, baseline.Life), 'state should be unaffected');
    log('PASS: unknown node rejected with state intact');

    // Test 5: find_best_next_nodes (limit results)
    log('Test 5: find_best_next_nodes (count=5, optimizeFor=Life)');
    const best = JSON.parse(
      extractText(await call(client, 'find_best_next_nodes', { count: 5, optimizeFor: 'Life' })),
    ) as { count: number; rankings: Array<{ nodeName: string; delta: number; isKeystone: boolean; nodeType: string }> };
    assert(best.count <= 5, `count should be <=5, got ${best.count}`);
    assert(best.count > 0, 'should find at least one reachable node');
    assert(best.rankings.every((r) => r.nodeType !== 'Socket'), 'jewel sockets should be excluded by default');
    log(`PASS: top ${best.count} (best="${best.rankings[0]?.nodeName}" delta=${best.rankings[0]?.delta})`);

    // Test 6: state restored after find_best_next_nodes
    log('Test 6: state integrity after find_best_next_nodes');
    const afterBest = await getKeyStats(client);
    assert(
      approxEq(afterBest.Life, baseline.Life) && approxEq(afterBest.CombinedDPS, baseline.CombinedDPS),
      `state should match baseline: ${JSON.stringify({ baseline, afterBest })}`,
    );
    log('PASS: state restored');

    // Test 7: find_worst_allocated_nodes
    log('Test 7: find_worst_allocated_nodes (count=5)');
    const worst = JSON.parse(
      extractText(await call(client, 'find_worst_allocated_nodes', { count: 5, optimizeFor: 'Life' })),
    ) as { count: number; rankings: Array<{ nodeName: string; lossIfRemoved: number; nodeType: string; isKeystone: boolean }> };
    assert(worst.count > 0, 'should find at least one removable node');
    assert(worst.rankings.every((r) => !r.isKeystone), 'keystones should be excluded');
    assert(worst.rankings.every((r) => r.nodeType === 'Normal'), 'only Normal nodes should be tested');
    log(`PASS: worst ${worst.count} (least valuable="${worst.rankings[0]?.nodeName}" loss=${worst.rankings[0]?.lossIfRemoved})`);

    // Test 8: state restored after find_worst
    log('Test 8: state integrity after find_worst_allocated_nodes');
    const afterWorst = await getKeyStats(client);
    assert(
      approxEq(afterWorst.Life, baseline.Life) && approxEq(afterWorst.CombinedDPS, baseline.CombinedDPS),
      `state should match baseline: ${JSON.stringify({ baseline, afterWorst })}`,
    );
    log('PASS: state restored');

    // Test 9: evaluate_keystone (toggle a currently allocated keystone)
    if (firstKeystone) {
      log(`Test 9: evaluate_keystone "${firstKeystone.name}"`);
      const ev = JSON.parse(
        extractText(await call(client, 'evaluate_keystone', { keystone: firstKeystone.name })),
      ) as { keystone: string; currentlyAllocated: boolean; action: string; keyDeltas: Record<string, number>; nodeStats: string[] };
      assert(ev.currentlyAllocated === true, 'should be currently allocated');
      assert(ev.action === 'removed', 'action should be "removed"');
      const totalAbsDelta = Math.abs(ev.keyDeltas.CombinedDPS) + Math.abs(ev.keyDeltas.Life) + Math.abs(ev.keyDeltas.TotalEHP);
      assert(totalAbsDelta > 0, 'keystone removal should produce some stat change');
      const afterEv = await getKeyStats(client);
      assert(approxEq(afterEv.Life, baseline.Life) && approxEq(afterEv.CombinedDPS, baseline.CombinedDPS), 'state should restore');
      log(`PASS: removed "${firstKeystone.name}" → keyDeltas=${JSON.stringify(ev.keyDeltas)}, restored`);
    } else {
      log('Test 9: SKIPPED (no allocated keystone)');
    }

    // Test 10: evaluate_keystone for not-allocated keystone
    log('Test 10: evaluate_keystone "Chaos Inoculation" (likely not allocated)');
    const ciResp = await call(client, 'evaluate_keystone', { keystone: 'Chaos Inoculation' });
    if (isError(ciResp)) {
      log('  CI not in tree data: SKIPPED');
    } else {
      const ci = JSON.parse(extractText(ciResp)) as { currentlyAllocated: boolean; action: string };
      log(`  CI currentlyAllocated=${ci.currentlyAllocated}, action=${ci.action}`);
      const afterCi = await getKeyStats(client);
      assert(approxEq(afterCi.Life, baseline.Life), 'state should restore after CI eval');
      log('PASS: CI eval restored state');
    }

    // Test 11: invalid keystone name
    log('Test 11: evaluate_keystone with non-keystone name');
    const badResp = await call(client, 'evaluate_keystone', { keystone: 'Not A Real Keystone' });
    assert(isError(badResp), 'unknown keystone should error');
    log('PASS: invalid keystone rejected');

    // Final integrity check
    log('Test 12: final overall state integrity');
    const final = await getKeyStats(client);
    assert(
      approxEq(final.Life, baseline.Life)
        && approxEq(final.CombinedDPS, baseline.CombinedDPS)
        && approxEq(final.TotalEHP, baseline.TotalEHP),
      `final state should match baseline: ${JSON.stringify({ baseline, final })}`,
    );
    log('PASS: build pristine after all phase 4 operations');
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

main()
  .then(() => {
    log('ALL PHASE 4 TESTS PASSED');
    process.exit(0);
  })
  .catch((error: unknown) => {
    log(`FAILED: ${error instanceof Error ? error.stack : error}`);
    process.exit(1);
  });
