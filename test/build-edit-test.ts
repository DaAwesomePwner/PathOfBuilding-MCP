// Committed build edits: apply_changes, create_socket_group,
// delete_socket_group, set_main_skill (on OccVortex: Vortex in group 5 is the
// main skill, group 2 holds Storm Brand and Cold Snap, group 7 is the
// monster-explosion group the build's items grant).
//
//   1. apply_changes parity with evaluate_changes (and the probe's raw
//      stats): (a) a gems-only variant, (b) a mixed variant (gem op, node,
//      config, item). One undo entry and one journal record each; undo
//      restores exactly (skills export byte-identical, export / node set /
//      stats as the other restore tests compare). (c) undoing a change of
//      the main skill's gem restores the cached main skill (build info,
//      summary export); (d) variants that take the probe's full-recalculation
//      fallback (two allocations; deallocate + allocate) match too.
//   2. Refusals (bad gem name, bad group / gem index, granted group,
//      unreachable node, unknown config key, empty variant; bad create /
//      delete / set_main_skill arguments; an off-hand refused only when
//      applied, after a two-handed weapon of the same variant, which is
//      rolled back): UserError, export byte-identical,
//      undo depth and journal unchanged.
//   3. create_socket_group / delete_socket_group / set_main_skill change the
//      groups and the main skill as expected and undo cleanly; a disabled
//      Vaal gem group counts two active skills, as PoB does.
//   4. Crash replay after apply_changes (with a node path; and a fallback
//      variant) and after the socket group edits reproduces the build.
//   5. Fault seams: a failure after the change (buildEditFailsAfterChange)
//      commits it (undo entry + journal record, "WAS applied", a crash
//      restores it), for apply_changes and create_socket_group; with the
//      recalculation failing too (buildEditRecalcFails) the error says the
//      stats may be stale, and with the engine gone then
//      (buildEditRecalcExits) nothing is committed; a failure part-way (applyChangesFailsMidway) rolls
//      back exactly and pushes nothing; a rollback whose fingerprint check
//      differs (buildEditRollbackInexact) is an internal error naming
//      reset_build with one undo entry and no journal record, and undo
//      restores the pre-call build.
//   6. Through the MCP server: the four tools are listed as undoable,
//      apply_changes echoes the label and reports points, undo reverts.
//   7. Masteries and the main skill (ConvertTreeMasteries.xml, a 3.24 tree):
//      (a) a `mainSkill` variant (group 2, its second active skill) equals
//      the probe, evaluate_changes and set_main_skill + get_stats; (b) a
//      variant switching an allocated mastery's effect, allocating another
//      mastery with its path (a fallback: two mastery changes) and setting
//      the main skill equals the probe, the export holds both effects and
//      the result lists them; undo restores exactly; (c) a crash replays it;
//      (d) refusals (an effect the mastery does not offer, a mastery in
//      `allocate`, an out-of-range main skill group / active skill) change
//      nothing; (e) a deallocation that removes a listed mastery is refused
//      alike by evaluate_changes and apply_changes, a deallocation plus a
//      switch on another mastery equals evaluate_changes, `mainSkill` with an
//      item granting a skill is refused by both, and a variant of only
//      masteries that already have their effect is `unchanged` (nothing
//      pushed or journaled).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BuildSession, EngineRestartedError, type NamedProbeVariant } from '../src/build-session.js';
import { evaluateChanges, roundStat } from '../src/evaluate-changes.js';
import { LuaBridge, Stats } from '../src/lua-bridge.js';
import { withoutNulls } from '../src/probe.js';
import { UserError } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const MAIN_GROUP = 5; // Vortex
const TWO_ACTIVES_GROUP = 2; // Storm Brand, Cold Snap
const GRANTED_GROUP = 7; // On Kill Monster Explosion (item-granted)
const OTHER_ASCENDANCY_NODE = 'Mindless Aggression'; // Necromancer; OccVortex is an Occultist
const RING = `Rarity: RARE
Build Edit Ring
Coral Ring
Item Level: 63
LevelReq: 64
Implicits: 1
+30 to maximum Life
+150 to maximum Life
+30% to all Elemental Resistances`;

const STAFF = `Rarity: RARE
Build Edit Staff
Imperial Staff
Item Level: 80`;
const SHIELD = `Rarity: RARE
Build Edit Shield
Titanium Spirit Shield
Item Level: 80`;

const log = (msg: string): void => console.log(`[build-edit-test] ${msg}`);
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const { paths, fixturePath } = setupTestEnv();
const occXml = readFileSync(fixturePath, 'utf8');
const bridges: LuaBridge[] = [];
const tempDirs: string[] = [];

function newBridge(testFaults?: string): LuaBridge {
  const b = new LuaBridge(paths, 120_000, { testFaults });
  bridges.push(b);
  return b;
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

function specNodes(xml: string): number[] {
  const m = /<Spec\b[^>]*\bnodes="([\d,]*)"/.exec(xml);
  assert(m, 'export has no Spec node list');
  return m[1] === '' ? [] : m[1].split(',').map(Number).sort((a, b) => a - b);
}

/** The export's <Skills> section, byte for byte. */
function skillsXml(xml: string): string {
  const m = /<Skills\b[\s\S]*?<\/Skills>/.exec(xml);
  assert(m, 'export has no Skills section');
  return m[0];
}

/** Export with node lists sorted and the tree URL dropped (both follow Lua table order). */
function canonical(xml: string): string {
  return xml
    .replace(/ nodes="([\d,]*)"/g, (_m, list: string) => ` nodes="${list.split(',').map(Number).sort((x, y) => x - y).join(',')}"`)
    .replace(/<URL>[\s\S]*?<\/URL>/g, '<URL/>');
}

interface State {
  xml: string;
  stats: Stats;
}

/** The committed config tables by value and in pairs() order (PoB 2.67 exports them in that order). */
async function configTables(bridge: LuaBridge): Promise<string> {
  const res = await bridge.send<{ fingerprint: string[] }>({ cmd: 'probe', fingerprint: true });
  return JSON.stringify(res.fingerprint.filter((line) => line.startsWith('config')));
}

async function state(session: BuildSession): Promise<State> {
  // Export first: an export written before PoB recalculated carries stale
  // PlayerStat lines, so this order catches a change left unrecalculated.
  const xml = await session.exportXML();
  return { xml, stats: await session.getStats() };
}

function assertSameStats(label: string, actual: Stats, expected: Stats): void {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const k of keys) {
    assert(Object.is(actual[k], expected[k]), `${label}: ${k} ${String(actual[k])} != ${String(expected[k])}`);
  }
}

