/**
 * compare_builds: the loaded build (or the `against` build) against another
 * build, read from Path of Building's own engine for both sides. The other
 * build is loaded into a short-lived second LuaJIT engine
 * (EngineManager.withTemporaryEngine), so the loaded build, its undo stack
 * and its crash journal are never touched; side A of the loaded build is one
 * read-only bridge read under the session lock.
 */
import { z } from 'zod';
import type { BuildSession } from './build-session.js';
import { resolveBuildSource } from './build-source.js';
import type { EngineManager, TemporaryEngineOptions } from './engine-manager.js';
import { roundStat } from './evaluate-changes.js';
import type { BuildInfo, LuaBridge } from './lua-bridge.js';
import type { ToolRegistrar } from './tool-registry.js';
import { UserError, validateBuildSource } from './validation.js';

// ---------------------------------------------------------------------------
// Snapshots (the bridge's compareSnapshot) and their diff
// ---------------------------------------------------------------------------

export interface SnapshotNode {
  id: number;
  name?: string;
  type?: string;
  ascendancy?: string;
  /** Selected mastery effect text (mastery nodes). */
  effect?: string;
}

export interface SnapshotItem {
  slot: string;
  name?: string;
  base?: string;
  rarity?: string;
  quality?: number;
  sockets?: string;
  corrupted?: boolean;
  hidden?: boolean;
  /** Weapon-swap slot. */
  swap?: boolean;
  /** PoB ignores this item: the weapon set not in use, or an abyss jewel in a socket its parent item does not have. */
  inactive?: boolean;
  /** Flask slots: whether the slot is active (PoB applies the flask or tincture only then). */
  flaskActive?: boolean;
  /** Active mod lines: {enchant}, {scourge}, {implicit}, then explicits ({crafted} / {fractured} marked). */
  mods: string[];
}

export interface SnapshotGem {
  name: string;
  level?: number;
  quality?: number;
  enabled: boolean;
  support: boolean;
}

export interface SnapshotGroup {
  label?: string;
  slot?: string;
  enabled: boolean;
  source?: string;
  main?: boolean;
  gems: SnapshotGem[];
}

export interface BuildSnapshot {
  info: BuildInfo;
  stats: Record<string, number | string | boolean | null>;
  tree: { points: number; ascendancyPoints: number; nodes: SnapshotNode[] };
  items: SnapshotItem[];
  groups: SnapshotGroup[];
  config: Record<string, unknown>;
}

/** Always reported, in this order. */
export const KEY_STATS = ['CombinedDPS', 'FullDPS', 'TotalDPS', 'TotalDot', 'Life', 'EnergyShield', 'Mana', 'TotalEHP'] as const;

/** Reported when they differ (the get_stats categories). */
const OTHER_STATS = [
  'CombinedAvg', 'AverageDamage', 'Speed', 'HitSpeed', 'CritChance', 'CritMultiplier', 'HitChance', 'Accuracy',
  'PhysicalDPS', 'ElementalDPS', 'ChaosDPS', 'BleedDPS', 'PoisonDPS', 'IgniteDPS', 'TotalDotDPS', 'ImpaleDPS',
  'WithBleedDPS', 'WithPoisonDPS', 'WithIgniteDPS', 'ManaCost',
  'Ward', 'Evasion', 'Armour', 'BlockChance', 'SpellBlockChance', 'SpellSuppressionChance',
  'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
  'FireResistOverCap', 'ColdResistOverCap', 'LightningResistOverCap', 'ChaosResistOverCap',
  'PhysicalMaximumHitTaken', 'ElementalMaximumHitTaken',
  'LifeRegen', 'NetLifeRegen', 'LifeLeechGainRate', 'LifeRecoup', 'EnergyShieldRegen', 'ManaRegen', 'ManaLeechRate',
  'EnduranceChargesMax', 'FrenzyChargesMax', 'PowerChargesMax', 'Str', 'Dex', 'Int', 'EffectiveMovementSpeedMod',
];

/** Every stat key read for both sides. */
export const COMPARE_STAT_KEYS: readonly string[] = [...KEY_STATS, ...OTHER_STATS];

