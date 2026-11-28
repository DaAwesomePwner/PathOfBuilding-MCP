// community_gap_report (src/community-gaps.ts, src/community-gaps-shares.ts)
// on a sample built from the OccVortex fixture and variants of it, so every
// planted gap is known.
//
//   A = the fixture as loaded (level 99).
//   B = A + an Opal Sceptre in Weapon 1 with Weapon 2 emptied, a Murderous
//       Eye Jewel in tree socket 41263, an Amethyst Ring in Ring 1, Elemental Focus in place of Swift
//       Affliction (main group), a cheap unique notable, usePowerCharges,
//       a Ruby Flask in Flask 5, a Crimson Jewel in tree socket 61419; level 100.
//   C = B + Herald of Ice in the Flame Dash group (another skill) and another
//       Crimson Jewel.
//
//   1. Planted gaps found in every category with share 2/3 (Herald of Ice
//      1/3); deltas equal an evaluate_changes run of the same variant
//      (gear: the sample copy in the reported slot); rows ranked, unmeasured
//      rows (Herald of Ice, the jewel: no empty allocated socket) after the
//      measured ones with notes; the build, undo depth and journal unchanged.
//   2. `apply` variants: apply_changes reproduces the delta, then undo.
//   3. minShare 0.5 drops Herald of Ice; 0.7 drops every planted gap.
//   4. filter: minLevel 100 (B, C: shares 1, uncommon Swift Affliction /
//      Paua Ring), ascendancy / mainSkill case-insensitive, an empty
//      filter result is a UserError naming the sample's ascendancies.
//   5. rankBy TotalEHP / objective; both is a UserError.
//   6. Budget: a lowered variant budget leaves rows unmeasured ("budget")
//      after the measured ones, with a note.
//   7. A stale snapshot is refreshed and saved.
//   8. No build loaded: a UserError naming load_build.
//  10. A mastery effect gap (3.24 masteries fixture): measured, parity with
//      evaluate_changes, build unchanged.
//  11. chooseJewelSocket rules (unit); then, on the loaded build with an
//      empty tree socket, an abyssal socket and every flask slot off: the
//      Crimson Jewel in the tree socket (two copies, median), the abyss jewel
//      in the abyssal socket, the Ruby Flask with its slot turned on (note),
//      all at evaluate_changes parity; with one full recalculation left the
//      Crimson row (two) is unmeasured "budget" with no best / median while
//      the calculator rows still run.
//  12. compareSnapshot gapContext reads the weapon set in use (1, then 2 on
//      the fixture switched to its second set): the Weapon 1 gap is measured
//      in Weapon 1 Swap, its note naming Weapon 2 Swap.
//   9. Over MCP: the tool is listed read-only and replies compact JSON.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { BuildSession } from '../src/build-session.js';
import { chooseJewelSocket } from '../src/community-gaps-plan.js';
import { communityGapReport, type CommunityGapArgs, type GapLimits } from '../src/community-gaps.js';
import { addSampleBuilds, listSamples } from '../src/community-samples.js';
import { EngineManager } from '../src/engine-manager.js';
import { evaluateChanges } from '../src/evaluate-changes.js';
import type { LuaBridge } from '../src/lua-bridge.js';
import { SampleStore } from '../src/sample-store.js';
import { UserError } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

process.env.POB_MCP_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-gaps-'));
const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'src', 'server.ts');

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
async function expectUserError(p: Promise<unknown>, pattern: RegExp, label: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    assert(e instanceof UserError, `${label}: expected UserError, got ${String(e)}`);
    assert(pattern.test(e.message), `${label}: unexpected message: ${e.message}`);
    return;
  }
  throw new Error(`${label}: expected an error`);
}