function assertSame(label: string, actual: State, expected: State): void {
  assertSameStats(label, actual.stats, expected.stats);
  assert(skillsXml(actual.xml) === skillsXml(expected.xml), `${label}: skills export differs`);
  assert(JSON.stringify(specNodes(actual.xml)) === JSON.stringify(specNodes(expected.xml)), `${label}: node set differs`);
  const a = canonical(actual.xml);
  const e = canonical(expected.xml);
  if (a !== e) {
    let i = 0;
    while (i < a.length && a[i] === e[i]) i++;
    throw new Error(`${label}: export differs at ${i}: ${JSON.stringify(a.slice(i - 80, i + 80))}\n  vs ${JSON.stringify(e.slice(i - 80, i + 80))}`);
  }
}

/** A session on a build already in PoB's re-read form (loading a fresh XML is not byte-idempotent once). */
async function primedSession(bridge: LuaBridge, xml = occXml): Promise<BuildSession> {
  const session = new BuildSession(bridge);
  await session.loadBuild(xml);
  await session.loadBuild(await session.exportXML());
  return session;
}

/** `count` distinct 2-point notables whose paths share no node (so allocating them together is one variant). */
async function twoPointNotables(bridge: LuaBridge, count: number): Promise<Array<{ id: number; name: string }>> {
  const r = await bridge.send<{ nodes: Array<{ id: number; name: string; type: string; points: number; nodes: number[]; fallback?: string }> }>({
    cmd: 'probe',
    candidates: 'allocate',
    maxPoints: 2,
  });
  const out: Array<{ id: number; name: string }> = [];
  const used = new Set<number>();
  for (const c of r.nodes) {
    if (c.type !== 'Notable' || c.points !== 2 || c.fallback || c.nodes.some((id) => used.has(id))) continue;
    c.nodes.forEach((id) => used.add(id));
    out.push(c);
    if (out.length === count) return out;
  }
  throw new Error(`only ${out.length} separate 2-point notables`);
}

/** An allocated notable that nothing depends on (deallocating it removes only itself). */
async function leafNotable(bridge: LuaBridge): Promise<{ id: number; name: string }> {
  const r = await bridge.send<{ nodes: Array<{ id: number; name: string; type: string; nodes: number[]; fallback?: string }> }>({
    cmd: 'probe',
    candidates: 'deallocate',
  });
  const leaf = r.nodes.find((c) => c.type === 'Notable' && c.nodes.length === 1 && !c.fallback);
  assert(leaf, 'an allocated leaf notable');
  return leaf;
}

async function twoPointNotable(bridge: LuaBridge): Promise<{ id: number; name: string }> {
  const r = await bridge.send<{ nodes: Array<{ id: number; name: string; type: string; points: number; fallback?: string }> }>({
    cmd: 'probe',
    candidates: 'allocate',
    maxPoints: 2,
  });
  const target = r.nodes.find((c) => c.type === 'Notable' && c.points === 2 && !c.fallback);
  assert(target, 'a 2-point notable the calculator can evaluate');
  return target;
}

/** apply_changes' stats equal the probe's raw numbers and evaluate_changes' (rounded) deltas for the same variant. */
async function assertParity(label: string, session: BuildSession, variant: NamedProbeVariant, apply: () => Promise<Stats>): Promise<Stats> {
  const probed = await session.probeNamed({ variants: [variant] });
  const r = probed.results[0];
  assert(r.error === undefined, `${label}: probe refused the variant: ${r.error}`);
  const evaluated = await evaluateChanges(session, { variants: [variant] });
  const row = evaluated.results[0];
  assert(row.error === undefined && row.delta, `${label}: evaluate_changes refused the variant: ${row.error}`);
  const after = await apply();
  const expected = withoutNulls(r.stats);
  for (const [k, v] of Object.entries(expected)) {
    assert(Object.is(after[k], v), `${label}: ${k} apply_changes ${String(after[k])} != probe ${String(v)}`);
  }
  for (const [k, d] of Object.entries(row.delta)) {
    const b = probed.base[k];
    const a = after[k];
    if (typeof a === 'number' && typeof b === 'number') {
      assert(d === roundStat(a - b), `${label}: ${k} delta evaluate_changes ${d} != apply_changes ${roundStat(a - b)}`);
    }
  }
  return after;
}

// ---------------------------------------------------------------------------

