import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BuildSession } from '../src/build-session.js';
import { LuaBridge, type Stats } from '../src/lua-bridge.js';
import type { ResolvedPaths } from '../src/paths.js';
import { UserError } from '../src/validation.js';
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
      candidates: Array<{ name: string; dps: number | null; dpsDelta: number | null; error: string | null }>;
    };
    assert(compareResp.candidates.length === 3, `expected 3 candidates, got ${compareResp.candidates.length}`);
    assert(typeof compareResp.weakestCurrentSupport.name === 'string', 'weakest support must be named');
    // Sorted descending by dps
    for (let i = 1; i < compareResp.candidates.length; i++) {
      assert((compareResp.candidates[i - 1].dps ?? -Infinity) >= (compareResp.candidates[i].dps ?? -Infinity), 'candidates should be sorted by dps desc');
    }
    log(`  Weakest current="${compareResp.weakestCurrentSupport.name}" loss=${compareResp.weakestCurrentSupport.dpsContribution.toFixed(1)}`);
    for (const c of compareResp.candidates) {
      log(`    ${c.name}: dps=${c.dps?.toFixed(0)} delta=${c.dpsDelta?.toFixed(0)}${c.error ? ` (error: ${c.error})` : ''}`);
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
    }))) as { count: number; scaling: Array<{ level: number; dps: number | null; dpsDelta: number | null; error: string | null }> };
    assert(scaling.count === 3, `expected 3 levels, got ${scaling.count}`);
    for (const s of scaling.scaling) {
      assert(s.error === null && s.dps !== null, `level ${s.level}: ${s.error}`);
      log(`    level=${s.level} dps=${s.dps.toFixed(0)} delta=${s.dpsDelta?.toFixed(0)}`);
    }
    const afterLevels = await getKeyStats(client);
    log(`  After levels: Life=${afterLevels.Life}, DPS=${afterLevels.CombinedDPS}, EHP=${afterLevels.TotalEHP}`);
    assert(approxEq(afterLevels.Life, baseline.Life), 'Life restored after evaluate_gem_levels');
    assert(approxEq(afterLevels.CombinedDPS, baseline.CombinedDPS), 'DPS restored after evaluate_gem_levels');
    assert(approxEq(afterLevels.TotalEHP, baseline.TotalEHP), `EHP should restore after evaluate_gem_levels (got ${afterLevels.TotalEHP})`);
    log('PASS: evaluate_gem_levels scaling computed and state restored');

    // Test 10: find_optimal_links — small topN to keep runtime sane
    log('Test 10: find_optimal_links (Vortex, 4 slots, topN=8)');
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
      baselineDPS: number;
      dpsDelta: number;
      search: { method: string; supportsEvaluated: number; poolSize: number; combinationsEvaluated: number };
    };
    const optMs = Date.now() - startOpt;
    assert(approxEq(optResp.baselineDPS, baseline.CombinedDPS, 1e-9), `baselineDPS ${optResp.baselineDPS} vs ${baseline.CombinedDPS}`);
    assert(optResp.dpsDelta === optResp.bestDPS - optResp.baselineDPS, 'dpsDelta is not bestDPS - baselineDPS');
    assert(optResp.search.poolSize === 8 && optResp.search.supportsEvaluated >= 8 && optResp.search.combinationsEvaluated > 0,
      `search: ${JSON.stringify(optResp.search)}`);
    assert(optResp.topAlternatives[0].dps === optResp.bestDPS, 'the best alternative is not the best combination');
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

    // Test 12: find_optimal_links timing probe (topN=25, 6 slots) — for profiling
    log('Test 12: find_optimal_links timing probe (Vortex, 6 slots, topN=25)');
    const t0 = Date.now();
    const timingResp = JSON.parse(extractText(await call(client, 'find_optimal_links', {
      activeSkill: 'Vortex',
      availableSlots: 6,
      topN: 25,
    }))) as { bestCombination: string[]; bestDPS: number; search: { method: string; combinationsEvaluated: number } };
    const dt = Date.now() - t0;
    log(`PASS: find_optimal_links (topN=25, 6-slot) returned in ${dt}ms (target 3000 ms), best=[${timingResp.bestCombination.join(', ')}] ` +
      `DPS=${timingResp.bestDPS.toFixed(0)}, ${timingResp.search.method}, ${timingResp.search.combinationsEvaluated} combinations`);

    // Final integrity check
    log('Test 13: final overall state integrity');
    const final = await getKeyStats(client);
    assert(
      approxEq(final.Life, baseline.Life)
        && approxEq(final.CombinedDPS, baseline.CombinedDPS)
        && approxEq(final.TotalEHP, baseline.TotalEHP),
      `final state should match baseline: ${JSON.stringify({ baseline, final })}`,
    );
    log('PASS: build pristine after all phase 5 operations (Test 13)');
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
  await directParity(paths, xml);
}