const RING = `Rarity: RARE
Gap Ring
Amethyst Ring
Item Level: 80
Implicits: 1
+17% to Chaos Resistance
+60 to maximum Life
+40% to Cold Resistance`;
const FLASK = `Rarity: NORMAL
Ruby Flask
Quality: 20`;
const JEWEL = `Rarity: RARE
Gap Jewel
Crimson Jewel
Item Level: 80
Implicits: 0
+10% to Fire Resistance
7% increased maximum Life`;
const JEWEL_C = `Rarity: RARE
Gap Jewel C
Crimson Jewel
Item Level: 80
Implicits: 0
+12% to Cold Resistance
6% increased maximum Life`;
const EYE = `Rarity: RARE
Gap Eye
Murderous Eye Jewel
Item Level: 84
+40 to maximum Life
+20% to Cold Resistance`;
const SCEPTRE = `Rarity: RARE
Gap Sceptre
Opal Sceptre
Item Level: 80
Implicits: 1
40% increased Elemental Damage
50% increased Spell Damage
+1 to Level of all Cold Spell Skill Gems`;
const ABYSS_HELMET = `Rarity: RARE
Gap Abyss Helmet
Hubris Circlet
Item Level: 84
Has 1 Abyssal Socket
+70 to maximum Life`;
const SAMPLE = 'Vortex Gaps';
const MAIN_GROUP = 5;
const SWIFT_INDEX = 3;

type Row = {
  kind: string; name: string; slot?: string; share: number; count: number; measured: boolean;
  delta?: number; pct?: number; perPoint?: number; points?: number; deltas?: Record<string, number | null>;
  best?: { delta: number | null; from?: { build: string; label?: string; slot: string }; replaces?: string; offHand?: string };
  median?: number; value?: unknown; yours?: unknown; assumption?: boolean; apply?: Record<string, unknown>; note?: string;
};
type Report = {
  sample: { name: string; size: number; used: number; mainSkillMatched: number; ascendancies: Array<{ name: string; share: number }>; filter?: unknown };
  rankBy?: string; objective?: unknown; base: Record<string, number>;
  gear: Row[]; tree: Row[]; gems: Row[]; settings: Row[];
  uncommon: { gear?: Array<{ name: string; slot?: string; share: number }>; tree?: unknown[]; gems?: Array<{ name: string; share: number }> };
  more?: Record<string, number>; notes: string[];
};

function find(rows: Row[], kind: string, name: string): Row {
  const r = rows.find((x) => x.kind === kind && x.name === name);
  assert(r, `no ${kind} row "${name}" in ${JSON.stringify(rows.map((x) => `${x.kind}:${x.name}`))}`);
  return r;
}

function checkOrder(rows: Row[], label: string): void {
  const firstUnmeasured = rows.findIndex((r) => !r.measured);
  if (firstUnmeasured >= 0) assert(rows.slice(firstUnmeasured).every((r) => !r.measured && typeof r.note === 'string'), `${label}: unmeasured rows must come last, with notes`);
  const measured = rows.filter((r) => r.measured);
  const key = (r: Row): number => (r.perPoint ?? r.delta ?? Number.NEGATIVE_INFINITY);
  for (let i = 1; i < measured.length; i++) assert(key(measured[i - 1]) >= key(measured[i]), `${label}: measured rows not ranked: ${JSON.stringify(measured.map(key))}`);
}

