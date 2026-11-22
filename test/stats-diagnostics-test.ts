// Stat keys outside the bridge's default list reach the tools that read them.
//
//   1. diagnose_build's suppression check (SpellSuppressionChance is not a
//      default bridge stat) fires after an amulet adds suppression; the crit
//      and hit checks read their inputs the same way (probe base read).
//   2. suggest_upgrades sorts by priority (highest first): empty slots first,
//      then non-empty slots by descending priority, error rows last.
import { mkdtempSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { BuildSession } from '../src/build-session.js';
import { LuaBridge } from '../src/lua-bridge.js';
import { setupTestEnv } from './_skip.js';

process.env.POB_MCP_CONFIG_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-statsdiag-'));

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const SUPPRESSION_AMULET = `Rarity: RARE
Diag Amulet
Jade Amulet
Item Level: 80
Implicits: 1
+25 to Dexterity
+30% chance to Suppress Spell Damage
+60 to maximum Life`;

async function main(): Promise<void> {
  const { paths, fixturePath } = setupTestEnv();
  const bridge = new LuaBridge(paths, 120_000);
  const session = new BuildSession(bridge);
  try {
    await session.loadBuild(readFileSync(fixturePath, 'utf8'));

    log('Test 1: diagnose_build reads SpellSuppressionChance');
    const before = await session.diagnoseBuild('defense');
    assert(!before.some((c) => /suppression/i.test(c.message)), 'fixture should have no suppression check');
    const base = (await session.probe({ stats: ['SpellSuppressionChance'], variants: [] })).base;
    assert(base.SpellSuppressionChance === 0, `fixture suppression is ${String(base.SpellSuppressionChance)}`);
    await session.equipItem('Amulet', SUPPRESSION_AMULET);
    const after = await session.diagnoseBuild('defense');
    const supp = after.find((c) => /Spell suppression at 30%/.test(c.message));
    assert(supp, `suppression check did not fire: ${JSON.stringify(after.map((c) => c.message))}`);
    log('PASS: suppression check fires');

    log('Test 2: suggest_upgrades sorts by priority');
    await session.unequipItem('Belt');
    const sug = await session.suggestUpgrades();
    assert(sug.length >= 5, `expected several slots, got ${sug.length}`);
    assert(sug[0].empty && sug[0].slot === 'Belt', `empty slot should come first, got ${sug[0].slot}`);
    const measured = sug.filter((s) => !s.empty && s.error === undefined);
    assert(measured.length >= 5, 'expected several measured slots');
    for (let i = 1; i < measured.length; i++) {
      assert(measured[i - 1].priority >= measured[i].priority,
        `not sorted by priority: ${measured.map((s) => `${s.slot}:${s.priority}`).join(', ')}`);
    }
    assert(new Set(measured.map((s) => s.priority)).size > 1, 'priorities should differ between slots');
    log(`PASS: ${measured.map((s) => `${s.slot}:${s.priority}`).join(', ')}`);
  } finally {
    await bridge.dispose();
  }
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  log(`FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
