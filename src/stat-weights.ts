// stat_weights: what each mod line is worth to the build. Every line is
// added on its own, as PoB's "Custom modifiers" box adds it, through the
// probe engine (a calculator variant with `modLines`, lua/probe.lua): the
// existing custom modifiers stay, nothing is applied to the build and nothing
// is pushed to undo. Lines PoB's mod parser cannot use are reported, never
// shown as worth zero.
//
// Also: the suggested mods of suggest_upgrades, read from PoB's own weighted
// trade query for a slot (topTradeMods).

import { z } from 'zod';
import type { BuildSession } from './build-session.js';
import { roundStat } from './evaluate-changes.js';
import type { Stats } from './lua-bridge.js';
import type { ToolRegistrar } from './tool-registry.js';
import type { TradeQueryRaw } from './trade-search.js';
import { UserError } from './validation.js';

/**
 * A generic pack of single-roll item lines (offence, defence, sustain), each
 * one PoB's mod parser reads. Values are typical single rolls, so lines can be
 * compared with each other.
 */
export const DEFAULT_STAT_WEIGHT_MODS = [
  // Life, mana, energy shield
  '+50 to maximum Life',
  '10% increased maximum Life',
  '+50 to maximum Energy Shield',
  '10% increased maximum Energy Shield',
  '+50 to maximum Mana',
  // Resistances and mitigation
  '+10% to all Elemental Resistances',
  '+1% to all maximum Elemental Resistances',
  '+20% to Chaos Resistance',
  '+500 to Armour',
  '+500 to Evasion Rating',
  '+10% chance to Suppress Spell Damage',
  '+5% Chance to Block Attack Damage',
  // Sustain
  'Regenerate 1% of Life per second',
  '+1 to Maximum Endurance Charges',
  // Damage
  '10% increased Damage',
  '10% increased Spell Damage',
  '10% increased Attack Damage',
  '10% increased Elemental Damage',
  '10% increased Physical Damage',
  '10% increased Fire Damage',
  '10% increased Cold Damage',
  '10% increased Lightning Damage',
  '10% increased Chaos Damage',
  '+10% to Damage over Time Multiplier',
  'Damage Penetrates 5% of Enemy Elemental Resistances',
  'Minions deal 10% increased Damage',
  // Critical strikes, speed, charges, gems
  '+1% to Critical Strike Chance',
  '30% increased Critical Strike Chance',
  '+20% to Critical Strike Multiplier',
  '10% increased Attack Speed',
  '10% increased Cast Speed',
  '+1 to Maximum Power Charges',
  '+1 to Maximum Frenzy Charges',
  '+1 to Level of all Skill Gems',
  // Attributes
  '+30 to Strength',
  '+30 to Dexterity',
  '+30 to Intelligence',
];

export const DEFAULT_STAT_WEIGHT_STATS = ['CombinedDPS', 'TotalEHP', 'Life', 'EnergyShield', 'Mana'];
export const MAX_STAT_WEIGHT_MODS = 200;
export const MAX_STAT_WEIGHT_STATS = 20;
export const MAX_MOD_LINE_LENGTH = 300;

export interface StatWeightsInput {
  mods?: string[];
  stats?: string[];
  rankBy?: string;
}

/** What the bridge says about one mod line (`probe` with `parseModLines`). */
export interface ModLineCheck {
  ok: boolean;
  /** Modifiers the line parses to. */
  mods?: number;
  /** Why PoB cannot use the line. */
  reason?: string;
}

export interface StatWeightRow {
  mod: string;
  /** Stat change with the line added, per requested stat (null when the stat is not a number). */
  delta: Record<string, number | null>;
  /** The change in % of the base (null when the base is 0 or not a number). */
  pct: Record<string, number | null>;
}

