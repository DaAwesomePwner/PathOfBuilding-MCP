/**
 * community_gap_report, part 2: the what-if variants that measure each gap
 * on the loaded build (src/community-gaps.ts runs them through the probe
 * engine). Reads the loaded build once (compareSnapshot with `gapContext`:
 * the weapon set in use and the allocated passive-tree sockets' kinds, plus
 * list_valid_slots' flask and abyssal-socket data); nothing here changes it.
 */
import type { BuildSession, NamedProbeVariant, SlotInfo } from './build-session.js';
import { activeSlot, type GapCandidate, type ItemCopy, mainGroupIndex, type SampleEntry } from './community-gaps-shares.js';
import { type BuildSnapshot, normalizeSnapshot, type RawSnapshot } from './compare-builds.js';
import type { ProbeGemChange, ProbeVariantResult } from './probe.js';
import { UserError } from './validation.js';

const MAX_GEM_LEVEL = 20;
const MAX_SOCKETED_GEMS = 6;
const MAX_NOTE = 300;

export const clip = (s: string): string => (s.length > MAX_NOTE ? `${s.slice(0, MAX_NOTE - 1)}…` : s);

export interface Probe {
  row: Row;
  variant: NamedProbeVariant;
  copy?: ItemCopy;
  /** The slot the candidate went into. */
  slot?: string;
  replaces?: string;
  /** Weapon 1: the source build's off-hand put in Weapon 2 with it ("empty": Weapon 2 left or made empty), and where it is in that build. */
  offHand?: { name: string; slot?: string };
  /** Flask slot turned on for the what-if. */
  activated?: boolean;
  /** classifyProbe: a full recalculation. */
  fallback?: boolean;
  result?: ProbeVariantResult;
}

export interface Row {
  c: GapCandidate;
  probes: Probe[];
  /** Set when the row cannot be measured (before probing). */
  note?: string;
  /** The probe budget did not cover the whole row: none of it ran. */
  budget?: boolean;
  /** Tree: retried by the sample's node id after an ambiguous name. */
  retried?: boolean;
}

// ---------------------------------------------------------------------------
// The loaded build
// ---------------------------------------------------------------------------

/** An allocated passive-tree socket (compareSnapshot `gapContext`). */
export interface TreeSocket {
  id: number;
  occupied: boolean;
  /** Cluster jewel size it takes (PoB's expansionJewel.size): 0 small, 1 medium, 2 large (and any). Absent: not a cluster socket. */
  expansion?: number;
  /** Takes charms only. */
  charm?: boolean;
}

export interface LoadedContext {
  snapshot: BuildSnapshot;
  /** PoB's weapon set in use (`useSecondWeaponSet`). */
  weaponSet: 1 | 2;
  /** Items by their actual slot name. */
  bySlot: Map<string, string>;
  flaskSlots: SlotInfo[];
  treeSockets: TreeSocket[];
  /** First empty abyssal socket the build's items have (of the weapon set in use). */
  abyssSocket?: string;
}

/** "Weapon 1" / "Weapon 2" as the weapon set in use names them. */
export function weaponSlot(weaponSet: 1 | 2, slot: 'Weapon 1' | 'Weapon 2'): string {
  return weaponSet === 2 ? `${slot} Swap` : slot;
}

type GapSnapshot = RawSnapshot & { weaponSet?: number; sockets?: TreeSocket[] };

