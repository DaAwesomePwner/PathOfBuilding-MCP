/**
 * Jewel sockets over MCP: list_valid_slots lists abyssal sockets only where the
 * parent's item has them (with parentSlot) and every passive-tree socket with
 * `allocated`; list_equipped_items lists abyss jewels with parentSlot and a
 * jewel in an unallocated tree socket with allocated: false. What-ifs into an
 * unallocated tree socket (compare_items, evaluate_changes, apply_changes) are
 * refused before any change unless the variant allocates the socket, and a
 * variant whose deallocation removes the socket is refused; swap_item still
 * equips there with a note. A socket inside a cluster jewel's subgraph behaves
 * the same once allocated (compare, evaluate, trade search); before a cluster
 * jewel adds it, it is marked requiresClusterIn and refusals say to socket one.
 * Variants that change the cluster jewel or several nodes are checked after
 * applying; suggest_upgrades gets weighted mods for a tree socket.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupTestEnv } from './_skip.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'src', 'server.ts');

const STYGIAN_VISE = `Rarity: RARE
Test Vise
Stygian Vise
Item Level: 80
Implicits: 1
Has 1 Abyssal Socket
+80 to maximum Life`;
const ABYSS_EYE = `Rarity: RARE
Test Eye
Murderous Eye Jewel
Item Level: 80
Implicits: 0
+40 to maximum Life
+10% to Fire Resistance`;
const ABYSS_EYE_2 = `Rarity: RARE
Other Eye
Murderous Eye Jewel
Item Level: 80
Implicits: 0
+20 to maximum Life`;
const COBALT_A = `Rarity: RARE
Test Cobalt
Cobalt Jewel
Item Level: 80
Implicits: 0
+30 to maximum Life
6% increased maximum Life`;
const COBALT_B = `Rarity: RARE
Other Cobalt
Cobalt Jewel
Item Level: 80
Implicits: 0
4% increased maximum Life`;
/** Voices with one small passive: a Large Cluster Jewel adding three Medium Jewel Sockets (10532, 23756, 46519 under 2491). */
const VOICES = `Rarity: UNIQUE
Voices
Large Cluster Jewel
Variant: Adds 1 Small Passive Skill
Variant: Adds 3 Small Passive Skills
Variant: Adds 5 Small Passive Skills
Variant: Adds 7 Small Passive Skills
Selected Variant: 1
Implicits: 0
Adds 3 Jewel Socket Passive Skills
{variant:1}Adds 1 Small Passive Skill which grants nothing
{variant:2}Adds 3 Small Passive Skills which grant nothing
{variant:3}Adds 5 Small Passive Skills which grant nothing
{variant:4}Adds 7 Small Passive Skills which grant nothing`;
const UNALLOCATED = 'Jewel 26725';
const ALLOCATED = 'Jewel 36634';
const LARGE_SOCKET = 2491;
const INNER_SOCKET = 10532;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface ToolResp { content?: Array<{ type: string; text: string }>; isError?: boolean }
interface SlotInfo { slot: string; occupied: boolean; itemName?: string; parentSlot?: string; allocated?: boolean; requiresClusterIn?: string }
interface Equipped { slot: string; title?: string; parentSlot?: string; allocated?: boolean; note?: string }
interface Candidate { index: number; error: string | null; keyDeltas: Record<string, number> | null }
interface EvalResult { index: number; error?: string; userError?: boolean; delta?: Record<string, number>; fallback?: boolean }