const MAX_NAMED_NODES = 30;
const MAX_ITEM_SLOTS = 30;
const MAX_MOD_LINES = 12;
const MAX_GROUPS = 20;
const MAX_CONFIG = 30;
const MAX_VALUE_CHARS = 120;
const MAX_LABEL_CHARS = 120;
const MAX_MOD_CHARS = 160;
const MAX_NAME_CHARS = 80;
const MAX_GEMS = 12;

/** `text` cut to `max` characters (with an ellipsis). */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The first `max` entries; `more` counts the rest (absent when nothing was cut). */
function capped<T>(list: T[], max: number): { list: T[]; more?: number } {
  return list.length > max ? { list: list.slice(0, max), more: list.length - max } : { list };
}

function statRow(a: unknown, b: unknown): Record<string, unknown> {
  if (typeof a === 'number' && typeof b === 'number') {
    const delta = roundStat(b - a);
    return { a, b, delta, ...(a !== 0 ? { pct: Math.round(((b - a) / Math.abs(a)) * 10000) / 100 } : {}) };
  }
  return { a: a ?? null, b: b ?? null };
}

function diffStats(a: BuildSnapshot['stats'], b: BuildSnapshot['stats']): { stats: Record<string, unknown>; statsUnchanged: number } {
  const stats: Record<string, unknown> = {};
  for (const key of KEY_STATS) {
    if ((a[key] ?? null) !== null || (b[key] ?? null) !== null) stats[key] = statRow(a[key], b[key]);
  }
  const changed: Array<{ key: string; row: Record<string, unknown>; weight: number }> = [];
  let unchanged = 0;
  for (const key of OTHER_STATS) {
    const va = a[key] ?? null;
    const vb = b[key] ?? null;
    if (va === vb) {
      if (va !== null) unchanged++;
      continue;
    }
    const row = statRow(va, vb);
    const weight = typeof row.pct === 'number' ? Math.abs(row.pct) : Number.POSITIVE_INFINITY;
    changed.push({ key, row, weight });
  }
  changed.sort((x, y) => y.weight - x.weight);
  for (const c of changed) stats[c.key] = c.row;
  return { stats, statsUnchanged: unchanged };
}

// ------------------------------------------------------------------ tree

type NamedNode = { id: number; name?: string; effect?: string };

function treeSide(nodes: SnapshotNode[]): Record<string, unknown> {
  const named: Record<'keystones' | 'notables' | 'masteries' | 'ascendancy', NamedNode[]> = {
    keystones: [], notables: [], masteries: [], ascendancy: [],
  };
  let normal = 0;
  let jewelSockets = 0;
  let other = 0;
  for (const n of nodes) {
    if (n.type === 'ClassStart' || n.type === 'AscendClassStart') continue;
    const entry: NamedNode = { id: n.id, ...(n.name !== undefined ? { name: clip(n.name, MAX_NAME_CHARS) } : {}) };
    if (n.ascendancy) named.ascendancy.push(entry);
    else if (n.type === 'Keystone') named.keystones.push(entry);
    else if (n.type === 'Notable') named.notables.push(entry);
    else if (n.type === 'Mastery') named.masteries.push(n.effect ? { ...entry, effect: clip(n.effect, MAX_MOD_CHARS) } : entry);
    else if (n.type === 'Socket') jewelSockets++;
    else if (n.type === 'Normal') normal++;
    else other++;
  }
  const out: Record<string, unknown> = {};
  let more = 0;
  for (const [key, list] of Object.entries(named)) {
    if (list.length === 0) continue;
    const c = capped(list, MAX_NAMED_NODES);
    out[key] = c.list;
    more += c.more ?? 0;
  }
  if (normal) out.normal = normal;
  if (jewelSockets) out.jewelSockets = jewelSockets;
  if (other) out.other = other;
  if (more) out.more = more;
  return out;
}