/**
 * Test 14: the gem tools on the probe engine give exactly what the mutate
 * path (the bridge's gem commands + full recalc, inside an exact restore)
 * gives for the same change, every stat; each leaves the export
 * byte-identical and the undo depth unchanged. Timings are printed (targets
 * asserted only when ASSERT_TIMINGS=1: parallel test runs make them flaky).
 */
async function directParity(paths: ResolvedPaths, xml: string): Promise<void> {
  log('Test 14: gem tools vs the mutate path (direct session)');
  const BAD = 'Definitely Not A Gem';
  const bridge = new LuaBridge(paths, 120_000);
  const session = new BuildSession(bridge);
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const viaMutate = (apply: (b: LuaBridge) => Promise<unknown>): Promise<Stats> =>
    session.withTemporaryChange(async (b) => {
      await apply(b);
      return b.getStats();
    });
  const sameStats = (a: Stats, b: Stats, label: string): void => {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    const diff = keys.filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} vs ${b[k]}`);
    assert(diff.length === 0, `${label}: differs from the mutate path: ${diff.join('; ')}`);
  };
  const assertTimings = process.env.ASSERT_TIMINGS === '1';
  async function readOnly<T>(label: string, fn: () => Promise<T>, targetMs?: number): Promise<T> {
    const before = await session.exportXML();
    const depth = session.undoStackDepth();
    const t = performance.now();
    const out = await fn();
    const ms = performance.now() - t;
    const over = targetMs !== undefined && ms >= targetMs;
    log(`  ${label}: ${ms.toFixed(0)} ms${targetMs ? ` (target ${targetMs} ms${over ? ', OVER' : ''})` : ''}`);
    if (assertTimings) assert(!over, `${label} took ${ms.toFixed(0)} ms`);
    assert((await session.exportXML()) === before, `${label}: export changed`);
    assert(session.undoStackDepth() === depth, `${label}: undo depth changed`);
    return out;
  }
  async function userError(p: Promise<unknown>, text: RegExp, label: string): Promise<void> {
    try {
      await p;
    } catch (e) {
      assert(e instanceof UserError && text.test(e.message), `${label}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    throw new Error(`${label}: expected a user error`);
  }

  try {
    await session.loadBuild(xml);
    const base = await session.getStats();
    const groups = await session.listSkillGroups();
    const main = groups.find((g) => g.isMainGroup);
    assert(main, 'no main group');
    const G = main.index;
    const vortex = main.gems.findIndex((g) => g.name === 'Vortex') + 1;
    const supports = main.gems.filter((g) => g.isSupport && g.enabled);
    assert(vortex > 0 && supports.length >= 3, `main group: ${JSON.stringify(main.gems.map((g) => g.name))}`);

    // swap_gem: with and without level / quality (setGem keeps the old gem's when not given).
    const swapCases: Array<[string, number | undefined, number | undefined]> = [
      ['swap_gem (level 20 / quality 20)', 20, 20],
      ['swap_gem (keeps level / quality)', undefined, undefined],
    ];
    for (const [label, level, quality] of swapCases) {
      const r = await readOnly(label, () => session.swapGemWithDiff(G, supports[0].index, 'Elemental Focus', level, quality));
      const m = await viaMutate((b) => b.send({ cmd: 'setGem', groupIndex: G, gemIndex: supports[0].index, gemName: 'Elemental Focus', level, quality }));
      sameStats(r.after, m, label);
      sameStats(r.before, base, `${label} before`);
    }
    await userError(session.swapGemWithDiff(G, supports[0].index, BAD), /Definitely Not A Gem/, 'swap_gem unknown gem');
    await userError(session.swapGemWithDiff(99, 1, 'Elemental Focus'), /group/i, 'swap_gem bad group');
    await userError(session.swapGemWithDiff(G, 99, 'Elemental Focus'), /gem not found/i, 'swap_gem bad gem index');

    // compare_supports: the weakest support and every candidate, plus a refused one.
    const cmp = await readOnly('compare_supports (3 candidates)', () =>
      session.compareSupports(G, ['Increased Critical Damage', 'Elemental Focus', BAD]), 200);
    const losses = new Map<number, number>();
    for (const s of supports) {
      const m = await viaMutate((b) => b.send({ cmd: 'removeGem', groupIndex: G, gemIndex: s.index }));
      losses.set(s.index, num(base.CombinedDPS) - num(m.CombinedDPS));
    }
    assert(cmp.weakestCurrentSupport.dpsContribution === losses.get(cmp.slotTested),
      `weakest loss ${cmp.weakestCurrentSupport.dpsContribution} vs removeGem ${losses.get(cmp.slotTested)}`);
    assert([...losses.values()].every((l) => l >= cmp.weakestCurrentSupport.dpsContribution), 'a support loses less than the weakest');
    for (const c of cmp.candidates.filter((x) => x.error === null)) {
      const m = await viaMutate((b) => b.send({ cmd: 'setGem', groupIndex: G, gemIndex: cmp.slotTested, gemName: c.name, level: 20, quality: 20 }));
      assert(c.dps === m.CombinedDPS && c.dpsDelta === num(m.CombinedDPS) - num(base.CombinedDPS),
        `compare_supports ${c.name}: ${c.dps} vs setGem ${m.CombinedDPS}`);
    }
    const refused = cmp.candidates[cmp.candidates.length - 1];
    assert(refused.name === BAD && refused.dps === null && refused.dpsDelta === null && /Definitely Not A Gem/.test(refused.error ?? ''),
      `refused candidate: ${JSON.stringify(refused)}`);
    assert(cmp.candidates.filter((x) => x.error === null).length === 2, 'valid candidates were refused');
    {
      // An internal failure of one candidate (injected by a test-only wrapper
      // around this process's LuaBridge.send) fails the call instead of
      // becoming a zero delta.
      const spy = bridge as unknown as { send: (cmd: object, ...rest: unknown[]) => Promise<unknown> };
      const realSend = spy.send;
      spy.send = async (cmd: object, ...rest: unknown[]) => {
        const out = (await realSend.call(bridge, cmd, ...rest)) as { results?: Array<Record<string, unknown>> };
        const c = cmd as { cmd?: string; classifyOnly?: boolean; variants?: unknown[] };
        if (c.cmd === 'probe' && !c.classifyOnly && c.variants?.length === 2 && out.results) {
          out.results[1] = { error: 'test failure', userError: false };
        }
        return out;
      };
      let failure: unknown;
      try {
        await session.compareSupports(G, ['Increased Critical Damage', 'Elemental Focus']);
      } catch (e) {
        failure = e;
      } finally {
        spy.send = realSend;
      }
      assert(failure instanceof Error && !(failure instanceof UserError) && /test failure/.test(failure.message),
        `an internal candidate failure did not fail compare_supports: ${String(failure)}`);
    }

    // evaluate_gem_levels: every default level.
    const levels = await readOnly('evaluate_gem_levels (default levels)', () => session.evaluateGemLevels(G, vortex), 200);
    assert(levels.length >= 5, `only ${levels.length} levels`);
    for (const l of levels) {
      const m = await viaMutate((b) => b.send({ cmd: 'setGemLevel', groupIndex: G, gemIndex: vortex, level: l.level }));
      assert(l.error === null && l.dps === m.CombinedDPS && l.dpsDelta === num(m.CombinedDPS) - num(base.CombinedDPS),
        `level ${l.level}: ${l.dps} vs setGemLevel ${m.CombinedDPS}`);
    }
    await userError(session.evaluateGemLevels(G, 99), /not found/, 'evaluate_gem_levels bad gem');

    // A granted skill group (the monster-explosion group from the build's items) keeps the mutate path.
    const explode = groups.find((g) => g.source === 'Explode');
    if (explode) {
      const lv = explode.gems[0].level ?? 1;
      const r = await readOnly('evaluate_gem_levels (granted group)', () => session.evaluateGemLevels(explode.index, 1, [lv]));
      assert(r.length === 1 && r[0].error === null && r[0].dps === base.CombinedDPS, `granted group: ${JSON.stringify(r)}`);
    }

    // find_optimal_links: the winner equals replaceSocketGroup + full recalc.
    const replaced = (gems: string[]) => (b: LuaBridge) =>
      b.send({ cmd: 'replaceSocketGroup', groupIndex: G, gems: gems.map((name) => ({ name, level: 20, quality: 20 })) });
    const six = await readOnly('find_optimal_links (6-link)', () => session.findOptimalLinks('Vortex', 5), 3000);
    log(`  6-link: [${six.bestCombination.join(', ')}] ${six.bestDPS.toFixed(0)} (delta ${six.dpsDelta.toFixed(0)}), ` +
      `${six.search.method}, ${six.search.supportsEvaluated} supports, ${six.search.combinationsEvaluated} combinations`);
    assert(six.bestCombination.length === 5 && new Set(six.bestCombination).size === 5, `combination ${six.bestCombination}`);
    assert(six.mainGroup.index === G && six.baselineDPS === base.CombinedDPS && six.dpsDelta === six.bestDPS - six.baselineDPS, 'baseline / delta');
    assert((await viaMutate(replaced(['Vortex', ...six.bestCombination]))).CombinedDPS === six.bestDPS,
      'find_optimal_links winner differs from replaceSocketGroup');
    const single = six.singleSupportDPS[0];
    assert((await viaMutate(replaced(['Vortex', single.name]))).CombinedDPS === single.dps, `single ${single.name} differs from replaceSocketGroup`);
    assert(six.topAlternatives.every((a, i) => i === 0 || a.dps <= six.topAlternatives[i - 1].dps), 'alternatives not sorted');
    const locked = await readOnly('find_optimal_links (4-link, one locked)', () => session.findOptimalLinks('Vortex', 3, ['Concentrated Effect']));
    assert(locked.bestCombination.length === 2 && !locked.bestCombination.includes('Concentrated Effect'), `locked: ${locked.bestCombination}`);
    assert((await viaMutate(replaced(['Vortex', 'Concentrated Effect', ...locked.bestCombination]))).CombinedDPS === locked.bestDPS,
      'locked find_optimal_links winner differs from replaceSocketGroup');
    await userError(session.findOptimalLinks('Vortex', 3, [BAD]), /Definitely Not A Gem/, 'find_optimal_links unknown locked gem');
    await userError(session.findOptimalLinks('Concentrated Effect', 3), /support gem/, 'find_optimal_links with a support as the skill');
    log('PASS: gem tools equal the mutate path; export and undo depth unchanged');
  } finally {
    await bridge.dispose();
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
