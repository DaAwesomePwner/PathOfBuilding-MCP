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

interface SkillGroupView {
  index: number;
  label: string;
  slot: string;
  enabled: boolean;
  isMainSkill: boolean;
  activeGems: Array<{ name: string; level: number; quality: number; isSupport: boolean }>;
  supportGems: Array<{ name: string; level: number; quality: number; isSupport: boolean }>;
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

  const client = new Client({ name: 'phase5-test', version: '0.0.0' });

  try {
    log('Connecting...');
    await client.connect(transport);
    log('Connected');

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const expected of [
      'list_skill_groups', 'lookup_gem', 'list_available_supports',
      'swap_gem', 'compare_supports', 'evaluate_gem_levels', 'find_optimal_links',
    ]) {
      assert(tools.includes(expected), `missing tool ${expected}`);
    }
    log(`PASS: phase5 tools registered (total tools: ${tools.length})`);

    log('Loading build');
    await call(client, 'load_build', { source: xml });
    const baseline = await getKeyStats(client);
    log(`Baseline: Life=${baseline.Life}, DPS=${baseline.CombinedDPS}, EHP=${baseline.TotalEHP}`);

    // Test 1: list_skill_groups
    log('Test 1: list_skill_groups');
    const groupsResp = JSON.parse(extractText(await call(client, 'list_skill_groups'))) as {
      count: number; groups: SkillGroupView[];
    };
    assert(groupsResp.count > 0, 'expected at least one skill group');
    const mainGroup = groupsResp.groups.find((g) => g.isMainSkill);
    assert(mainGroup, 'expected a main skill group');
    assert(mainGroup.activeGems.length >= 1, 'main group should have at least one active gem');
    assert(mainGroup.supportGems.length >= 1, 'main group should have at least one support');
    log(`PASS: ${groupsResp.count} groups, main slot="${mainGroup.slot}" active=[${mainGroup.activeGems.map(g => g.name).join(',')}] supports=[${mainGroup.supportGems.map(g => g.name).join(',')}]`);

    // Test 2: lookup_gem
    log('Test 2: lookup_gem (Vortex)');
    const vortex = JSON.parse(extractText(await call(client, 'lookup_gem', { name: 'Vortex' }))) as {
      name: string; isSupport: boolean; tags: string[];
    };
    assert(vortex.name.toLowerCase().includes('vortex'), `expected Vortex, got ${vortex.name}`);
    assert(vortex.isSupport === false, 'Vortex is an active skill');
    assert(Array.isArray(vortex.tags) && vortex.tags.length > 0, 'tags should be a non-empty array');
    log(`PASS: Vortex tags=${vortex.tags.join(',')}`);

    // Test 3: lookup_gem on a support
    log('Test 3: lookup_gem (Concentrated Effect)');
    const conc = JSON.parse(extractText(await call(client, 'lookup_gem', { name: 'Concentrated Effect' }))) as {
      name: string; isSupport: boolean;
    };
    assert(conc.isSupport === true, 'Concentrated Effect is a support');
    log(`PASS: ${conc.name} isSupport=${conc.isSupport}`);

    // Test 4: list_available_supports
    log('Test 4: list_available_supports (filtered by Vortex tags)');
    const supports = JSON.parse(extractText(
      await call(client, 'list_available_supports', { activeSkillTags: vortex.tags, includeAwakened: false }),
    )) as { count: number; supports: Array<{ name: string; isSupport: boolean; isAwakened: boolean }> };
    assert(supports.count > 5, `expected many viable supports, got ${supports.count}`);
    assert(supports.supports.every((s) => s.isSupport === true), 'all should be supports');
    assert(supports.supports.every((s) => s.isAwakened === false), 'awakened should be excluded');
    log(`PASS: ${supports.count} supports for Vortex`);

