// Stat keys outside the bridge's default list reach the tools that read them.
//
//   1. diagnose_build's suppression check (SpellSuppressionChance is not a
//      default bridge stat) fires after an amulet adds suppression; the crit
//      and hit checks read their inputs the same way (probe base read).
//   1b. The crit check fires after a committed custom modifier lifts CritChance
//      into 5-40% (no Resolute Technique) and is gone after undo; the hit check
//      fires on an attack setup (Cleave with a sword) whose HitChance is under
//      95%, which the old default stat list never exposed (HitChance read as 100).
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

const MAIN_GROUP = 5; // Body Armour: Vortex

const SWORD = `Rarity: RARE
Diag Sword
Corroded Blade
Item Level: 80
+10 to Strength`;

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

    log('Test 3: crit check reads CritChance');
    const critKey = async (): Promise<number> => Number((await session.probe({ stats: ['CritChance'], variants: [] })).base.CritChance);
    const critBefore = await critKey();
    assert(critBefore < 5, `fixture crit should be under 5%, got ${critBefore}`);
    assert(!(await session.diagnoseBuild('offense')).some((c) => /crit chance/i.test(c.message)), 'crit warning before the change');
    await session.setConfigWithUndo({ customMods: '+30% to Critical Strike Chance' });
    const critAfter = await critKey();
    assert(critAfter > 5 && critAfter < 40, `custom mod should lift crit into 5-40%, got ${critAfter}`);
    const critChecks = await session.diagnoseBuild('offense');
    assert(critChecks.some((c) => c.message.startsWith(`Low crit chance (${critAfter.toFixed(1)}%)`)),
      `crit warning missing: ${JSON.stringify(critChecks.map((c) => c.message))}`);
    await session.undoLastChange();
    assert(!(await session.diagnoseBuild('offense')).some((c) => /crit chance/i.test(c.message)), 'crit warning after undo');
    log(`PASS: crit warning at ${critAfter}%, gone after undo`);

    log('Test 4: hit check reads HitChance');
    assert(!(await session.diagnoseBuild('offense')).some((c) => /hit chance/i.test(c.message)), 'hit warning on the spell build');
    await session.resetBuild();
    await session.equipItem('Weapon 1', SWORD);
    await bridge.send({ cmd: 'replaceSocketGroup', groupIndex: MAIN_GROUP, gems: [{ name: 'Cleave', level: 20, quality: 0 }] });
    const hit = Number((await session.probe({ stats: ['HitChance'], variants: [] })).base.HitChance);
    assert(hit > 0 && hit < 95, `Cleave with a sword should have under 95% hit chance, got ${hit}`);
    const hitChecks = await session.diagnoseBuild('offense');
    assert(hitChecks.some((c) => c.message === `Low hit chance (${hit.toFixed(0)}%)`),
      `hit warning missing: ${JSON.stringify(hitChecks.map((c) => c.message))}`);
    await session.resetBuild();
    log(`PASS: hit warning at ${hit}%`);
  } finally {
    await bridge.dispose();
  }
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  log(`FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
