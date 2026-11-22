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
  // Generous: other test scripts run at the same time on a CI runner.
  return client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
}

async function exportXml(client: Client): Promise<string> {
  return extractText(await call(client, 'export_build', { format: 'xml' }));
}

/** Call a read-only tool; the exported build must stay byte-identical. */
async function readOnlyCall(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const before = await exportXml(client);
  const t = performance.now();
  const result = await call(client, name, args);
  log(`  ${name} ${JSON.stringify(args)}: ${(performance.now() - t).toFixed(0)} ms`);
  assert((await exportXml(client)) === before, `${name}: the exported build changed`);
  return result;
}

interface Ranking {
  nodeId: number;
  nodeName: string;
  nodeType: string;
  isKeystone: boolean;
  isNotable: boolean;
  delta: number;
  pointsCost?: number;
  deltaPerPoint?: number;
  path?: Array<{ id: number; name: string }>;
  lossIfRemoved?: number;
  pointsRefunded?: number;
  lossPerPoint?: number;
  removedNodes?: Array<{ id: number; name: string }>;
  removedNodeCount?: number;
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
    const tree = JSON.parse(extractText(await call(client, 'get_passive_tree', { detail: 'full' }))) as {
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

    log('Test 1b: get_passive_tree default (compact)');
    const compact = JSON.parse(extractText(await call(client, 'get_passive_tree'))) as {
      allocatedNodes: Array<Record<string, unknown>>;
      keystones: Array<{ id: number; name: string; stats: string[] }>;
      notables: Array<{ id: number; name: string; stats: string[] }>;
      summary: { totalPoints: number };
    };
    assert(
      JSON.stringify(compact.allocatedNodes.map((n) => n.id)) === JSON.stringify(tree.allocatedNodes.map((n) => n.id)),
      'compact allocatedNodes lists the same nodes',
    );
    assert(compact.allocatedNodes.every((n) => typeof n.name === 'string' && typeof n.type === 'string' && !('stats' in n)),
      'compact allocatedNodes: id, name, type, no stats');
    assert(compact.keystones.length === tree.keystones.length && compact.keystones.every((k) => k.stats.length > 0), 'keystones keep their stats');
    assert(compact.notables.length === tree.notables.length, 'notables are all listed');
    assert(compact.summary.totalPoints === tree.summary.totalPoints, 'summary unchanged');
    log('PASS: compact tree');

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

    // Test 4a: a name several allocated nodes share is refused with their ids.
    log('Test 4a: simulate_passive_change with an ambiguous name');
    const seen = new Map<string, number[]>();
    for (const n of tree.allocatedNodes) seen.set(n.name, [...(seen.get(n.name) ?? []), n.id]);
    const [dupName, dupIds] = [...seen.entries()].find(([, ids]) => ids.length > 1) ?? [];
    assert(dupName && dupIds, 'fixture needs two allocated nodes with the same name');
    const ambiguous = (await call(client, 'simulate_passive_change', { deallocate: [dupName] })) as { isError?: boolean; content: ToolTextContent[] };
    assert(ambiguous.isError === true, `deallocate "${dupName}" should be refused as ambiguous`);
    const ambiguousText = ambiguous.content[0].text;
    assert(/matches \d+ nodes/.test(ambiguousText) && ambiguousText.includes('Pass the node id'), `message: ${ambiguousText}`);
    // Up to 12 candidates are listed (lowest ids first), then "and N more".
    const listedIds = [...dupIds].sort((x, y) => x - y).slice(0, 12);
    assert(listedIds.every((id) => ambiguousText.includes(String(id))) && ambiguousText.includes('allocated'), `ids missing: ${ambiguousText}`);
    assert(ambiguousText.includes(`matches ${dupIds.length} nodes`), `count: ${ambiguousText}`);
    assert(!ambiguousText.startsWith('Internal error'), 'ambiguity is a user error');
    const afterAmbiguous = await getKeyStats(client);
    assert(approxEq(afterAmbiguous.Life, baseline.Life), 'state should be unaffected');
    log(`PASS: ${ambiguousText.slice(0, 160)}`);

    // Test 4b: one node to allocate runs on the probe engine; the export stays byte-identical.
    log('Test 4b: simulate_passive_change (allocate one node)');
    const near = JSON.parse(
      extractText(await call(client, 'find_best_next_nodes', { count: 1, optimizeFor: 'Life', maxPoints: 3, rankBy: 'total' })),
    ) as { rankings: Ranking[] };
    const target = near.rankings[0];
    assert(target, 'no node to allocate');
    const simOne = JSON.parse(
      extractText(await readOnlyCall(client, 'simulate_passive_change', { allocate: [target.nodeId] })),
    ) as { valid: boolean; keyDeltas: Record<string, number> };
    assert(simOne.valid, 'allocating one node with its path must keep the tree connected');
    assert(approxEq(simOne.keyDeltas.Life, target.delta, 1e-9), `Life delta ${simOne.keyDeltas.Life} vs find_best_next_nodes ${target.delta}`);
    log(`PASS: allocate "${target.nodeName}" (${target.pointsCost} points) → Life ${simOne.keyDeltas.Life}`);

    // Test 5: find_best_next_nodes (limit results)
    log('Test 5: find_best_next_nodes (count=5, optimizeFor=Life)');
    const best = JSON.parse(
      extractText(await readOnlyCall(client, 'find_best_next_nodes', { count: 5, optimizeFor: 'Life' })),
    ) as { count: number; maxPoints: number; rankBy: string; evaluated: number; rankings: Ranking[] };
    assert(best.count <= 5, `count should be <=5, got ${best.count}`);
    assert(best.count > 0, 'should find at least one reachable node');
    assert(best.maxPoints === 3 && best.rankBy === 'perPoint', `defaults: maxPoints ${best.maxPoints}, rankBy ${best.rankBy}`);
    assert(best.rankings.every((r) => r.nodeType !== 'Socket'), 'jewel sockets should be excluded by default');
    for (const r of best.rankings) {
      assert(r.pointsCost !== undefined && r.pointsCost >= 1 && r.pointsCost <= 3, `${r.nodeName}: pointsCost ${r.pointsCost}`);
      assert(r.path?.length === r.pointsCost && r.path[r.path.length - 1].id === r.nodeId, `${r.nodeName}: path ${JSON.stringify(r.path)}`);
      assert(approxEq(r.deltaPerPoint, r.delta / r.pointsCost), `${r.nodeName}: deltaPerPoint`);
    }
    for (let i = 1; i < best.rankings.length; i++) {
      assert((best.rankings[i - 1].deltaPerPoint ?? 0) >= (best.rankings[i].deltaPerPoint ?? 0), 'not ranked by delta per point');
    }
    log(`PASS: top ${best.count} of ${best.evaluated} (best="${best.rankings[0]?.nodeName}" delta=${best.rankings[0]?.delta} over ${best.rankings[0]?.pointsCost} points)`);

    log('Test 5b: find_best_next_nodes maxPoints / rankBy');
    const adjacent = JSON.parse(
      extractText(await readOnlyCall(client, 'find_best_next_nodes', { count: 50, optimizeFor: 'Life', maxPoints: 1, rankBy: 'total' })),
    ) as { evaluated: number; rankings: Ranking[] };
    assert(adjacent.rankings.every((r) => r.pointsCost === 1), 'maxPoints 1 returned a node costing more than one point');
    for (let i = 1; i < adjacent.rankings.length; i++) {
      assert(adjacent.rankings[i - 1].delta >= adjacent.rankings[i].delta, 'rankBy total is not ranked by delta');
    }
    const wide = JSON.parse(
      extractText(await readOnlyCall(client, 'find_best_next_nodes', { count: 50, maxPoints: 3, rankBy: 'total' })),
    ) as { evaluated: number; rankings: Ranking[] };
    assert(wide.evaluated > adjacent.evaluated, `maxPoints 3 evaluated ${wide.evaluated}, maxPoints 1 ${adjacent.evaluated}`);
    assert(wide.rankings.some((r) => (r.pointsCost ?? 0) > 1), 'maxPoints 3 found no node costing more than one point');
    assert(isError(await call(client, 'find_best_next_nodes', { maxPoints: 11 })), 'maxPoints 11 should be refused');
    log(`PASS: maxPoints 1 evaluated ${adjacent.evaluated} nodes, maxPoints 3 ${wide.evaluated}`);

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
      extractText(await readOnlyCall(client, 'find_worst_allocated_nodes', { count: 5, optimizeFor: 'Life' })),
    ) as { count: number; rankBy: string; rankings: Ranking[] };
    assert(worst.count > 0, 'should find at least one removable node');
    assert(worst.rankBy === 'perPoint', `default rankBy ${worst.rankBy}`);
    // Notables and keystones are evaluated too (with their dependents); masteries never.
    assert(worst.rankings.every((r) => r.nodeType !== 'Mastery' && r.nodeType !== 'ClassStart'), 'masteries and class starts are excluded');
    for (const r of worst.rankings) {
      assert((r.pointsRefunded ?? 0) >= 1 && r.removedNodes?.[0]?.id === r.nodeId, `${r.nodeName}: ${JSON.stringify(r)}`);
      assert(approxEq(r.lossPerPoint, (r.lossIfRemoved ?? 0) / (r.pointsRefunded ?? 1)), `${r.nodeName}: lossPerPoint`);
    }
    const worstAll = JSON.parse(
      extractText(await readOnlyCall(client, 'find_worst_allocated_nodes', { count: 50, optimizeFor: 'Life', rankBy: 'total' })),
    ) as { rankings: Ranking[] };
    for (let i = 1; i < worstAll.rankings.length; i++) {
      assert((worstAll.rankings[i - 1].lossIfRemoved ?? 0) <= (worstAll.rankings[i].lossIfRemoved ?? 0), 'rankBy total is not ranked by loss');
    }
    const notable = worstAll.rankings.find((r) => r.isNotable && (r.pointsRefunded ?? 0) > 1);
    assert(notable, 'no notable with its dependents among the 50 least valuable nodes');
    log(`PASS: worst ${worst.count} (least valuable="${worst.rankings[0]?.nodeName}" loss=${worst.rankings[0]?.lossIfRemoved} over ${worst.rankings[0]?.pointsRefunded} points); notable "${notable.nodeName}" refunds ${notable.pointsRefunded}`);

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
        extractText(await readOnlyCall(client, 'evaluate_keystone', { keystone: firstKeystone.name })),
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
    const ciResp = await readOnlyCall(client, 'evaluate_keystone', { keystone: 'Chaos Inoculation' });
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

