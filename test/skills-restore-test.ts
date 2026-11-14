// Skills snapshot/restore exactness and all-or-nothing batch commands.
//
// The test build is OccVortex.xml with two gems added through the engine
// (Raise Zombie and Stormblast Mine in group 1), exported by PoB, given the
// skill fields the old snapshot dropped (group count, imbued support, minion
// skill choice for the main and Calcs views, mine counts, a group label, a
// full-DPS flag) plus a second skill set, and loaded back through PoB's own
// SkillsTab:Load. The baseline is the engine's export of that load.
//
//   1. Every skills probe (swap_gem, compare_supports, evaluate_gem_levels,
//      find_optimal_links, a probe on group 1 itself) and an undo leave the
//      exported build byte-identical and Life / CombinedDPS / TotalEHP
//      bit-exact.
//   2. Repeated probe cycles do not drift (export and skills snapshot).
//   3. replaceSocketGroup with one unknown gem among valid ones, or a bad
//      group index or level, is a UserError that leaves the group untouched
//      (directly at the bridge and through find_optimal_links).
//   4. allocNodes / deallocNodes with one unknown, unreachable, unallocated
//      or class-start node among valid ones are UserErrors that leave the
//      tree untouched (through simulate_passive_change and at the bridge).
//   5. A probe user error followed by a failing skills restore (a corrupted
//      snapshot injected through a test-only wrapper around this process's
//      LuaBridge.send, not reachable from MCP tool arguments) reaches the
//      client as an internal error naming reset_build that keeps the probe's
//      message and has the probe error as its cause; the same for
//      suggest_upgrades' restore. Without the injection the probe error stays
//      a user error, shown verbatim.
//   6. The monster-explosion group (from OccVortex's items): a gem level
//      changed through the engine survives skills probes (the gem is
//      relinked to its source); a snapshot naming a source that no longer
//      exists (injected by the same wrapper) is an internal error naming
//      reset_build, not a silent difference.
//   7. Batch-command rollbacks, with failures injected inside the engine
//      through POB_MCP_TEST_FAULTS (read by bridge.lua at start; set only by
//      the LuaBridge `testFaults` option, for engine processes this test
//      starts, never from the environment): a batch that fails after changing
//      the tree or group is rolled back and stays a user error; a rollback
//      that throws or leaves the tree different is an internal error naming
//      reset_build that keeps the original message without the user-error
//      marker.
import { readFileSync } from 'fs';
import { BuildSession } from '../src/build-session.js';
import { LuaBridge, Stats } from '../src/lua-bridge.js';
import { errorResponse } from '../src/tool-registry.js';
import { UserError } from '../src/validation.js';
import { setupTestEnv } from './_skip.js';

const MAIN_GROUP = 5; // Vortex and its supports
const FIELD_GROUP = 1; // Flame Dash group that gets the extra fields
const REACHABLE = [2260, 56158]; // unallocated, next to the allocated tree
const UNREACHABLE = 1734; // Unflinching: a Juggernaut node, no path for an Occultist
const CLASS_START_OTHER = 47175; // MARAUDER start, not allocated
const UNKNOWN_NODE = 999999;
const BAD_GEM = 'Definitely Not A Gem';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** Test-only seam: while true, skills snapshots come back corrupted, so restoring them throws. */
let corruptSkillsSnapshot = false;
/** Test-only seam: while true, explosion gems in skills snapshots name a source that does not exist. */
let unknownExplodeSource = false;
const EXPLODE_KEY = '__explodeSourceKey';