export interface StatWeightsResult {
  rankBy: string;
  base: Stats;
  /** Ranked by delta[rankBy], highest first; ties keep the input order. */
  weights: StatWeightRow[];
  /** Lines PoB's mod parser cannot use (they would do nothing in its Custom modifiers box). */
  unparsed: { mod: string; reason: string }[];
  /** Lines the probe refused or could not evaluate. */
  failed?: { mod: string; error: string }[];
  /** Requested stats the engine does not report (left out of delta / pct). */
  unknownStats?: string[];
}

function cleanLines(mods: string[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const raw of mods) {
    const line = raw.trim();
    if (line === '') throw new UserError('mods must not contain empty lines');
    if (/[\r\n]/.test(line)) throw new UserError(`each entry of mods must be one line: ${JSON.stringify(raw)}`);
    if (line.length > MAX_MOD_LINE_LENGTH) throw new UserError(`mod line longer than ${MAX_MOD_LINE_LENGTH} characters: ${line.slice(0, 40)}...`);
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }
  return lines;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Evaluate every line on its own (one probe call, ~5 ms a line) and rank them
 * by the rankBy stat's change. Values are not rounded (the tool rounds them).
 */
export async function computeStatWeights(session: BuildSession, input: StatWeightsInput): Promise<StatWeightsResult> {
  const lines = cleanLines(input.mods && input.mods.length > 0 ? input.mods : DEFAULT_STAT_WEIGHT_MODS);
  const rankBy = input.rankBy ?? 'CombinedDPS';
  const requested = [...new Set(input.stats && input.stats.length > 0 ? input.stats : DEFAULT_STAT_WEIGHT_STATS)];
  if (!requested.includes(rankBy)) requested.unshift(rankBy);

  const { checks, probe } = await session.probeModLines(lines, requested);
  const unknownStats = requested.filter((k) => num(probe.base[k]) === null && typeof probe.base[k] !== 'boolean');
  if (unknownStats.includes(rankBy)) {
    throw new UserError(`rankBy stat "${rankBy}" is not a stat the engine reports as a number (see get_stats for names)`);
  }
  const keys = requested.filter((k) => !unknownStats.includes(k));

  const weights: Array<StatWeightRow & { order: number; rank: number }> = [];
  const unparsed: StatWeightsResult['unparsed'] = [];
  const failed: NonNullable<StatWeightsResult['failed']> = [];
  let next = 0;
  lines.forEach((mod, i) => {
    const check = checks[i];
    if (!check?.ok) {
      unparsed.push({ mod, reason: check?.reason ?? 'not recognised by Path of Building\'s mod parser' });
      return;
    }
    const r = probe.results[next++];
    if (r === undefined || r.error !== undefined) {
      if (r !== undefined && !r.userError) throw new Error(`stat_weights: ${mod}: ${r.error}`);
      failed.push({ mod, error: r?.error ?? 'not evaluated' });
      return;
    }
    const delta: Record<string, number | null> = {};
    const pct: Record<string, number | null> = {};
    for (const key of keys) {
      const before = num(probe.base[key]);
      const after = num(r.stats[key]);
      const d = before !== null && after !== null ? after - before : null;
      delta[key] = d;
      pct[key] = d !== null && before !== null && before !== 0 ? (d / Math.abs(before)) * 100 : null;
    }
    weights.push({ mod, delta, pct, order: i, rank: delta[rankBy] ?? -Infinity });
  });
  weights.sort((a, b) => (a.rank === b.rank ? a.order - b.order : b.rank - a.rank));

  const base: Stats = {};
  for (const key of keys) base[key] = probe.base[key] ?? null;
  return {
    rankBy,
    base,
    weights: weights.map(({ order: _o, rank: _r, ...row }) => row),
    unparsed,
    ...(failed.length > 0 ? { failed } : {}),
    ...(unknownStats.length > 0 ? { unknownStats } : {}),
  };
}

const roundRecord = (r: Record<string, number | null>): Record<string, number | null> =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null ? null : roundStat(v)]));