    // Test 13: the compact tree keeps allocated masteries' chosen effects.
    log('Test 13: get_passive_tree default keeps mastery stats');
    await call(client, 'load_build', { source: readFileSync(path.join(path.dirname(fixturePath), 'ConvertTreeMasteries.xml'), 'utf8') });
    type Node = { id: number; type: string; stats?: string[] };
    const fullM = JSON.parse(extractText(await call(client, 'get_passive_tree', { detail: 'full' }))) as { allocatedNodes: Node[] };
    const compactM = JSON.parse(extractText(await call(client, 'get_passive_tree'))) as { allocatedNodes: Node[] };
    const masteries = fullM.allocatedNodes.filter((n) => n.type === 'Mastery');
    assert(masteries.length > 0, 'fixture has allocated masteries');
    for (const m of masteries) {
      const c = compactM.allocatedNodes.find((n) => n.id === m.id);
      assert(c && (m.stats ?? []).length > 0 && JSON.stringify(c.stats) === JSON.stringify(m.stats), `mastery ${m.id}: ${JSON.stringify(c)} vs ${JSON.stringify(m.stats)}`);
    }
    assert(compactM.allocatedNodes.every((n) => n.type === 'Mastery' || n.stats === undefined), 'only masteries carry stats in allocatedNodes');
    log(`PASS: ${masteries.length} masteries with their effects (e.g. ${JSON.stringify(masteries[0].stats)})`);
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
