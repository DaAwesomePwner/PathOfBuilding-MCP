/**
 * community_gap_report, part 1: what the sample has. Pure functions over
 * compareSnapshot reads (the loaded build's and the sample's, with item text):
 * the sample filter, the share of the sample that uses each thing (gear,
 * gems, passive tree, settings), the gaps (at or above `minShare` and missing
 * from the loaded build) and the loaded build's uncommon choices. Nothing here
 * touches the engine; src/community-gaps.ts measures the gaps.
 */
import type { ConfigVarMetadata } from './build-session.js';
import type { BuildSnapshot, SnapshotGroup, SnapshotItem, SnapshotNode } from './compare-builds.js';
import { UserError } from './validation.js';

export type GapCategory = 'gear' | 'gems' | 'tree' | 'settings';
export const GAP_CATEGORIES: readonly GapCategory[] = ['gear', 'tree', 'gems', 'settings'];
export type GapKind = 'item' | 'flask' | 'jewel' | 'support' | 'skill' | 'keystone' | 'notable' | 'ascendancy' | 'mastery' | 'config';

/** Uncommon choices of the loaded build: used by fewer than this share of the sample. */
export const UNCOMMON_SHARE = 0.1;
/** Distinct sample copies measured per gear / flask / jewel gap. */
export const GEAR_COPIES = 5;
export const FLASK_COPIES = 3;
export const JEWEL_COPIES = 3;
const TOP_SUMMARY = 5;
/** Config sections that hold assumptions about the fight (enemy, conditions, buffs), not the character. */
const ASSUMPTION_SECTIONS = new Set(['Map Modifiers and Player Debuffs', 'When In Combat', 'For Effective DPS', 'Enemy Stats']);
const EPS = 1e-9;

export interface SampleEntry {
  id: string;
  label?: string;
  snapshot: BuildSnapshot;
}

export interface GapFilter {
  ascendancy?: string;
  mainSkill?: string;
  minLevel?: number;
}

/** One sample item to try: its text and where it came from (list_samples `build` + `slot` returns the same text). */
export interface ItemCopy {
  text: string;
  from: { build: string; label?: string; slot: string };
}

export interface GapCandidate {
  category: GapCategory;
  kind: GapKind;
  name: string;
  /** Gear: the slot ("Ring" for both rings); flasks and jewels are slot-agnostic. */
  slot?: string;
  share: number;
  count: number;
  /** item / flask / jewel: distinct sample copies (item text), most used first. */
  copies?: ItemCopy[];
  /** jewel: an abyss jewel (fits abyssal sockets too). */
  abyss?: boolean;
  /** support: the sample's most common level and quality for it. */
  gem?: { level: number; quality: number };
  /** tree: node ids the sample has it on, most common first. */
  nodeIds?: number[];
  /** mastery: the mastery name and effect text. */
  mastery?: { name: string; effect: string };
  /** settings: the sample's value, the loaded build's (null: unset with no default), and whether it is a fight assumption. */
  config?: { key: string; value: unknown; yours: unknown; assumption: boolean };
  /** Not measurable: why (set for other skills). */
  unmeasured?: string;
}

export interface UncommonEntry {
  name: string;
  slot?: string;
  share: number;
}

export interface SampleShares {
  candidates: GapCandidate[];
  uncommon: Partial<Record<'gear' | 'tree' | 'gems', UncommonEntry[]>>;
  mainSkillMatched: number;
  notes: string[];
}

const lower = (s: string | undefined | null): string => (s ?? '').trim().toLowerCase();
export const roundShare = (x: number): number => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------
// Sample filter and summary
// ---------------------------------------------------------------------------