async function test1Parity(): Promise<void> {
  const bridge = newBridge();
  const session = await primedSession(bridge);
  const base = await state(session);

  log('Test 1a: a gems-only variant');
  const gemsOnly: NamedProbeVariant = {
    gems: [
      { op: 'set', group: MAIN_GROUP, index: 2, name: 'Elemental Focus' },
      { op: 'set', group: MAIN_GROUP, index: 3, level: 15, quality: 10 },
      { op: 'add', group: MAIN_GROUP, name: 'Inspiration', level: 18 },
    ],
  };
  const gemsAfter = await assertParity('gems-only', session, gemsOnly, async () => (await session.applyChanges(gemsOnly)).after);
  assert(toNumber(gemsAfter.CombinedDPS) !== toNumber(base.stats.CombinedDPS), 'the gem change changes DPS');
  assert(session.undoStackDepth() === 1 && bridge.committedCount() === 1, 'one undo entry, one journal record');
  const gemsState = await state(session);
  assert(/nameSpec="Elemental Focus"/.test(skillsXml(gemsState.xml)) && /nameSpec="Inspiration"/.test(skillsXml(gemsState.xml)), 'the export holds the new gems');
  assertSameStats('stats after apply_changes', gemsState.stats, gemsAfter);
  await session.undoLastChange();
  assertSame('undo of the gems-only variant', await state(session), base);
  assert(session.undoStackDepth() === 0 && bridge.committedCount() === 0, 'undo pops the entry and the journal record');
  log('PASS 1a');

  log('Test 1b: a mixed variant (gem op, node, config, item)');
  const notable = await twoPointNotable(bridge);
  const mixed: NamedProbeVariant = {
    gems: [{ op: 'set', group: MAIN_GROUP, index: 2, name: 'Elemental Focus' }],
    allocate: [notable.name],
    config: { enemyIsBoss: 'Pinnacle', usePowerCharges: true },
    items: [{ slot: 'Ring 1', itemText: RING }],
  };
  let result: Awaited<ReturnType<BuildSession['applyChanges']>> | undefined;
  const tablesBefore = await configTables(bridge);
  await assertParity('mixed', session, mixed, async () => {
    result = await session.applyChanges(mixed);
    return result.after;
  });
  assert(result, 'apply result');
  assert(result.added.length === 2 && result.added[1].id === notable.id && result.removed.length === 0, `added: ${JSON.stringify(result.added)}`);
  assert(result.summary && result.summary.totalPoints === Number((await session.getPassiveTree()).summary.totalPoints), 'summary is the tree after');
  const mixedState = await state(session);
  assert(specNodes(mixedState.xml).includes(notable.id), 'the export holds the node');
  assert(/<Input (boolean="true" name="usePowerCharges"|name="usePowerCharges" boolean="true")\/>/.test(mixedState.xml), 'the export holds the config');
  assert(mixedState.xml.includes('Build Edit Ring'), 'the export holds the ring');
  assert(session.undoStackDepth() === 1 && bridge.committedCount() === 1, 'one undo entry, one journal record');
  await session.undoLastChange();
  assertSame('undo of the mixed variant', await state(session), base);
  assert((await configTables(bridge)) === tablesBefore, 'undo of the mixed variant: config tables differ in value or pairs() order');
  // Config keys added and removed again can reorder a table; undo puts the very tables back.
  for (let i = 0; i < 5; i++) {
    await session.applyChanges({ config: { useFrenzyCharges: true, buffOnslaught: true, conditionLowLife: true, buffElusive: true } });
    await session.undoLastChange();
    assert((await configTables(bridge)) === tablesBefore, `apply_changes config + undo #${i + 1}: config tables differ in value or pairs() order`);
  }
  // XML refused before it reaches PoB (truncated) keeps the build, its undo
  // entries and the config tables they remembered: undo still puts the very
  // tables back.
  const truncated = occXml.slice(0, occXml.indexOf('</PathOfBuilding>'));
  for (let i = 0; i < 5; i++) {
    await session.applyChanges({ config: { useFrenzyCharges: true, buffOnslaught: true, conditionLowLife: true, buffElusive: true } });
    const refused = await rejection(session.loadBuild(truncated));
    assert(refused instanceof UserError && /Invalid Path of Building XML/.test(refused.message), `truncated XML: ${String(refused)}`);
    assert(session.undoStackDepth() === 1, 'a refused load kept the undo entry');
    await session.undoLastChange();
    assert((await configTables(bridge)) === tablesBefore, `refused load between apply_changes and undo #${i + 1}: config tables differ in value or pairs() order`);
  }
  // A config option set to the value it holds changes nothing; later restores
  // that are not this change's own (a probe fallback, a swap_item undo) leave
  // the config tables as they are.
  const live = (await bridge.send<{ input: Record<string, unknown> }>({ cmd: 'getFullConfig' })).input;
  const noopKey = Object.keys(live).find((k) => live[k] === true);
  assert(noopKey, 'a config option that is on');
  const [far1, far2] = await twoPointNotables(bridge, 2);
  await session.applyChanges({ config: { [noopKey]: true }, allocate: [far1.id] });
  const afterNoop = await configTables(bridge);
  assert(afterNoop === tablesBefore, 'a no-op config option changed the config tables');
  const fb = await session.probe({ variants: [{ deallocate: [far1.id], allocate: [far2.id] }, { deallocate: [far1.id], allocate: [far2.id], config: { usePowerCharges: true } }] });
  assert(fb.results.every((r) => r.fallback && r.error === undefined), `fallback variants: ${JSON.stringify(fb.results.map((r) => r.error ?? r.fallbackReason))}`);
  assert((await configTables(bridge)) === tablesBefore, 'a probe fallback after a no-op config apply_changes changed the config tables');
  await session.swapItemWithDiff('Ring 1', RING);
  await session.undoLastChange();
  assert((await configTables(bridge)) === tablesBefore, 'a swap_item undo after a no-op config apply_changes changed the config tables');
  await session.undoLastChange();
  assertSame('undo of the no-op config variant', await state(session), base);
  assert((await configTables(bridge)) === tablesBefore, 'undo of the no-op config variant: config tables differ');
  log('PASS 1b');

  log('Test 1c: undo of a main-skill gem change restores the cached main skill');
  const vortex = (await session.listSkillGroups())[MAIN_GROUP - 1].gems.find((g) => g.name === 'Vortex');
  assert(vortex, 'Vortex in the main group');
  await session.applyChanges({ gems: [{ op: 'set', group: MAIN_GROUP, index: vortex.index, name: 'Fireball' }] });
  assert((await session.getBuildInfo()).mainSkill === 'Fireball', 'main skill after the change');
  assert((await session.exportBuild('summary')).includes('Main Skill: Fireball'), 'summary after the change');
  await session.undoLastChange();
  assert((await session.getBuildInfo()).mainSkill === 'Vortex', 'build info after undo');
  const summary = await session.exportBuild('summary');
  assert(summary.includes('Main Skill: Vortex') && !summary.includes('Fireball'), `summary after undo: ${summary}`);
  assertSame('undo of the main-skill change', await state(session), base);
  log('PASS 1c');

  log('Test 1d: variants that take the full-recalculation fallback');
  const [n1, n2] = await twoPointNotables(bridge, 2);
  const leaf = await leafNotable(bridge);
  for (const [label, variant] of [
    ['two allocations', { allocate: [n1.id, n2.name], gems: [{ op: 'set', group: MAIN_GROUP, index: 3, level: 18 }] }],
    ['deallocate + allocate', { deallocate: [leaf.id], allocate: [n1.id], config: { usePowerCharges: true } }],
  ] as Array<[string, NamedProbeVariant]>) {
    const probed = await session.probeNamed({ variants: [variant] });
    assert(probed.results[0].fallback === true, `${label}: the probe takes the fallback`);
    let applied: Awaited<ReturnType<BuildSession['applyChanges']>> | undefined;
    await assertParity(label, session, variant, async () => {
      applied = await session.applyChanges(variant);
      return applied.after;
    });
    assert(applied && applied.summary, `${label}: result`);
    const ids = specNodes((await state(session)).xml);
    assert(ids.includes(n1.id), `${label}: ${n1.id} allocated`);
    if (variant.deallocate) assert(!ids.includes(leaf.id) && applied.removed.some((n) => n.id === leaf.id), `${label}: leaf removed`);
    else assert(ids.includes(n2.id), `${label}: ${n2.id} allocated`);
    await session.undoLastChange();
    assertSame(`${label}: undo`, await state(session), base);
  }
  log('PASS 1d');
}