function diffTree(a: BuildSnapshot, b: BuildSnapshot): Record<string, unknown> {
  const byIdA = new Map(a.tree.nodes.map((n) => [n.id, n]));
  const byIdB = new Map(b.tree.nodes.map((n) => [n.id, n]));
  const onlyA = a.tree.nodes.filter((n) => !byIdB.has(n.id));
  const onlyB = b.tree.nodes.filter((n) => !byIdA.has(n.id));
  const masteryChanges = a.tree.nodes
    .filter((n) => n.type === 'Mastery' && byIdB.has(n.id) && (byIdB.get(n.id)!.effect ?? null) !== (n.effect ?? null))
    .map((n) => {
      const effectB = byIdB.get(n.id)!.effect;
      return {
        id: n.id,
        name: n.name !== undefined ? clip(n.name, MAX_NAME_CHARS) : undefined,
        a: n.effect !== undefined ? clip(n.effect, MAX_MOD_CHARS) : null,
        b: effectB !== undefined ? clip(effectB, MAX_MOD_CHARS) : null,
      };
    });
  const mc = capped(masteryChanges, MAX_NAMED_NODES);
  const versionA = a.info.treeVersion ?? null;
  const versionB = b.info.treeVersion ?? null;
  return {
    points: { a: a.tree.points, b: b.tree.points },
    ascendancyPoints: { a: a.tree.ascendancyPoints, b: b.tree.ascendancyPoints },
    sameNodes: a.tree.nodes.length - onlyA.length,
    onlyA: treeSide(onlyA),
    onlyB: treeSide(onlyB),
    ...(mc.list.length ? { masteryChanges: mc.list } : {}),
    ...(mc.more ? { masteryChangesMore: mc.more } : {}),
    ...(versionA !== versionB
      ? { treeVersionNote: `The two sides use different passive tree versions (${versionA} / ${versionB}); nodes are compared by id.` }
      : {}),
  };
}

// ------------------------------------------------------------------ items

function itemLabel(item: SnapshotItem): string {
  const name = item.name ?? item.base ?? '(unnamed item)';
  return clip(item.base && item.base !== name ? `${name} (${item.base})` : name, MAX_LABEL_CHARS);
}

/** Entries of `x` not matched by an entry of `y` (multiset difference). */
function multisetMinus(x: string[], y: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of y) counts.set(v, (counts.get(v) ?? 0) + 1);
  const out: string[] = [];
  for (const v of x) {
    const n = counts.get(v) ?? 0;
    if (n > 0) counts.set(v, n - 1);
    else out.push(v);
  }
  return out;
}

function itemChange(slot: string, a: SnapshotItem, b: SnapshotItem): Record<string, unknown> | null {
  const removed = multisetMinus(a.mods, b.mods).map((m) => clip(m, MAX_MOD_CHARS));
  const added = multisetMinus(b.mods, a.mods).map((m) => clip(m, MAX_MOD_CHARS));
  const fields: Record<string, unknown> = {};
  for (const key of ['rarity', 'quality', 'sockets', 'corrupted', 'inactive', 'flaskActive'] as const) {
    if ((a[key] ?? null) !== (b[key] ?? null)) fields[key] = { a: a[key] ?? null, b: b[key] ?? null };
  }
  const sameLabel = itemLabel(a) === itemLabel(b);
  if (sameLabel && removed.length === 0 && added.length === 0 && Object.keys(fields).length === 0) return null;
  const r = capped(removed, MAX_MOD_LINES);
  const ad = capped(added, MAX_MOD_LINES);
  const more = (r.more ?? 0) + (ad.more ?? 0);
  return {
    slot,
    ...(b.swap ? { swap: true } : {}),
    ...(sameLabel ? { item: itemLabel(a) } : { a: itemLabel(a), b: itemLabel(b) }),
    ...(r.list.length ? { modsOnlyA: r.list } : {}),
    ...(ad.list.length ? { modsOnlyB: ad.list } : {}),
    ...(more ? { more } : {}),
    ...fields,
  };
}

function oneSide(slot: string, item: SnapshotItem): Record<string, unknown> {
  return {
    slot,
    item: itemLabel(item),
    ...(item.swap ? { swap: true } : {}),
    ...(item.inactive ? { inactive: true } : {}),
    ...(item.flaskActive === false ? { flaskActive: false } : {}),
  };
}

