import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const serverPath = path.resolve(testDir, '..', 'src', 'server.ts');
const fixturePath = path.join(repoRoot, 'spec', 'TestBuilds', '3.13', 'OccVortex.xml');

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function findLuaJIT(): string {
  if (process.env.LUAJIT_PATH) return process.env.LUAJIT_PATH;
  return execFileSync('which', ['luajit'], { encoding: 'utf8' }).trim();
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
  const text = r.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('Expected text content');
  return text;
}

async function main(): Promise<void> {
  const xml = readFileSync(fixturePath, 'utf8');

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverPath],
    env: {
      ...process.env,
      POB_PATH: repoRoot,
      LUAJIT_PATH: findLuaJIT(),
    } as Record<string, string>,
    stderr: 'inherit',
  });

  const client = new Client({ name: 'pob-mcp-test', version: '0.0.0' });

  try {
    log('Connecting MCP client...');
    await client.connect(transport);
    log('Connected');

    log('Listing tools');
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    log(`Tools: ${names.join(', ')}`);
    assert(names.includes('load_build'), 'load_build missing');
    assert(names.includes('get_stats'), 'get_stats missing');
    assert(names.includes('get_skill_breakdown'), 'get_skill_breakdown missing');
    assert(names.includes('list_equipped_items'), 'list_equipped_items missing');

    log('Test 1: load_build (raw XML)');
    const loadResult = await client.callTool({
      name: 'load_build',
      arguments: { source: xml },
    });
    const loadParsed = JSON.parse(extractText(loadResult)) as Record<string, unknown>;
    assert(loadParsed.status === 'loaded', 'expected status loaded');
    assert(loadParsed.class === 'Witch', `expected Witch, got ${loadParsed.class}`);
    log(`PASS: ${loadParsed.class}/${loadParsed.ascendancy}/${loadParsed.level}`);

    log('Test 2: get_stats (all)');
    const statsResult = await client.callTool({
      name: 'get_stats',
      arguments: {},
    });
    const stats = JSON.parse(extractText(statsResult)) as Record<string, Record<string, unknown>>;
    assert(stats.offense, 'offense missing');
    assert(stats.defense, 'defense missing');
    assert(typeof stats.defense.Life === 'number' && (stats.defense.Life as number) > 0, 'Life should be > 0');
    assert(typeof stats.offense.CombinedDPS === 'number' && (stats.offense.CombinedDPS as number) > 0, 'CombinedDPS > 0');
    log(`PASS: Life=${stats.defense.Life}, CombinedDPS=${stats.offense.CombinedDPS}`);

    log('Test 3: get_stats (filtered to defense)');
    const defResult = await client.callTool({
      name: 'get_stats',
      arguments: { categories: ['defense'] },
    });
    const defStats = JSON.parse(extractText(defResult)) as Record<string, Record<string, unknown>>;
    assert(Object.keys(defStats).length === 1 && defStats.defense, 'expected only defense');
    log(`PASS: ${Object.keys(defStats.defense).length} defense stats`);

    log('Test 4: get_skill_breakdown (main)');
    const skillResult = await client.callTool({
      name: 'get_skill_breakdown',
      arguments: {},
    });
    const skill = JSON.parse(extractText(skillResult)) as {
      isMainGroup: boolean;
      gems: unknown[];
      activeGem?: { nameSpec?: string };
    };
    assert(skill.isMainGroup === true, 'expected main group');
    assert(Array.isArray(skill.gems) && skill.gems.length > 0, 'expected gems');
    log(`PASS: main skill = ${skill.activeGem?.nameSpec ?? '(unknown)'}, ${skill.gems.length} gems`);

    log('Test 5: list_equipped_items');
    const itemsResult = await client.callTool({
      name: 'list_equipped_items',
      arguments: {},
    });
    const items = JSON.parse(extractText(itemsResult)) as {
      count: number;
      items: Array<{ slot: string; rarity?: string; baseName?: string }>;
    };
    assert(items.count > 0, 'expected at least one equipped item');
    const slots = new Set(items.items.map((i) => i.slot));
    for (const expected of ['Weapon 1', 'Body Armour', 'Helmet', 'Boots', 'Ring 1', 'Ring 2']) {
      assert(slots.has(expected), `missing slot ${expected}`);
    }
    log(`PASS: ${items.count} items across ${slots.size} slots`);

    log('Test 6: load_build with invalid input (error path)');
    const badResult = await client.callTool({
      name: 'load_build',
      arguments: { source: '<not-valid>' },
    });
    const bad = badResult as { isError?: boolean; content?: ToolTextContent[] };
    assert(bad.isError === true, 'expected error response');
    log(`PASS: error reported = ${bad.content?.[0]?.text}`);

    log('Test 7: build code round-trip via load_build');
    const { deflateRawSync } = await import('zlib');
    const code = deflateRawSync(Buffer.from(xml, 'utf8'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const codeResult = await client.callTool({
      name: 'load_build',
      arguments: { source: code },
    });
    const codeParsed = JSON.parse(extractText(codeResult)) as { class?: string };
    assert(codeParsed.class === 'Witch', 'build code load failed');
    log('PASS: build code load');
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
}

main()
  .then(() => {
    log('ALL MCP TESTS PASSED');
    process.exit(0);
  })
  .catch((error: unknown) => {
    log(`FAILED: ${error instanceof Error ? error.stack : error}`);
    process.exit(1);
  });