function toNumber(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

async function test2Refusals(): Promise<void> {
  log('Test 2: refusals change nothing');
  const bridge = newBridge();
  const session = await primedSession(bridge);
  const base = await state(session);
  const notable = await twoPointNotable(bridge);
  const refusals: Array<[string, () => Promise<unknown>, RegExp]> = [
    ['bad gem name', () => session.applyChanges({ gems: [{ op: 'set', group: MAIN_GROUP, index: 2, name: 'No Such Gem Whatsoever' }] }), /gem lookup failed/i],
    ['bad gem name after a good op', () => session.applyChanges({ gems: [{ op: 'remove', group: MAIN_GROUP, index: 1 }, { op: 'add', group: MAIN_GROUP, name: 'No Such Gem Whatsoever' }] }), /gem lookup failed/i],
    ['bad group index', () => session.applyChanges({ gems: [{ op: 'remove', group: 99, index: 1 }] }), /not found/],
    ['bad gem index', () => session.applyChanges({ gems: [{ op: 'remove', group: MAIN_GROUP, index: 40 }] }), /not found/],
    ['granted group', () => session.applyChanges({ gems: [{ op: 'remove', group: GRANTED_GROUP, index: 1 }] }), /granted/],
    ['unreachable node', () => session.applyChanges({ allocate: [OTHER_ASCENDANCY_NODE], gems: [{ op: 'remove', group: MAIN_GROUP, index: 1 }] }), /no path/],
    ['unknown node', () => session.applyChanges({ allocate: ['No Such Passive Node'] }), /not found/],
    ['unknown config key', () => session.applyChanges({ config: { noSuchConfigKeyAtAll: true }, allocate: [notable.id] }), /Unknown config key/],
    ['bad item', () => session.applyChanges({ items: [{ slot: 'Ring 1', itemText: 'not an item' }] }), /Rarity/],
    ['empty variant', () => session.applyChanges({}), /changes nothing/],
    // Checked only when applied (its fit depends on the two-handed staff of
    // the same variant): a refusal after the change started, rolled back.
    ['off-hand after a two-handed weapon', () => session.applyChanges({
      config: { usePowerCharges: true },
      gems: [{ op: 'remove', group: MAIN_GROUP, index: 1 }],
      items: [{ slot: 'Weapon 1', itemText: STAFF }, { slot: 'Weapon 2', itemText: SHIELD }],
    }), /cannot be equipped in Weapon 2/],
    ['create: bad gem', () => session.createSocketGroup({ gems: [{ name: 'Fireball' }, { name: 'No Such Gem Whatsoever' }] }), /gem lookup failed/i],
    ['create: bad slot', () => session.createSocketGroup({ gems: [{ name: 'Fireball' }], slot: 'Flask 1' }), /slot must be/],
    ['delete: granted group', () => session.deleteSocketGroup(GRANTED_GROUP), /granted by/],
    ['delete: no such group', () => session.deleteSocketGroup(99), /not found/],
    ['set main: no such group', () => session.setMainSkill(99), /not found/],
    ['set main: activeSkill out of range', () => session.setMainSkill(TWO_ACTIVES_GROUP, 3), /out of range/],
  ];
  for (const [label, call, pattern] of refusals) {
    const e = await rejection(call());
    assert(e instanceof UserError, `${label}: expected a UserError, got ${e.constructor.name}: ${e.message}`);
    assert(pattern.test(e.message), `${label}: "${e.message}" does not match ${pattern}`);
    const now = await state(session);
    assert(now.xml === base.xml, `${label}: export changed`);
    assertSameStats(label, now.stats, base.stats);
    assert(session.undoStackDepth() === 0 && bridge.committedCount() === 0, `${label}: undo/journal changed`);
  }
  log(`PASS 2 (${refusals.length} refusals)`);
}

async function test3SocketGroups(): Promise<void> {
  log('Test 3: create / delete socket groups and set the main skill');
  const bridge = newBridge();
  const session = await primedSession(bridge);
  const base = await state(session);
  const groups0 = await session.listSkillGroups();
  assert((await session.getBuildInfo()).mainSkill === 'Vortex', 'Vortex is the main skill');

  const created = await session.createSocketGroup({ gems: [{ name: 'Fireball' }, { name: 'Spell Echo', quality: 20 }], label: 'Test group', setAsMain: true });
  const newIndex = created.details.index as number;
  assert(newIndex === groups0.length + 1, `new group goes last: ${newIndex}`);
  assert(created.mainSkill === 'Fireball' && (await session.getBuildInfo()).mainSkill === 'Fireball', `main skill: ${created.mainSkill}`);
  const breakdown = await session.getSkillBreakdown();
  assert(breakdown.index === newIndex && breakdown.isMainGroup && breakdown.gems.map((g) => g.nameSpec).join() === 'Fireball,Spell Echo', `breakdown: ${JSON.stringify(breakdown)}`);
  assert(toNumber(created.after.CombinedDPS) !== toNumber(base.stats.CombinedDPS), 'DPS now describes Fireball');
  assert(session.undoStackDepth() === 1 && bridge.committedCount() === 1, 'one undo entry, one journal record');
  await session.undoLastChange();
  assertSame('undo of create_socket_group', await state(session), base);
  assert((await session.getBuildInfo()).mainSkill === 'Vortex', 'undo restores the main skill');

  // Deleting a group before the main one shifts the main group down by one.
  const deleted = await session.deleteSocketGroup(TWO_ACTIVES_GROUP);
  assert(deleted.details.mainSocketGroup === MAIN_GROUP - 1, `main group shifts: ${JSON.stringify(deleted.details)}`);
  const groups1 = await session.listSkillGroups();
  assert(groups1.length === groups0.length - 1 && groups1[MAIN_GROUP - 2].isMainGroup, 'one group fewer, Vortex still main');
  assert(deleted.mainSkill === 'Vortex' && Object.keys(deleted.diff).length === 0, `deleting an unrelated group keeps the main skill: ${JSON.stringify(deleted.diff)}`);
  await session.undoLastChange();
  assertSame('undo of delete_socket_group', await state(session), base);

  // Deleting the main group: the next group takes its index and is main.
  const deletedMain = await session.deleteSocketGroup(MAIN_GROUP);
  assert(deletedMain.details.mainSocketGroup === MAIN_GROUP, 'the main index stays valid');
  const groups2 = await session.listSkillGroups();
  assert(groups2[MAIN_GROUP - 1].isMainGroup && groups2[MAIN_GROUP - 1].label === groups0[MAIN_GROUP].label, 'the next group is main');
  await session.undoLastChange();
  assertSame('undo of deleting the main group', await state(session), base);

  // set_main_skill: the second active skill of group 2.
  const setMain = await session.setMainSkill(TWO_ACTIVES_GROUP, 2);
  assert(setMain.details.mainSocketGroup === TWO_ACTIVES_GROUP && setMain.details.activeSkill === 2, JSON.stringify(setMain.details));
  assert(setMain.mainSkill === 'Cold Snap', `main skill: ${setMain.mainSkill}`);
  const groups3 = await session.listSkillGroups();
  assert(groups3[TWO_ACTIVES_GROUP - 1].isMainGroup && groups3[TWO_ACTIVES_GROUP - 1].mainActiveSkill === 2, 'group 2, second skill');
  const first = await session.setMainSkill(TWO_ACTIVES_GROUP, 1);
  assert(first.mainSkill === 'Storm Brand', `main skill: ${first.mainSkill}`);
  assert(session.undoStackDepth() === 2 && bridge.committedCount() === 2, 'one entry per call');
  await session.undoLastChange();
  await session.undoLastChange();
  assertSame('undo of set_main_skill', await state(session), base);
  assert(session.undoStackDepth() === 0 && bridge.committedCount() === 0, 'undo stack and journal back');

  // A Vaal gem grants two active skills; a disabled group is not built by
  // PoB until it is main, so the bound comes from the gems.
  const vaal = await session.createSocketGroup({ gems: [{ name: 'Vaal Cold Snap' }], enabled: false });
  const vaalIndex = vaal.details.index as number;
  const vaalXml = skillsXml((await state(session)).xml).split('<Skill ').find((x) => x.includes('Vaal Cold Snap'));
  assert(vaalXml && /mainActiveSkill="1"/.test(vaalXml) && /mainActiveSkillCalcs="1"/.test(vaalXml), `a new group is saved with mainActiveSkill 1: ${vaalXml}`);
  const second = await session.setMainSkill(vaalIndex, 2);
  const firstVaal = await session.setMainSkill(vaalIndex, 1);
  assert(second.mainSkill && firstVaal.mainSkill && second.mainSkill !== firstVaal.mainSkill, `two active skills: ${firstVaal.mainSkill} / ${second.mainSkill}`);
  const outOfRange = await rejection(session.setMainSkill(vaalIndex, 3));
  assert(outOfRange instanceof UserError && /has 2 active skill/.test(outOfRange.message), `vaal bound: ${outOfRange.message}`);
  for (let i = 0; i < 3; i++) await session.undoLastChange();
  assertSame('undo of the Vaal group', await state(session), base);
  log('PASS 3');
}

async function crash(bridge: LuaBridge): Promise<void> {
  const pid = bridge.getPid();
  assert(pid !== undefined && bridge.isRunning(), 'engine should be running before the crash');
  process.kill(pid, 'SIGKILL');
  const end = Date.now() + 10_000;
  while (bridge.isRunning()) {
    if (Date.now() > end) throw new Error('timed out waiting for the engine to exit');
    await sleep(25);
  }
}

async function expectRestart(label: string, p: Promise<unknown>): Promise<void> {
  const e = await rejection(p);
  assert(e instanceof EngineRestartedError && /build was restored/.test(e.message), `${label}: expected the restart notice, got ${e.message}`);
}

async function test4CrashReplay(): Promise<void> {
  log('Test 4: a crash after committed build edits respawns with them');
  const bridge = newBridge();
  const session = await primedSession(bridge);
  const notable = await twoPointNotable(bridge);

  // An undone apply_changes is not replayed.
  await session.applyChanges({ gems: [{ op: 'remove', group: MAIN_GROUP, index: 1 }] });
  await session.undoLastChange();
  await session.applyChanges({
    allocate: [notable.id],
    gems: [{ op: 'set', group: MAIN_GROUP, index: 2, name: 'elemental focus' }],
    config: { usePowerCharges: true },
    items: [{ slot: 'Ring 1', itemText: RING }],
  });
  const applied = await state(session);
  await crash(bridge);
  await expectRestart('after apply_changes', session.getStats());
  assertSame('respawned after apply_changes', await state(session), applied);

  await session.createSocketGroup({ gems: [{ name: 'fireball' }, { name: 'Spell Echo' }], slot: 'Gloves', setAsMain: true });
  await session.setMainSkill(TWO_ACTIVES_GROUP, 2);
  await session.deleteSocketGroup(1);
  const edited = await state(session);
  await crash(bridge);
  await expectRestart('after the socket group edits', session.getStats());
  assertSame('respawned after the socket group edits', await state(session), edited);

  {
    // A fallback variant (several node changes) is replayed too (a new engine: three crashes trip the breaker).
    const bridge2 = newBridge();
    const session2 = await primedSession(bridge2);
    const [m1, m2, m3] = await twoPointNotables(bridge2, 3);
    await session2.allocateNodes([m1.id]);
    await session2.applyChanges({ allocate: [m2.id, m3.id], deallocate: [m1.id] });
    const fallbackApplied = await state(session2);
    await crash(bridge2);
    await expectRestart('after a fallback apply_changes', session2.getStats());
    assertSame('respawned after a fallback apply_changes', await state(session2), fallbackApplied);
  }
  log('PASS 4');
}

async function test5Faults(): Promise<void> {
  log('Test 5: fault seams around the change');
  {
    const bridge = newBridge('buildEditFailsAfterChange');
    const session = await primedSession(bridge);
    const base = await state(session);
    const notable = await twoPointNotable(bridge);
    const e = await rejection(session.applyChanges({ allocate: [notable.id], gems: [{ op: 'remove', group: MAIN_GROUP, index: 1 }] }));
    assert(!(e instanceof UserError) && /WAS applied/.test(e.message) && /test fault/.test(e.message), `applied-but-failed: ${e.message}`);
    assert(session.undoStackDepth() === 1 && bridge.committedCount() === 1, 'the applied change is committed with its journal record');
    const applied = await state(session);
    assert(specNodes(applied.xml).includes(notable.id), 'the change is in the build');
    await session.undoLastChange();
    assertSame('undo of the applied-but-failed apply_changes', await state(session), base);
    await rejection(session.applyChanges({ allocate: [notable.id], gems: [{ op: 'remove', group: MAIN_GROUP, index: 1 }] }));
    await crash(bridge);
    await expectRestart('after the applied-but-failed apply_changes', session.getStats());
    assertSame('respawned after the applied-but-failed apply_changes', await state(session), applied);

    const c = await rejection(session.createSocketGroup({ gems: [{ name: 'Fireball' }], setAsMain: true }));
    assert(!(c instanceof UserError) && /WAS applied/.test(c.message), `create applied-but-failed: ${c.message}`);
    assert((await session.getBuildInfo()).mainSkill === 'Fireball', 'the new group is in the build');
    assert(session.undoStackDepth() === 1 && bridge.committedCount() === 2, 'committed with its journal record');
    const created = await state(session);
    await crash(bridge);
    await expectRestart('after the applied-but-failed create_socket_group', session.getStats());
    assertSame('respawned after the applied-but-failed create_socket_group', await state(session), created);
  }
  {
    const bridge = newBridge('buildEditFailsAfterChange,buildEditRecalcFails');
    const session = await primedSession(bridge);
    const e = await rejection(session.setMainSkill(TWO_ACTIVES_GROUP));
    assert(/WAS applied/.test(e.message) && /recalculation also failed/.test(e.message) && /may show values from before/.test(e.message), `recalc failed too: ${e.message}`);
    assert(session.undoStackDepth() === 1 && bridge.committedCount() === 1, 'committed');
    assert((await session.listSkillGroups())[TWO_ACTIVES_GROUP - 1].isMainGroup, 'the main group changed');
  }
  {
    const bridge = newBridge('applyChangesFailsMidway');
    const session = await primedSession(bridge);
    const base = await state(session);
    const e = await rejection(session.applyChanges({ config: { usePowerCharges: true }, gems: [{ op: 'remove', group: MAIN_GROUP, index: 1 }], items: [{ slot: 'Ring 1', itemText: RING }] }));
    assert(!(e instanceof UserError) && /failed part-way/.test(e.message) && !/WAS applied/.test(e.message), `rolled back: ${e.message}`);
    assert(session.undoStackDepth() === 0 && bridge.committedCount() === 0, 'nothing pushed or journaled');
    assertSame('rolled back after a failure part-way', await state(session), base);
  }
  {
    // The engine dies during the recalculation after an applied change: nothing is committed.
    const bridge = newBridge('buildEditFailsAfterChange,buildEditRecalcExits');
    const session = await primedSession(bridge);
    const base = await state(session);
    const e = await rejection(session.setMainSkill(TWO_ACTIVES_GROUP));
    assert(/recalculation also failed/.test(e.message) && !/may show values/.test(e.message) && !/WAS applied/.test(e.message), `engine gone: ${e.message}`);
    assert(!bridge.isRunning(), 'the engine is gone');
    assert(session.undoStackDepth() === 0 && bridge.committedCount() === 0, 'nothing committed');
    await expectRestart('after the engine died in the recalculation', session.getStats());
    assertSame('respawned without the uncommitted change', await state(session), base);
  }
  {
    const bridge = newBridge('applyChangesFailsMidway,buildEditRollbackInexact');
    const session = await primedSession(bridge);
    const base = await state(session);
    const e = await rejection(session.applyChanges({ config: { usePowerCharges: true }, gems: [{ op: 'remove', group: MAIN_GROUP, index: 1 }], items: [{ slot: 'Ring 1', itemText: RING }] }));
    assert(!(e instanceof UserError) && /failed part-way/.test(e.message) && /not exact/.test(e.message) && /reset_build/.test(e.message), `inexact rollback: ${e.message}`);
    assert(session.undoStackDepth() === 1 && bridge.committedCount() === 0, 'one undo entry, nothing journaled');
    await session.undoLastChange();
    assertSame('undo after the inexact rollback', await state(session), base);
    assert(session.undoStackDepth() === 0 && bridge.committedCount() === 0, 'undo pops the entry');
  }
  log('PASS 5');
}

interface ToolText {
  type: 'text';
  text: string;
}

async function test6Mcp(): Promise<void> {
  log('Test 6: through the MCP server');
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'pob-build-edit-'));
  tempDirs.push(configDir);
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', path.resolve(testDir, '..', 'src', 'server.ts')],
    env: { ...process.env, POB_PATH: paths.pobPath, LUAJIT_PATH: paths.luajitPath, POB_MCP_CONFIG_DIR: configDir } as Record<string, string>,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'build-edit-test', version: '0.0.0' });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
    const r = (await client.callTool({ name, arguments: args })) as { content: ToolText[]; isError?: boolean };
    return { text: r.content[0].text, isError: r.isError === true };
  };
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    for (const name of ['apply_changes', 'create_socket_group', 'delete_socket_group', 'set_main_skill']) {
      const t = tools.find((x) => x.name === name);
      assert(t, `${name} is listed`);
      assert(t.annotations?.readOnlyHint === false && t.annotations?.destructiveHint === false, `${name}: undoable annotations`);
    }
    assert(!(await call('load_build', { source: occXml })).isError, 'load_build');
    const bridge = newBridge();
    const probeSession = new BuildSession(bridge);
    await probeSession.loadBuild(occXml);
    const notable = await twoPointNotable(bridge);
    const variant = { label: 'winner', allocate: [notable.id], gems: [{ op: 'set', group: MAIN_GROUP, index: 2, name: 'Elemental Focus' }] };
    const evaluated = JSON.parse((await call('evaluate_changes', { variants: [variant] })).text) as { results: Array<{ delta: Record<string, number> }> };
    const res = await call('apply_changes', { variant });
    assert(!res.isError && !res.text.includes('\n'), `apply_changes: ${res.text}`);
    const parsed = JSON.parse(res.text) as {
      status: string;
      label: string;
      added: Array<{ id: number }>;
      pointsUsed: number;
      points: { used: number; max: number; remaining: number };
      keyDeltas: Record<string, number>;
    };
    assert(parsed.status === 'applied' && parsed.label === 'winner' && parsed.pointsUsed === 2 && parsed.added[1].id === notable.id, `result: ${res.text}`);
    assert(roundStat(parsed.keyDeltas.CombinedDPS) === evaluated.results[0].delta.CombinedDPS, 'the committed DPS change is the evaluated one');
    const created = JSON.parse((await call('create_socket_group', { gems: [{ name: 'Fireball' }], setAsMain: true })).text) as { status: string; group: number; mainSkill: string };
    assert(created.status === 'created' && created.mainSkill === 'Fireball' && created.group > 0, `create: ${JSON.stringify(created)}`);
    const refused = await call('delete_socket_group', { group: GRANTED_GROUP });
    assert(refused.isError && /granted by/.test(refused.text) && !/Internal error/.test(refused.text), `refusal: ${refused.text}`);
    assert(!(await call('undo_last_change')).isError && !(await call('undo_last_change')).isError, 'undo both');
    const info = JSON.parse((await call('get_skill_breakdown')).text) as { activeGem: { nameSpec: string } };
    assert(info.activeGem.nameSpec === 'Vortex', 'undo_last_change reverts the main skill');
  } finally {
    await client.close();
  }
  log('PASS 6');
}