export async function loadedContext(session: BuildSession): Promise<LoadedContext> {
  const raw = await session.compareSnapshot<GapSnapshot>(['Life'], { gapContext: true });
  const snapshot = normalizeSnapshot(raw);
  const weaponSet: 1 | 2 = raw.weaponSet === 2 ? 2 : 1;
  const slots = await session.getValidSlots();
  // Abyssal sockets of the weapon set not in use count for nothing.
  const inUse = (parent: string): boolean => !parent.startsWith('Weapon') || parent.includes(' Swap') === (weaponSet === 2);
  const abyss = slots.find((s) => s.parentSlot !== undefined && !s.occupied && inUse(s.parentSlot));
  return {
    snapshot,
    weaponSet,
    bySlot: new Map(snapshot.items.map((i) => [i.slot, i.name ?? i.base ?? '?'])),
    flaskSlots: slots.filter((s) => /^Flask [1-5]$/.test(s.slot)),
    treeSockets: Array.isArray(raw.sockets) ? raw.sockets : [],
    ...(abyss ? { abyssSocket: abyss.slot } : {}),
  };
}

// ---------------------------------------------------------------------------
// Jewel sockets
// ---------------------------------------------------------------------------

const CLUSTER_SIZES: Record<string, number> = { Small: 0, Medium: 1, Large: 2 };

/** A cluster jewel's size index (0 small, 1 medium, 2 large), or null for any other base. */
export function clusterSize(base: string | undefined): number | null {
  const m = /^(Small|Medium|Large) Cluster Jewel$/.exec(base ?? '');
  return m ? CLUSTER_SIZES[m[1]] : null;
}

/**
 * Where a sample jewel is measured, by PoB's own socket rules
 * (ItemsTab:IsItemValidForSlot): an abyss jewel in an empty abyssal socket
 * first (calculator path), else an empty allocated tree socket; a cluster
 * jewel only in an empty allocated cluster socket that takes its size; any
 * other jewel in an empty allocated non-charm socket (plain sockets first).
 */
export function chooseJewelSocket(
  jewel: { abyss?: boolean; base?: string },
  treeSockets: TreeSocket[],
  abyssSocket: string | undefined,
): { slot: string } | { note: string } {
  if (jewel.abyss && abyssSocket) return { slot: abyssSocket };
  const empty = treeSockets.filter((s) => !s.occupied && !s.charm).sort((a, b) => a.id - b.id);
  const size = clusterSize(jewel.base);
  if (size !== null) {
    const fit = empty.find((s) => s.expansion !== undefined && (s.expansion === 2 || size <= s.expansion));
    return fit
      ? { slot: `Jewel ${fit.id}` }
      : { note: `not measured: the build has no empty allocated cluster jewel socket that takes a ${jewel.base}` };
  }
  const fit = empty.find((s) => s.expansion === undefined) ?? empty[0];
  if (fit) return { slot: `Jewel ${fit.id}` };
  return {
    note: jewel.abyss
      ? 'not measured: the build has no empty abyssal socket or empty allocated passive-tree jewel socket'
      : 'not measured: the build has no empty allocated passive-tree jewel socket',
  };
}

// ---------------------------------------------------------------------------
// Variants per gap
// ---------------------------------------------------------------------------