    // Test 5: swap_gem — find a support gem in main group, swap to a different one
    log('Test 5: swap_gem (replace a main-group support with another support)');
    const firstSupport = mainGroup.supportGems[0];
    assert(firstSupport, 'main group must have a support gem');
    // Find the gem index within the original group structure
    // We need to find this gem's position in the full gemList (active+support combined order)
    // Since list_skill_groups returns separate active/support arrays, query bridge directly.
    // Use "Increased Critical Damage Support" as the swap target — typically broadly compatible.
    const swapTarget = 'Increased Critical Damage';
    log(`  Replacing "${firstSupport.name}" with "${swapTarget}" in group ${mainGroup.index}`);
    // We need the actual gemIndex — list_skill_groups splits but we need the underlying index.
    // Easiest: call swap_gem with gemIndex 1, 2, ... until we hit the support. Or use
    // raw list_skill_groups output: index in display = order. But our Lua returns gems in
    // their original order; the activeGems/supportGems split is post-filter. So we need
    // a different approach — we'll just hit each gem index trying to find the support.
    // Simpler: query the underlying bridge result via a tool that preserves original order.
    // Since list_skill_groups splits, do swap_gem with a level/quality preserved and let it
    // fail silently if we hit an active. We'll iterate.
    let swapResult: { keyDeltas: Record<string, number>; statDiff?: unknown } | null = null;
    let triedIndex = -1;
    for (let i = 1; i <= mainGroup.activeGems.length + mainGroup.supportGems.length; i++) {
      const resp = await call(client, 'swap_gem', {
        skillGroupIndex: mainGroup.index,
        gemIndex: i,
        newGemName: swapTarget,
      });
      if (!isError(resp)) {
        swapResult = JSON.parse(extractText(resp)) as { keyDeltas: Record<string, number> };
        triedIndex = i;
        break;
      }
    }
    assert(swapResult, 'expected at least one swap_gem call to succeed');
    log(`  Swapped at index ${triedIndex}: keyDeltas=${JSON.stringify(swapResult.keyDeltas)}`);
    const afterSwap = await getKeyStats(client);
    log(`  After swap: Life=${afterSwap.Life}, DPS=${afterSwap.CombinedDPS}, EHP=${afterSwap.TotalEHP}`);
    assert(approxEq(afterSwap.Life, baseline.Life), 'Life should restore after swap_gem');
    assert(approxEq(afterSwap.CombinedDPS, baseline.CombinedDPS), 'DPS should restore after swap_gem');
    assert(approxEq(afterSwap.TotalEHP, baseline.TotalEHP), `EHP should restore after swap_gem (got ${afterSwap.TotalEHP}, expected ${baseline.TotalEHP})`);
    log('PASS: swap_gem produced diff and state restored');

    // Test 6: invalid gem name
    log('Test 6: swap_gem with invalid gem name');
    const badSwap = await call(client, 'swap_gem', {
      skillGroupIndex: mainGroup.index,
      gemIndex: 1,
      newGemName: 'Definitely Not A Real Gem Support',
    });
    assert(isError(badSwap), 'invalid gem name should error');
    const afterBad = await getKeyStats(client);
    assert(approxEq(afterBad.Life, baseline.Life), 'state should be unaffected by invalid swap');
    log('PASS: invalid gem name rejected with state intact');

    // Test 7: invalid group index
    log('Test 7: swap_gem with out-of-range group index');
    const badGroup = await call(client, 'swap_gem', {
      skillGroupIndex: 999,
      gemIndex: 1,
      newGemName: swapTarget,
    });
    assert(isError(badGroup), 'invalid group index should error');
    log('PASS: out-of-range group index rejected');

    // Test 8: compare_supports
    log('Test 8: compare_supports (3 candidates on main group)');
    const compareResp = JSON.parse(extractText(await call(client, 'compare_supports', {
      skillGroupIndex: mainGroup.index,
      candidates: ['Increased Critical Damage', 'Empower', 'Inspiration'],
    }))) as {
      weakestCurrentSupport: { name: string; gemIndex: number; dpsContribution: number };
      slotTested: number;
      baselineDPS: number;
      candidates: Array<{ name: string; dps: number; dpsDelta: number; error: string | null }>;
    };
    assert(compareResp.candidates.length === 3, `expected 3 candidates, got ${compareResp.candidates.length}`);
    assert(typeof compareResp.weakestCurrentSupport.name === 'string', 'weakest support must be named');
    // Sorted descending by dps
    for (let i = 1; i < compareResp.candidates.length; i++) {
      assert(compareResp.candidates[i - 1].dps >= compareResp.candidates[i].dps, 'candidates should be sorted by dps desc');
    }
    log(`  Weakest current="${compareResp.weakestCurrentSupport.name}" loss=${compareResp.weakestCurrentSupport.dpsContribution.toFixed(1)}`);
    for (const c of compareResp.candidates) {
      log(`    ${c.name}: dps=${c.dps.toFixed(0)} delta=${c.dpsDelta.toFixed(0)}${c.error ? ` (error: ${c.error})` : ''}`);
    }
    const afterCompare = await getKeyStats(client);
    log(`  After compare: Life=${afterCompare.Life}, DPS=${afterCompare.CombinedDPS}, EHP=${afterCompare.TotalEHP}`);
    assert(approxEq(afterCompare.Life, baseline.Life), 'Life restored after compare_supports');
    assert(approxEq(afterCompare.CombinedDPS, baseline.CombinedDPS), 'DPS restored after compare_supports');
    assert(approxEq(afterCompare.TotalEHP, baseline.TotalEHP), `EHP should restore after compare_supports (got ${afterCompare.TotalEHP})`);
    log('PASS: compare_supports with restored state');