function installSeam(bridge: LuaBridge): void {
  const realSend = bridge.send.bind(bridge);
  bridge.send = (async (command: object, timeoutOverrideMs?: number) => {
    const result = await realSend<{ snapshot?: unknown; skills?: unknown }>(command, timeoutOverrideMs);
    if (corruptSkillsSnapshot && (command as { cmd?: string }).cmd === 'snapshotSkills') {
      result.snapshot = 'corrupted by the test seam';
    }
    if (unknownExplodeSource && (command as { cmd?: string }).cmd === 'snapshotSkills') {
      const text = JSON.stringify(result.snapshot);
      assert(text.includes(EXPLODE_KEY), 'seam: the snapshot has no explosion gem');
      result.snapshot = JSON.parse(text.replace(new RegExp(`\\["${EXPLODE_KEY}",(?:"[^"]*"|[\\d.]+)\\]`, 'g'), `["${EXPLODE_KEY}","no such source"]`));
    }
    return result;
  }) as LuaBridge['send'];
}

/**
 * A second engine process started with test-only faults. Only the LuaBridge
 * `testFaults` option passes POB_MCP_TEST_FAULTS to the child (bridge.lua reads
 * it at start); the server's own environment value never reaches it.
 */
async function faultySession(paths: ReturnType<typeof setupTestEnv>['paths'], faults: string, xml: string): Promise<{ bridge: LuaBridge; session: BuildSession }> {
  const bridge = new LuaBridge(paths, 120_000, { testFaults: faults });
  const session = new BuildSession(bridge);
  await session.loadBuild(xml);
  return { bridge, session };
}

function assertInternal(err: Error, parts: RegExp[], label: string): void {
  assert(!(err instanceof UserError), `${label}: reported as a user error: ${err.message}`);
  for (const p of parts) assert(p.test(err.message), `${label}: ${p} missing from: ${err.message}`);
  assert(!err.message.startsWith('__USER__') && !err.message.includes('__USER__'), `${label}: user-error marker leaked: ${err.message}`);
  const reply = errorResponse(err).content[0].text;
  assert(reply.startsWith('Internal error: ') && reply.includes('reset_build'), `${label}: client reply: ${reply}`);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    assert(err instanceof Error, `rejected with a non-Error: ${String(err)}`);
    return err;
  }
  throw new Error('expected the call to fail, but it succeeded');
}

interface State {
  xml: string;
  skills: string;
  nodeIds: number[];
  stats: { Life: unknown; CombinedDPS: unknown; TotalEHP: unknown };
}

async function state(bridge: LuaBridge, session: BuildSession): Promise<State> {
  const xml = (await bridge.send<{ xml: string }>({ cmd: 'exportXML' })).xml;
  const skills = JSON.stringify(await session.snapshotSkills());
  const spec = (await bridge.send<{ state: { nodeIds: number[] } }>({ cmd: 'captureSpecState' })).state;
  const s = (await bridge.getStats()) as Stats;
  return {
    xml,
    skills,
    nodeIds: [...spec.nodeIds].sort((a, b) => a - b),
    stats: { Life: s.Life, CombinedDPS: s.CombinedDPS, TotalEHP: s.TotalEHP },
  };
}

function firstDifference(a: string, b: string): string {
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) return `line ${i + 1}\n  expected ${al[i]?.trim()}\n  actual   ${bl[i]?.trim()}`;
  }
  return 'no line differs';
}

function assertSame(label: string, actual: State, expected: State): void {
  assert(actual.xml === expected.xml, `${label}: export differs at ${firstDifference(expected.xml, actual.xml)}`);
  assert(actual.skills === expected.skills, `${label}: skills snapshot differs`);
  assert(
    JSON.stringify(actual.nodeIds) === JSON.stringify(expected.nodeIds),
    `${label}: allocated nodes differ`,
  );
  for (const key of ['Life', 'CombinedDPS', 'TotalEHP'] as const) {
    assert(actual.stats[key] === expected.stats[key], `${label}: ${key} not bit-exact (${actual.stats[key]} != ${expected.stats[key]})`);
  }
}