let client: Client;
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResp> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as ToolResp;
}
const text = (r: ToolResp) => r.content?.[0]?.text ?? '';
async function ok<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await call(name, args);
  assert(!r.isError, `${name} failed: ${text(r)}`);
  return JSON.parse(text(r)) as T;
}
async function userError(name: string, args: Record<string, unknown>, expect: RegExp): Promise<void> {
  const r = await call(name, args);
  assert(r.isError, `${name} ${JSON.stringify(args).slice(0, 120)} should fail`);
  assert(!text(r).startsWith('Internal error'), `expected a user error, got: ${text(r)}`);
  assert(expect.test(text(r)), `error text ${JSON.stringify(text(r))} should match ${expect}`);
}
async function exportXml(): Promise<string> {
  const r = await call('export_build', { format: 'xml' });
  assert(!r.isError, `export_build failed: ${text(r)}`);
  return text(r);
}
const slots = async () => (await ok<{ slots: SlotInfo[] }>('list_valid_slots')).slots;
const equipped = async (detail?: 'full') => (await ok<{ items: Equipped[] }>('list_equipped_items', detail ? { detail } : {})).items;
const evaluate = async (variants: Record<string, unknown>[]) =>
  (await ok<{ results: EvalResult[] }>('evaluate_changes', { variants, rankBy: 'Life' })).results.sort((a, b) => a.index - b.index);

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-jewels-'));
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverPath],
    env: { ...process.env, POB_PATH: paths.pobPath, LUAJIT_PATH: paths.luajitPath, POB_MCP_CONFIG_DIR: configDir } as Record<string, string>,
    stderr: 'ignore',
  });
  client = new Client({ name: 'pob-mcp-jewel-sockets-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    await ok('load_build', { source: readFileSync(fixturePath, 'utf8') });

    log('Test 1: list_valid_slots marks tree sockets and lists only abyssal sockets the item has');
    const initial = await slots();
    const jewels = initial.filter((s) => /^Jewel \d+$/.test(s.slot));
    assert(jewels.length > 20 && jewels.every((s) => typeof s.allocated === 'boolean'), 'every tree socket has allocated');
    assert(jewels.find((s) => s.slot === ALLOCATED)?.allocated === true, `${ALLOCATED} is allocated`);
    assert(jewels.find((s) => s.slot === UNALLOCATED)?.allocated === false, `${UNALLOCATED} is not allocated`);
    assert(initial.filter((s) => !/^Jewel /.test(s.slot)).every((s) => s.allocated === undefined && s.parentSlot === undefined),
      'gear slots carry neither allocated nor parentSlot');
    assert(!initial.some((s) => /Abyssal Socket/.test(s.slot)), 'no item of the fixture has an abyssal socket');
    log('PASS');

    log('Test 1b: a socket a cluster jewel would add (no cluster jewel in its parent socket yet)');
    const inner = `Jewel ${INNER_SOCKET}`;
    const absent = initial.find((s) => s.slot === inner);
    assert(absent?.allocated === false && absent.requiresClusterIn === `Jewel ${LARGE_SOCKET}`, `marked: ${JSON.stringify(absent)}`);
    assert(jewels.find((s) => s.slot === UNALLOCATED)?.requiresClusterIn === undefined, 'base tree sockets carry no requiresClusterIn');
    const clusterFirst = /no cluster jewel in Jewel 2491 adds it: socket a cluster jewel with jewel sockets in Jewel 2491 \(swap_item\), then allocate node 10532 \(allocate_nodes\)/;
    await userError('compare_items', { slot: inner, items: [COBALT_A, COBALT_B] }, clusterFirst);
    await userError('generate_trade_search', { slot: inner, league: 'Standard' }, clusterFirst);
    const [absentVariant] = await evaluate([{ items: [{ slot: inner, itemText: COBALT_A }] }]);
    assert(absentVariant.userError === true && clusterFirst.test(absentVariant.error ?? '') && !/same variant/.test(absentVariant.error ?? ''),
      `variant into a socket not on the tree: ${JSON.stringify(absentVariant)}`);
    log('PASS');

    log('Test 2: an abyssal socket appears with its item, and its abyss jewel is listed with parentSlot');
    await ok('swap_item', { slot: 'Belt', itemText: STYGIAN_VISE });
    const withVise = await slots();
    const socket = withVise.find((s) => s.slot === 'Belt Abyssal Socket 1');
    assert(socket && socket.parentSlot === 'Belt' && socket.occupied === false && socket.allocated === undefined, `socket listed: ${JSON.stringify(socket)}`);
    assert(!withVise.some((s) => s.slot === 'Belt Abyssal Socket 2'), 'only as many sockets as the item has');
    assert(withVise.findIndex((s) => s.slot === 'Belt Abyssal Socket 1') === withVise.findIndex((s) => s.slot === 'Belt') + 1, 'listed after its parent');
    const eyeSwap = await ok<{ keyDeltas: Record<string, number>; note?: string }>('swap_item', { slot: 'Belt Abyssal Socket 1', itemText: ABYSS_EYE });
    assert(eyeSwap.keyDeltas.Life > 0 && eyeSwap.note === undefined, `abyss jewel counts: ${JSON.stringify(eyeSwap)}`);
    for (const items of [await equipped(), await equipped('full')]) {
      const eye = items.find((i) => i.slot === 'Belt Abyssal Socket 1');
      assert(eye?.title === 'Test Eye' && eye.parentSlot === 'Belt' && eye.allocated === undefined, `abyss jewel listed: ${JSON.stringify(eye)?.slice(0, 200)}`);
    }
    assert((await slots()).find((s) => s.slot === 'Belt Abyssal Socket 1')?.occupied === true, 'socket now occupied');
    const cmp = await ok<{ candidates: Candidate[] }>('compare_items', { slot: 'Belt Abyssal Socket 1', items: [ABYSS_EYE_2, ABYSS_EYE] });
    assert(cmp.candidates[0].error === null && cmp.candidates[0].keyDeltas!.Life < 0 && cmp.candidates[1].keyDeltas!.Life === 0,
      `compare_items in an abyssal socket: ${JSON.stringify(cmp.candidates.map((c) => c.keyDeltas))}`);
    // A socket the item lacks: each candidate does not fit (per-candidate errors, as for any misfit).
    const missing = await ok<{ candidates: Candidate[] }>('compare_items', { slot: 'Belt Abyssal Socket 2', items: [ABYSS_EYE, ABYSS_EYE_2] });
    assert(missing.candidates.every((c) => /the item in Belt has 1 abyssal socket\(s\)/.test(c.error ?? '')), `missing socket: ${JSON.stringify(missing.candidates)}`);
    log('PASS');

    log('Test 3: what-ifs into an unallocated tree socket are refused before any change');
    const before = await exportXml();
    await userError('compare_items', { slot: UNALLOCATED, items: [COBALT_A, COBALT_B] },
      /Jewel 26725 is an unallocated passive tree jewel socket.*Allocate node 26725 first \(allocate_nodes\)/);
    const [refused, allocatedHere, unequipOk] = await evaluate([
      { items: [{ slot: UNALLOCATED, itemText: COBALT_A }] },
      { allocate: [26725], items: [{ slot: UNALLOCATED, itemText: COBALT_A }] },
      { items: [{ slot: UNALLOCATED, unequip: true }] },
    ]);
    assert(refused.userError === true && /unallocated passive tree jewel socket.*or allocate it in the same variant/.test(refused.error ?? ''),
      `variant refused: ${JSON.stringify(refused)}`);
    assert(allocatedHere.error === undefined && (allocatedHere.delta?.Life ?? 0) > 0, `allocating the socket in the variant counts the jewel: ${JSON.stringify(allocatedHere)}`);
    assert(unequipOk.error === undefined, `emptying the socket is not refused: ${JSON.stringify(unequipOk)}`);
    const [dealloc] = await evaluate([{ deallocate: [36634], items: [{ slot: ALLOCATED, itemText: COBALT_A }] }]);
    assert(dealloc.userError === true && /Deallocating 36634 .*also deallocates the jewel socket of Jewel 36634/.test(dealloc.error ?? ''),
      `a variant removing the socket is refused: ${JSON.stringify(dealloc)}`);
    await userError('apply_changes', { variant: { items: [{ slot: UNALLOCATED, itemText: COBALT_A }] } }, /unallocated passive tree jewel socket/);
    assert((await exportXml()) === before, 'refused what-ifs changed the build');
    assert(!(await call('undo_last_change')).isError, 'undo the abyss jewel swap (the refusals pushed nothing)');
    assert(!(await equipped()).some((i) => i.slot === 'Belt Abyssal Socket 1'), 'the last undo entry was the abyss jewel swap');
    log('PASS');

    log('Test 4: swap_item into an unallocated socket equips with a note');
    const noted = await ok<{ keyDeltas: Record<string, number>; note?: string }>('swap_item', { slot: UNALLOCATED, itemText: COBALT_A });
    assert(/socket is not allocated.*Allocate node 26725 first \(allocate_nodes\)/.test(noted.note ?? ''), `note: ${noted.note}`);
    assert(noted.keyDeltas.Life === 0 && noted.keyDeltas.CombinedDPS === 0, 'the jewel counts for nothing');
    const idle = (await equipped()).find((i) => i.slot === UNALLOCATED);
    assert(idle?.allocated === false && /not allocated.*Allocate node 26725 first/.test(idle.note ?? ''), `listed as unallocated: ${JSON.stringify(idle)?.slice(0, 300)}`);
    assert((await equipped()).find((i) => i.slot === ALLOCATED)?.allocated === undefined, 'jewels in allocated sockets carry no flag');
    const allocate = await ok<{ keyDeltas: Record<string, number> }>('allocate_nodes', { nodes: [26725] });
    assert(allocate.keyDeltas.Life > 0, 'allocating the socket turns the jewel on');
    const live = (await equipped()).find((i) => i.slot === UNALLOCATED);
    assert(live && live.allocated === undefined && live.note === undefined, 'no flag once allocated');
    log('PASS');

    log('Test 5: a socket inside a cluster jewel subgraph');
    await ok('allocate_nodes', { nodes: [LARGE_SOCKET] });
    await ok('swap_item', { slot: `Jewel ${LARGE_SOCKET}`, itemText: VOICES });
    const builtInner = (await slots()).find((s) => s.slot === inner);
    assert(builtInner?.allocated === false && builtInner.requiresClusterIn === undefined,
      `the cluster's socket is on the tree, unallocated: ${JSON.stringify(builtInner)}`);
    await userError('compare_items', { slot: inner, items: [COBALT_A, COBALT_B] }, /unallocated passive tree jewel socket/);
    const [viaVariant] = await evaluate([{ allocate: [INNER_SOCKET], items: [{ slot: inner, itemText: COBALT_A }] }]);
    assert(viaVariant.error === undefined && (viaVariant.delta?.Life ?? 0) > 0, `allocated in the variant: ${JSON.stringify(viaVariant)}`);
    await ok('allocate_nodes', { nodes: [INNER_SOCKET] });
    assert((await slots()).find((s) => s.slot === inner)?.allocated === true, 'allocated after allocate_nodes');
    const innerCmp = await ok<{ candidates: Candidate[] }>('compare_items', { slot: inner, items: [COBALT_A, COBALT_B] });
    assert(innerCmp.candidates.every((c) => c.error === null && c.keyDeltas!.Life > 0), `compare in the cluster socket: ${JSON.stringify(innerCmp.candidates)}`);
    const [inVariant] = await evaluate([{ items: [{ slot: inner, itemText: COBALT_A }] }]);
    assert(inVariant.fallback === true && inVariant.delta?.Life === innerCmp.candidates[0].keyDeltas!.Life,
      `evaluate_changes matches compare_items: ${JSON.stringify(inVariant)}`);
    const [cut] = await evaluate([{ deallocate: [LARGE_SOCKET], items: [{ slot: inner, itemText: COBALT_A }] }]);
    assert(cut.userError === true && /Deallocating 2491/.test(cut.error ?? ''), `removing the cluster's socket: ${JSON.stringify(cut)}`);
    const trade = await ok<{ itemCategory: string; filters: { weight: number }[] }>('generate_trade_search', { slot: inner, league: 'Standard' });
    assert(trade.itemCategory === 'BaseJewel' && trade.filters.filter((f) => f.weight > 0).length >= 5, `trade search in the cluster socket: ${trade.itemCategory}`);
    log('PASS');

    log('Test 6: variants decided after applying (another cluster jewel in the parent socket, deallocation + allocation)');
    const beforeSwap = await exportXml();
    const swapOut = { items: [{ slot: `Jewel ${LARGE_SOCKET}`, itemText: COBALT_B }, { slot: inner, itemText: COBALT_A }] };
    const [swapped] = await evaluate([swapOut]);
    assert(swapped.userError === true
      && /After this variant's changes Jewel 10532 is not on the passive tree: no cluster jewel in Jewel 2491 adds that socket/.test(swapped.error ?? ''),
      `replacing the cluster jewel while filling its socket: ${JSON.stringify(swapped)}`);
    await userError('apply_changes', { variant: swapOut }, /After this variant's changes Jewel 10532 is not on the passive tree/);
    assert((await exportXml()) === beforeSwap, 'the refused apply_changes was rolled back');
    // Deallocating one socket and allocating another (two node changes) is decided after applying; the inner socket stays allocated.
    const [mixed] = await evaluate([{ deallocate: [26725], allocate: [23756], items: [{ slot: inner, itemText: COBALT_B }] }]);
    assert(mixed.error === undefined && mixed.fallback === true, `a deallocation + allocation variant keeping the socket: ${JSON.stringify(mixed)}`);
    assert((await exportXml()) === beforeSwap, 'evaluate_changes changed the build');
    log('PASS');

    log('Test 7: suggest_upgrades for a tree socket gets PoB-weighted mods');
    const upgrades = await ok<{ suggestions: { slot: string; suggestedMods?: { mod: string; weight: number }[]; modsError?: string }[] }>(
      'suggest_upgrades', { slot: ALLOCATED });
    const forJewel = upgrades.suggestions.find((s) => s.slot === ALLOCATED);
    assert(forJewel && forJewel.modsError === undefined && (forJewel.suggestedMods?.length ?? 0) > 0 && forJewel.suggestedMods!.every((m) => m.weight > 0),
      `suggestedMods for ${ALLOCATED}: ${JSON.stringify(forJewel)?.slice(0, 300)}`);
    log('PASS');
    log('ALL JEWEL SOCKET TESTS PASSED');
  } finally {
    await client.close().catch(() => undefined);
    rmSync(configDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