    // Test 9: evaluate_gem_levels
    log('Test 9: evaluate_gem_levels (active gem in main group, levels 19-22)');
    // Find the active gem index in the main group by trying setGemLevel via evaluate
    // Use explicit levels to keep it fast
    const scaling = JSON.parse(extractText(await call(client, 'evaluate_gem_levels', {
      skillGroupIndex: mainGroup.index,
      gemIndex: triedIndex, // reuse the index we know is valid
      levels: [19, 20, 21],
    }))) as { count: number; scaling: Array<{ level: number; dps: number; dpsDelta: number; error: string | null }> };
    assert(scaling.count === 3, `expected 3 levels, got ${scaling.count}`);
    for (const s of scaling.scaling) {
      log(`    level=${s.level} dps=${s.dps.toFixed(0)} delta=${s.dpsDelta.toFixed(0)}${s.error ? ` (error: ${s.error})` : ''}`);
    }
    const afterLevels = await getKeyStats(client);
    log(`  After levels: Life=${afterLevels.Life}, DPS=${afterLevels.CombinedDPS}, EHP=${afterLevels.TotalEHP}`);
    assert(approxEq(afterLevels.Life, baseline.Life), 'Life restored after evaluate_gem_levels');
    assert(approxEq(afterLevels.CombinedDPS, baseline.CombinedDPS), 'DPS restored after evaluate_gem_levels');
    assert(approxEq(afterLevels.TotalEHP, baseline.TotalEHP), `EHP should restore after evaluate_gem_levels (got ${afterLevels.TotalEHP})`);
    log('PASS: evaluate_gem_levels scaling computed and state restored');

    // Test 10: find_optimal_links — small topN to keep runtime sane
    log('Test 10: find_optimal_links (Vortex, 4 slots, topN=8) — may take ~30s');
    const startOpt = Date.now();
    const optResp = JSON.parse(extractText(await call(client, 'find_optimal_links', {
      activeSkill: 'Vortex',
      availableSlots: 4, // active + 3 supports
      topN: 8,
    }))) as {
      activeSkill: string;
      lockedSupports: string[];
      bestCombination: string[];
      bestDPS: number;
      singleSupportDPS: Array<{ name: string; dps: number }>;
      topAlternatives: Array<{ combo: string[]; dps: number }>;
    };
    const optMs = Date.now() - startOpt;
    log(`  Best: [${optResp.bestCombination.join(', ')}] DPS=${optResp.bestDPS.toFixed(0)} (${optMs}ms)`);
    assert(optResp.bestCombination.length === 3, `expected 3 supports for 4-slot link, got ${optResp.bestCombination.length}`);
    assert(optResp.bestDPS > 0, 'bestDPS should be positive');
    assert(optResp.singleSupportDPS.length > 0, 'singleSupportDPS should be populated');
    assert(optResp.topAlternatives.length > 0, 'topAlternatives should be populated');
    const afterOpt = await getKeyStats(client);
    log(`  After opt: Life=${afterOpt.Life}, DPS=${afterOpt.CombinedDPS}, EHP=${afterOpt.TotalEHP}`);
    assert(approxEq(afterOpt.Life, baseline.Life), `Life restored after find_optimal_links (got ${afterOpt.Life}, expected ${baseline.Life})`);
    assert(approxEq(afterOpt.CombinedDPS, baseline.CombinedDPS), `DPS restored after find_optimal_links (got ${afterOpt.CombinedDPS}, expected ${baseline.CombinedDPS})`);
    assert(approxEq(afterOpt.TotalEHP, baseline.TotalEHP), `EHP should restore after find_optimal_links (got ${afterOpt.TotalEHP}, expected ${baseline.TotalEHP})`);
    log('PASS: find_optimal_links with state restored');

    // Test 11: find_optimal_links with constraints
    log('Test 11: find_optimal_links with locked support');
    const optConstrained = JSON.parse(extractText(await call(client, 'find_optimal_links', {
      activeSkill: 'Vortex',
      availableSlots: 4,
      constraints: ['Concentrated Effect'],
      topN: 8,
    }))) as { lockedSupports: string[]; bestCombination: string[]; bestDPS: number };
    assert(optConstrained.lockedSupports.includes('Concentrated Effect'), 'lockedSupports should include the constraint');
    assert(optConstrained.bestCombination.length === 2, `expected 2 free supports (4 slots - active - 1 locked = 2), got ${optConstrained.bestCombination.length}`);
    log(`  Locked CE → best free combo=[${optConstrained.bestCombination.join(', ')}] DPS=${optConstrained.bestDPS.toFixed(0)}`);
    const afterOpt2 = await getKeyStats(client);
    assert(approxEq(afterOpt2.Life, baseline.Life), 'state restored after constrained find_optimal_links');
    log('PASS: constrained find_optimal_links');

    // Final integrity check
    log('Test 12: final overall state integrity');
    const final = await getKeyStats(client);
    assert(
      approxEq(final.Life, baseline.Life)
        && approxEq(final.CombinedDPS, baseline.CombinedDPS)
        && approxEq(final.TotalEHP, baseline.TotalEHP),
      `final state should match baseline: ${JSON.stringify({ baseline, final })}`,
    );
    log('PASS: build pristine after all phase 5 operations');
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

main()
  .then(() => {
    log('ALL PHASE 5 TESTS PASSED');
    process.exit(0);
  })
  .catch((error: unknown) => {
    log(`FAILED: ${error instanceof Error ? error.stack : error}`);
    process.exit(1);
  });
