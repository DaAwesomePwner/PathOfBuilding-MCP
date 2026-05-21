import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupTestEnv } from './_skip.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'src', 'server.ts');

const ALT_RING_RAW = `Rarity: RARE
Test Ring Variant
Coral Ring
Unique ID: efc86ac7b5df717bfdbaea47dd45f77c40526efae46a3900b62c776bb4d6e161
Item Level: 63
LevelReq: 64
Implicits: 1
+30 to maximum Life
+150 to maximum Life
+50 to maximum Mana
+30% to all Elemental Resistances`;

const ALT_RING_2 = `Rarity: RARE
Other Ring Variant
Iron Ring
Unique ID: efc86ac7b5df717bfdbaea47dd45f77c40526efae46a3900b62c776bb4d6e162
Item Level: 50
LevelReq: 50
Implicits: 1
Adds 1 to 4 Physical Damage to Attacks
+30 to Strength
+30 to Dexterity
+30 to Intelligence`;

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

function approxEq(a: unknown, b: unknown, tol = 1e-4): boolean {
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

  const client = new Client({ name: 'phase3-test', version: '0.0.0' });

  try {
    log('Connecting...');
    await client.connect(transport);
    log('Connected');

    log('Listing tools');
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const expected of [
      'load_build', 'get_stats', 'get_skill_breakdown', 'list_equipped_items',
      'list_valid_slots', 'get_item_in_slot', 'swap_item', 'unequip_item',
      'compare_items', 'undo_last_change',
    ]) {
      assert(tools.includes(expected), `missing tool ${expected}`);
    }
    log(`PASS: ${tools.length} tools registered`);

    log('Loading build');
    await call(client, 'load_build', { source: xml });
    const baseline = await getKeyStats(client);
    log(`Baseline: Life=${baseline.Life}, DPS=${baseline.CombinedDPS}`);

    log('Test 1: list_valid_slots');
    const slotsResp = JSON.parse(extractText(await call(client, 'list_valid_slots'))) as {
      count: number;
      slots: Array<{ slot: string; occupied: boolean }>;
    };
    assert(slotsResp.count > 10, `expected many slots, got ${slotsResp.count}`);
    const ring1 = slotsResp.slots.find((s) => s.slot === 'Ring 1');
    assert(ring1 && ring1.occupied, 'Ring 1 should be occupied');
    log(`PASS: ${slotsResp.count} slots, Ring 1 occupied=${ring1?.occupied}`);

    log('Test 2: get_item_in_slot (occupied)');
    const itemResp = JSON.parse(extractText(await call(client, 'get_item_in_slot', { slot: 'Ring 1' }))) as {
      empty: boolean;
      item: { raw: string; baseName?: string } | null;
    };
    assert(!itemResp.empty && itemResp.item?.raw, 'Ring 1 item should have raw text');
    log(`PASS: ${itemResp.item?.baseName}`);

    log('Test 3: get_item_in_slot (empty Weapon 1 Swap)');
    const emptyResp = JSON.parse(extractText(await call(client, 'get_item_in_slot', { slot: 'Weapon 1 Swap' }))) as {
      empty: boolean;
      item: unknown;
    };
    assert(emptyResp.empty === true && emptyResp.item === null, 'Weapon 1 Swap should be empty');
    log('PASS: empty slot reported correctly');

    log('Test 4: swap_item + undo round-trip');
    const swapResp = JSON.parse(extractText(await call(client, 'swap_item', { slot: 'Ring 1', itemText: ALT_RING_RAW }))) as {
      keyDeltas: { Life: number };
    };
    assert(Math.abs(swapResp.keyDeltas.Life) > 0, 'Life should have changed');
    const afterSwap = await getKeyStats(client);
    assert(!approxEq(afterSwap.Life, baseline.Life), 'Life should differ after swap');
    log(`After swap: Life=${afterSwap.Life} (delta=${swapResp.keyDeltas.Life})`);

    const undoResp = JSON.parse(extractText(await call(client, 'undo_last_change'))) as {
      status: string;
    };
    assert(undoResp.status === 'reverted', 'undo should report reverted');
    const afterUndo = await getKeyStats(client);
    assert(approxEq(afterUndo.Life, baseline.Life), `Life should restore to ${baseline.Life}, got ${afterUndo.Life}`);
    log('PASS: swap_item + undo round-trip');

    log('Test 5: unequip_item + undo');
    const unequipResp = JSON.parse(extractText(await call(client, 'unequip_item', { slot: 'Ring 1' }))) as {
      keyDeltas: { Life: number };
    };
    assert(unequipResp.keyDeltas.Life < 0, 'unequipping a life ring should reduce Life');
    const afterUnequip = await getKeyStats(client);
    assert(afterUnequip.Life < baseline.Life, 'Life should drop after unequip');
    await call(client, 'undo_last_change');
    const afterUndo2 = await getKeyStats(client);
    assert(approxEq(afterUndo2.Life, baseline.Life), 'Life should restore after undo');
    log('PASS: unequip_item + undo');

    log('Test 6: compare_items (3 candidates)');
    const compareResp = JSON.parse(
      extractText(
        await call(client, 'compare_items', {
          slot: 'Ring 1',
          items: [ALT_RING_RAW, ALT_RING_2, itemResp.item!.raw],
        }),
      ),
    ) as {
      candidates: Array<{ index: number; error: string | null; keyDeltas: { Life: number; CombinedDPS: number } | null }>;
      bestForLife: number | null;
    };
    assert(compareResp.candidates.length === 3, 'should have 3 candidates');
    assert(compareResp.candidates.every((c) => c.error === null), 'no candidate should error');
    const lives = compareResp.candidates.map((c) => c.keyDeltas!.Life);
    assert(new Set(lives).size > 1, `candidates should differ; lives=${JSON.stringify(lives)}`);
    log(`PASS: bestForLife=${compareResp.bestForLife}, deltas=${JSON.stringify(lives)}`);

    log('Test 7: state integrity after compare_items');
    const afterCompare = await getKeyStats(client);
    assert(
      approxEq(afterCompare.Life, baseline.Life)
        && approxEq(afterCompare.CombinedDPS, baseline.CombinedDPS, 1e-3),
      `state should match baseline after compare_items: ${JSON.stringify({ baseline, afterCompare })}`,
    );
    log('PASS: build state restored exactly');

    log('Test 8: invalid slot name');
    const badSlotResp = await call(client, 'swap_item', { slot: 'Nonexistent', itemText: ALT_RING_RAW });
    assert(isError(badSlotResp), 'invalid slot should error cleanly');
    log(`PASS: ${(badSlotResp as { content: ToolTextContent[] }).content[0].text}`);

    log('Test 9: state integrity after invalid slot');
    const afterBad = await getKeyStats(client);
    assert(
      approxEq(afterBad.Life, baseline.Life),
      'state should be unaffected by errored swap_item',
    );
    log('PASS: state unaffected');

    log('Test 10: malformed item text');
    const malformedResp = await call(client, 'swap_item', { slot: 'Ring 1', itemText: 'this is not a valid item' });
    assert(isError(malformedResp), 'malformed item should error');
    const afterMalformed = await getKeyStats(client);
    assert(approxEq(afterMalformed.Life, baseline.Life), 'state must remain after malformed swap');
    log('PASS: malformed item rejected, state preserved');

    log('Test 11: compare_items with one bad candidate');
    const mixedResp = JSON.parse(
      extractText(
        await call(client, 'compare_items', {
          slot: 'Ring 1',
          items: [ALT_RING_RAW, 'completely garbage'],
        }),
      ),
    ) as {
      candidates: Array<{ error: string | null }>;
    };
    assert(mixedResp.candidates[0].error === null, 'first candidate should succeed');
    assert(mixedResp.candidates[1].error !== null, 'second candidate should report error');
    const afterMixed = await getKeyStats(client);
    assert(approxEq(afterMixed.Life, baseline.Life), 'state should be restored after partially-bad compare');
    log('PASS: partially-failed compare restored state');
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

main()
  .then(() => {
    log('ALL PHASE 3 TESTS PASSED');
    process.exit(0);
  })
  .catch((error: unknown) => {
    log(`FAILED: ${error instanceof Error ? error.stack : error}`);
    process.exit(1);
  });