/** The builds matching `filter` (case-insensitive exact names); none is a UserError naming what the sample has. */
export function filterSample(sampleName: string, builds: SampleEntry[], filter: GapFilter | undefined): SampleEntry[] {
  if (builds.length === 0) {
    throw new UserError(`Sample "${sampleName}" has no usable builds; add some with add_sample_builds.`);
  }
  if (!filter || (filter.ascendancy === undefined && filter.mainSkill === undefined && filter.minLevel === undefined)) return builds;
  const out = builds.filter(({ snapshot: { info } }) => {
    if (filter.ascendancy !== undefined && lower(info.ascendancy ?? info.class) !== lower(filter.ascendancy)) return false;
    if (filter.mainSkill !== undefined && lower(info.mainSkill) !== lower(filter.mainSkill)) return false;
    if (filter.minLevel !== undefined && !((info.level ?? 0) >= filter.minLevel)) return false;
    return true;
  });
  if (out.length === 0) {
    const list = (values: Array<string | undefined>): string => [...new Set(values.filter((v): v is string => !!v))].sort().join(', ') || 'none';
    throw new UserError(
      `No build of sample "${sampleName}" matches the filter ${JSON.stringify(filter)}. ` +
        `Its ascendancies: ${list(builds.map((b) => b.snapshot.info.ascendancy ?? b.snapshot.info.class))}; ` +
        `main skills: ${list(builds.map((b) => b.snapshot.info.mainSkill))}; ` +
        `levels ${Math.min(...builds.map((b) => b.snapshot.info.level ?? 0))}-${Math.max(...builds.map((b) => b.snapshot.info.level ?? 0))}.`,
    );
  }
  return out;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function sampleSummary(builds: SampleEntry[]): Record<string, unknown> {
  const n = builds.length;
  const top = (values: Array<string | undefined>): Array<{ name: string; share: number }> => {
    const counts = new Map<string, number>();
    for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_SUMMARY)
      .map(([name, c]) => ({ name, share: roundShare(c / n) }));
  };
  return {
    ascendancies: top(builds.map((b) => b.snapshot.info.ascendancy ?? b.snapshot.info.class)),
    mainSkills: top(builds.map((b) => b.snapshot.info.mainSkill)),
    levelMedian: median(builds.map((b) => b.snapshot.info.level).filter((l): l is number => typeof l === 'number')),
  };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const GEAR_SLOTS = new Set(['Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Belt', 'Weapon 1', 'Weapon 2']);
const FLASK_RE = /^Flask [1-5]$/;
const JEWEL_RE = /^Tree jewel \d+$| Abyssal Socket \d+$/;
const CLUSTER_RE = /Cluster Jewel$/;
const ABYSS_RE = /Eye Jewel$/;
const CLUSTER_SKILL_RE = /^(?:\{[a-z]+\})*(Added Small Passive Skills grant: .*)$/;

/** The slot an item counts in (the weapon set in use is "Weapon 1" / "Weapon 2"), or null when PoB ignores it. */
export function activeSlot(item: SnapshotItem): string | null {
  if (item.inactive) return null;
  return item.slot.replace(' Swap', '');
}

/** Unique / relic: its name; cluster jewel: base + its small passive line; else the base type. */
export function itemKey(item: SnapshotItem): string {
  const rarity = (item.rarity ?? '').toUpperCase();
  if ((rarity === 'UNIQUE' || rarity === 'RELIC') && item.name) return item.name;
  const base = item.base ?? item.name ?? '?';
  if (CLUSTER_RE.test(base)) {
    for (const m of item.mods ?? []) {
      const hit = CLUSTER_SKILL_RE.exec(m);
      if (hit) return `${base}: ${hit[1]}`;
    }
  }
  return base;
}

type ItemGroup = { kind: 'item' | 'flask' | 'jewel'; slot?: string };

/** Which gap group an item belongs to (gear slot, flask, jewel), or null. A sample's flask counts only in an active slot; the loaded build has the flasks it holds. */
function itemGroup(item: SnapshotItem, inactiveFlasks = false): ItemGroup | null {
  const slot = activeSlot(item);
  if (slot === null || item.hidden) return null;
  if (GEAR_SLOTS.has(slot)) return { kind: 'item', slot: slot.startsWith('Ring ') ? 'Ring' : slot };
  if (FLASK_RE.test(slot)) return item.flaskActive === false && !inactiveFlasks ? null : { kind: 'flask' };
  if (JEWEL_RE.test(slot)) return { kind: 'jewel' };
  return null;
}

const groupId = (g: ItemGroup): string => `${g.kind}|${g.slot ?? ''}`;

interface ItemTally {
  group: ItemGroup;
  key: string;
  builds: Set<string>;
  copies: Map<string, ItemCopy & { uses: number }>;
  abyss: boolean;
}

function tallyItems(builds: SampleEntry[]): Map<string, ItemTally> {
  const tallies = new Map<string, ItemTally>();
  for (const b of builds) {
    for (const item of b.snapshot.items) {
      const group = itemGroup(item);
      if (!group) continue;
      const key = itemKey(item);
      const id = `${groupId(group)}|${key}`;
      let t = tallies.get(id);
      if (!t) {
        t = { group, key, builds: new Set(), copies: new Map(), abyss: ABYSS_RE.test(item.base ?? '') };
        tallies.set(id, t);
      }
      t.builds.add(b.id);
      if (typeof item.text === 'string' && item.text.length > 0) {
        const c = t.copies.get(item.text);
        if (c) c.uses++;
        else t.copies.set(item.text, { text: item.text, from: { build: b.id, ...(b.label ? { label: b.label } : {}), slot: item.slot }, uses: 1 });
      }
    }
  }
  return tallies;
}

function loadedItemIds(loaded: BuildSnapshot): Map<string, SnapshotItem> {
  const out = new Map<string, SnapshotItem>();
  for (const item of loaded.items) {
    const group = itemGroup(item, true);
    if (group) out.set(`${groupId(group)}|${itemKey(item)}`, item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gems
// ---------------------------------------------------------------------------

export function mainGroupIndex(s: BuildSnapshot): number {
  return s.groups.findIndex((g) => g.main);
}

function supportsOf(g: SnapshotGroup | undefined): Array<{ name: string; level?: number; quality?: number }> {
  return (g?.gems ?? []).filter((gem) => gem.support && gem.enabled && gem.name);
}

/** Active skill gems outside the main group (enabled groups the player socketed, not item / tree granted). */
function otherSkills(s: BuildSnapshot): Set<string> {
  const main = mainGroupIndex(s);
  const out = new Set<string>();
  s.groups.forEach((g, i) => {
    if (i === main || !g.enabled || g.source) return;
    for (const gem of g.gems) if (!gem.support && gem.enabled && gem.name) out.add(gem.name);
  });
  return out;
}

function allActiveGems(s: BuildSnapshot): Set<string> {
  const out = new Set<string>();
  for (const g of s.groups) for (const gem of g.gems) if (!gem.support && gem.name) out.add(lower(gem.name));
  return out;
}

function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<string, { v: T; n: number }>();
  for (const v of values) {
    const k = JSON.stringify(v);
    const c = counts.get(k);
    if (c) c.n++;
    else counts.set(k, { v, n: 1 });
  }
  let best: { v: T; n: number } | undefined;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best?.v;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

type TreeKey = { kind: 'keystone' | 'notable' | 'ascendancy' | 'mastery'; name: string; mastery?: { name: string; effect: string } };

function treeKey(n: SnapshotNode): TreeKey | null {
  if (!n.name) return null;
  if (n.type === 'Keystone' && !n.ascendancy) return { kind: 'keystone', name: n.name };
  if (n.type === 'Notable') return n.ascendancy ? { kind: 'ascendancy', name: n.name } : { kind: 'notable', name: n.name };
  if (n.type === 'Mastery' && n.effect) return { kind: 'mastery', name: `${n.name}: ${n.effect}`, mastery: { name: n.name, effect: n.effect } };
  return null;
}

const treeId = (k: TreeKey): string => `${k.kind}|${lower(k.name)}`;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The value PoB uses for an option nobody set, or undefined when it has none (no comparison then). */
function configDefault(meta: ConfigVarMetadata | undefined): unknown {
  if (!meta) return undefined;
  if (meta.type === 'check') return meta.defaultState ?? false;
  if (meta.type === 'list') return meta.list?.[(meta.defaultIndex ?? 1) - 1]?.val ?? meta.defaultState;
  return meta.defaultState;
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function settingGaps(loaded: BuildSnapshot, builds: SampleEntry[], minShare: number, meta: Map<string, ConfigVarMetadata>): GapCandidate[] {
  const n = builds.length;
  const keys = new Set<string>();
  for (const b of builds) for (const k of Object.keys(b.snapshot.config)) keys.add(k);
  const out: GapCandidate[] = [];
  for (const key of [...keys].sort()) {
    if (key === 'customMods') continue;
    const m = meta.get(key);
    const def = configDefault(m);
    const values = builds.map((b) => b.snapshot.config[key] ?? def).filter((v) => v !== undefined && v !== null);
    const counts = new Map<string, { v: unknown; n: number }>();
    for (const v of values) {
      const k = JSON.stringify(v);
      const c = counts.get(k);
      if (c) c.n++;
      else counts.set(k, { v, n: 1 });
    }
    const best = [...counts.values()].sort((a, b) => b.n - a.n || JSON.stringify(a.v).localeCompare(JSON.stringify(b.v)))[0];
    if (!best || best.n / n < minShare - EPS) continue;
    const yours = loaded.config[key] ?? def;
    if (sameValue(best.v, yours)) continue;
    out.push({
      category: 'settings',
      kind: 'config',
      name: key,
      share: roundShare(best.n / n),
      count: best.n,
      config: { key, value: best.v, yours: yours ?? null, assumption: m ? ASSUMPTION_SECTIONS.has(m.section) : false },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shares and gaps
// ---------------------------------------------------------------------------

export interface ShareOptions {
  categories: ReadonlySet<GapCategory>;
  minShare: number;
  configMeta: Map<string, ConfigVarMetadata>;
}

/** Every gap of the loaded build against the (filtered) sample, unmeasured, plus its uncommon choices. */
export function sampleShares(loaded: BuildSnapshot, builds: SampleEntry[], opts: ShareOptions): SampleShares {
  const n = builds.length;
  const { minShare } = opts;
  const atLeast = (count: number, of: number): boolean => of > 0 && count / of >= minShare - EPS;
  const candidates: GapCandidate[] = [];
  const uncommon: SampleShares['uncommon'] = {};
  const notes: string[] = [];

  // ---- gear (slots, flasks, jewels)
  if (opts.categories.has('gear')) {
    const tallies = tallyItems(builds);
    const have = loadedItemIds(loaded);
    for (const [id, t] of tallies) {
      if (have.has(id) || !atLeast(t.builds.size, n)) continue;
      const max = t.group.kind === 'item' ? GEAR_COPIES : t.group.kind === 'flask' ? FLASK_COPIES : JEWEL_COPIES;
      const copies = [...t.copies.values()].sort((a, b) => b.uses - a.uses).slice(0, max).map(({ uses: _u, ...c }) => c);
      candidates.push({
        category: 'gear',
        kind: t.group.kind,
        name: t.key,
        ...(t.group.slot ? { slot: t.group.slot } : {}),
        share: roundShare(t.builds.size / n),
        count: t.builds.size,
        copies,
        ...(t.group.kind === 'jewel' && t.abyss ? { abyss: true } : {}),
        ...(copies.length === 0 ? { unmeasured: 'not measured: the sample has no item text for it' } : {}),
      });
    }
    const list: UncommonEntry[] = [];
    for (const [id, item] of have) {
      const share = (tallies.get(id)?.builds.size ?? 0) / n;
      if (share < UNCOMMON_SHARE) list.push({ name: itemKey(item), slot: activeSlot(item)!, share: roundShare(share) });
    }
    uncommon.gear = list;
  }

  // ---- gems
  let mainSkillMatched = 0;
  if (opts.categories.has('gems')) {
    const loadedMain = loaded.groups[mainGroupIndex(loaded)];
    const mainSkill = lower(loaded.info.mainSkill);
    const matched = mainSkill ? builds.filter((b) => lower(b.snapshot.info.mainSkill) === mainSkill) : [];
    mainSkillMatched = matched.length;
    const yourSupports = new Set(supportsOf(loadedMain).map((g) => lower(g.name)));
    const gemsList: UncommonEntry[] = [];
    if (!loadedMain || !mainSkill) {
      notes.push('The loaded build has no main skill group: no support rows.');
    } else if (matched.length === 0) {
      notes.push(`No build of the sample uses ${loaded.info.mainSkill} as its main skill: no support rows (main skill supports are compared only between builds with the same main skill).`);
    } else {
      const supportTally = new Map<string, { name: string; builds: Set<string>; levels: number[]; qualities: number[] }>();
      for (const b of matched) {
        for (const gem of supportsOf(b.snapshot.groups[mainGroupIndex(b.snapshot)])) {
          const k = lower(gem.name);
          let t = supportTally.get(k);
          if (!t) supportTally.set(k, (t = { name: gem.name, builds: new Set(), levels: [], qualities: [] }));
          t.builds.add(b.id);
          if (typeof gem.level === 'number') t.levels.push(gem.level);
          if (typeof gem.quality === 'number') t.qualities.push(gem.quality);
        }
      }
      for (const [k, t] of supportTally) {
        if (yourSupports.has(k) || !atLeast(t.builds.size, matched.length)) continue;
        candidates.push({
          category: 'gems',
          kind: 'support',
          name: t.name,
          share: roundShare(t.builds.size / matched.length),
          count: t.builds.size,
          gem: { level: mostCommon(t.levels) ?? 20, quality: mostCommon(t.qualities) ?? 0 },
        });
      }
      for (const g of supportsOf(loadedMain)) {
        const share = (supportTally.get(lower(g.name))?.builds.size ?? 0) / matched.length;
        if (share < UNCOMMON_SHARE) gemsList.push({ name: g.name, share: roundShare(share) });
      }
    }
    const yourActive = allActiveGems(loaded);
    const skillTally = new Map<string, { name: string; builds: Set<string> }>();
    for (const b of builds) {
      for (const name of otherSkills(b.snapshot)) {
        const k = lower(name);
        let t = skillTally.get(k);
        if (!t) skillTally.set(k, (t = { name, builds: new Set() }));
        t.builds.add(b.id);
      }
    }
    for (const [k, t] of skillTally) {
      if (yourActive.has(k) || !atLeast(t.builds.size, n)) continue;
      candidates.push({
        category: 'gems',
        kind: 'skill',
        name: t.name,
        share: roundShare(t.builds.size / n),
        count: t.builds.size,
        unmeasured:
          'not measured: a what-if cannot add a socket group; add it with create_socket_group, compare with get_stats, then undo_last_change',
      });
    }
    for (const name of otherSkills(loaded)) {
      const share = (skillTally.get(lower(name))?.builds.size ?? 0) / n;
      if (share < UNCOMMON_SHARE) gemsList.push({ name, share: roundShare(share) });
    }
    uncommon.gems = gemsList;
  }

  // ---- tree
  if (opts.categories.has('tree')) {
    const yourAsc = lower(loaded.info.ascendancy);
    const ascBuilds = yourAsc ? builds.filter((b) => lower(b.snapshot.info.ascendancy) === yourAsc) : [];
    const ascIds = new Set(ascBuilds.map((b) => b.id));
    const tally = new Map<string, { key: TreeKey; builds: Set<string>; ids: Map<number, number> }>();
    for (const b of builds) {
      for (const node of b.snapshot.tree.nodes) {
        const key = treeKey(node);
        if (!key || (key.kind === 'ascendancy' && !ascIds.has(b.id))) continue;
        const id = treeId(key);
        let t = tally.get(id);
        if (!t) tally.set(id, (t = { key, builds: new Set(), ids: new Map() }));
        t.builds.add(b.id);
        t.ids.set(node.id, (t.ids.get(node.id) ?? 0) + 1);
      }
    }
    const yours = new Map<string, TreeKey>();
    for (const node of loaded.tree.nodes) {
      const key = treeKey(node);
      if (key) yours.set(treeId(key), key);
    }
    for (const [id, t] of tally) {
      const of = t.key.kind === 'ascendancy' ? ascBuilds.length : n;
      if (yours.has(id) || !atLeast(t.builds.size, of)) continue;
      candidates.push({
        category: 'tree',
        kind: t.key.kind,
        name: t.key.name,
        share: roundShare(t.builds.size / of),
        count: t.builds.size,
        nodeIds: [...t.ids.entries()].sort((a, b) => b[1] - a[1]).map(([nodeId]) => nodeId),
        ...(t.key.mastery ? { mastery: t.key.mastery } : {}),
      });
    }
    if (!yourAsc) notes.push('The loaded build has no ascendancy: ascendancy notables are not compared.');
    else if (ascBuilds.length < n) {
      notes.push(
        `Ascendancy notables are compared only with the ${ascBuilds.length} of ${n} builds that are ${loaded.info.ascendancy} (their share is of those builds).`,
      );
    }
    const list: UncommonEntry[] = [];
    for (const [id, key] of yours) {
      if (key.kind === 'ascendancy') continue;
      const share = (tally.get(id)?.builds.size ?? 0) / n;
      if (share < UNCOMMON_SHARE) list.push({ name: key.name, share: roundShare(share) });
    }
    uncommon.tree = list;
  }

  // ---- settings
  if (opts.categories.has('settings')) candidates.push(...settingGaps(loaded, builds, minShare, opts.configMeta));

  return { candidates, uncommon, mainSkillMatched, notes };
}