function diffItems(a: SnapshotItem[], b: SnapshotItem[]): Record<string, unknown> {
  const mapA = new Map(a.map((i) => [i.slot, i]));
  const mapB = new Map(b.map((i) => [i.slot, i]));
  const slots = [...new Set([...a.map((i) => i.slot), ...b.map((i) => i.slot)])];
  const same: string[] = [];
  const changed: Array<Record<string, unknown>> = [];
  const onlyA: Array<Record<string, unknown>> = [];
  const onlyB: Array<Record<string, unknown>> = [];
  for (const slot of slots) {
    const ia = mapA.get(slot);
    const ib = mapB.get(slot);
    if (ia && ib) {
      const change = itemChange(slot, ia, ib);
      if (change) changed.push(change);
      else same.push(slot);
    } else if (ia) onlyA.push(oneSide(slot, ia));
    else if (ib) onlyB.push(oneSide(slot, ib));
  }
  const c = capped(changed, MAX_ITEM_SLOTS);
  const oa = capped(onlyA, MAX_ITEM_SLOTS);
  const ob = capped(onlyB, MAX_ITEM_SLOTS);
  const more = (c.more ?? 0) + (oa.more ?? 0) + (ob.more ?? 0);
  return { same, changed: c.list, onlyA: oa.list, onlyB: ob.list, ...(more ? { more } : {}) };
}

// ------------------------------------------------------------------ gems

function activeNames(g: SnapshotGroup): string[] {
  return g.gems.filter((x) => !x.support).map((x) => x.name).sort();
}

/** Matching key of a group: its active skills (full names; shown clipped by groupLabel). */
function groupKey(g: SnapshotGroup): string {
  const active = activeNames(g);
  if (active.length) return active.join(' + ');
  return `supports in ${g.label ?? g.slot ?? 'a group'}`;
}

function groupLabel(g: SnapshotGroup): string {
  return clip(groupKey(g), MAX_LABEL_CHARS);
}

/** Gem names (clipped), at most MAX_GEMS, under `key`, with `<key>More` counting the rest. */
function gemList(key: string, names: string[]): Record<string, unknown> {
  if (!names.length) return {};
  const c = capped(names.map((n) => clip(n, MAX_NAME_CHARS)), MAX_GEMS);
  return { [key]: c.list, ...(c.more ? { [`${key}More`]: c.more } : {}) };
}

function groupSummary(g: SnapshotGroup): Record<string, unknown> {
  return {
    skills: groupLabel(g),
    ...(g.slot ? { slot: clip(g.slot, MAX_NAME_CHARS) } : {}),
    supports: [],
    ...gemList('supports', g.gems.filter((x) => x.support).map((x) => x.name)),
    ...(g.enabled ? {} : { enabled: false }),
  };
}

/** "level/quality", plus " disabled" for a disabled gem. */
function gemText(gem: SnapshotGem): string {
  return `${gem.level ?? '?'}/${gem.quality ?? 0}${gem.enabled ? '' : ' disabled'}`;
}

function groupChange(a: SnapshotGroup, b: SnapshotGroup): Record<string, unknown> | null {
  const supA = a.gems.filter((x) => x.support).map((x) => x.name);
  const supB = b.gems.filter((x) => x.support).map((x) => x.name);
  const supportsRemoved = multisetMinus(supA, supB);
  const supportsAdded = multisetMinus(supB, supA);
  // Groups paired by one shared active skill can differ in their other actives.
  const activesRemoved = multisetMinus(activeNames(a), activeNames(b));
  const activesAdded = multisetMinus(activeNames(b), activeNames(a));
  const gemChanges: string[] = [];
  const used = new Set<SnapshotGem>();
  for (const ga of a.gems) {
    const gb = b.gems.find((x) => x.name === ga.name && !used.has(x));
    if (!gb) continue;
    used.add(gb);
    if (gemText(ga) !== gemText(gb)) gemChanges.push(`${clip(ga.name, MAX_NAME_CHARS)}: ${gemText(ga)} -> ${gemText(gb)}`);
  }
  const fields: Record<string, unknown> = {};
  if ((a.slot ?? null) !== (b.slot ?? null)) {
    fields.slot = { a: a.slot !== undefined ? clip(a.slot, MAX_NAME_CHARS) : null, b: b.slot !== undefined ? clip(b.slot, MAX_NAME_CHARS) : null };
  }
  if (a.enabled !== b.enabled) fields.enabled = { a: a.enabled, b: b.enabled };
  const gemDiffs = [supportsRemoved, supportsAdded, activesRemoved, activesAdded, gemChanges];
  if (gemDiffs.every((list) => !list.length) && !Object.keys(fields).length) return null;
  const changes = capped(gemChanges, MAX_GEMS);
  return {
    skills: groupLabel(a),
    ...gemList('supportsAdded', supportsAdded),
    ...gemList('supportsRemoved', supportsRemoved),
    ...gemList('activesAdded', activesAdded),
    ...gemList('activesRemoved', activesRemoved),
    ...(changes.list.length ? { gemChanges: changes.list } : {}),
    ...(changes.more ? { gemChangesMore: changes.more } : {}),
    ...fields,
  };
}