/** The tool reply: numbers rounded (2 decimals; 4 significant digits below 1). */
export function compactStatWeights(result: StatWeightsResult): Record<string, unknown> {
  const base: Stats = {};
  for (const [k, v] of Object.entries(result.base)) base[k] = typeof v === 'number' ? roundStat(v) : v;
  return {
    ...result,
    base,
    weights: result.weights.map((w) => ({ mod: w.mod, delta: roundRecord(w.delta), pct: roundRecord(w.pct) })),
    note:
      'Each line was added on its own as a custom modifier (PoB\'s Custom modifiers box, existing custom modifiers kept): ' +
      'a global modifier, so local item mods (e.g. a weapon\'s added damage, an armour piece\'s own armour) count as global. ' +
      'delta = stat change, pct = change in % of base. The build is unchanged.',
  };
}

// ---------------------------------------------------------------------------
// suggest_upgrades: suggested mods from PoB's weighted trade query
// ---------------------------------------------------------------------------

export interface SuggestedMod {
  /** The trade site's mod text, e.g. "+# to maximum Life". */
  mod: string;
  /** PoB's weight: stat-score gain per 1 point of the mod (score = sum of statWeights x relative stat change x 1000). */
  weight: number;
}

/**
 * The first `limit` weighted filters of PoB's trade query for a slot, in
 * PoB's order (mean stat gain of a typical roll, highest first). Mods that
 * lower the score (negative weight) are left out, and a text listed again
 * (the same mod as explicit and implicit) is listed once.
 */
export function topTradeMods(raw: TradeQueryRaw, limit: number): SuggestedMod[] {
  const texts = new Map(raw.texts.map((t) => [t.id, t.text]));
  const query = JSON.parse(raw.queryJson) as { query: { stats: { filters: { id: string; value?: { weight?: number } }[] }[] } };
  const filters = query.query.stats[0]?.filters ?? [];
  const out: SuggestedMod[] = [];
  const seen = new Set<string>();
  for (const f of filters) {
    const weight = Number(f.value?.weight);
    const mod = texts.get(f.id) ?? f.id;
    if (!Number.isFinite(weight) || weight <= 0 || seen.has(mod)) continue;
    seen.add(mod);
    out.push({ mod, weight: Number(weight.toPrecision(4)) });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerStatWeights(tools: ToolRegistrar): void {
  tools.engine<StatWeightsInput>(
    'stat_weights',
    {
      description:
        'What each mod line is worth to this build, from Path of Building\'s own calculator: every line is added on its own as a custom modifier ' +
        '(PoB\'s "Custom modifiers" box; existing custom modifiers are kept) and the change of each requested stat is measured. ' +
        `Default lines: a generic pack of ${DEFAULT_STAT_WEIGHT_MODS.length} single-roll offence/defence/sustain mods (life, ES, resistances, damage types, crit, speed, charges, gem levels, attributes). ` +
        'Returns `weights` ranked by the rankBy stat\'s change (delta = absolute change, pct = % of base), and `unparsed`: lines PoB\'s mod parser cannot use ' +
        '(reported instead of shown as worth zero). Lines are global modifiers (local weapon/armour mods count as global). Read-only; about 5 ms a line.',
      inputSchema: {
        mods: z.array(z.string().min(1).max(MAX_MOD_LINE_LENGTH)).max(MAX_STAT_WEIGHT_MODS).optional()
          .describe('Item-style mod lines, one modifier each, e.g. "+50 to maximum Life", "10% increased Cold Damage", "+1% to Critical Strike Chance". Default: the generic pack.'),
        stats: z.array(z.string().min(1).max(64)).max(MAX_STAT_WEIGHT_STATS).optional()
          .describe(`PoB stat names to measure (default ${DEFAULT_STAT_WEIGHT_STATS.join(', ')}).`),
        rankBy: z.string().min(1).max(64).optional().describe('Stat to rank by (default CombinedDPS); added to stats when missing.'),
      },
    },
    async (args, session) => compactStatWeights(await computeStatWeights(session, args)),
  );
}