async function main(): Promise<void> {
  const { fixturePath } = setupTestEnv();
  const fixtureXml = readFileSync(fixturePath, 'utf8').trim();
  const engine = new EngineManager();
  const store = new SampleStore();
  const run = <T>(fn: (s: BuildSession) => Promise<T>): Promise<T> => engine.run(fn);
  const bridgeOf = (s: BuildSession): LuaBridge => (s as unknown as { bridge: LuaBridge }).bridge;
  const report = (args: Partial<CommunityGapArgs> = {}, limits: GapLimits = {}): Promise<Report> =>
    run((s) => communityGapReport(engine, store, s, { sample: SAMPLE, ...args }, limits)) as unknown as Promise<Report>;
  const liveState = (): Promise<string> =>
    run(async (s) => JSON.stringify([await s.exportXML(), s.undoStackDepth(), bridgeOf(s).getRecoveryState(), bridgeOf(s).getSpawnCount()]));

  try {
    // ---- setup: A, B, C
    let notable = '';
    const [codeA, codeB, codeC] = await run(async (s) => {
      await s.loadBuild(fixtureXml);
      await s.loadBuild(await s.exportXML());
      const codeA = await s.exportBuild('code');
      // The cheapest unallocated notable whose name is unique among the reachable nodes.
      const cand = await bridgeOf(s).send<{ nodes: Array<{ id: number; name: string; type: string; points: number }> }>({ cmd: 'probe', candidates: 'allocate', maxPoints: 6 });
      const counts = new Map<string, number>();
      for (const n of cand.nodes) counts.set(n.name.toLowerCase(), (counts.get(n.name.toLowerCase()) ?? 0) + 1);
      const pick = cand.nodes.filter((n) => n.type === 'Notable' && counts.get(n.name.toLowerCase()) === 1).sort((a, b) => a.points - b.points)[0];
      assert(pick, 'no unique reachable notable');
      notable = pick.name;
      await s.applyChanges({
        items: [
          { slot: 'Ring 1', itemText: RING }, { slot: 'Flask 5', itemText: FLASK }, { slot: 'Jewel 61419', itemText: JEWEL },
          { slot: 'Jewel 41263', itemText: EYE }, { slot: 'Weapon 1', itemText: SCEPTRE }, { slot: 'Weapon 2', unequip: true },
        ],
        gems: [{ op: 'set', group: MAIN_GROUP, index: SWIFT_INDEX, name: 'Elemental Focus' }],
        allocate: [notable],
        config: { usePowerCharges: true },
      });
      await s.setCharacterLevel(100);
      const codeB = await s.exportBuild('code');
      await s.applyChanges({ gems: [{ op: 'add', group: 1, name: 'Herald of Ice' }], items: [{ slot: 'Jewel 61419', itemText: JEWEL_C }] });
      const codeC = await s.exportBuild('code');
      for (let i = 0; i < 3; i++) await s.undoLastChange();
      return [codeA, codeB, codeC];
    });
    log(`notable: ${notable}`);
    const added = (await run(() => addSampleBuilds(engine, store, { sample: SAMPLE, builds: [{ source: codeA, label: 'A' }, { source: codeB, label: 'B' }, { source: codeC, label: 'C' }] }))) as { added: Array<{ id: string }> };
    assert(added.added.length === 3, `added: ${JSON.stringify(added)}`);
    const [idA, idB, idC] = added.added.map((a) => a.id);
    const stateBefore = await liveState();

    log('Test 1: planted gaps, shares, parity with evaluate_changes, order, build unchanged');
    let t0 = Date.now();
    const r1 = await report();
    log(`  report: ${Date.now() - t0} ms; ${r1.gear.length} gear, ${r1.tree.length} tree, ${r1.gems.length} gems, ${r1.settings.length} settings`);
    assert((await liveState()) === stateBefore, 'the gap report changed the build, undo depth or journal');
    assert(r1.sample.size === 3 && r1.sample.used === 3 && r1.sample.mainSkillMatched === 3, `sample: ${JSON.stringify(r1.sample)}`);
    assert(r1.rankBy === 'CombinedDPS' && typeof r1.base.CombinedDPS === 'number', `rankBy / base: ${JSON.stringify([r1.rankBy, r1.base])}`);
    const ring = find(r1.gear, 'item', 'Amethyst Ring');
    const flask = find(r1.gear, 'flask', 'Ruby Flask');
    const jewel = find(r1.gear, 'jewel', 'Crimson Jewel');
    const support = find(r1.gems, 'support', 'Elemental Focus');
    const skill = find(r1.gems, 'skill', 'Herald of Ice');
    const node = find(r1.tree, 'notable', notable);
    const config = find(r1.settings, 'config', 'usePowerCharges');
    const sceptre = find(r1.gear, 'item', 'Opal Sceptre');
    const eye = find(r1.gear, 'jewel', 'Murderous Eye Jewel');
    for (const [r, share, count] of [[ring, 0.67, 2], [flask, 0.67, 2], [jewel, 0.67, 2], [support, 0.67, 2], [skill, 0.33, 1], [node, 0.67, 2], [config, 0.67, 2]] as const) {
      assert(r.share === share && r.count === count, `${r.name}: share ${r.share} count ${r.count}`);
    }
    assert(sceptre.measured && sceptre.slot === 'Weapon 1' && sceptre.best?.offHand === 'empty' && /Weapon 2 left empty/.test(sceptre.note ?? ''), `sceptre row: ${JSON.stringify(sceptre)}`);
    assert(!eye.measured && /no empty abyssal socket or empty allocated passive-tree jewel socket/.test(eye.note ?? ''), `eye row: ${JSON.stringify(eye)}`);
    for (const r of [ring, flask, support, node, config]) assert(r.measured && typeof r.delta === 'number' && r.deltas, `${r.name} not measured: ${JSON.stringify(r)}`);
    assert(!skill.measured && /create_socket_group/.test(skill.note ?? ''), `skill row: ${JSON.stringify(skill)}`);
    assert(!jewel.measured && /no empty allocated passive-tree jewel socket/.test(jewel.note ?? ''), `jewel row: ${JSON.stringify(jewel)}`);
    assert(config.value === true && config.yours === false, `config row: ${JSON.stringify(config)}`);
    assert(ring.slot === 'Ring 1' || ring.slot === 'Ring 2', `ring slot: ${ring.slot}`);
    assert(ring.best?.from && [idB, idC].includes(ring.best.from.build) && ring.best.from.slot === 'Ring 1' && typeof ring.median === 'number', `ring best: ${JSON.stringify(ring)}`);
    assert(support.best?.replaces !== undefined && support.apply, `support: ${JSON.stringify(support)}`);
    assert(typeof node.points === 'number' && node.points >= 1 && typeof node.perPoint === 'number', `node: ${JSON.stringify(node)}`);
    for (const cat of ['gear', 'tree', 'gems', 'settings'] as const) checkOrder(r1[cat], cat);
    assert(r1.uncommon.gear !== undefined && r1.uncommon.tree !== undefined && r1.uncommon.gems !== undefined, 'uncommon lists');
    assert(!JSON.stringify(r1.settings).includes('customMods'), 'customMods compared');

    // Parity: the same variants through evaluate_changes.
    const ringText = ((await listSamples(engine, store, { sample: SAMPLE, build: ring.best!.from!.build, slot: ring.best!.from!.slot })) as { item: { itemText: string } }).item.itemText;
    const flaskText = ((await listSamples(engine, store, { sample: SAMPLE, build: flask.best!.from!.build, slot: flask.best!.from!.slot })) as { item: { itemText: string } }).item.itemText;
    const ev = await run((s) =>
      evaluateChanges(s, {
        variants: [
          { label: 'ring', items: [{ slot: ring.slot!, itemText: ringText }] },
          { label: 'flask', items: [{ slot: flask.slot!, itemText: flaskText }] },
          { label: 'support', ...support.apply },
          { label: 'node', ...node.apply },
          { label: 'config', ...config.apply },
          { label: 'sceptre', items: [{ slot: 'Weapon 1', itemText: SCEPTRE }, { slot: 'Weapon 2', unequip: true }] },
        ],
        stats: ['CombinedDPS', 'TotalEHP', 'Life'],
      }),
    );
    for (const [label, row, delta] of [['ring', ring, ring.best!.delta], ['flask', flask, flask.best!.delta], ['support', support, support.delta], ['node', node, node.delta], ['config', config, config.delta], ['sceptre', sceptre, sceptre.best!.delta]] as const) {
      const er = ev.results.find((x) => x.label === label)!;
      assert(er.error === undefined, `${label}: evaluate_changes refused: ${er.error}`);
      assert(er.delta!.CombinedDPS === delta && er.delta!.CombinedDPS === row.delta, `${label}: gap delta ${delta} / ${row.delta} vs evaluate_changes ${er.delta!.CombinedDPS}`);
      assert(er.delta!.TotalEHP === row.deltas!.TotalEHP && er.delta!.Life === row.deltas!.Life, `${label}: deltas ${JSON.stringify(row.deltas)} vs ${JSON.stringify(er.delta)}`);
    }
    assert((await liveState()) === stateBefore, 'evaluate_changes changed the build');
    log('PASS');

    log('Test 2: apply variants commit the measured delta, undo restores');
    for (const row of [support, node, config]) {
      const after = await run(async (s) => {
        const res = await s.applyChanges(row.apply as never);
        const cdps = (await s.getStats()).CombinedDPS as number;
        await s.undoLastChange();
        return { res, cdps };
      });
      const d = Math.round((after.cdps - r1.base.CombinedDPS) * 100) / 100;
      assert(Math.abs(d - row.delta!) <= Math.max(0.01, Math.abs(row.delta!) * 1e-9), `${row.name}: applied delta ${d} vs reported ${row.delta}`);
    }
    assert((await liveState()).replace(/"committed":\d+/, '') === stateBefore.replace(/"committed":\d+/, ''), 'apply + undo did not restore the build');
    log('PASS');

    log('Test 3: minShare');
    const r3a = await report({ minShare: 0.5 });
    assert(!r3a.gems.some((r) => r.name === 'Herald of Ice') && r3a.gems.some((r) => r.name === 'Elemental Focus'), 'minShare 0.5');
    const r3b = await report({ minShare: 0.7 });
    for (const [cat, name] of [['gear', 'Amethyst Ring'], ['gems', 'Elemental Focus'], ['tree', notable], ['settings', 'usePowerCharges']] as const) {
      assert(!r3b[cat].some((r) => r.name === name), `minShare 0.7 kept ${name}`);
    }
    log('PASS');

    log('Test 4: filter');
    const r4 = await report({ filter: { minLevel: 100 } });
    assert(r4.sample.used === 2 && find(r4.gems, 'support', 'Elemental Focus').share === 1 && find(r4.gear, 'item', 'Amethyst Ring').share === 1, `filter minLevel: ${JSON.stringify(r4.sample)}`);
    assert(r4.uncommon.gems?.some((g) => g.name === 'Swift Affliction' && g.share === 0), `uncommon gems: ${JSON.stringify(r4.uncommon.gems)}`);
    assert(r4.uncommon.gear?.some((g) => g.name === 'Paua Ring' && g.slot === 'Ring 1' && g.share === 0), `uncommon gear: ${JSON.stringify(r4.uncommon.gear)}`);
    const r4b = await report({ filter: { ascendancy: 'occultist', mainSkill: 'VORTEX' } });
    assert(r4b.sample.used === 3, 'case-insensitive filter');
    await expectUserError(report({ filter: { ascendancy: 'Necromancer' } }), /No build of sample "Vortex Gaps" matches.*ascendancies: Occultist.*main skills: Vortex/, 'empty filter');
    log('PASS');

    log('Test 5: rankBy / objective');
    const r5 = await report({ rankBy: 'TotalEHP', categories: ['gems', 'tree'] });
    assert(r5.rankBy === 'TotalEHP' && typeof r5.base.TotalEHP === 'number' && r5.gear === undefined && r5.settings === undefined, `rankBy TotalEHP: ${JSON.stringify(Object.keys(r5))}`);
    const s5 = find(r5.gems, 'support', 'Elemental Focus');
    assert(s5.delta === s5.deltas!.TotalEHP, `rankBy TotalEHP delta ${s5.delta} vs ${s5.deltas!.TotalEHP}`);
    checkOrder(r5.tree, 'tree by TotalEHP');
    const r5b = await report({ objective: { weights: { CombinedDPS: 1 } }, categories: ['gems'] });
    const s5b = find(r5b.gems, 'support', 'Elemental Focus');
    assert(r5b.rankBy === undefined && r5b.objective !== undefined && s5b.pct === undefined, `objective: ${JSON.stringify(r5b.objective)}`);
    assert(Math.abs(s5b.delta! - support.pct! / 100) < 1e-3, `objective score ${s5b.delta} vs pct ${support.pct}`);
    await expectUserError(report({ rankBy: 'Life', objective: { weights: { Life: 1 } } }), /either `objective` or `rankBy`/, 'rankBy + objective');
    log('PASS');

    log('Test 6: budget');
    const r6 = await report({ categories: ['tree', 'settings', 'gems'] }, { maxVariants: 3 });
    const all6 = [...r6.tree, ...r6.settings, ...r6.gems];
    const budgeted = all6.filter((r) => r.note === 'not measured: budget');
    assert(budgeted.length > 0 && all6.filter((r) => r.measured).length > 0, `budget rows: ${JSON.stringify(all6.map((r) => [r.name, r.measured, r.note]))}`);
    for (const cat of ['tree', 'settings', 'gems'] as const) checkOrder(r6[cat], `budget ${cat}`);
    assert(r6.notes.some((n) => /not measured: at most 3 what-ifs/.test(n)), `budget note: ${JSON.stringify(r6.notes)}`);
    log('PASS');

    log('Test 11: jewel sockets, inactive flask slots, the full-recalculation budget');
    const unitSockets = [{ id: 5, occupied: false, expansion: 1 }, { id: 9, occupied: false }, { id: 3, occupied: true }, { id: 7, occupied: false, expansion: 2 }, { id: 2, occupied: false, charm: true }];
    const choice = (j: { abyss?: boolean; base?: string }, abyssSocket?: string): string => JSON.stringify(chooseJewelSocket(j, unitSockets, abyssSocket));
    assert(choice({ abyss: true, base: 'Murderous Eye Jewel' }, 'Belt Abyssal Socket 1') === '{"slot":"Belt Abyssal Socket 1"}', 'abyss jewel: abyssal socket first');
    assert(choice({ abyss: true, base: 'Murderous Eye Jewel' }) === '{"slot":"Jewel 9"}', 'abyss jewel: else a plain tree socket');
    assert(choice({ base: 'Cobalt Jewel' }) === '{"slot":"Jewel 9"}', 'plain jewel: plain socket first');
    assert(choice({ base: 'Large Cluster Jewel' }) === '{"slot":"Jewel 7"}' && choice({ base: 'Medium Cluster Jewel' }) === '{"slot":"Jewel 5"}', 'cluster sizes');
    assert(/cluster jewel socket that takes a Large Cluster Jewel/.test(JSON.stringify(chooseJewelSocket({ base: 'Large Cluster Jewel' }, unitSockets.filter((x) => x.id !== 7), undefined))), 'no large socket');
    assert(/no empty allocated passive-tree jewel socket/.test(JSON.stringify(chooseJewelSocket({ base: 'Cobalt Jewel' }, [unitSockets[4]], undefined))), 'charm socket refused');
    const modState = await run((s) => s.exportXML());
    await run(async (s) => {
      await s.unequipItemWithDiff('Jewel 61419');
      await s.swapItemWithDiff('Helmet', ABYSS_HELMET);
      for (let i = 1; i <= 5; i++) await s.setFlaskActive(`Flask ${i}`, false);
    });
    try {
      const r11 = await report({ categories: ['gear'] });
      const crimson = find(r11.gear, 'jewel', 'Crimson Jewel');
      const eye11 = find(r11.gear, 'jewel', 'Murderous Eye Jewel');
      const ruby = find(r11.gear, 'flask', 'Ruby Flask');
      assert(crimson.measured && crimson.slot === 'Jewel 61419' && typeof crimson.median === 'number', `crimson: ${JSON.stringify(crimson)}`);
      assert(eye11.measured && eye11.slot === 'Helmet Abyssal Socket 1', `eye: ${JSON.stringify(eye11)}`);
      assert(ruby.measured && /not active in your build/.test(ruby.note ?? ''), `ruby: ${JSON.stringify(ruby)}`);
      const textOf = async (r: Row): Promise<string> =>
        ((await listSamples(engine, store, { sample: SAMPLE, build: r.best!.from!.build, slot: r.best!.from!.slot })) as { item: { itemText: string } }).item.itemText;
      const texts = { crimson: await textOf(crimson), eye: await textOf(eye11), ruby: await textOf(ruby) };
      const ev11 = await run((s) => evaluateChanges(s, {
        variants: [
          { label: 'crimson', items: [{ slot: crimson.slot!, itemText: texts.crimson }] },
          { label: 'eye', items: [{ slot: eye11.slot!, itemText: texts.eye }] },
          { label: 'ruby', items: [{ slot: ruby.slot!, itemText: texts.ruby }], flasks: [{ slot: ruby.slot!, active: true }] },
        ],
        stats: ['CombinedDPS', 'TotalEHP', 'Life'],
      }));
      for (const [label, row] of [['crimson', crimson], ['eye', eye11], ['ruby', ruby]] as const) {
        const er = ev11.results.find((x) => x.label === label)!;
        assert(er.error === undefined && er.delta!.CombinedDPS === row.best!.delta && er.delta!.TotalEHP === row.deltas!.TotalEHP, `${label} parity: ${JSON.stringify([row, er])}`);
      }
      // Two Crimson copies, each a full recalculation: with one left none of that row runs; later calculator rows still do.
      const r11b = await report({ categories: ['gear'] }, { maxFallbacks: 1 });
      const crimsonB = find(r11b.gear, 'jewel', 'Crimson Jewel');
      assert(!crimsonB.measured && crimsonB.note === 'not measured: budget' && crimsonB.best === undefined && crimsonB.median === undefined, `crimson on budget: ${JSON.stringify(crimsonB)}`);
      for (const name of ['Ruby Flask', 'Amethyst Ring', 'Opal Sceptre']) assert(r11b.gear.find((r) => r.name === name)?.measured, `${name} not measured with the full recalculations used up`);
      assert(r11b.notes.some((n) => /\(1 needing a full recalculation\)/.test(n)), `budget note: ${JSON.stringify(r11b.notes)}`);
      checkOrder(r11b.gear, 'gear on budget');
    } finally {
      await run(async (s) => {
        for (let i = 0; i < 7; i++) await s.undoLastChange();
      });
    }
    assert((await run((s) => s.exportXML())) === modState, 'undoing the loaded-build changes of test 11');
    log('PASS');

    log('Test 12: the weapon set in use is read from PoB');
    const swapXml = fixtureXml
      .replace('<Items activeItemSet="1" useSecondWeaponSet="false">', '<Items activeItemSet="1" useSecondWeaponSet="true">')
      .replace('<ItemSet useSecondWeaponSet="false" id="1">', '<ItemSet useSecondWeaponSet="true" id="1">');
    assert(swapXml !== fixtureXml, 'fixture weapon-set attributes not found');
    const set1 = await run((s) => s.compareSnapshot<{ weaponSet: number; sockets: Array<{ id: number; occupied: boolean }> }>(['Life'], { gapContext: true }));
    assert(set1.weaponSet === 1 && set1.sockets.some((x) => x.id === 36634 && x.occupied), `weapon set 1 / sockets: ${JSON.stringify(set1.sockets)}`);
    await run((s) => s.loadBuild(swapXml));
    const set2 = await run((s) => s.compareSnapshot<{ weaponSet: number }>(['Life'], { gapContext: true }));
    assert(set2.weaponSet === 2, `weapon set: ${set2.weaponSet}`);
    const r12 = await report({ categories: ['gear'] });
    const sceptre12 = find(r12.gear, 'item', 'Opal Sceptre');
    assert(sceptre12.measured && sceptre12.slot === 'Weapon 1 Swap' && /Weapon 2 Swap/.test(sceptre12.note ?? ''), `sceptre on the second set: ${JSON.stringify(sceptre12)}`);
    await run(async (s) => {
      await s.loadBuild(fixtureXml);
      await s.loadBuild(await s.exportXML());
    });
    log('PASS');

    log('Test 7: stale snapshot refreshed');
    await store.update(SAMPLE, (cur) => ({ file: { ...cur!, builds: cur!.builds.map((b) => (b.id === idA ? { ...b, snapshot: { ...b.snapshot!, pobVersion: 'stale' } } : b)) }, result: null }));
    const r7 = await report({ categories: ['settings'] });
    assert(r7.sample.used === 3 && find(r7.settings, 'config', 'usePowerCharges').share === 0.67, 'report after refresh');
    const file = await store.get(SAMPLE);
    assert(file.builds.find((b) => b.id === idA)!.snapshot!.pobVersion === (engine.pobVersion() ?? 'unknown'), 'stale snapshot not saved back');
    assert((await liveState()) === stateBefore, 'refresh changed the live build');
    log('PASS');

    log('Test 8: no build loaded');
    const engine2 = new EngineManager();
    try {
      await expectUserError(engine2.run((s) => communityGapReport(engine2, store, s, { sample: SAMPLE })), /load_build/, 'no build');
    } finally {
      await engine2.shutdown();
    }
    log('PASS');

    log('Test 10: a mastery effect (3.24 tree)');
    const masteriesXml = readFileSync(path.join(path.dirname(fixturePath), 'ConvertTreeMasteries.xml'), 'utf8').trim();
    const MASTERY = 12382;
    const [codeM, codeM2, codeM3, effectText] = await run(async (s) => {
      await s.loadBuild(masteriesXml);
      await s.loadBuild(await s.exportXML());
      const codeM = await s.exportBuild('code');
      const tree = await s.getPassiveTree([MASTERY]);
      const opt = tree.masteryOptions?.[0];
      const other = opt?.options?.find((o) => o.effect !== opt.effect && o.takenBy === undefined);
      assert(other, `no free effect on mastery ${MASTERY}: ${JSON.stringify(opt)}`);
      await s.applyChanges({ masteries: [{ node: MASTERY, effect: other.effect }] });
      const codeM2 = await s.exportBuild('code');
      await s.setCharacterLevel(98);
      const codeM3 = await s.exportBuild('code');
      await s.undoLastChange();
      await s.undoLastChange();
      return [codeM, codeM2, codeM3, other.stats];
    });
    await run(() => addSampleBuilds(engine, store, { sample: 'Mastery Gaps', builds: [{ source: codeM }, { source: codeM2 }, { source: codeM3 }] }));
    const mState = await liveState();
    const r10 = await report({ sample: 'Mastery Gaps', categories: ['tree'] });
    assert((await liveState()) === mState, 'mastery report changed the build');
    const mRow = r10.tree.find((r) => r.kind === 'mastery' && r.share === 0.67);
    assert(mRow && mRow.measured && mRow.apply && mRow.name.includes(effectText.split('\n')[0]), `mastery row: ${JSON.stringify(r10.tree)}`);
    const evM = await run((s) => evaluateChanges(s, { variants: [mRow.apply as never], stats: ['CombinedDPS', 'TotalEHP', 'Life'] }));
    assert(evM.results[0].error === undefined && evM.results[0].delta!.CombinedDPS === mRow.delta, `mastery parity: ${JSON.stringify([mRow, evM.results[0]])}`);
    log('PASS');
  } finally {
    await engine.shutdown();
  }

  log('Test 9: over MCP');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', serverPath],
    env: { ...process.env } as Record<string, string>,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'gaps-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'community_gap_report');
    assert(tool && tool.annotations?.readOnlyHint === true && tool.annotations?.openWorldHint === false, `tool listing: ${JSON.stringify(tool?.annotations)}`);
    const none = await client.callTool({ name: 'community_gap_report', arguments: { sample: SAMPLE } });
    const noneText = (none.content as Array<{ text: string }>)[0].text;
    assert(none.isError && /load_build/.test(noneText), `no build over MCP: ${noneText}`);
    await client.callTool({ name: 'load_build', arguments: { source: fixtureXml } });
    const res = await client.callTool({ name: 'community_gap_report', arguments: { sample: SAMPLE, categories: ['settings'] } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    assert(!res.isError && !text.includes('\n') && JSON.parse(text).settings.some((r: Row) => r.name === 'usePowerCharges'), `over MCP: ${text.slice(0, 300)}`);
  } finally {
    await client.close();
  }
  log('PASS');
  log('All community gap report tests passed');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