const MASTERY_FIXTURE = path.resolve(testDir, 'fixtures', 'ConvertTreeMasteries.xml');
const LIFE_MASTERY = 2841; // allocated, effect 64381; 34242 and 47642 are chosen on 12125 / 12382

function specMasteries(xml: string): string[] {
  const m = /<Spec\b[^>]*\bmasteryEffects="([^"]*)"/.exec(xml);
  assert(m, 'export has no masteryEffects attribute');
  return (m[1].match(/\{\d+,\d+\}/g) ?? []).sort();
}

async function test7MasteriesAndMainSkill(): Promise<void> {
  const masteryXml = readFileSync(MASTERY_FIXTURE, 'utf8');
  const bridge = newBridge();
  const session = await primedSession(bridge, masteryXml);
  const base = await state(session);

  log('Test 7a: a mainSkill variant equals set_main_skill + get_stats');
  const mainOnly: NamedProbeVariant = { mainSkill: { group: TWO_ACTIVES_GROUP, activeSkill: 2 } };
  let applied: Awaited<ReturnType<BuildSession['applyChanges']>> | undefined;
  await assertParity('mainSkill', session, mainOnly, async () => {
    applied = await session.applyChanges(mainOnly);
    return applied.after;
  });
  assert(applied, 'applied');
  assert(applied.mainSkill === 'Cold Snap', `main skill after: ${applied.mainSkill}`);
  assert(toNumber(applied.after.CombinedDPS) !== toNumber(base.stats.CombinedDPS), 'another main skill changes DPS');
  assert(session.undoStackDepth() === 1 && bridge.committedCount() === 1, 'one undo entry, one journal record');
  await session.undoLastChange();
  assertSame('undo of the mainSkill variant', await state(session), base);
  const viaTool = await session.setMainSkill(TWO_ACTIVES_GROUP, 2);
  assertSameStats('apply_changes mainSkill = set_main_skill', viaTool.after, applied.after);
  await session.undoLastChange();
  assertSame('undo of set_main_skill', await state(session), base);
  log('PASS 7a');

  log('Test 7b: masteries + mainSkill in one variant (fallback), undo exact');
  const life = (await session.getPassiveTree([LIFE_MASTERY])).masteryOptions![0];
  const free = (life.options ?? []).filter((o) => o.takenBy === undefined && o.effect !== life.effect);
  const other = ((await session.getPassiveTree(['Life Mastery'])).masteryOptions ?? [])
    .filter((m) => !m.allocated && m.points !== undefined)
    .sort((a, b) => a.points! - b.points!)[0];
  assert(free.length >= 2 && other, 'two free Life Mastery effects and a reachable unallocated Life Mastery');
  const mixed: NamedProbeVariant = {
    masteries: [{ node: LIFE_MASTERY, effect: free[0].effect }, { node: other.id!, effect: free[1].stats }],
    mainSkill: { group: TWO_ACTIVES_GROUP },
  };
  const probed = await session.probeNamed({ variants: [mixed] });
  assert(probed.results[0].fallback === true, `two mastery changes take the fallback: ${JSON.stringify(probed.results[0])}`);
  let result: Awaited<ReturnType<BuildSession['applyChanges']>> | undefined;
  await assertParity('masteries + mainSkill', session, mixed, async () => {
    result = await session.applyChanges(mixed);
    return result.after;
  });
  assert(result, 'applied');
  const masteries = result.masteries ?? [];
  assert(masteries.length === 2 && masteries[0].id === LIFE_MASTERY && masteries[0].effect === free[0].effect && masteries[0].previousEffect === 64381
    && masteries[1].id === other.id && masteries[1].effect === free[1].effect, `masteries: ${JSON.stringify(masteries)}`);
  assert(result.added.length === other.points && result.added[result.added.length - 1].id === other.id, `added: ${JSON.stringify(result.added)}`);
  const mixedState = await state(session);
  const effects = specMasteries(mixedState.xml);
  assert(effects.includes(`{${LIFE_MASTERY},${free[0].effect}}`) && effects.includes(`{${other.id},${free[1].effect}}`), `export effects: ${effects}`);
  assert(session.undoStackDepth() === 1 && bridge.committedCount() === 1, 'one undo entry, one journal record');
  await session.undoLastChange();
  assertSame('undo of masteries + mainSkill', await state(session), base);
  log('PASS 7b');

  log('Test 7c: a crash replays it');
  await session.applyChanges(mixed);
  const again = await state(session);
  assertSame('the same variant applied again', again, mixedState);
  await crash(bridge);
  await expectRestart('after apply_changes with masteries', session.getStats());
  assertSame('respawned after apply_changes with masteries', await state(session), again);
  log('PASS 7c');

  log('Test 7d: refusals change nothing');
  const now = await state(session);
  const depth = session.undoStackDepth();
  const journal = bridge.committedCount();
  const refusals: Array<[string, NamedProbeVariant, RegExp]> = [
    ['effect not offered', { masteries: [{ node: 12125, effect: 41322 }] }, /does not offer effect 41322/],
    ['mastery in allocate', { allocate: [other.id!] }, /is a mastery; pass it in `masteries`/],
    ['main skill group out of range', { mainSkill: { group: 99 } }, /Skill group not found at index 99/],
    ['active skill out of range', { mainSkill: { group: TWO_ACTIVES_GROUP, activeSkill: 3 } }, /out of range/],
    ['mixed with a bad effect', { config: { usePowerCharges: true }, masteries: [{ node: 12125, effect: 'no such effect text' }] }, /no effect of mastery/],
  ];
  for (const [label, variant, pattern] of refusals) {
    const e = await rejection(session.applyChanges(variant));
    assert(e instanceof UserError && pattern.test(e.message), `${label}: ${e.constructor.name}: ${e.message}`);
    assertSame(`${label}: unchanged`, await state(session), now);
    assert(session.undoStackDepth() === depth && bridge.committedCount() === journal, `${label}: undo/journal changed`);
  }
  log('PASS 7d');

  log('Test 7e: a deallocation that removes a listed mastery; mainSkill with a skill-granting item; a no-op');
  // A node whose deallocation removes an allocated mastery (one of its dependents).
  const masteryIds = new Set((await session.getPassiveTree()).allocatedNodes.filter((n) => n.type === 'Mastery').map((n) => n.id));
  const deallocs = (await bridge.send<{ nodes: Array<{ id: number; type: string; nodes: number[]; fallback?: string }> }>({ cmd: 'probe', candidates: 'deallocate' })).nodes;
  const carrier = deallocs.find((c) => !c.fallback && c.nodes.slice(1).some((id) => masteryIds.has(id)));
  assert(carrier, 'an allocated node with a mastery among its dependents');
  const dependent = carrier.nodes.slice(1).find((id) => masteryIds.has(id))!;
  const dependentEffect = ((await session.getPassiveTree([dependent])).masteryOptions![0]).effect!;
  // Refused the same way by evaluate_changes and apply_changes (the calculator
  // would drop the mastery with its node, apply_changes re-allocate it).
  const removedShape: NamedProbeVariant = { deallocate: [carrier.id], masteries: [{ node: dependent, effect: dependentEffect }] };
  const evalRemoved = await evaluateChanges(session, { variants: [removedShape] });
  assert(evalRemoved.results[0].userError === true && /removed by this change's deallocation/.test(evalRemoved.results[0].error ?? ''), `evaluate: ${JSON.stringify(evalRemoved.results[0])}`);
  const applyRemoved = await rejection(session.applyChanges(removedShape));
  assert(applyRemoved instanceof UserError && /removed by this change's deallocation/.test(applyRemoved.message), `apply: ${applyRemoved.message}`);
  assertSame('refused deallocation + mastery: unchanged', await state(session), now);
  // A deallocation plus a switch on a mastery it leaves alone: evaluate_changes (fallback) = apply_changes.
  const alone = [...masteryIds].find((id) => !carrier.nodes.includes(id))!;
  const aloneOpt = (await session.getPassiveTree([alone])).masteryOptions![0];
  const aloneEffect = (aloneOpt.options ?? []).find((o) => o.takenBy === undefined && o.effect !== aloneOpt.effect)!;
  const deallocAndSwitch: NamedProbeVariant = { deallocate: [carrier.id], masteries: [{ node: alone, effect: aloneEffect.effect }] };
  await assertParity('deallocate + mastery switch', session, deallocAndSwitch, async () => (await session.applyChanges(deallocAndSwitch)).after);
  await session.undoLastChange();
  assertSame('undo of deallocate + mastery switch', await state(session), now);

  const skillRing = 'Rarity: RARE\nSkill Ring\nCoral Ring\n+30 to maximum Life\nGrants Level 20 Summon Skitterbots Skill';
  const withSkillItem: NamedProbeVariant = { items: [{ slot: 'Ring 1', itemText: skillRing }], mainSkill: { group: TWO_ACTIVES_GROUP } };
  const evalSkill = await evaluateChanges(session, { variants: [withSkillItem, { items: [{ slot: 'Ring 1', itemText: skillRing }] }] });
  const skillRow = evalSkill.results.find((r) => r.index === 0)!;
  assert(skillRow.userError === true && /mainSkill cannot be combined/.test(skillRow.error ?? ''), `evaluate mainSkill + skill item: ${JSON.stringify(skillRow)}`);
  assert(evalSkill.results.find((r) => r.index === 1)!.error === undefined, 'the item alone is evaluated');
  const applySkill = await rejection(session.applyChanges(withSkillItem));
  assert(applySkill instanceof UserError && /mainSkill cannot be combined/.test(applySkill.message), `apply mainSkill + skill item: ${applySkill.message}`);

  const noop = await session.applyChanges({ masteries: [{ node: 12125, effect: 34242 }] });
  assert(noop.unchanged === true && Object.keys(noop.diff).length === 0, `no-op apply_changes: ${JSON.stringify(noop.masteries)}`);
  assertSame('after the refusals and the no-op', await state(session), now);
  assert(session.undoStackDepth() === depth && bridge.committedCount() === journal, 'nothing pushed or journaled');
  log('PASS 7e');
}

async function main(): Promise<void> {
  try {
    await test1Parity();
    await test2Refusals();
    await test3SocketGroups();
    await test4CrashReplay();
    await test5Faults();
    await test6Mcp();
    await test7MasteriesAndMainSkill();
    log('ALL PASS');
  } finally {
    for (const b of bridges) await b.shutdown().catch(() => undefined);
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