/** Set attributes on the first element matching `pattern` (a `<Skill ` or `<Gem ` opening tag). */
function addAttributes(xml: string, pattern: RegExp, attrs: string, label: string): string {
  const match = pattern.exec(xml);
  assert(match, `test build: ${label} not found in the export`);
  let tag = match[0];
  for (const [, name, value] of attrs.matchAll(/(\w+)="([^"]*)"/g)) {
    const existing = new RegExp(` ${name}="[^"]*"`);
    tag = existing.test(tag) ? tag.replace(existing, ` ${name}="${value}"`) : tag.replace(/^(<\w+) /, `$1 ${name}="${value}" `);
  }
  return xml.replace(match[0], tag);
}

/** The OccVortex build with the skill fields the old snapshot dropped, as PoB loads and saves it. */
async function buildFieldBuild(bridge: LuaBridge, session: BuildSession, occXml: string): Promise<string> {
  await session.loadBuild(occXml);
  await bridge.send({ cmd: 'addGem', groupIndex: FIELD_GROUP, gemName: 'Raise Zombie', level: 20, quality: 0 });
  await bridge.send({ cmd: 'addGem', groupIndex: FIELD_GROUP, gemName: 'Stormblast Mine', level: 20, quality: 0 });
  let xml = (await bridge.send<{ xml: string }>({ cmd: 'exportXML' })).xml;
  xml = addAttributes(xml, /<Skill [^>]*slot="Weapon 2"[^>]*>/, 'groupCount="3" imbuedSupport="Added Fire Damage" label="Probe Fields"', 'group 1');
  xml = addAttributes(xml, /<Skill [^>]*slot="Boots"[^>]*>/, 'includeInFullDPS="true"', 'Boots group');
  xml = xml.replace(/(<Gem [^>]*)skillMinionSkill="1"([^>]*)skillMinionSkillCalcs="1"/, '$1skillMinionSkill="2"$2skillMinionSkillCalcs="2"');
  xml = xml.replace(/(<Gem [^>]*)skillMinionSkillCalcs="1"([^>]*)skillMinionSkill="1"/, '$1skillMinionSkillCalcs="2"$2skillMinionSkill="2"');
  xml = addAttributes(xml, /<Gem [^>]*nameSpec="Stormblast Mine"[^>]*>/, 'skillMineCount="3" skillMineCountCalcs="2"', 'Stormblast Mine');
  // A second skill set: a copy of the first under id 2.
  const set = /<SkillSet [^>]*id="1"[^>]*>[\s\S]*?<\/SkillSet>/.exec(xml);
  assert(set, 'test build: skill set 1 not found');
  const copy = set[0].replace(/id="1"/, 'id="2"').replace(/title="[^"]*"/, 'title="Second Set"');
  xml = xml.replace(set[0], set[0] + '\n' + (copy.includes('title=') ? copy : copy.replace('<SkillSet ', '<SkillSet title="Second Set" ')));
  await session.loadBuild(xml);
  const saved = (await bridge.send<{ xml: string }>({ cmd: 'exportXML' })).xml;
  for (const expected of [
    'groupCount="3"',
    'imbuedSupport="Added Fire Damage"',
    'label="Probe Fields"',
    'includeInFullDPS="true"',
    'skillMinionSkill="2"',
    'skillMinionSkillCalcs="2"',
    'skillMineCount="3"',
    'skillMineCountCalcs="2"',
    'title="Second Set"',
  ]) {
    assert(saved.includes(expected), `test build: PoB did not keep ${expected}`);
  }
  return saved;
}

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const occXml = readFileSync(fixturePath, 'utf8');
  const bridge = new LuaBridge(paths, 120_000);
  installSeam(bridge);
  const session = new BuildSession(bridge);

  try {
    log('Building the test build (fields the old skills snapshot dropped)');
    const fieldXml = await buildFieldBuild(bridge, session, occXml);
    const s0 = await state(bridge, session);
    assert(s0.xml === fieldXml, 'export changed between two reads');

    // ---------------------------------------------------------------- 1
    log('Test 1: skills probes leave the export byte-identical and stats bit-exact');
    await session.swapGemWithDiff(MAIN_GROUP, 1, 'Added Cold Damage', 20, 20);
    assertSame('after swap_gem', await state(bridge, session), s0);
    await session.swapGemWithDiff(FIELD_GROUP, 4, 'Raise Spectre', 20, 0);
    assertSame('after swap_gem on the field group', await state(bridge, session), s0);
    await session.compareSupports(MAIN_GROUP, ['Added Cold Damage', 'Elemental Focus']);
    assertSame('after compare_supports', await state(bridge, session), s0);
    await session.evaluateGemLevels(MAIN_GROUP, 6, [19, 21]);
    assertSame('after evaluate_gem_levels', await state(bridge, session), s0);
    await session.evaluateGemLevels(FIELD_GROUP, 5, [10]);
    assertSame('after evaluate_gem_levels on the mine', await state(bridge, session), s0);
    await session.findOptimalLinks('Vortex', 3, [], { topN: 3, topAlternatives: 2 });
    assertSame('after find_optimal_links', await state(bridge, session), s0);
    await session.pushUndo();
    await bridge.send({ cmd: 'removeGem', groupIndex: FIELD_GROUP, gemIndex: 4 });
    await bridge.send({ cmd: 'setGemLevel', groupIndex: MAIN_GROUP, gemIndex: 6, level: 1 });
    assert((await state(bridge, session)).xml !== s0.xml, 'the undo test change did not apply');
    await session.undoLastChange();
    assertSame('after undo', await state(bridge, session), s0);
    log('PASS: probes and undo keep the build exact');

    // ---------------------------------------------------------------- 2
    log('Test 2: repeated probe cycles do not drift');
    for (let i = 0; i < 8; i++) {
      await session.swapGemWithDiff(FIELD_GROUP, 2, 'Faster Casting', 20, 0);
      await session.evaluateGemLevels(FIELD_GROUP, 4, [15]);
    }
    assertSame('after 16 probe cycles', await state(bridge, session), s0);
    log('PASS: no drift');

    // ---------------------------------------------------------------- 3
    log('Test 3: replaceSocketGroup is all-or-nothing');
    const replaceErr = await rejection(bridge.send({
      cmd: 'replaceSocketGroup',
      groupIndex: MAIN_GROUP,
      gems: [{ name: 'Vortex', level: 20, quality: 20 }, { name: 'Added Cold Damage' }, { name: BAD_GEM }, { name: 'Elemental Focus' }],
    }));
    assert(replaceErr instanceof UserError && replaceErr.message.includes(BAD_GEM), `unknown gem: ${replaceErr.message}`);
    assertSame('after replaceSocketGroup with an unknown gem', await state(bridge, session), s0);
    const indexErr = await rejection(bridge.send({ cmd: 'replaceSocketGroup', groupIndex: 99, gems: [{ name: 'Vortex' }] }));
    assert(indexErr instanceof UserError, `bad group index: ${indexErr.message}`);
    const levelErr = await rejection(bridge.send({
      cmd: 'replaceSocketGroup',
      groupIndex: MAIN_GROUP,
      gems: [{ name: 'Vortex', level: 20 }, { name: 'Added Cold Damage', level: 'high' }],
    }));
    assert(levelErr instanceof UserError && /level/.test(levelErr.message), `bad level: ${levelErr.message}`);
    assertSame('after rejected replaceSocketGroup calls', await state(bridge, session), s0);
    const linksErr = await rejection(session.findOptimalLinks('Vortex', 3, ['Added Cold Damage', BAD_GEM], { topN: 2 }));
    assert(linksErr instanceof UserError && linksErr.message.includes(BAD_GEM), `find_optimal_links: ${linksErr.message}`);
    assertSame('after find_optimal_links with an unknown gem', await state(bridge, session), s0);
    log('PASS: an invalid gem, index or level changes nothing');

    // ---------------------------------------------------------------- 4
    log('Test 4: allocNodes / deallocNodes are all-or-nothing');
    const allocated = s0.nodeIds.filter((id) => id !== CLASS_START_OTHER);
    let someNormal: number | undefined;
    for (const id of allocated) {
      const info = await bridge.send<{ node: { type: string } | null }>({ cmd: 'getNodeInfo', nodeId: id });
      if (info.node?.type === 'Normal') {
        someNormal = id;
        break;
      }
    }
    assert(someNormal !== undefined, 'no allocated Normal node');
    let classStart: number | undefined;
    for (const id of allocated) {
      const info = await bridge.send<{ node: { type: string } | null }>({ cmd: 'getNodeInfo', nodeId: id });
      if (info.node?.type === 'ClassStart') classStart = id;
    }
    assert(classStart !== undefined, 'no allocated class start');
    for (const id of REACHABLE) assert(!s0.nodeIds.includes(id), `node ${id} is already allocated`);
    assert(!s0.nodeIds.includes(UNREACHABLE), `node ${UNREACHABLE} is allocated`);

    const cases: Array<{ label: string; allocate: number[]; deallocate: number[]; text: RegExp }> = [
      { label: 'unreachable node', allocate: [...REACHABLE, UNREACHABLE], deallocate: [], text: /no path/ },
      { label: "another class's start", allocate: [REACHABLE[0], CLASS_START_OTHER], deallocate: [], text: /no path/ },
      { label: 'unknown alloc node', allocate: [REACHABLE[0], UNKNOWN_NODE], deallocate: [], text: /Unknown node id: 999999/ },
      { label: 'unknown dealloc node', allocate: [], deallocate: [someNormal, UNKNOWN_NODE], text: /Unknown node id: 999999/ },
      { label: 'unallocated dealloc node', allocate: [], deallocate: [someNormal, REACHABLE[0]], text: /not allocated/ },
      { label: 'class start dealloc', allocate: [], deallocate: [someNormal, classStart], text: /class start/ },
    ];
    for (const c of cases) {
      const err = await rejection(session.simulatePassiveChange(c.allocate, c.deallocate));
      assert(err instanceof UserError && c.text.test(err.message), `simulate_passive_change, ${c.label}: ${err.message}`);
      assertSame(`after simulate_passive_change with ${c.label}`, await state(bridge, session), s0);
      const cmd = c.allocate.length > 0 ? 'allocNodes' : 'deallocNodes';
      const nodeIds = c.allocate.length > 0 ? c.allocate : c.deallocate;
      const direct = await rejection(bridge.send({ cmd, nodeIds }));
      assert(direct instanceof UserError && c.text.test(direct.message), `${cmd}, ${c.label}: ${direct.message}`);
      assertSame(`after ${cmd} with ${c.label}`, await state(bridge, session), s0);
    }
    // A valid batch still works and is undone by the probe. A tree that did
    // change is re-imported by restoreTreeState, which keeps the node set
    // but not PoB's allocNodes iteration order, so the saved node list is
    // compared as a set and the tree URL (the same list, encoded) is left
    // out (the node set is compared through captureSpecState); every other
    // byte of the export must match.
    const ok = await session.simulatePassiveChange(REACHABLE, [someNormal]);
    assert(ok.after.Life !== undefined, 'valid simulate_passive_change returned no stats');
    const sortNodes = (xml: string): string =>
      xml
        .replace(/ nodes="([\d,]*)"/g, (_, list: string) => ` nodes="${list.split(',').map(Number).sort((a, b) => a - b).join(',')}"`)
        .replace(/passive-skill-tree\/[A-Za-z0-9_=-]+/g, 'passive-skill-tree/<url>');
    const afterValid = await state(bridge, session);
    assertSame('after a valid simulate_passive_change', { ...afterValid, xml: sortNodes(afterValid.xml) }, { ...s0, xml: sortNodes(s0.xml) });
    log('PASS: an invalid node anywhere in a batch changes nothing');

    // ---------------------------------------------------------------- 5
    log('Test 5: a probe user error plus a failing skills restore is an internal error naming reset_build');
    // New byte-exact baseline (the node order moved in test 4).
    const s5 = await state(bridge, session);
    const plainErr = await rejection(session.findOptimalLinks('Vortex', 2, [BAD_GEM]));
    assert(plainErr instanceof UserError && !/also failed/.test(plainErr.message), `plain probe error changed: ${plainErr.message}`);
    assert(errorResponse(plainErr).content[0].text === plainErr.message, 'plain probe user error is not shown verbatim');

    corruptSkillsSnapshot = true;
    const bothErr = await rejection(session.findOptimalLinks('Vortex', 2, [BAD_GEM]));
    corruptSkillsSnapshot = false;
    assert(!(bothErr instanceof UserError), `probe + restore failure reported as a user error: ${bothErr.message}`);
    assert(bothErr.message.includes(BAD_GEM), `probe message lost: ${bothErr.message}`);
    assert(/restoring the build afterwards also failed: .*Invalid skills snapshot/.test(bothErr.message), `restore message missing: ${bothErr.message}`);
    assert(bothErr.cause instanceof UserError && bothErr.cause.message.includes(BAD_GEM), 'probe error is not the cause');
    const reply = errorResponse(bothErr).content[0].text;
    assert(reply.startsWith('Internal error: ') && reply.includes('reset_build') && reply.includes(BAD_GEM), `client reply: ${reply}`);
    // The probe's own change was refused before anything moved, so the build is still exact.
    assertSame('after a refused probe with a failing restore', await state(bridge, session), s5);

    corruptSkillsSnapshot = true;
    const upgradesErr = await rejection(session.suggestUpgrades('Ring 1'));
    corruptSkillsSnapshot = false;
    assert(!(upgradesErr instanceof UserError), `suggest_upgrades restore failure is a user error: ${upgradesErr.message}`);
    assert(/Invalid skills snapshot/.test(upgradesErr.message), `suggest_upgrades: ${upgradesErr.message}`);
    const upgradesReply = errorResponse(upgradesErr).content[0].text;
    assert(upgradesReply.startsWith('Internal error: ') && upgradesReply.includes('reset_build'), `suggest_upgrades reply: ${upgradesReply}`);
    // The failed restore may have left the build changed: reload it.
    await session.loadBuild(fieldXml);
    const s5b = await state(bridge, session);
    assert(s5b.skills === s0.skills, 'reloaded test build has different skills');
    await session.suggestUpgrades('Ring 1');
    assertSame('after suggest_upgrades', await state(bridge, session), s5b);
    log('PASS: restore failures keep the probe error and name reset_build');

    // ---------------------------------------------------------------- 6
    log('Test 6: monster-explosion gem settings survive a skills probe; an unrelinkable one is reported');
    const groups = await session.listSkillGroups();
    const explode = groups.find((g) => g.source === 'Explode');
    assert(explode && explode.gems.length > 0, `test build has no explosion group: ${JSON.stringify(groups.map((g) => g.source))}`);
    // The explosion skill has one level, so its quality is the setting changed.
    const explodeLevel = explode.gems[0].level ?? 1;
    await bridge.send({ cmd: 'setGemLevel', groupIndex: explode.index, gemIndex: 1, quality: 7 });
    const s6 = await state(bridge, session);
    assert(/<Gem [^>]*skillId="EnemyExplode"[^>]*>/.exec(s6.xml)?.[0].includes('quality="7"'),
      `the explosion gem quality change did not stick: ${/<Gem [^>]*skillId="EnemyExplode"[^>]*>/.exec(s6.xml)?.[0]}`);
    assert(s6.skills.includes(EXPLODE_KEY), 'explosion gem snapshot carries no source key');
    await session.swapGemWithDiff(MAIN_GROUP, 1, 'Added Cold Damage', 20, 20);
    await session.evaluateGemLevels(explode.index, 1, [explodeLevel + 1]);
    assertSame('after skills probes with a changed explosion gem', await state(bridge, session), s6);
    unknownExplodeSource = true;
    const explodeErr = await rejection(session.swapGemWithDiff(MAIN_GROUP, 1, 'Added Cold Damage', 20, 20));
    unknownExplodeSource = false;
    assertInternal(explodeErr, [/Skills restore was not exact/, /monster-explosion/, /no such source/], 'unrelinkable explosion gem');
    log('PASS: explosion gems are relinked; a lost one is an internal error naming reset_build');

    // ---------------------------------------------------------------- 7
    log('Test 7: a failed rollback of a batch command is an internal error naming reset_build');
    {
      // Rollback succeeds: the user error stays, the tree and group are back.
      const { bridge: b, session: s } = await faultySession(paths, 'batchFailsAfterChange,replaceFailsAfterChange', fieldXml);
      try {
        const t0 = await state(b, s);
        const allocErr = await rejection(b.send({ cmd: 'allocNodes', nodeIds: REACHABLE }));
        assert(allocErr instanceof UserError && /test fault/.test(allocErr.message), `rolled-back batch: ${allocErr.message}`);
        const t1 = await state(b, s);
        assert(JSON.stringify(t1.nodeIds) === JSON.stringify(t0.nodeIds), 'tree not rolled back');
        assert(t1.skills === t0.skills && t1.stats.Life === t0.stats.Life, 'rollback changed something else');
        const replaceErr = await rejection(b.send({ cmd: 'replaceSocketGroup', groupIndex: MAIN_GROUP, gems: [{ name: 'Vortex' }] }));
        assert(replaceErr instanceof UserError && /test fault/.test(replaceErr.message), `rolled-back replace: ${replaceErr.message}`);
        assertSame('after a rolled-back replaceSocketGroup', await state(b, s), t1);
      } finally {
        await b.shutdown();
      }
    }
    {
      const { bridge: b, session: s } = await faultySession(paths, 'batchFailsAfterChange,treeRollbackThrows,replaceFailsAfterChange,replaceRollbackThrows', fieldXml);
      try {
        assertInternal(await rejection(b.send({ cmd: 'allocNodes', nodeIds: REACHABLE })),
          [/test fault: batch failed/, /rolling the passive tree back also failed: test fault: tree rollback threw/], 'throwing tree rollback');
        assertInternal(await rejection(b.send({ cmd: 'deallocNodes', nodeIds: [someNormal] })),
          [/test fault: batch failed/, /rolling the passive tree back also failed/], 'throwing tree rollback (dealloc)');
        assertInternal(await rejection(b.send({ cmd: 'replaceSocketGroup', groupIndex: MAIN_GROUP, gems: [{ name: 'Vortex' }] })),
          [/test fault: replaceSocketGroup failed/, /putting the old gems back also failed: test fault/], 'throwing gem rollback');
        // Through the tool: the probe's restore then fixes the build, but the
        // rollback failure is still an internal error, not a user error.
        assertInternal(await rejection(s.simulatePassiveChange(REACHABLE, [])),
          [/test fault: batch failed/, /rolling the passive tree back also failed/], 'simulate_passive_change');
      } finally {
        await b.shutdown();
      }
    }
    {
      const { bridge: b } = await faultySession(paths, 'batchFailsAfterChange,treeRollbackInexact', fieldXml);
      try {
        assertInternal(await rejection(b.send({ cmd: 'allocNodes', nodeIds: REACHABLE })),
          [/test fault: batch failed/, /rolling the passive tree back also failed: the tree is not as before/, /missingNodeIds/], 'inexact tree rollback');
      } finally {
        await b.shutdown();
      }
    }
    log('PASS: failed or inexact rollbacks are internal errors that keep the original message');

    log('ALL SKILLS RESTORE TESTS PASSED');
  } finally {
    await bridge.shutdown();
  }
}

main().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
