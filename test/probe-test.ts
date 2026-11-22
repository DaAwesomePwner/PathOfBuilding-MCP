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
//   9. `{ slot, unequip: true }` item entries and abyssal sockets: emptying
//      a ring, the main hand, an abyss jewel, a helmet holding one, a helmet
//      without an abyssal socket in place of one, an unequip plus an equip,
//      and a passive-tree jewel (fallback) equal unequip_item / swap_item;
//      the export is unchanged.
//  10. A call whose variants all fall back sends only the classify pass
//      (no calculator is built for the base), with the same base.
//  11. The tools on the probe engine, each leaving the export byte-identical
//      and the undo depth unchanged, with timings printed (targets: default
//      find_best_next_nodes 5 s, find_worst_allocated_nodes 3 s, compare_items
//      with 2 items 0.2 s; asserted only when ASSERT_TIMINGS=1, x3 when CI is
//      set, as parallel test runs make them flaky): find_best_next_nodes with
//      maxPoints 1 ranks exactly the nodes next to the tree (the old search's
//      set) with allocNode's deltas; with the default maxPoints 3 its top 10
//      holds a multi-point node whose path, cost and delta match allocNode;
//      find_worst_allocated_nodes ranks a notable refunding several points
//      whose removed nodes and loss match deallocNode, and evaluates the
//      full-recalculation candidates refunding the most points (the skipped
//      ones refund no more than any evaluated one; the largest is ranked with
//      deallocNode's loss); compare_items, suggest_upgrades, evaluate_keystone
//      and a one-node simulate_passive_change match equipItem / unequipItem /
//      allocNode(s).
//  12. A fallback restore that is exact for the tree but leaves something else
//      changed (a gem level changed behind the tree restore by a test-only
//      wrapper around this process's LuaBridge.send) is an internal error
//      naming reset_build (the committed-state fingerprint check).
//  13. A change that empties an off-hand or abyss jewel granting a skill (a
//      two-hand weapon replacing a main hand beside a skill-granting shield,
//      unequipping a helmet whose abyss jewel grants a skill) takes the
//      fallback and equals swap_item / unequip_item; the export is unchanged.
import { mkdtempSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { BuildSession, type TreeNodeInfo } from '../src/build-session.js';
import { LuaBridge, type Stats } from '../src/lua-bridge.js';
import type { ProbeResponse, ProbeVariant, ProbeVariantResult } from '../src/probe.js';
import { MAX_SEARCH_FALLBACKS } from '../src/tree-search.js';
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

const RING_B = `Rarity: RARE
Probe Ring B
Coral Ring
Item Level: 63
Implicits: 1
+30 to maximum Life
+40% to Fire Resistance
+12% increased Cast Speed`;

const ABYSS_HELMET = `Rarity: RARE
Probe Abyss Helmet
Hubris Circlet
Item Level: 84
Has 1 Abyssal Socket
+70 to maximum Life`;

const ABYSS_EYE = `Rarity: RARE
Probe Eye
Murderous Eye Jewel
Item Level: 84
+40 to maximum Life`;

/** OccVortex's passive-tree socket holding a jewel. */
const TREE_JEWEL_SOCKET = 36634;

const BAD_ITEM ='Rarity: RARE\nUnknown Base Ring\nNot A Real Base\n+80 to maximum Life';

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
      { name: 'group rebuilt (clear + add)',
        variant: { gems: [{ op: 'clear', group: MAIN_GROUP }, ...['Vortex', NEW_SUPPORT, 'Concentrated Effect'].map(
          (name) => ({ op: 'add' as const, group: MAIN_GROUP, name, level: 20, quality: 20 }))] },
        mutate: (b) => b.send({ cmd: 'replaceSocketGroup', groupIndex: MAIN_GROUP,
          gems: ['Vortex', NEW_SUPPORT, 'Concentrated Effect'].map((name) => ({ name, level: 20, quality: 20 })) }) },
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

    // ------------------------------------------------------------------
    log('9. Unequip entries and abyssal sockets (parity with unequip_item / swap_item)');
    await session.loadBuild(fixtureXml);
    await bridge.send({ cmd: 'equipItem', slot: 'Helmet', itemText: ABYSS_HELMET });
    await bridge.send({ cmd: 'equipItem', slot: 'Helmet Abyssal Socket 1', itemText: ABYSS_EYE });
    await session.loadBuild(await session.exportXML());
    const eyeSlot = 'Helmet Abyssal Socket 1';
    assert((await session.getItemInSlot(eyeSlot))?.raw?.includes('Probe Eye'), 'setup did not socket the abyss jewel');
    const slotId = async (b: LuaBridge, slot: string): Promise<number> =>
      (await b.send<{ item: { itemId?: number } | null }>({ cmd: 'getItemInSlot', slot })).item?.itemId ?? 0;
    const xmlAbyss = await session.exportXML();
    const baseAbyss = (await probe([])).base;
    const abyssCases: Array<{ name: string; variant: ProbeVariant; mutate: (b: LuaBridge) => Promise<unknown>; dropsEye?: boolean; fallback?: boolean }> = [
      { name: 'unequip Ring 1', variant: { items: [{ slot: 'Ring 1', unequip: true }] },
        mutate: (b) => b.send({ cmd: 'unequipItem', slot: 'Ring 1' }) },
      { name: 'unequip Weapon 1', variant: { items: [{ slot: 'Weapon 1', unequip: true }] },
        mutate: (b) => b.send({ cmd: 'unequipItem', slot: 'Weapon 1' }) },
      { name: 'unequip the abyss jewel', variant: { items: [{ slot: eyeSlot, unequip: true }] },
        mutate: (b) => b.send({ cmd: 'unequipItem', slot: eyeSlot }), dropsEye: true },
      { name: 'unequip Helmet (drops its abyss jewel)', variant: { items: [{ slot: 'Helmet', unequip: true }] },
        mutate: (b) => b.send({ cmd: 'unequipItem', slot: 'Helmet' }), dropsEye: true },
      { name: 'helmet without an abyssal socket (drops the abyss jewel)', variant: { items: [{ slot: 'Helmet', itemText: HELMET }] },
        mutate: (b) => b.send({ cmd: 'equipItem', slot: 'Helmet', itemText: HELMET }), dropsEye: true },
      { name: 'unequip + equip in one variant', variant: { items: [{ slot: 'Ring 1', unequip: true }, { slot: 'Amulet', itemText: AMULET }] },
        mutate: async (b) => {
          await b.send({ cmd: 'unequipItem', slot: 'Ring 1' });
          await b.send({ cmd: 'equipItem', slot: 'Amulet', itemText: AMULET });
        } },
      { name: 'unequip a passive-tree jewel (fallback)', variant: { items: [{ slot: `Jewel ${TREE_JEWEL_SOCKET}`, unequip: true }] }, fallback: true,
        mutate: (b) => b.send({ cmd: 'unequipItem', slot: `Jewel ${TREE_JEWEL_SOCKET}` }) },
    ];
    const abyssRes = await probe(abyssCases.map((c) => c.variant));
    assert(normalise(await session.exportXML()) === normalise(xmlAbyss), 'export changed after the unequip probes');
    for (const [i, c] of abyssCases.entries()) {
      const r = abyssRes.results[i];
      assert(!r.error, `${c.name}: ${r.error}`);
      assert(Boolean(r.fallback) === Boolean(c.fallback), `${c.name}: fallback=${r.fallback} (${r.fallbackReason})`);
      assert(changesStats(r, baseAbyss, keys), `${c.name}: no stat changed`);
      const m = await session.withTemporaryChange(async (b) => {
        await c.mutate(b);
        return { stats: await b.getStats(), eye: await slotId(b, eyeSlot) };
      });
      if (c.dropsEye) assert(m.eye === 0, `${c.name}: the mutate path kept the abyss jewel, the case tests nothing`);
      const d = statDiffs(r.stats, m.stats, keys);
      assert(d.length === 0, `${c.name}: probe differs from the mutate path: ${d.join('; ')}`);
    }
    const unequipErr = (await probe([{ items: [{ slot: 'No Such Slot', unequip: true }] }])).results[0];
    assert(unequipErr.userError === true && /slot/i.test(unequipErr.error ?? ''), `unknown unequip slot: ${JSON.stringify(unequipErr)}`);
    log(`   ${abyssCases.length} unequip / abyssal-socket variants equal the mutate path`);

    // ------------------------------------------------------------------
    log('10. A call whose variants all fall back reads the base without building a calculator');
    await session.loadBuild(fixtureXml);
    const sent: Array<Record<string, unknown>> = [];
    const spy = bridge as unknown as { send: (cmd: object, ...rest: unknown[]) => Promise<unknown> };
    const originalSend = spy.send;
    spy.send = (cmd: object, ...rest: unknown[]) => {
      sent.push(cmd as Record<string, unknown>);
      return originalSend.call(bridge, cmd, ...rest);
    };
    let allFallback: ProbeResponse;
    try {
      allFallback = await probe([{ allocate: [nodeA, nodeB] }, { deallocate: [deallocPick[1].node.id, deallocPick[2].node.id] }]);
    } finally {
      spy.send = originalSend;
    }
    const probeCmds = sent.filter((c) => c.cmd === 'probe' && !c.fingerprint);
    const fingerprints = sent.filter((c) => c.cmd === 'probe' && c.fingerprint === true);
    assert(fingerprints.length === 4, `expected a committed-state fingerprint before and after each of the 2 fallbacks, got ${fingerprints.length}`);
    assert(probeCmds.length === 1 && probeCmds[0].classifyOnly === true,
      `an all-fallback call sent ${JSON.stringify(probeCmds.map((c) => ({ classifyOnly: c.classifyOnly, variants: (c.variants as unknown[]).length })))}`);
    assert(allFallback.results.every((r) => r.fallback && !r.error), 'the variants did not fall back');
    assert(statDiffs(allFallback.base, base, keys).length === 0, `all-fallback base differs: ${statDiffs(allFallback.base, base, keys)}`);
    const emptyBase = (await probe([])).base;
    assert(statDiffs(emptyBase, base, keys).length === 0 && Object.keys(emptyBase).length === keys.length, 'variant-less base differs');

    // ------------------------------------------------------------------
    log('11. Tree searches and item tools on the probe engine');
    await session.loadBuild(fixtureXml);
    const statsT = await session.getStats();
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const slack = process.env.CI ? 3 : 1; // shared CI runners are slower
    // Timing targets are printed always and asserted only on request: other
    // test scripts running in parallel (npm run test:all) make them flaky.
    const assertTimings = process.env.ASSERT_TIMINGS === '1';
    /** Run a tool; the export must stay byte-identical and the undo depth unchanged. */
    async function readOnly<T>(label: string, fn: () => Promise<T>, limitMs?: number): Promise<T> {
      const xml = await session.exportXML();
      const depth = undoDepth();
      let t = performance.now();
      let out = await fn();
      let ms = performance.now() - t;
      if (assertTimings && limitMs && ms >= limitMs * slack) {
        // Once more: other test scripts may be loading the machine (npm run test:all).
        log(`   ${label}: ${ms.toFixed(0)} ms, over the limit; timing it again`);
        t = performance.now();
        out = await fn();
        ms = performance.now() - t;
      }
      const over = limitMs !== undefined && ms >= limitMs * slack;
      log(`   ${label}: ${ms.toFixed(0)} ms${limitMs ? ` (target ${limitMs * slack} ms${over ? ', OVER' : ''})` : ''}`);
      if (assertTimings && limitMs) assert(!over, `${label} took ${ms.toFixed(0)} ms`);
      assert((await session.exportXML()) === xml, `${label}: export changed`);
      assert(undoDepth() === depth, `${label}: undo depth changed`);
      return out;
    }

    const adjacent = (await session.getReachableNodes()).filter((n) => !n.isJewelSocket).map((n) => n.id).sort((a, b) => a - b);
    const best1 = await readOnly('find_best_next_nodes maxPoints 1', () => session.findBestNextNodes(10_000, 'CombinedDPS', false, 1, 'total'));
    const best1Ids = best1.rankings.map((r) => r.nodeId).sort((a, b) => a - b);
    assert(JSON.stringify(best1Ids) === JSON.stringify(adjacent),
      `maxPoints 1 differs from the adjacent nodes: only new ${best1Ids.filter((id) => !adjacent.includes(id))}, only old ${adjacent.filter((id) => !best1Ids.includes(id))}`);
    assert(best1.rankings.every((r) => r.pointsCost === 1 && r.deltaPerPoint === r.delta), 'a maxPoints 1 ranking costs more than one point');
    for (const r of best1.rankings.slice(0, 5)) {
      const m = await viaMutate((b) => b.send({ cmd: 'allocNode', nodeId: r.nodeId }));
      const expected = num(m.stats.CombinedDPS) - num(statsT.CombinedDPS);
      assert(r.delta === expected, `best node ${r.nodeId} (${r.nodeName}): delta ${r.delta}, allocNode gives ${expected}`);
    }

    const best3 = await readOnly('find_best_next_nodes (default maxPoints 3)', () => session.findBestNextNodes(), 5000);
    assert(best3.rankings.length === 10, `expected 10 rankings, got ${best3.rankings.length}`);
    for (let i = 1; i < best3.rankings.length; i++) {
      assert((best3.rankings[i - 1].deltaPerPoint ?? 0) >= (best3.rankings[i].deltaPerPoint ?? 0), 'rankings are not sorted by delta per point');
    }
    const multi = best3.rankings.find((r) => (r.pointsCost ?? 0) > 1);
    assert(multi, `no node with pointsCost > 1 in the top 10: ${JSON.stringify(best3.rankings.map((r) => [r.nodeName, r.pointsCost]))}`);
    {
      const m = await viaMutate((b) => b.send({ cmd: 'allocNode', nodeId: multi.nodeId }));
      const added = m.nodes.filter((id) => !allocated0.includes(id)).sort((a, b) => a - b);
      const path = (multi.path ?? []).map((p) => p.id);
      assert(path[path.length - 1] === multi.nodeId && JSON.stringify([...path].sort((a, b) => a - b)) === JSON.stringify(added),
        `path ${path} vs allocNode adding ${added}`);
      assert(multi.pointsCost === added.length, `pointsCost ${multi.pointsCost} vs ${added.length} nodes added`);
      assert(multi.delta === num(m.stats.CombinedDPS) - num(statsT.CombinedDPS), `${multi.nodeName}: delta differs from allocNode`);
      assert(multi.deltaPerPoint === multi.delta / added.length, 'deltaPerPoint');
      log(`   ${multi.nodeName}: ${multi.pointsCost} points via ${(multi.path ?? []).map((p) => p.name).join(' -> ')}`);
    }

    await readOnly('find_worst_allocated_nodes (default)', () => session.findWorstAllocatedNodes(), 3000);
    const worst = await readOnly('find_worst_allocated_nodes (all)', () => session.findWorstAllocatedNodes(10_000, 'CombinedDPS'));
    for (let i = 1; i < worst.rankings.length; i++) {
      assert((worst.rankings[i - 1].lossPerPoint ?? 0) <= (worst.rankings[i].lossPerPoint ?? 0), 'worst rankings are not sorted by loss per point');
    }
    assert(worst.rankings.every((r) => r.nodeType !== 'Mastery' && r.nodeType !== 'ClassStart'), 'a mastery or class start was ranked');
    const worstNotable = worst.rankings.find((r) => r.isNotable && (r.pointsRefunded ?? 0) > 1 && (r.removedNodeCount ?? 0) <= 25);
    assert(worstNotable, 'no notable with pointsRefunded > 1');
    {
      const m = await viaMutate((b) => b.send({ cmd: 'deallocNode', nodeId: worstNotable.nodeId }));
      const removed = allocated0.filter((id) => !m.nodes.includes(id));
      const listed = (worstNotable.removedNodes ?? []).map((n) => n.id).sort((a, b) => a - b);
      assert(JSON.stringify(listed) === JSON.stringify(removed), `removedNodes ${listed} vs deallocNode removing ${removed}`);
      assert(worstNotable.lossIfRemoved === num(statsT.CombinedDPS) - num(m.stats.CombinedDPS), `${worstNotable.nodeName}: loss differs from deallocNode`);
      log(`   ${worstNotable.nodeName}: refunds ${worstNotable.pointsRefunded} points, loss ${worstNotable.lossIfRemoved}`);
    }
    const worstTotal = await session.findWorstAllocatedNodes(10_000, 'Life', 'total');
    for (let i = 1; i < worstTotal.rankings.length; i++) {
      assert((worstTotal.rankings[i - 1].lossIfRemoved ?? 0) <= (worstTotal.rankings[i].lossIfRemoved ?? 0), 'rankBy total is not sorted by loss');
    }
    log(`   ${worst.skipped.length} slow nodes skipped (cap ${MAX_SEARCH_FALLBACKS})`);
    {
      // The full-recalculation candidates evaluated alternate between two
      // queues: those with an estimate (the largest loss among their
      // evaluated dependents, recomputed here from the ranking of the
      // calculator candidates), lowest per refunded point first, and those
      // with none, largest refund first.
      const listed = await bridge.send<{ nodes: Array<{ id: number; points: number; nodes: number[]; fallback?: string }> }>({ cmd: 'probe', candidates: 'deallocate' });
      const slow = listed.nodes.filter((c) => c.fallback !== undefined);
      const slowIds = new Set(slow.map((c) => c.id));
      assert(slow.length > MAX_SEARCH_FALLBACKS, `the fixture has only ${slow.length} full-recalculation candidates; the cap is not exercised`);
      assert(worst.skipped.length === slow.length - MAX_SEARCH_FALLBACKS, `skipped ${worst.skipped.length} of ${slow.length}`);
      const ranked = new Map(worst.rankings.map((r) => [r.nodeId, r]));
      const keptSlow = slow.filter((c) => ranked.has(c.id));
      assert(keptSlow.length === MAX_SEARCH_FALLBACKS, `${keptSlow.length} full-recalculation candidates ranked`);
      const fastLoss = new Map(worst.rankings.filter((r) => !slowIds.has(r.nodeId)).map((r) => [r.nodeId, r.lossIfRemoved ?? 0]));
      const estimate = (c: { nodes: number[] }): number | undefined => {
        const known = c.nodes.filter((id) => fastLoss.has(id)).map((id) => fastLoss.get(id)!);
        return known.length > 0 ? Math.max(...known) : undefined;
      };
      const perPt = (c: { nodes: number[]; points: number }): number => estimate(c)! / Math.max(1, c.points);
      for (const sk of worst.skipped) {
        const c = slow.find((x) => x.id === sk.nodeId)!;
        assert(sk.minLossEstimate === estimate(c) && sk.points === c.points && /full recalculation/.test(sk.reason),
          `skipped ${sk.nodeId}: ${JSON.stringify(sk)} vs estimate ${estimate(c)}`);
      }
      const skippedSlow = worst.skipped.map((sk) => slow.find((x) => x.id === sk.nodeId)!);
      const keptWith = keptSlow.filter((c) => estimate(c) !== undefined);
      const keptWithout = keptSlow.filter((c) => estimate(c) === undefined);
      const skippedWith = skippedSlow.filter((c) => estimate(c) !== undefined);
      const skippedWithout = skippedSlow.filter((c) => estimate(c) === undefined);
      const allWithout = keptWithout.length + skippedWithout.length;
      assert(allWithout > 0 && keptWith.length + skippedWith.length > 0, `the fixture does not exercise both queues (${allWithout} without an estimate)`);
      // Alternating: each queue gets half the slots (more when the other runs out).
      const half = Math.floor(MAX_SEARCH_FALLBACKS / 2);
      assert(keptWithout.length === Math.min(allWithout, Math.max(half, MAX_SEARCH_FALLBACKS - (keptWith.length + skippedWith.length))),
        `${keptWithout.length} of ${allWithout} no-estimate nodes evaluated`);
      if (keptWith.length > 0 && skippedWith.length > 0) {
        assert(Math.max(...keptWith.map(perPt)) <= Math.min(...skippedWith.map(perPt)), 'a skipped node with an estimate came before an evaluated one');
      }
      if (keptWithout.length > 0 && skippedWithout.length > 0) {
        assert(Math.min(...keptWithout.map((c) => c.points)) >= Math.max(...skippedWithout.map((c) => c.points)),
          'a skipped node without an estimate refunds more than an evaluated one');
      }
      log(`   slow nodes: ${keptWith.length} + ${keptWithout.length} evaluated (with / without an estimate), ${skippedWith.length} + ${skippedWithout.length} skipped`);
      // A travel path to a socketed jewel: little lost, several points back; ranked with deallocNode's loss.
      const firstSlow = worst.rankings.find((r) => slowIds.has(r.nodeId));
      assert(firstSlow && (firstSlow.pointsRefunded ?? 0) > 1, `no multi-point full-recalculation node ranked: ${JSON.stringify(firstSlow)}`);
      const m = await viaMutate((b) => b.send({ cmd: 'deallocNode', nodeId: firstSlow.nodeId }));
      assert(firstSlow.lossIfRemoved === num(statsT.CombinedDPS) - num(m.stats.CombinedDPS), `${firstSlow.nodeName}: loss differs from deallocNode`);
      log(`   best full-recalculation node ${firstSlow.nodeName}: refunds ${firstSlow.pointsRefunded}, loss ${firstSlow.lossIfRemoved}, rank ${worst.rankings.indexOf(firstSlow) + 1}`);
    }
    const cmp = await readOnly('compare_items (2 items)', () => session.compareItems('Ring 1', [RING_A, RING_B]), 200);
    for (const [i, text] of [RING_A, RING_B].entries()) {
      const m = await viaMutate((b) => b.send({ cmd: 'equipItem', slot: 'Ring 1', itemText: text }));
      const c = cmp.candidates[i];
      assert(c.error === null && c.stats, `candidate ${i}: ${c.error}`);
      assert(statDiffs(c.stats, m.stats, keys).length === 0 && JSON.stringify(Object.keys(c.stats).sort()) === JSON.stringify(Object.keys(m.stats).sort()),
        `compare_items candidate ${i} differs from equipItem: ${statDiffs(c.stats, m.stats, keys)}`);
    }

    const upgrades = await readOnly('suggest_upgrades', () => session.suggestUpgrades());
    {
      const ring = upgrades.find((u) => u.slot === 'Ring 1');
      assert(ring && ring.error === undefined, `Ring 1 suggestion: ${JSON.stringify(ring)}`);
      const m = await viaMutate((b) => b.send({ cmd: 'unequipItem', slot: 'Ring 1' }));
      assert(ring.ehpContribution === num(statsT.TotalEHP) - num(m.stats.TotalEHP), 'Ring 1 EHP contribution differs from unequipItem');
      assert(ring.dpsContribution === num(statsT.CombinedDPS) - num(m.stats.CombinedDPS), 'Ring 1 DPS contribution differs from unequipItem');
    }

    const ci = await readOnly('evaluate_keystone (Chaos Inoculation)', () => session.evaluateKeystone('Chaos Inoculation'));
    {
      const m = await viaMutate((b) => b.send({ cmd: 'allocNode', nodeId: ci.nodeId }));
      assert(statDiffs(ci.after, m.stats, keys).length === 0, `evaluate_keystone differs from allocNode: ${statDiffs(ci.after, m.stats, keys)}`);
    }

    const sim = await readOnly('simulate_passive_change (one node)', () => session.simulatePassiveChange([multi.nodeId], []));
    {
      const m = await viaMutate((b) => b.send({ cmd: 'allocNodes', nodeIds: [multi.nodeId] }));
      const sameKeys = JSON.stringify(Object.keys(sim.after).sort()) === JSON.stringify(Object.keys(m.stats).sort());
      assert(sim.valid && sameKeys && statDiffs(sim.after, m.stats, keys).length === 0,
        `simulate_passive_change differs from allocNodes: ${statDiffs(sim.after, m.stats, keys)}`);
      // A node the probe refuses (already allocated) takes the mutate path, as before.
      const again = await session.simulatePassiveChange([deallocPick[1].node.id], []);
      assert(again.valid && Object.keys(again.statDiff).length === 0, 'an already allocated node changed stats');
    }

    // ------------------------------------------------------------------
    log('12. A fallback restore that leaves something besides the tree changed is an internal error');
    {
      const listed = await bridge.send<{ nodes: Array<{ id: number; points: number; fallback?: string }> }>({ cmd: 'probe', candidates: 'deallocate' });
      const slowNode = listed.nodes.find((c) => c.fallback !== undefined);
      assert(slowNode, 'no full-recalculation deallocate candidate');
      const ok = (await probe([{ deallocate: [slowNode.id] }])).results[0];
      assert(ok.fallback && !ok.error, `fallback variant: ${JSON.stringify(ok)}`);
      // Test-only seam: after the tree restore, change a gem level behind its back.
      const spy = bridge as unknown as { send: (cmd: object, ...rest: unknown[]) => Promise<unknown> };
      const realSend = spy.send;
      let tampered = 0;
      spy.send = async (cmd: object, ...rest: unknown[]) => {
        const out = await realSend.call(bridge, cmd, ...rest);
        if ((cmd as { cmd?: string }).cmd === 'restoreTreeState') {
          tampered++;
          await realSend.call(bridge, { cmd: 'setGemLevel', groupIndex: MAIN_GROUP, gemIndex: VORTEX, level: 1 });
        }
        return out;
      };
      let err: unknown;
      try {
        await probe([{ deallocate: [slowNode.id] }]);
      } catch (e) {
        err = e;
      } finally {
        spy.send = realSend;
      }
      assert(tampered > 0, 'the fallback did not restore the tree (seam never ran)');
      assert(err instanceof Error && !(err as { isUserError?: boolean }).isUserError,
        `expected an internal error, got ${err instanceof Error ? err.message : String(err)}`);
      assert(/not exact/.test(err.message) && /reset_build/.test(err.message), `fingerprint error: ${err.message}`);
      log(`   ${err.message.slice(0, 160)}`);
      await session.loadBuild(fixtureXml); // the seam changed the build
    }

    // ------------------------------------------------------------------
    log('13. Emptying an off-hand or abyss jewel that grants a skill takes the fallback');
    {
      const SKILL_SHIELD = `Rarity: RARE\nProbe Skill Shield\nSplintered Tower Shield\n+30 to maximum Life\nGrants Level 20 Summon Skitterbots Skill`;
      const SKILL_EYE = `Rarity: RARE\nProbe Skill Eye\nMurderous Eye Jewel\nItem Level: 84\n+40 to maximum Life\nGrants Level 20 Summon Skitterbots Skill`;
      const STAFF = `Rarity: RARE\nProbe Staff\nGnarled Branch\n+25 to maximum Life`;
      await session.loadBuild(fixtureXml);
      await bridge.send({ cmd: 'equipItem', slot: 'Weapon 1', itemText: WAND });
      await bridge.send({ cmd: 'equipItem', slot: 'Weapon 2', itemText: SKILL_SHIELD });
      await bridge.send({ cmd: 'equipItem', slot: 'Helmet', itemText: ABYSS_HELMET });
      await bridge.send({ cmd: 'equipItem', slot: 'Helmet Abyssal Socket 1', itemText: SKILL_EYE });
      await session.loadBuild(await session.exportXML());
      const granted = (await session.listSkillGroups()).filter((g) => g.source?.startsWith('Item:'));
      assert(granted.length >= 2, `the skill-granting items grant no skill: ${JSON.stringify((await session.listSkillGroups()).map((g) => g.source))}`);
      const xmlSkill = await session.exportXML();
      const depth = undoDepth();
      const skillCases: Array<{ name: string; variant: ProbeVariant; mutate: (b: LuaBridge) => Promise<unknown> }> = [
        { name: 'two-hand weapon beside a skill-granting shield', variant: { items: [{ slot: 'Weapon 1', itemText: STAFF }] },
          mutate: (b) => b.send({ cmd: 'equipItem', slot: 'Weapon 1', itemText: STAFF }) },
        { name: 'unequip a helmet whose abyss jewel grants a skill', variant: { items: [{ slot: 'Helmet', unequip: true }] },
          mutate: (b) => b.send({ cmd: 'unequipItem', slot: 'Helmet' }) },
        { name: 'helmet without a socket in place of one whose abyss jewel grants a skill', variant: { items: [{ slot: 'Helmet', itemText: HELMET }] },
          mutate: (b) => b.send({ cmd: 'equipItem', slot: 'Helmet', itemText: HELMET }) },
      ];
      const res = await probe(skillCases.map((c) => c.variant));
      assert((await session.exportXML()) === xmlSkill, 'export changed after the skill-granting probes');
      assert(undoDepth() === depth, 'undo depth changed after the skill-granting probes');
      for (const [i, c] of skillCases.entries()) {
        const r = res.results[i];
        assert(!r.error, `${c.name}: ${r.error}`);
        assert(r.fallback && /grants a skill/.test(r.fallbackReason ?? ''), `${c.name}: fallback=${r.fallback} (${r.fallbackReason})`);
        const m = await viaMutate(c.mutate);
        const d = statDiffs(r.stats, m.stats, keys);
        assert(d.length === 0, `${c.name}: probe differs from the mutate path: ${d.join('; ')}`);
        log(`   ${c.name}: ${r.fallbackReason}`);
      }
    }

    log('ALL TESTS PASSED');
  } finally {
    await bridge.dispose();
  }
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  log(`FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
