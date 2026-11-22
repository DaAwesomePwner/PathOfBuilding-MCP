// The read-only `probe` engine (lua/probe.lua, src/probe.ts) against the
// OccVortex fixture.
//
//   1. Parity: every default stat of a probe variant equals the same change
//      made through the mutate commands + get_stats (inside an exact
//      withTemporaryChange restore): single allocates of >=10 reachable nodes
//      that change stats, single deallocates of >=5 allocated nodes including
//      a notable with dependents (compared with deallocating the reported
//      nodesRemoved), an item swap, two items at once, a support swap, an
//      active gem swap, gem level changes, a support removal, a support add,
//      config changes, one combined variant (node + item + gem + config), and
//      a multi-node variant (which takes the full-recalc fallback).
//   2. Interleaving: gem/config variants, then node/item variants, then the
//      base give the same numbers as each run alone and as one mixed call.
//   3. Build unchanged: export byte-identical, get_stats identical and the
//      undo stack depth unchanged after a 50-variant mixed probe; fallback
//      variants (several node changes at once) leave the same stats and node
//      set (PoB 2.67.2's restore may reorder the exported node list) and
//      equal the mutate path.
//   4. Per-variant errors (unknown node, mastery, unparseable item, item that
//      does not fit, unknown gem, unknown config key) are user errors on that
//      variant only; their siblings succeed.
//   5. Speed: the average per variant over 100 single-node variants is printed
//      and must be under 25 ms.
//   6. Off-hand displacement: a new main hand that the current off-hand cannot
//      go with (bow + quiver -> claw, dual wands -> sword, sword + claw ->
//      wand) gives the same stats as equip_item, which empties the off-hand.
//   7. Full DPS: on the fixture with three socket groups and a Raise Zombie
//      group included in Full DPS (plus a Cast when Damage Taken trigger
//      group), FullDPS / FullDotDPS of node, item, gem and config variants
//      equal the mutate path; on a build whose only Full DPS group has no
//      active skill, a variant adding one (the build's first Full DPS skill)
//      equals add_gem + full recalc.
//   8. More than 50 fallback variants is a user error before anything runs.
import { mkdtempSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { BuildSession, type TreeNodeInfo } from '../src/build-session.js';
import { LuaBridge, type Stats } from '../src/lua-bridge.js';
import type { ProbeResponse, ProbeVariant, ProbeVariantResult } from '../src/probe.js';
import { setupTestEnv } from './_skip.js';

process.env.POB_MCP_CONFIG_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-probe-'));

const MAIN_GROUP = 5; // Body Armour: Hypothermia, Controlled Destruction, Rapid Decay, Efficacy, Concentrated Effect, Vortex
const VORTEX = 6;
const NEW_SUPPORT = 'Elemental Focus';
const UNKNOWN_NODE = 999999;

const RING_A = `Rarity: RARE
Probe Ring A
Coral Ring
Item Level: 63
LevelReq: 64
Implicits: 1
+30 to maximum Life
+150 to maximum Life
+30% to all Elemental Resistances`;

const AMULET = `Rarity: RARE
Probe Amulet
Jade Amulet
Item Level: 80
Implicits: 1
+25 to Dexterity
+60 to maximum Life`;

const HELMET = `Rarity: RARE
Probe Helmet
Hubris Circlet
Item Level: 84
+80 to maximum Life`;

const BOW = `Rarity: RARE
Probe Bow
Short Bow
+40 to maximum Life`;

const QUIVER = `Rarity: RARE
Probe Quiver
Serrated Arrow Quiver
+80 to maximum Life`;

const CLAW = `Rarity: RARE
Probe Claw
Nailed Fist
+10 to maximum Life`;

const CLAW_OFF = `Rarity: RARE
Probe Off Claw
Nailed Fist
+70 to maximum Life`;

const WAND = `Rarity: RARE
Probe Wand
Driftwood Wand
+20 to maximum Life`;

const WAND_OFF = `Rarity: RARE
Probe Off Wand
Driftwood Wand
+90 to maximum Life`;

const SWORD = `Rarity: RARE
Probe Sword
Rusted Sword
+30 to maximum Life`;

/** A socket group for the build XML; gems by name (PoB resolves them when the build loads). */
function skillGroup(gems: string[], slot?: string, fullDps = true): string {
  const attrs = `enabled="true" mainActiveSkill="1" mainActiveSkillCalcs="1"${fullDps ? ' includeInFullDPS="true"' : ''}${slot ? ` slot="${slot}"` : ''}`;
  const gemXml = gems.map((name) =>
    `<Gem nameSpec="${name}" level="20" quality="0" enabled="true" enableGlobal1="true" enableGlobal2="true" count="1"/>`).join('');
  return `<Skill ${attrs}>${gemXml}</Skill>`;
}

const BAD_ITEM = 'Rarity: RARE\nUnknown Base Ring\nNot A Real Base\n+80 to maximum Life';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const norm = (v: unknown): unknown => (v === undefined ? null : v);

/** Keys whose values differ (exactly) between two stat sets, over `keys`. */
function statDiffs(a: Stats, b: Stats, keys: string[]): string[] {
  return keys.filter((k) => norm(a[k]) !== norm(b[k])).map((k) => `${k}: ${a[k]} vs ${b[k]}`);
}

function changesStats(r: ProbeVariantResult, base: Stats, keys: string[]): boolean {
  return statDiffs(r.stats, base, keys).length > 0;
}

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const pobLabel = paths.pobPath;
  const bridge = new LuaBridge(paths, 120_000);
  const session = new BuildSession(bridge);
  const undoDepth = (): number => (session as unknown as { undoStack: unknown[] }).undoStack.length;

  const probe = (variants: ProbeVariant[], extra: { stats?: string[]; useFullDPS?: boolean } = {}): Promise<ProbeResponse> =>
    session.probe({ variants, ...extra });

  /** Stats after a change made through the mutate commands, then exactly restored. */
  async function viaMutate(apply: (b: LuaBridge) => Promise<unknown>): Promise<{ stats: Stats; nodes: number[] }> {
    return session.withTemporaryChange(async (b) => {
      await apply(b);
      const stats = await b.getStats();
      const nodes = (await b.send<{ nodeIds: number[] }>({ cmd: 'getAllocatedNodes' })).nodeIds;
      return { stats, nodes };
    });
  }

  try {
    log(`PoB: ${pobLabel}`);
    const fixtureXml = readFileSync(fixturePath, 'utf8');
    await session.loadBuild(fixtureXml);
    const stats0 = await session.getStats();
    const empty = await probe([{}]);
    const base = empty.base;
    const keys = Object.keys(base);
    assert(keys.length >= 20, `base has only ${keys.length} keys`);
    assert(statDiffs(base, stats0, keys).length === 0, `probe base differs from get_stats: ${statDiffs(base, stats0, keys)}`);
    assert(statDiffs(empty.results[0].stats, base, keys).length === 0,
      `an empty variant differs from the base: ${statDiffs(empty.results[0].stats, base, keys)}`);
    const allocated0 = (await bridge.send<{ nodeIds: number[] }>({ cmd: 'getAllocatedNodes' })).nodeIds.sort((a, b) => a - b);

    // ------------------------------------------------------------------
    log('5. Speed: 100 single-node allocate variants');
    const reachable = (await session.getReachableNodes()).filter((n) => !n.isJewelSocket);
    assert(reachable.length >= 100, `only ${reachable.length} reachable nodes`);
    const first100 = reachable.slice(0, 100).map((n) => ({ allocate: [n.id] }));
    const t0 = performance.now();
    const speed = await probe(first100);
    const perVariant = (performance.now() - t0) / 100;
    log(`   ${perVariant.toFixed(2)} ms per variant (100 node variants, ${pobLabel})`);
    assert(perVariant < 25, `probe took ${perVariant.toFixed(2)} ms per variant (limit 25 ms)`);
    assert(speed.results.every((r) => !r.error && !r.fallback), 'a single-node allocate failed or fell back');

    // ------------------------------------------------------------------
    log('1a. Parity: allocate');
    const allReach = await probe(reachable.map((n) => ({ allocate: [n.id] })));
    const changing = reachable
      .map((n, i) => ({ node: n, r: allReach.results[i] }))
      .filter(({ r }) => !r.fallback && !r.error && changesStats(r, base, keys));
    assert(changing.length >= 10, `only ${changing.length} reachable nodes change stats`);
    for (const { node, r } of changing.slice(0, 10)) {
      const m = await viaMutate((b) => b.send({ cmd: 'allocNode', nodeId: node.id }));
      const d = statDiffs(r.stats, m.stats, keys);
      assert(d.length === 0, `allocate ${node.id} (${node.name}): probe differs from mutate: ${d.join('; ')}`);
      const added = m.nodes.filter((id) => !allocated0.includes(id)).sort((a, b) => a - b);
      assert(JSON.stringify(added) === JSON.stringify(r.nodesAdded), `allocate ${node.id}: nodesAdded ${r.nodesAdded} vs ${added}`);
      assert(r.pointsAdded === added.length, `allocate ${node.id}: pointsAdded ${r.pointsAdded}`);
    }

    log('1b. Parity: deallocate');
    const allocatedNodes = (await bridge.send<{ nodes: TreeNodeInfo[] }>({ cmd: 'getAllocatedNodesDetailed' })).nodes
      .filter((n) => n.type !== 'ClassStart' && n.type !== 'AscendClassStart');
    const allDealloc = await probe(allocatedNodes.map((n) => ({ deallocate: [n.id] })));
    const deallocs = allocatedNodes
      .map((n, i) => ({ node: n, r: allDealloc.results[i] }))
      .filter(({ r }) => !r.fallback && !r.error && changesStats(r, base, keys));
    const notable = deallocs.find(({ node, r }) => node.isNotable && (r.nodesRemoved?.length ?? 0) > 1);
    assert(notable, 'no allocated notable with dependents changes stats');
    const deallocPick = [notable, ...deallocs.filter((d) => d !== notable).slice(0, 5)];
    assert(deallocPick.length >= 6, `only ${deallocPick.length} deallocate variants`);
    for (const { node, r } of deallocPick) {
      const m = await viaMutate((b) => b.send({ cmd: 'deallocNodes', nodeIds: r.nodesRemoved }));
      const d = statDiffs(r.stats, m.stats, keys);
      assert(d.length === 0, `deallocate ${node.id} (${node.name}): probe differs from mutate: ${d.join('; ')}`);
    }
    {
      const { node, r } = notable;
      const m = await viaMutate((b) => b.send({ cmd: 'deallocNode', nodeId: node.id }));
      const removed = allocated0.filter((id) => !m.nodes.includes(id));
      assert(JSON.stringify(removed) === JSON.stringify(r.nodesRemoved),
        `deallocate ${node.id}: nodesRemoved ${r.nodesRemoved} vs deallocNode removing ${removed}`);
      assert(statDiffs(r.stats, m.stats, keys).length === 0, `deallocate ${node.id}: differs from deallocNode`);
      log(`   notable ${node.name} removes ${r.nodesRemoved?.length} nodes`);
    }

    log('1c. Parity: items, gems, config, combined, multi-node fallback');
    const groups = (await bridge.send<{ groups: Array<{ gems: Array<{ name: string; isSupport: boolean }> }> }>({ cmd: 'getSocketGroups' })).groups;
    assert(groups[MAIN_GROUP - 1].gems[VORTEX - 1].name === 'Vortex', 'group 5 gem 6 is not Vortex');
    assert(groups[MAIN_GROUP - 1].gems[1].isSupport, 'group 5 gem 2 is not a support');
    const nodeA = changing[0].node.id;
    const nodeB = changing[1].node.id;
    const cases: Array<{ name: string; variant: ProbeVariant; mutate: (b: LuaBridge) => Promise<unknown>; fallback?: boolean }> = [
      { name: 'item swap (Ring 1)', variant: { items: [{ slot: 'Ring 1', itemText: RING_A }] },
        mutate: (b) => b.send({ cmd: 'equipItem', slot: 'Ring 1', itemText: RING_A }) },
      { name: 'two items (Ring 1 + Amulet)', variant: { items: [{ slot: 'Ring 1', itemText: RING_A }, { slot: 'Amulet', itemText: AMULET }] },
        mutate: async (b) => {
          await b.send({ cmd: 'equipItem', slot: 'Ring 1', itemText: RING_A });
          await b.send({ cmd: 'equipItem', slot: 'Amulet', itemText: AMULET });
        } },
      { name: 'support swap', variant: { gems: [{ op: 'set', group: MAIN_GROUP, index: 3, name: NEW_SUPPORT }] },
        mutate: (b) => b.send({ cmd: 'setGem', groupIndex: MAIN_GROUP, gemIndex: 3, gemName: NEW_SUPPORT }) },
      { name: 'active gem swap', variant: { gems: [{ op: 'set', group: MAIN_GROUP, index: VORTEX, name: 'Frostbolt' }] },
        mutate: (b) => b.send({ cmd: 'setGem', groupIndex: MAIN_GROUP, gemIndex: VORTEX, gemName: 'Frostbolt' }) },
      { name: 'active gem level', variant: { gems: [{ op: 'set', group: MAIN_GROUP, index: VORTEX, level: 18 }] },
        mutate: (b) => b.send({ cmd: 'setGemLevel', groupIndex: MAIN_GROUP, gemIndex: VORTEX, level: 18 }) },
      { name: 'support level + quality', variant: { gems: [{ op: 'set', group: MAIN_GROUP, index: 2, level: 15, quality: 5 }] },
        mutate: (b) => b.send({ cmd: 'setGemLevel', groupIndex: MAIN_GROUP, gemIndex: 2, level: 15, quality: 5 }) },
      { name: 'support removal', variant: { gems: [{ op: 'remove', group: MAIN_GROUP, index: 2 }] },
        mutate: (b) => b.send({ cmd: 'removeGem', groupIndex: MAIN_GROUP, gemIndex: 2 }) },
      { name: 'support add', variant: { gems: [{ op: 'add', group: MAIN_GROUP, name: NEW_SUPPORT }] },
        mutate: (b) => b.send({ cmd: 'addGem', groupIndex: MAIN_GROUP, gemName: NEW_SUPPORT }) },
      { name: 'config list (enemyIsBoss)', variant: { config: { enemyIsBoss: 'None' } },
        mutate: (b) => b.send({ cmd: 'setConfig', options: { enemyIsBoss: 'None' } }) },
      { name: 'config check (buffFortification)', variant: { config: { buffFortification: false } },
        mutate: (b) => b.send({ cmd: 'setConfig', options: { buffFortification: false } }) },
      { name: 'combined node + item + gem + config',
        variant: {
          allocate: [nodeA],
          items: [{ slot: 'Ring 1', itemText: RING_A }],
          gems: [{ op: 'set', group: MAIN_GROUP, index: VORTEX, level: 18 }],
          config: { enemyIsBoss: 'None' },
        },
        mutate: async (b) => {
          await b.send({ cmd: 'setConfig', options: { enemyIsBoss: 'None' } });
          await b.send({ cmd: 'setGemLevel', groupIndex: MAIN_GROUP, gemIndex: VORTEX, level: 18 });
          await b.send({ cmd: 'equipItem', slot: 'Ring 1', itemText: RING_A });
          await b.send({ cmd: 'allocNode', nodeId: nodeA });
        } },
      { name: 'two nodes (fallback)', variant: { allocate: [nodeA, nodeB] }, fallback: true,
        mutate: (b) => b.send({ cmd: 'allocNodes', nodeIds: [nodeA, nodeB] }) },
    ];
    const caseRes = await probe(cases.map((c) => c.variant));
    for (const [i, c] of cases.entries()) {
      const r = caseRes.results[i];
      assert(!r.error, `${c.name}: ${r.error}`);
      assert(Boolean(r.fallback) === Boolean(c.fallback), `${c.name}: fallback=${r.fallback} (${r.fallbackReason})`);
      assert(changesStats(r, base, keys), `${c.name}: no stat changed`);
      const m = await viaMutate(c.mutate);
      const d = statDiffs(r.stats, m.stats, keys);
      assert(d.length === 0, `${c.name}: probe differs from mutate: ${d.join('; ')}`);
    }
    const fb = caseRes.results[cases.length - 1];
    assert(JSON.stringify(fb.nodesAdded) === JSON.stringify([nodeA, nodeB].sort((a, b) => a - b)), `fallback nodesAdded ${fb.nodesAdded}`);

    // ------------------------------------------------------------------
    log('2. Interleaving (no stale calculator cache)');
    const dataVariants: ProbeVariant[] = cases.slice(2, 10).map((c) => c.variant); // gems + config
    const treeVariants: ProbeVariant[] = [cases[0].variant, cases[1].variant, { allocate: [nodeA] }, { deallocate: [notable.node.id] }];
    const alone = [];
    for (const v of [...dataVariants, ...treeVariants, {}]) alone.push((await probe([v])).results[0]);
    const seqData = (await probe(dataVariants)).results;
    const seqTree = (await probe(treeVariants)).results;
    const seqBase = (await probe([{}])).results;
    const mixed = (await probe([...dataVariants, ...treeVariants, {}])).results;
    const reversed = (await probe([{}, ...treeVariants, ...[...dataVariants].reverse()])).results;
    const sequence = [...seqData, ...seqTree, ...seqBase];
    const reorder = [reversed[0], ...reversed.slice(1, 1 + treeVariants.length)];
    for (let i = 0; i < alone.length; i++) {
      assert(statDiffs(sequence[i].stats, alone[i].stats, keys).length === 0, `variant ${i}: sequential calls differ from alone`);
      assert(statDiffs(mixed[i].stats, alone[i].stats, keys).length === 0, `variant ${i}: mixed call differs from alone`);
    }
    assert(statDiffs(reorder[0].stats, alone[alone.length - 1].stats, keys).length === 0, 'base first differs');
    for (let j = 0; j < treeVariants.length; j++) {
      assert(statDiffs(reorder[1 + j].stats, alone[dataVariants.length + j].stats, keys).length === 0, `tree variant ${j} reordered differs`);
    }
    for (let j = 0; j < dataVariants.length; j++) {
      const r = reversed[reversed.length - 1 - j];
      assert(statDiffs(r.stats, alone[j].stats, keys).length === 0, `data variant ${j} reversed differs`);
    }
    assert(statDiffs(alone[alone.length - 1].stats, base, keys).length === 0, 'base variant differs from base');

    // ------------------------------------------------------------------
    log('3. Build unchanged after a 50-variant mixed probe');
    // Taken here: the mutate-path comparisons above go through the full
    // snapshot/restore, which on PoB 2.67.2 may reorder the exported Spec node
    // list (same nodes; see 3b).
    const xmlBefore = await session.exportXML();
    const undo0 = undoDepth();
    const mixed50: ProbeVariant[] = [];
    for (let i = 0; mixed50.length < 50; i++) {
      mixed50.push({ allocate: [reachable[i % reachable.length].id] });
      mixed50.push(cases[2 + (i % 9)].variant); // gem / config / combined
      if (i % 5 === 0) mixed50.push(cases[i % 2].variant); // items
      if (i % 7 === 0) mixed50.push({ deallocate: [deallocPick[i % deallocPick.length].node.id] });
    }
    mixed50.length = 50;
    const tMixed = performance.now();
    const big = await probe(mixed50);
    log(`   ${((performance.now() - tMixed) / 50).toFixed(2)} ms per variant (nodes, items, gems, config, combined)`);
    assert(big.results.every((r) => !r.error), `a mixed variant failed: ${big.results.find((r) => r.error)?.error}`);
    assert(big.results.every((r) => !r.fallback), 'a mixed variant took the fallback');
    const xml1 = await session.exportXML();
    const stats1 = await session.getStats();
    assert(xml1 === xmlBefore, 'export changed after the mixed probe');
    assert(statDiffs(stats1, stats0, keys).length === 0, `get_stats changed: ${statDiffs(stats1, stats0, keys)}`);
    assert(undoDepth() === undo0, `undo depth changed ${undo0} -> ${undoDepth()}`);
    const allocated1 = (await bridge.send<{ nodeIds: number[] }>({ cmd: 'getAllocatedNodes' })).nodeIds.sort((a, b) => a - b);
    assert(JSON.stringify(allocated1) === JSON.stringify(allocated0), 'allocated nodes changed');

    log('3b. Fallback variants restore the build');
    const fallbackVariants: ProbeVariant[] = [
      { allocate: [nodeA, nodeB] },
      { allocate: [nodeA], deallocate: [deallocPick[1].node.id] },
      { deallocate: [deallocPick[1].node.id, deallocPick[2].node.id], config: { enemyIsBoss: 'None' } },
    ];
    const fbRes = await probe([...fallbackVariants, { allocate: [nodeA] }]);
    assert(fbRes.results.slice(0, 3).every((r) => r.fallback && !r.error), 'a fallback variant failed or did not fall back');
    assert(statDiffs(fbRes.results[3].stats, changing[0].r.stats, keys).length === 0, 'calculator variant after fallbacks differs');
    const xml2 = await session.exportXML();
    assert(statDiffs(await session.getStats(), stats0, keys).length === 0, 'get_stats changed after fallback variants');
    assert(undoDepth() === undo0, 'undo depth changed after fallback variants');
    // The full snapshot/restore puts the same nodes back; PoB 2.67.2 may list them in another order.
    const normalise = (x: string): string =>
      x.replace(/nodes="([^"]*)"/g, (_m, list: string) => `nodes="${list.split(',').sort().join(',')}"`)
        .replace(/^.*passive-skill-tree\/.*$/gm, '');
    assert(normalise(xml2) === normalise(xml1), 'export changed after fallback variants (beyond node order)');
    log(`   export after fallback variants: ${xml2 === xml1 ? 'byte-identical' : 'same nodes, reordered'}`);
    for (const [i, v] of fallbackVariants.entries()) {
      const m = await viaMutate(async (b) => {
        if (v.config) await b.send({ cmd: 'setConfig', options: v.config });
        if (v.deallocate) await b.send({ cmd: 'deallocNodes', nodeIds: v.deallocate });
        if (v.allocate) await b.send({ cmd: 'allocNodes', nodeIds: v.allocate });
      });
      const d = statDiffs(fbRes.results[i].stats, m.stats, keys);
      assert(d.length === 0, `fallback variant ${i}: differs from mutate: ${d.join('; ')}`);
    }

    // ------------------------------------------------------------------
    log('4. Per-variant errors');
    const xmlErr = await session.exportXML();
    const mastery = (await bridge.send<{ node: TreeNodeInfo | null }>({ cmd: 'getNodeInfo', name: 'Life Mastery' })).node;
    assert(mastery?.isMastery, 'no Life Mastery node');
    const ok1 = { allocate: [nodeA] };
    const errCases: Array<{ name: string; variant: ProbeVariant; match: RegExp }> = [
      { name: 'unknown node', variant: { allocate: [UNKNOWN_NODE] }, match: /Unknown node id/ },
      { name: 'mastery', variant: { allocate: [mastery.id] }, match: /mastery/ },
      { name: 'unparseable item', variant: { items: [{ slot: 'Ring 1', itemText: BAD_ITEM }] }, match: /parse|base type/i },
      { name: 'item not fitting', variant: { items: [{ slot: 'Ring 1', itemText: HELMET }] }, match: /cannot be equipped/ },
      { name: 'unknown gem', variant: { gems: [{ op: 'add', group: MAIN_GROUP, name: 'Definitely Not A Gem' }] }, match: /gem lookup failed/i },
      { name: 'unknown config key', variant: { config: { someUnknownConfigKey: 1 } }, match: /Unknown config key/ },
      { name: 'null config value', variant: { config: { enemyIsBoss: null } }, match: /Invalid value for config key "enemyIsBoss"/ },
      { name: 'item text without Rarity', variant: { items: [{ slot: 'Ring 1', itemText: 'Coral Ring\n+80 to maximum Life' }] }, match: /Rarity/ },
    ];
    const errRes = await probe([ok1, ...errCases.flatMap((c) => [c.variant, ok1])]);
    const okStats = errRes.results[0].stats;
    assert(!errRes.results[0].error && changesStats(errRes.results[0], base, keys), 'first sibling failed');
    for (const [i, c] of errCases.entries()) {
      const r = errRes.results[1 + 2 * i];
      const sibling = errRes.results[2 + 2 * i];
      assert(r.error && r.userError === true, `${c.name}: expected a user error, got ${JSON.stringify(r).slice(0, 200)}`);
      assert(c.match.test(r.error), `${c.name}: unexpected message: ${r.error}`);
      assert(!sibling.error && statDiffs(sibling.stats, okStats, keys).length === 0, `${c.name}: sibling variant failed or differs`);
      log(`   ${c.name}: ${r.error}`);
    }
    assert((await session.exportXML()) === xmlErr, 'export changed after the error probe');

    log('Extra stat keys and useFullDPS');
    const extra = await probe([ok1], { stats: ['Life', 'Str', 'NoSuchStat', 'Spec:LifeInc', 'FullDPS'], useFullDPS: false });
    assert(extra.results[0].stats.NoSuchStat === null && extra.base.NoSuchStat === null, 'unknown stat key is not null');
    assert(typeof extra.results[0].stats.Str === 'number', 'Str is not a number');
    assert(extra.results[0].stats.FullDPS === null, 'FullDPS is not null with useFullDPS=false');
    assert(extra.results[0].stats.Life === changing[0].r.stats.Life, 'Life differs with useFullDPS=false');


    // ------------------------------------------------------------------
    log('6. Off-hand displaced by a new main hand');
    /** Stats (and slot contents) after equipping through the mutate commands, exactly restored. */
    async function offHandCase(name: string, setup: Array<[string, string]>, mainHand: string): Promise<void> {
      await session.loadBuild(fixtureXml);
      for (const [slot, itemText] of setup) await bridge.send({ cmd: 'equipItem', slot, itemText });
      await session.loadBuild(await session.exportXML());
      const offBefore = await session.getItemInSlot('Weapon 2');
      assert(offBefore && offBefore.raw?.includes('Probe'), `${name}: setup did not equip the off-hand`);
      const r = (await probe([{ items: [{ slot: 'Weapon 1', itemText: mainHand }] }])).results[0];
      assert(!r.error && !r.fallback, `${name}: ${r.error ?? r.fallbackReason}`);
      const m = await session.withTemporaryChange(async (b) => {
        await b.send({ cmd: 'equipItem', slot: 'Weapon 1', itemText: mainHand });
        const off = await b.send<{ item: { itemId: number } }>({ cmd: 'getItemInSlot', slot: 'Weapon 2' });
        return { stats: await b.getStats(), offId: off.item.itemId };
      });
      assert(m.offId === 0, `${name}: equip_item kept the off-hand, the case tests nothing`);
      const d = statDiffs(r.stats, m.stats, keys);
      assert(d.length === 0, `${name}: probe differs from equip_item: ${d.join('; ')}`);
      log(`   ${name}: Life ${r.stats.Life} (off-hand dropped)`);
    }
    await offHandCase('bow + quiver -> claw', [['Weapon 1', BOW], ['Weapon 2', QUIVER]], CLAW);
    await offHandCase('dual wands -> sword', [['Weapon 1', WAND], ['Weapon 2', WAND_OFF]], SWORD);
    await offHandCase('sword + claw -> wand', [['Weapon 1', SWORD], ['Weapon 2', CLAW_OFF]], WAND);

    // ------------------------------------------------------------------
    log('7. Full DPS parity');
    /** FullDPS / FullDotDPS of the committed (mutated) build, read like get_stats reads the output. */
    const fullKeys = ['FullDPS', 'FullDotDPS', 'CombinedDPS', 'Life'];
    async function readFull(b: LuaBridge): Promise<Stats> {
      return (await b.send<{ base: Stats }>({ cmd: 'probe', variants: [], stats: fullKeys })).base;
    }
    async function fullDpsParity(label: string, cases2: Array<{ name: string; variant: ProbeVariant; mutate: (b: LuaBridge) => Promise<unknown> }>): Promise<ProbeResponse> {
      const res = await probe(cases2.map((c) => c.variant), { stats: fullKeys });
      for (const [i, c] of cases2.entries()) {
        const r = res.results[i];
        assert(!r.error && !r.fallback, `${label} ${c.name}: ${r.error ?? r.fallbackReason}`);
        const m = await session.withTemporaryChange(async (b) => { await c.mutate(b); return readFull(b); });
        const d = statDiffs(r.stats, m, fullKeys);
        assert(d.length === 0, `${label} ${c.name}: probe differs from mutate: ${d.join('; ')}`);
      }
      return res;
    }
    let fullXml = fixtureXml;
    for (const slot of ['Weapon 1', 'Gloves', 'Body Armour']) {
      fullXml = fullXml.replace(new RegExp(`<Skill ([^>]*slot="${slot}")`), '<Skill includeInFullDPS="true" $1');
    }
    fullXml = fullXml.replace('</Skills>', `${skillGroup(['Raise Zombie'])}${skillGroup(['Cast when Damage Taken', 'Frostblink'], 'Helmet')}</Skills>`);
    await session.loadBuild(fullXml);
    const fullGroups = (await bridge.send<{ groups: Array<{ gems: Array<{ name: string }> }> }>({ cmd: 'getSocketGroups' })).groups;
    const zombieGroup = fullGroups.findIndex((g) => g.gems[0]?.name === 'Raise Zombie') + 1;
    assert(zombieGroup > 0, 'Raise Zombie group missing');
    assert(fullGroups.some((g) => g.gems.map((x) => x.name).join('+') === 'Cast when Damage Taken+Frostblink'), 'trigger group missing');
    const fullBase = (await probe([], { stats: fullKeys })).base;
    assert(typeof fullBase.FullDPS === 'number' && fullBase.FullDPS > (fullBase.CombinedDPS as number), `FullDPS ${fullBase.FullDPS} does not add up several skills`);
    const fullRes = await fullDpsParity('full DPS build', [
      { name: 'node', variant: { allocate: [nodeA] }, mutate: (b) => b.send({ cmd: 'allocNode', nodeId: nodeA }) },
      { name: 'deallocate notable', variant: { deallocate: [notable.node.id] }, mutate: (b) => b.send({ cmd: 'deallocNodes', nodeIds: notable.r.nodesRemoved }) },
      { name: 'item', variant: { items: [{ slot: 'Ring 1', itemText: RING_A }] }, mutate: (b) => b.send({ cmd: 'equipItem', slot: 'Ring 1', itemText: RING_A }) },
      { name: 'support swap', variant: { gems: [{ op: 'set', group: MAIN_GROUP, index: 3, name: NEW_SUPPORT }] },
        mutate: (b) => b.send({ cmd: 'setGem', groupIndex: MAIN_GROUP, gemIndex: 3, gemName: NEW_SUPPORT }) },
      { name: 'minion level', variant: { gems: [{ op: 'set', group: zombieGroup, index: 1, level: 10 }] },
        mutate: (b) => b.send({ cmd: 'setGemLevel', groupIndex: zombieGroup, gemIndex: 1, level: 10 }) },
      { name: 'config', variant: { config: { enemyIsBoss: 'None' } }, mutate: (b) => b.send({ cmd: 'setConfig', options: { enemyIsBoss: 'None' } }) },
    ]);
    assert(fullRes.results.some((r) => r.stats.FullDPS !== fullBase.FullDPS), 'no variant changed FullDPS');

    log('7b. A variant adding the build\'s first Full DPS skill');
    const firstXml = fixtureXml.replace('</Skills>', `${skillGroup(['Elemental Focus'], undefined, true)}</Skills>`);
    await session.loadBuild(firstXml);
    const firstGroups = (await bridge.send<{ groups: Array<{ gems: Array<{ name: string }> }> }>({ cmd: 'getSocketGroups' })).groups
      .findIndex((g) => g.gems.length === 1 && g.gems[0].name === 'Elemental Focus') + 1;
    assert(firstGroups > 0, 'Elemental Focus group missing');
    const firstBase = (await probe([], { stats: fullKeys })).base;
    assert(firstBase.FullDPS === 0, `FullDPS should start at 0, got ${firstBase.FullDPS}`);
    const firstRes = await fullDpsParity('first Full DPS skill', [
      { name: 'add Frostbolt', variant: { gems: [{ op: 'add', group: firstGroups, name: 'Frostbolt', position: 1 }] },
        mutate: (b) => b.send({ cmd: 'addGem', groupIndex: firstGroups, gemName: 'Frostbolt', position: 1 }) },
      { name: 'node', variant: { allocate: [nodeA] }, mutate: (b) => b.send({ cmd: 'allocNode', nodeId: nodeA }) },
    ]);
    assert((firstRes.results[0].stats.FullDPS as number) > 0, 'adding Frostbolt did not add Full DPS');

    // ------------------------------------------------------------------
    log('8. Fallback cap is checked before any work');
    await session.loadBuild(fixtureXml);
    const tooMany: ProbeVariant[] = [
      ...reachable.slice(0, 100).map((n) => ({ allocate: [n.id] })),
      ...Array.from({ length: 51 }, (_v, i) => ({ allocate: [reachable[i].id, reachable[i + 1].id] })),
    ];
    const undoCap = undoDepth();
    let capError: unknown = null;
    try {
      await probe(tooMany);
    } catch (e) {
      capError = e;
    }
    assert(capError instanceof Error && /51 variants need a full recalculation/.test(capError.message) && (capError as { isUserError?: boolean }).isUserError,
      `expected the fallback-cap user error, got ${capError}`);
    assert(undoDepth() === undoCap, 'undo depth changed after the refused call');

    log('ALL TESTS PASSED');
  } finally {
    await bridge.dispose();
  }
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  log(`FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