function diffGems(a: BuildSnapshot, b: BuildSnapshot): Record<string, unknown> {
  const groupsA = a.groups.filter((g) => g.gems.length > 0);
  const groupsB = b.groups.filter((g) => g.gems.length > 0);
  const pairs: Array<[SnapshotGroup, SnapshotGroup]> = [];
  const freeB = new Set(groupsB);
  const unmatchedA: SnapshotGroup[] = [];
  // Same active skills first, then any shared active skill.
  for (const ga of groupsA) {
    const gb = groupsB.find((x) => freeB.has(x) && groupKey(x) === groupKey(ga));
    if (gb) {
      freeB.delete(gb);
      pairs.push([ga, gb]);
    } else unmatchedA.push(ga);
  }
  const onlyA: SnapshotGroup[] = [];
  for (const ga of unmatchedA) {
    const names = new Set(activeNames(ga));
    const gb = groupsB.find((x) => freeB.has(x) && activeNames(x).some((n) => names.has(n)));
    if (gb) {
      freeB.delete(gb);
      pairs.push([ga, gb]);
    } else onlyA.push(ga);
  }
  const changed = pairs.map(([x, y]) => groupChange(x, y)).filter((c): c is Record<string, unknown> => c !== null);
  const c = capped(changed, MAX_GROUPS);
  const oa = capped(onlyA.map(groupSummary), MAX_GROUPS);
  const ob = capped([...freeB].map(groupSummary), MAX_GROUPS);
  const more = (c.more ?? 0) + (oa.more ?? 0) + (ob.more ?? 0);
  return {
    mainSkill: {
      a: a.info.mainSkill != null ? clip(a.info.mainSkill, MAX_NAME_CHARS) : null,
      b: b.info.mainSkill != null ? clip(b.info.mainSkill, MAX_NAME_CHARS) : null,
    },
    sameGroups: pairs.length - changed.length,
    changed: c.list,
    onlyA: oa.list,
    onlyB: ob.list,
    ...(more ? { more } : {}),
  };
}

// ------------------------------------------------------------------ meta / config

/** Config options most often behind a stat difference, listed first. */
const NOTABLE_CONFIG = /^(enemyIs|use[A-Z].*Charges|buff|condition|multiplier|customMods)/;

function shortValue(v: unknown): unknown {
  if (typeof v === 'string' && v.length > MAX_VALUE_CHARS) return `${v.slice(0, MAX_VALUE_CHARS)}…`;
  return v ?? null;
}

function diffConfig(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => (a[k] ?? null) !== (b[k] ?? null))
    .sort((x, y) => Number(NOTABLE_CONFIG.test(y)) - Number(NOTABLE_CONFIG.test(x)) || x.localeCompare(y));
  const c = capped(keys, MAX_CONFIG);
  const changed: Record<string, unknown> = {};
  for (const k of c.list) changed[k] = { a: shortValue(a[k]), b: shortValue(b[k]) };
  return { changed, ...(c.more ? { more: c.more } : {}) };
}

function metaSide(s: BuildSnapshot): Record<string, unknown> {
  return {
    class: s.info.class ?? null,
    ascendancy: s.info.ascendancy ?? null,
    level: s.info.level ?? null,
    mainSkill: s.info.mainSkill != null ? clip(s.info.mainSkill, MAX_NAME_CHARS) : null,
    treeVersion: s.info.treeVersion ?? null,
  };
}