function itemProbes(row: Row, ctx: LoadedContext, samples: Map<string, SampleEntry>): void {
  const { c } = row;
  const copies = c.copies ?? [];
  const add = (p: Omit<Probe, 'row'>): void => {
    row.probes.push({ row, ...p });
  };
  const replaces = (slot: string): { replaces?: string } => (ctx.bySlot.has(slot) ? { replaces: ctx.bySlot.get(slot) } : {});
  if (c.kind === 'item') {
    const slots = c.slot === 'Ring' ? ['Ring 1', 'Ring 2'] : [c.slot === 'Weapon 1' || c.slot === 'Weapon 2' ? weaponSlot(ctx.weaponSet, c.slot) : c.slot!];
    for (const copy of copies) {
      for (const slot of slots) {
        const items: NonNullable<NamedProbeVariant['items']> = [{ slot, itemText: copy.text }];
        let offHand: Probe['offHand'];
        if (c.slot === 'Weapon 1') {
          // Two-handers and off-hands stay coherent: the source build's off-hand comes along (or Weapon 2 is emptied).
          const offSlot = weaponSlot(ctx.weaponSet, 'Weapon 2');
          const off = samples.get(copy.from.build)?.snapshot.items.find((i) => activeSlot(i) === 'Weapon 2' && typeof i.text === 'string');
          if (off) {
            items.push({ slot: offSlot, itemText: off.text! });
            offHand = { name: off.name ?? off.base ?? '?', slot: off.slot };
          } else {
            if (ctx.bySlot.has(offSlot)) items.push({ slot: offSlot, unequip: true });
            offHand = { name: 'empty' };
          }
        }
        add({ variant: { items }, copy, slot, ...replaces(slot), ...(offHand ? { offHand } : {}) });
      }
    }
  } else if (c.kind === 'flask') {
    if (ctx.flaskSlots.length === 0) row.note = 'not measured: the build has no flask slots';
    for (const copy of copies) {
      for (const s of ctx.flaskSlots) {
        const activate = s.active === false;
        add({
          variant: { items: [{ slot: s.slot, itemText: copy.text }], ...(activate ? { flasks: [{ slot: s.slot, active: true }] } : {}) },
          copy,
          slot: s.slot,
          ...replaces(s.slot),
          ...(activate ? { activated: true } : {}),
        });
      }
    }
  } else {
    const socket = chooseJewelSocket(c, ctx.treeSockets, ctx.abyssSocket);
    if ('note' in socket) {
      row.note = socket.note;
      return;
    }
    for (const copy of copies) add({ variant: { items: [{ slot: socket.slot, itemText: copy.text }] }, copy, slot: socket.slot });
  }
}

async function supportProbes(row: Row, ctx: LoadedContext, session: BuildSession): Promise<void> {
  const mi = mainGroupIndex(ctx.snapshot);
  const main = ctx.snapshot.groups[mi];
  if (!main) {
    row.note = 'not measured: the build has no main skill group';
    return;
  }
  let cap = MAX_GEM_LEVEL;
  try {
    const gem = await session.getGemByName(row.c.name);
    if (!gem) throw new UserError(`gem "${row.c.name}" not found`);
    cap = Math.min(MAX_GEM_LEVEL, gem.naturalMaxLevel ?? MAX_GEM_LEVEL);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    row.note = clip(e.message);
    return;
  }
  const level = Math.max(1, Math.min(row.c.gem?.level ?? MAX_GEM_LEVEL, cap));
  const quality = Math.max(0, Math.min(row.c.gem?.quality ?? 0, 40));
  const group = mi + 1;
  main.gems.forEach((g, j) => {
    if (!g.support) return;
    const op: ProbeGemChange = { op: 'set', group, index: j + 1, name: row.c.name, level, quality };
    row.probes.push({ row, variant: { gems: [op] }, replaces: g.name });
  });
  if (main.gems.length < MAX_SOCKETED_GEMS) {
    row.probes.push({ row, variant: { gems: [{ op: 'add', group, name: row.c.name, level, quality }] } });
  }
}

export function treeVariant(c: GapCandidate, byId: boolean): NamedProbeVariant {
  const id = c.nodeIds?.[0];
  if (c.mastery) return { masteries: [{ node: byId && id !== undefined ? id : c.mastery.name, effect: c.mastery.effect }] };
  return { allocate: [byId && id !== undefined ? id : c.name] };
}

export async function planRow(row: Row, ctx: LoadedContext, session: BuildSession, samples: Map<string, SampleEntry>): Promise<void> {
  const { c } = row;
  if (c.unmeasured) {
    row.note = c.unmeasured;
    return;
  }
  if (c.kind === 'item' || c.kind === 'flask' || c.kind === 'jewel') itemProbes(row, ctx, samples);
  else if (c.kind === 'support') await supportProbes(row, ctx, session);
  else if (c.kind === 'config') row.probes.push({ row, variant: { config: { [c.config!.key]: c.config!.value as string | number | boolean } } });
  else row.probes.push({ row, variant: treeVariant(c, false) });
}