/** The comparison of two build snapshots (a = before, b = after). */
export function diffBuilds(a: BuildSnapshot, b: BuildSnapshot): Record<string, unknown> {
  const ma = metaSide(a);
  const mb = metaSide(b);
  return {
    meta: { a: ma, b: mb, differs: Object.keys(ma).filter((k) => ma[k] !== mb[k]) },
    ...diffStats(a.stats, b.stats),
    tree: diffTree(a, b),
    items: diffItems(a.items, b.items),
    gems: diffGems(a, b),
    config: diffConfig(a.config, b.config),
  };
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

/** The temporary engine failed (crash, timeout, startup): the call fails, the live engine is unaffected. */
export class TemporaryEngineError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = 'TemporaryEngineError';
  }
}

export interface CompareBuildsArgs {
  source: string;
  against?: string;
}

type RawSnapshot = Omit<BuildSnapshot, 'config'> & { config: Record<string, unknown> | unknown[] };

/** dkjson sends an empty Lua table as `[]`. */
function normalize(raw: RawSnapshot): BuildSnapshot {
  const obj = <T>(v: T | unknown[] | undefined | null): T => (Array.isArray(v) || v == null ? ({} as T) : (v as T));
  const arr = <T>(v: T[] | Record<string, never> | undefined | null): T[] => (Array.isArray(v) ? v : []);
  return {
    info: obj<BuildInfo>(raw.info),
    stats: obj(raw.stats),
    tree: {
      points: Number(raw.tree?.points ?? 0),
      ascendancyPoints: Number(raw.tree?.ascendancyPoints ?? 0),
      nodes: arr(raw.tree?.nodes),
    },
    items: arr(raw.items).map((i) => ({ ...i, mods: arr(i.mods) })),
    groups: arr(raw.groups).map((g) => ({ ...g, gems: arr(g.gems) })),
    config: obj(raw.config),
  };
}

function firstLine(message: string): string {
  const line = message.split('\n')[0].trim();
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/**
 * A temporary engine's error line without the live engine's crash wording
 * (strike counts, "the next tool call restarts the engine"): the temporary
 * engine's strikes are its own and it is never restarted.
 */
function temporaryDetail(message: string): string {
  const line = firstLine(message);
  if (/^The Path of Building engine stopped during this call/.test(line)) return 'its process exited';
  return line
    .replace(/\(the engine was stopped; strike \d+ of \d+\)/g, '(its process was killed)')
    .replace(/\s*\(strike \d+ of \d+\)/g, '')
    .replace(/[;,]?\s*strike \d+ of \d+/g, '')
    .replace(/\.?\s*Stderr:\s*$/, '');
}

const UNAFFECTED =
  'It was discarded and is not restarted; this is not a crash of the main engine and does not count towards its crash limit; the loaded build and the main engine are unaffected.';

/** What went wrong in the temporary engine, as an error of this call. */
function temporaryFailure(e: unknown, bridge: LuaBridge, step: string, label: string): Error {
  const message = e instanceof Error ? e.message : String(e);
  if (!bridge.isRunning()) {
    return new TemporaryEngineError(
      `The temporary Path of Building engine started for this comparison stopped while ${step} the ${label} build (${temporaryDetail(message)}). ` +
        `${UNAFFECTED} Retry the call, or check that the build opens in Path of Building.`,
    );
  }
  if (step === 'loading') {
    const reason = firstLine(message).replace(/\s*\((the engine now has no build loaded|the previously loaded build is still active)[^)]*\)\s*$/, '');
    return new UserError(`Path of Building could not load the ${label} build: ${reason}`);
  }
  if (e instanceof UserError) return new UserError(`The ${label} build: ${message}`);
  return new TemporaryEngineError(
    `Reading the ${label} build in the temporary Path of Building engine started for this comparison failed: ${temporaryDetail(message)}. ` +
      'The loaded build and the main engine are unaffected.',
  );
}

/** Load each build into one temporary engine in turn and read it. */
async function readInTemporaryEngine(
  engine: EngineManager,
  builds: Array<{ label: string; xml: string }>,
  stats: string[],
  options: TemporaryEngineOptions,
): Promise<BuildSnapshot[]> {
  try {
    return await engine.withTemporaryEngine(async (bridge) => {
      const out: BuildSnapshot[] = [];
      for (const { label, xml } of builds) {
        try {
          await bridge.send({ cmd: 'loadXML', xml, name: `compare_builds ${label}` });
        } catch (e) {
          throw temporaryFailure(e, bridge, 'loading', label);
        }
        try {
          out.push(normalize(await bridge.send<RawSnapshot>({ cmd: 'compareSnapshot', stats })));
        } catch (e) {
          throw temporaryFailure(e, bridge, 'reading', label);
        }
      }
      return out;
    }, options);
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new TemporaryEngineError(
      `The temporary Path of Building engine for this comparison could not start (${temporaryDetail((e as Error).message)}). ${UNAFFECTED}`,
    );
  }
}

function checkedSource(value: string, arg: string): string {
  try {
    return validateBuildSource(value);
  } catch (e) {
    if (e instanceof UserError) throw new UserError(`${arg}: ${e.message}`);
    throw e;
  }
}

async function resolvedSource(value: string, arg: string): Promise<string> {
  try {
    return await resolveBuildSource(value);
  } catch (e) {
    if (e instanceof UserError) throw new UserError(`${arg}: ${e.message}`);
    throw e;
  }
}

/**
 * Compare side A (the loaded build, or `against`) with side B (`source`).
 * `options` reach the temporary engine (tests: timeout, fault seam).
 */
export async function compareBuilds(
  engine: EngineManager,
  session: BuildSession,
  args: CompareBuildsArgs,
  options: TemporaryEngineOptions = {},
): Promise<Record<string, unknown>> {
  const sourceB = checkedSource(args.source, 'source');
  const sourceA = args.against !== undefined ? checkedSource(args.against, 'against') : undefined;
  if (sourceA === undefined && !session.hasBuild()) {
    throw new UserError('No build loaded — call load_build first, or pass `against` to compare two other builds');
  }
  // Downloads and decoding happen before any engine work, outside the session lock.
  const [xmlA, xmlB] = await Promise.all([
    sourceA !== undefined ? resolvedSource(sourceA, 'against') : Promise.resolve(null),
    resolvedSource(sourceB, 'source'),
  ]);
  const stats = [...COMPARE_STAT_KEYS];
  let a: BuildSnapshot;
  let b: BuildSnapshot;
  if (xmlA === null) {
    a = normalize(await session.compareSnapshot<RawSnapshot>(stats));
    [b] = await readInTemporaryEngine(engine, [{ label: 'source', xml: xmlB }], stats, options);
  } else {
    [a, b] = await readInTemporaryEngine(engine, [{ label: 'against', xml: xmlA }, { label: 'source', xml: xmlB }], stats, options);
  }
  return {
    a: xmlA === null ? 'loaded build' : 'against',
    b: 'source',
    ...diffBuilds(a, b),
  };
}

const sourceSchema = z
  .string()
  .min(1)
  .describe('Build code (base64), pastebin URL, pobb.in URL, or raw XML starting with <?xml or <PathOfBuilding (as load_build takes)');

export function registerCompareBuilds(tools: ToolRegistrar, engine: EngineManager): void {
  tools.engine<CompareBuildsArgs>(
    'compare_builds',
    {
      description:
        'Compare the loaded build (side a) with another build (side b: `source`, anything load_build accepts), or two other builds (`against` = a, `source` = b), ' +
        "with Path of Building's own numbers for both. The other build is evaluated in a short-lived second engine started for this call (a few seconds); " +
        'the loaded build, its undo history and its config are never changed. Returns `meta` (class, ascendancy, level, main skill, tree version of each side), ' +
        `\`stats\` (a, b, delta = b - a, pct = delta in % of a: ${KEY_STATS.join(', ')} always, other stats only when they differ, largest change first), ` +
        '`tree` (points; nodes only in a / only in b: keystones, notables, masteries with their effect and ascendancy nodes named with ids, normal nodes and jewel sockets counted; mastery effect changes), ' +
        '`items` (slots holding the same item; changed slots with the mod lines only in a / only in b, and `flaskActive` {a, b} when a flask slot is on in one build only; slots filled on one side only), ' +
        '`gems` (socket groups matched by their active skills: supports and other active gems added / removed, level / quality / enabled changes; groups on one side only) and `config` (options that differ). ' +
        'Long lists are cut; `more` says how many entries were left out.',
      inputSchema: {
        source: sourceSchema,
        against: sourceSchema.optional().describe('Optional: compare this build (side a) with `source` instead of the loaded build.'),
      },
    },
    async (args, session) => compareBuilds(engine, session, args),
  );
}
