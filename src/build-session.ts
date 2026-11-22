import { encodeBuildCode, resolveBuildSource } from './build-source.js';
import { appliedButFailed, carriedWithoutChanges, engineRestarted } from './engine-messages.js';
import { BuildInfo, LuaBridge, Stats } from './lua-bridge.js';
import { findOptimalLinks, type OptimalLinksResult } from './link-search.js';
import {
  runProbe,
  withoutNulls,
  type ProbeGemChange,
  type ProbeRequest,
  type ProbeResponse,
  type ProbeVariant,
  type ProbeVariantResult,
} from './probe.js';
import { toNumber } from './stat-values.js';
import { DEFAULT_MAX_POINTS, findBestNextNodes, findWorstAllocatedNodes, type RankBy, type TreeSearchResult } from './tree-search.js';
import type { TradeModsResult, TradeQueryRaw } from './trade-search.js';
import { UserError, normalizeItemText } from './validation.js';

/**
 * Bridge timeout for a trade query (one calculation per candidate mod).
 * Measured 1-1.5s per slot on the OccVortex fixture; 90s leaves ~60x headroom
 * for heavy builds without running far past common 60s MCP client timeouts,
 * since a bridge timeout kills the engine and counts as a crash-breaker strike.
 */
const TRADE_QUERY_TIMEOUT_MS = 90_000;

/** Different passive node names one evaluate_changes call may use (each unknown one is a bridge lookup). */
export const MAX_NODE_NAMES = 200;
/** Candidates listed in an ambiguous-name error. */
const MAX_LISTED_MATCHES = 12;

interface NodeMatch {
  id: number;
  name: string;
  type: string;
  allocated: boolean;
  /** Unallocated: passive points of its path from the allocated tree. */
  points?: number;
}

/**
 * Resolves passive node names (case-insensitive, as PoB's node names) to ids
 * for simulate_passive_change and evaluate_changes. The index holds every
 * allocated node and every unallocated node a path from the allocated tree
 * reaches (ascendancy nodes, masteries and class starts excepted), read once
 * per call and only when a name is given. A name is resolved among the nodes
 * the change can apply to (unallocated ones to allocate, allocated ones to
 * deallocate): exactly one is used; several are a UserError listing their
 * ids. When none of that kind match, a single match of the other kind is used
 * (so the engine reports e.g. "already allocated") and several are an error;
 * a name the index lacks is looked up with getNodeInfo (one node).
 */
class NodeNameResolver {
  private index?: Map<string, NodeMatch[]>;
  private readonly single = new Map<string, number | null>();

  constructor(private readonly send: <T>(command: object) => Promise<T>) {}

  private async loadIndex(): Promise<Map<string, NodeMatch[]>> {
    if (this.index) return this.index;
    const index = new Map<string, NodeMatch[]>();
    const add = (m: NodeMatch): void => {
      const key = m.name.toLowerCase();
      if (key === '') return;
      const list = index.get(key) ?? [];
      list.push(m);
      index.set(key, list);
    };
    const allocated = await this.send<{ nodes: TreeNodeInfo[] }>({ cmd: 'getAllocatedNodesDetailed' });
    for (const n of allocated.nodes ?? []) add({ id: n.id, name: n.name, type: n.type, allocated: true });
    const reachable = await this.send<{ nodes: Array<{ id: number; name: string; type: string; points: number }> }>({
      cmd: 'probe',
      candidates: 'allocate',
      maxPoints: 10_000,
    });
    for (const n of reachable.nodes ?? []) add({ id: n.id, name: n.name, type: n.type, allocated: false, points: n.points });
    this.index = index;
    return index;
  }

  async resolve(ref: string | number, mode: 'allocate' | 'deallocate'): Promise<number> {
    if (typeof ref === 'number') return ref;
    const matches = (await this.loadIndex()).get(ref.toLowerCase()) ?? [];
    const relevant = matches.filter((m) => m.allocated === (mode === 'deallocate'));
    if (relevant.length === 1) return relevant[0].id;
    if (relevant.length > 1) throw ambiguousName(ref, relevant);
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) throw ambiguousName(ref, matches);
    const key = ref.toLowerCase();
    if (!this.single.has(key)) {
      const res = await this.send<{ node: TreeNodeInfo | null }>({ cmd: 'getNodeInfo', name: ref });
      this.single.set(key, res.node ? res.node.id : null);
    }
    const id = this.single.get(key);
    if (id === null || id === undefined) throw new UserError(`Passive node not found: "${ref}"`);
    return id;
  }

  async resolveAll(refs: Array<string | number>, mode: 'allocate' | 'deallocate'): Promise<number[]> {
    const ids: number[] = [];
    for (const ref of refs) ids.push(await this.resolve(ref, mode));
    return ids;
  }
}

function ambiguousName(ref: string, matches: NodeMatch[]): UserError {
  const sorted = [...matches].sort((a, b) => (a.points ?? 0) - (b.points ?? 0) || a.id - b.id);
  const listed = sorted.slice(0, MAX_LISTED_MATCHES).map((m) =>
    `${m.id} (${m.allocated ? 'allocated' : `unallocated, ${m.points} point${m.points === 1 ? '' : 's'} away`}, ${m.type})`,
  );
  const more = sorted.length > listed.length ? ` and ${sorted.length - listed.length} more` : '';
  return new UserError(
    `Passive node name "${ref}" matches ${matches.length} nodes: ` +
      `${listed.join(', ')}${more}. Pass the node id instead.`,
  );
}

/**
 * The engine was restarted after a crash or timeout since the last tool call.
 * Thrown once, by the first locked call after the restart, which does nothing else.
 */
export class EngineRestartedError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = 'EngineRestartedError';
  }
}

export interface ItemSnapshot {
  slot: string;
  itemText: string | null;
  itemId: number | null;
}

/**
 * Item state of the active item set from the bridge's captureItemsState: the
 * item id in every non-socket equipment slot the engine has (weapon swap,
 * Ring 3, grafts, flasks, abyssal sockets included) and the build's item list
 * in order. Passive-tree jewel sockets are not in it: the tree state owns them.
 */
export interface ItemsState {
  /** [slot name, item id] for every occupied non-socket slot. */
  slots: Array<[string, number]>;
  itemOrder: number[];
  /**
   * Identity token of each item in `itemOrder` (bridge-side, per item object):
   * a restore is refused, before anything changes, when an id no longer
   * names the item it named at capture: a snapshot taken before the engine
   * was restarted or the build was reloaded.
   */
  itemTokens: string[];
}

/** What the bridge's restoreItemsState found. */
export interface ItemsRestoreReport {
  exact: boolean;
  mismatches?: string[];
  /** Items added since the capture (probe items) that were deleted. */
  removedItemIds?: number[];
}

export interface TreeSnapshot {
  allocatedNodeIds: number[];
  /** Tree version the snapshot was taken on; restoring onto another version rebuilds the spec. */
  treeVersion: string;
  /**
   * Full spec state from the bridge's captureSpecState: nodes, mastery
   * selections, tattoos (hash overrides), socketed jewels, class,
   * ascendancies and tree version. Restored exactly by restoreTreeState.
   */
  state: SpecState;
}

/** What the bridge's restoreTreeState / verifyTreeState found after a restore. */
export interface TreeRestoreReport {
  exact: boolean;
  /** Wanted nodes PoB did not allocate. */
  missingNodeIds?: number[];
  /** Wanted cluster-jewel nodes whose subgraph does not exist (jewel missing). */
  pendingNodeIds?: number[];
  /** Allocated nodes the snapshot does not have. */
  extraNodeIds?: number[];
  /** Nodes PoB re-allocated on its own during the restore that were deallocated again. */
  correctedExtraNodeIds?: number[];
  /** Mastery, tattoo, jewel, class, ascendancy or tree-version differences. */
  mismatches?: string[];
}

/**
 * Run a what-if probe, then restore. A probe error (UserError or not) is
 * thrown unchanged when the restore succeeds. When the restore fails too, the
 * build may be left changed, so the result is always an internal (non-user)
 * error, reported with the "Internal error ... reset_build" advice; its text
 * holds both messages and the probe's error is the `cause`. A restore failure
 * after a successful probe is thrown as is.
 */
async function probeThenRestore<T>(probe: () => Promise<T>, restore: () => Promise<void>): Promise<T> {
  let result: T;
  try {
    result = await probe();
  } catch (probeError) {
    try {
      await restore();
    } catch (restoreError) {
      throw withRestoreFailure(probeError, restoreError);
    }
    throw probeError;
  }
  await restore();
  return result;
}

/** A load result's one-time engine-restart note is not part of the cached build info. */
function withoutRestartNote(info: BuildInfo): BuildInfo {
  const { engineRestart: _note, ...rest } = info;
  return rest;
}

function withRestoreFailure(probeError: unknown, restoreError: unknown): Error {
  const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  const message = `${text(probeError)} (restoring the build afterwards also failed: ${text(restoreError)})`;
  return new Error(message, { cause: probeError });
}

function describeTreeMismatch(report: TreeRestoreReport): string {
  const ids = (list: number[]): string => list.slice(0, 10).join(', ') + (list.length > 10 ? ', ...' : '');
  const parts: string[] = [];
  if (report.missingNodeIds?.length) {
    parts.push(`${report.missingNodeIds.length} node(s) not allocated (${ids(report.missingNodeIds)})`);
  }
  if (report.pendingNodeIds?.length) {
    parts.push(`${report.pendingNodeIds.length} cluster node(s) without their jewel graph (${ids(report.pendingNodeIds)})`);
  }
  if (report.extraNodeIds?.length) {
    parts.push(`${report.extraNodeIds.length} extra node(s) allocated (${ids(report.extraNodeIds)})`);
  }
  if (report.mismatches?.length) {
    parts.push(report.mismatches.slice(0, 10).join('; ') + (report.mismatches.length > 10 ? '; ...' : ''));
  }
  return parts.join('; ') || 'unknown difference';
}

export interface ConfigSnapshot {
  input: Record<string, unknown>;
}

export interface FullSnapshot {
  items: ItemsState;
  tree: TreeSnapshot;
  config: ConfigSnapshot;
  skills: SkillsSnapshot;
  stats: Stats;
}

/**
 * Opaque, JSON-safe state of a whole passive spec (tree version, class,
 * ascendancies, allocated nodes, masteries, jewels, tattoos) produced by the
 * bridge's captureSpecState and fed back to restoreSpecState.
 */
export type SpecState = Record<string, unknown>;

export type UndoEntry = (
  | { kind: 'full'; snapshot: FullSnapshot }
  | { kind: 'config'; snapshot: ConfigSnapshot }
  /** Tree-version change: restores the whole spec, version included. */
  | { kind: 'spec'; state: SpecState }
) & {
  /** Committed commands the bridge had recorded when the entry was taken; undoing it truncates back to that. */
  journal?: number;
};

export interface StatDelta {
  before: number | string | boolean | null | undefined;
  after: number | string | boolean | null | undefined;
  delta: number;
}

export type StatDiff = Record<string, StatDelta>;

class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = (): void => {
        if (!this.locked) {
          this.locked = true;
          resolve(() => {
            this.locked = false;
            const next = this.queue.shift();
            if (next) next();
          });
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }
}

export function computeDiff(before: Stats, after: Stats): StatDiff {
  const diff: StatDiff = {};
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const bRaw = before[key];
    const aRaw = after[key];
    const bNum = toNumber(bRaw);
    const aNum = toNumber(aRaw);
    if (bRaw !== aRaw || bNum !== aNum) {
      diff[key] = { before: bRaw, after: aRaw, delta: aNum - bNum };
    }
  }
  return diff;
}

export class BuildSession {
  private readonly bridge: LuaBridge;
  private readonly mutex = new AsyncMutex();
  private readonly snapshots = new Map<string, { stats: Stats; timestamp: number }>();
  private readonly undoStack: UndoEntry[] = [];
  private readonly maxUndo: number;
  private configMetaCache: Map<string, ConfigVarMetadata> | null = null;
  private originalXML: string | null = null;
  private buildInfo: BuildInfo | null = null;
  /** Undo history was dropped by an engine restart (named when undo finds the stack empty). */
  private undoClearedByRestart = false;

  constructor(
    bridge: LuaBridge,
    options: { maxUndo?: number } = {},
  ) {
    this.bridge = bridge;
    this.maxUndo = options.maxUndo ?? 20;
  }

  // ------------------------------------------------------------------
  // Locking
  // ------------------------------------------------------------------

  /**
   * Serialise an engine operation. A dead engine is restarted only here,
   * before the operation starts (the restart reloads the last committed
   * build; the first call after it reports it and stops). While the operation
   * runs the bridge refuses to respawn, so a crash or timeout part-way
   * through fails the call instead of letting it continue, or roll back,
   * against a fresh engine.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.mutex.acquire();
    try {
      await this.bridge.start();
      this.handleRespawnUnlocked();
      this.bridge.setRespawnHeld(true);
      try {
        return await fn();
      } finally {
        this.bridge.setRespawnHeld(false);
      }
    } finally {
      release();
    }
  }

  /** load_build / reset_build replace the whole build, so they skip the restart notice. */
  private async withLoadLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.mutex.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * After a respawn: undo entries refer to the old process (item identity
   * tokens, ids) and are dropped; labelled snapshots hold only stats and are
   * kept. Throws the one-time notice.
   */
  private handleRespawnUnlocked(): void {
    const report = this.bridge.takeRespawnReport();
    if (!report) return;
    const undoEntriesCleared = this.undoStack.length;
    this.undoStack.length = 0;
    this.undoClearedByRestart = true;
    this.configMetaCache = null;
    this.buildInfo = report.restored === 'build' ? (report.info ?? this.buildInfo) : null;
    throw new EngineRestartedError(
      engineRestarted({
        crashCount: report.crashCount,
        restored: report.restored,
        error: report.error,
        undoEntriesCleared,
        snapshotsKept: this.snapshots.size,
      }),
    );
  }

  /**
   * The build to carry over an engine swap (which already holds the gate
   * exclusively). Live engine: its export. Engine gone after a crash: the
   * accepted build XML if nothing was committed since; otherwise the engine
   * is restarted here (replaying the committed changes) just to export it.
   * When that is impossible (breaker open) or the build was already lost at
   * an earlier restart, the last accepted build is carried with a note
   * saying what is missing.
   */
  async exportForEngineSwap(): Promise<{ xml: string | null; note?: string }> {
    return this.withLoadLock(async () => {
      let rec = this.bridge.getRecoveryState();
      if (!this.bridge.isRunning() && !rec.lostError && rec.xml) {
        if (rec.committed === 0) return { xml: rec.xml };
        if (!this.bridge.isCircuitOpen()) {
          try {
            await this.bridge.start();
          } catch (e) {
            // The restart (or its replay) failed: carry what is known, say what is missing.
            console.error('[pob-mcp] restarting the engine to export the build for an engine swap failed:', (e as Error).message);
            return { xml: rec.xml, note: carriedWithoutChanges(rec.committed, 'restartFailed') };
          }
          this.bridge.takeRespawnReport(); // the swap result reports the restart itself
          rec = this.bridge.getRecoveryState();
        }
      }
      if (rec.lostError && rec.xml) {
        console.error('[pob-mcp] the build was lost at an earlier restart:', rec.lostError);
        return { xml: rec.xml, note: carriedWithoutChanges(-1, 'buildLost') };
      }
      if (!this.bridge.isRunning()) {
        if (!rec.xml) return { xml: null };
        return { xml: rec.xml, note: carriedWithoutChanges(rec.committed, 'breakerOpen') };
      }
      if (!this.buildInfo && !rec.xml) return { xml: null };
      const result = await this.bridge.send<{ ok: true; xml: string }>({ cmd: 'exportXML' });
      return { xml: result.xml };
    });
  }

  /**
   * Run the rest of a change the engine already applied (stats, build info,
   * the report), then commit it: push its undo entry and record its command
   * for replay after a crash. When the rest fails with the engine gone,
   * nothing is committed (the restarted engine will not have the change).
   * With the engine alive the change is in the live build, so it is
   * committed all the same (undo reverts it, a later crash restores it) and
   * the internal error says so.
   */
  private async commitAfterUnlocked<T>(entry: UndoEntry, journal: number, command: object, rest: () => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await rest();
    } catch (err) {
      if (!this.bridge.isRunning()) throw err;
      this.pushUndoEntryUnlocked(entry, journal);
      this.bridge.recordCommitted(command);
      throw new Error(appliedButFailed((err as Error).message), { cause: err });
    }
    this.pushUndoEntryUnlocked(entry, journal);
    this.bridge.recordCommitted(command);
    return result;
  }

  // ------------------------------------------------------------------
  // Build loading
  // ------------------------------------------------------------------

  async loadBuild(source: string): Promise<BuildInfo> {
    // Download and decode outside the lock: a slow pobb.in/pastebin fetch must
    // not block other engine calls. Only the engine load and state swap are serialised.
    // Recorded choice: concurrent loadBuild calls therefore finish in completion
    // order, not call order (a slow URL load started first can land after, and
    // replace, a build code loaded later).
    const xml = await resolveBuildSource(source);
    return this.withLoadLock(async () => {
      // The bridge records the build for crash recovery only once it is accepted.
      const info = await this.bridge.loadBuildXML(xml);
      this.originalXML = xml;
      this.buildInfo = withoutRestartNote(info);
      this.configMetaCache = null;
      this.undoStack.length = 0;
      this.undoClearedByRestart = false;
      this.snapshots.clear();
      return info;
    });
  }

  async resetBuild(): Promise<BuildInfo> {
    if (!this.originalXML) throw new UserError('No build loaded — call load_build first');
    const xml = this.originalXML;
    return this.withLoadLock(async () => {
      const info = await this.bridge.loadBuildXML(xml);
      this.buildInfo = withoutRestartNote(info);
      this.configMetaCache = null;
      this.undoStack.length = 0;
      this.undoClearedByRestart = false;
      this.snapshots.clear();
      return info;
    });
  }

  /** True once a build has been loaded into this session. */
  hasBuild(): boolean {
    return this.buildInfo !== null;
  }

  async getBuildInfo(): Promise<BuildInfo> {
    if (!this.buildInfo) throw new UserError('No build loaded — call load_build first');
    return this.buildInfo;
  }

  // ------------------------------------------------------------------
  // Stats
  // ------------------------------------------------------------------

  async getStats(): Promise<Stats> {
    return this.withLock(() => this.bridge.getStats());
  }

  // ------------------------------------------------------------------
  // Item snapshot/restore
  // ------------------------------------------------------------------

  async snapshotSlot(slot: string): Promise<ItemSnapshot> {
    return this.withLock(() => this.snapshotSlotUnlocked(slot));
  }

  private async snapshotSlotUnlocked(slot: string): Promise<ItemSnapshot> {
    const result = await this.bridge.send<{
      ok: true;
      item: { slot: string; itemId: number; raw?: string | null };
    }>({ cmd: 'getItemInSlot', slot });
    const item = result.item;
    if (!item || !item.itemId || item.itemId === 0 || !item.raw) {
      return { slot, itemText: null, itemId: null };
    }
    return { slot, itemText: item.raw, itemId: item.itemId };
  }

  async restoreSlot(snapshot: ItemSnapshot): Promise<void> {
    return this.withLock(() => this.restoreSlotUnlocked(snapshot));
  }

  /**
   * Put one slot back: re-select the snapshot's item id when the build still
   * holds that item, else (id gone or reused) equip the item text. Items added
   * since are not removed here; probes use the full item state instead.
   */
  private async restoreSlotUnlocked(snapshot: ItemSnapshot): Promise<void> {
    if (snapshot.itemId !== null) {
      const res = await this.bridge.send<{ ok: true; selected: boolean }>({
        cmd: 'selectItem',
        slot: snapshot.slot,
        itemId: snapshot.itemId,
        itemText: snapshot.itemText ?? undefined,
      });
      if (res.selected) return;
    }
    if (snapshot.itemText) {
      await this.bridge.send({
        cmd: 'equipItem',
        slot: snapshot.slot,
        itemText: snapshot.itemText,
      });
    } else {
      await this.bridge.send({ cmd: 'unequipItem', slot: snapshot.slot });
    }
  }

  private async captureItemsStateUnlocked(): Promise<ItemsState> {
    const result = await this.bridge.send<{ ok: true; state: ItemsState }>({ cmd: 'captureItemsState' });
    const state = result.state;
    if (!state || !Array.isArray(state.slots) || !Array.isArray(state.itemOrder) || !Array.isArray(state.itemTokens)) {
      throw new Error('captureItemsState returned a malformed item state');
    }
    return state;
  }

  /** Restore without judging the result (callers check `exact`). */
  private async restoreItemsStateUnlocked(state: ItemsState): Promise<ItemsRestoreReport> {
    return this.bridge.send<{ ok: true } & ItemsRestoreReport>({ cmd: 'restoreItemsState', state });
  }

  private assertItemsExact(report: ItemsRestoreReport): void {
    if (report.exact !== true) {
      const detail = (report.mismatches ?? []).slice(0, 10).join('; ') || 'unknown difference';
      throw new Error(`Item restore was not exact (${detail}); call reset_build to return to the loaded build`);
    }
  }

  /**
   * Restore the tree (which owns passive-tree jewel sockets), run `between`
   * (config), restore the item state (which deletes items added since, so the
   * tree must no longer reference them), re-check the tree once items are
   * back (restoring it again if an item change moved it), run `after`
   * (skills), and only then throw if the tree or the items are not exact.
   */
  private async restoreTreeAndItemsUnlocked(
    tree: TreeSnapshot,
    items: ItemsState,
    between?: () => Promise<void>,
    after?: () => Promise<void>,
  ): Promise<void> {
    // A snapshot whose item ids no longer name its items (taken before the
    // engine was restarted or the build was reloaded) is refused before the
    // tree, which holds jewel item ids, or anything else is touched.
    await this.bridge.send({ cmd: 'checkItemsState', state: items });
    // A tree the probe did not touch is left alone: re-importing it would
    // only reshuffle PoB's allocNodes table (and so the order of the exported
    // node list) and cost a recalculation.
    let treeReport = await this.verifyTreeUnlocked(tree);
    if (!treeReport.exact) treeReport = await this.restoreTreeStateUnlocked(tree);
    if (between) await between();
    const itemsReport = await this.restoreItemsStateUnlocked(items);
    if (treeReport.exact) treeReport = await this.verifyTreeUnlocked(tree);
    if (!treeReport.exact) treeReport = await this.restoreTreeStateUnlocked(tree);
    if (after) await after();
    this.assertTreeExact(treeReport);
    this.assertItemsExact(itemsReport);
  }

  async equipItem(slot: string, itemText: string): Promise<Stats> {
    return this.withLock(async () => {
      const result = await this.bridge.send<{ ok: true; stats: Stats }>({
        cmd: 'equipItem',
        slot,
        itemText,
      });
      return result.stats;
    });
  }

  async unequipItem(slot: string): Promise<Stats> {
    return this.withLock(async () => {
      const result = await this.bridge.send<{ ok: true; stats: Stats }>({
        cmd: 'unequipItem',
        slot,
      });
      return result.stats;
    });
  }

  // ------------------------------------------------------------------
  // Tree snapshot/restore
  // ------------------------------------------------------------------

  async snapshotTree(): Promise<TreeSnapshot> {
    return this.withLock(() => this.snapshotTreeUnlocked());
  }

  private async snapshotTreeUnlocked(): Promise<TreeSnapshot> {
    const result = await this.bridge.send<{
      ok: true;
      state: SpecState & { nodeIds?: unknown; treeVersion?: unknown };
    }>({ cmd: 'captureSpecState' });
    const { nodeIds, treeVersion } = result.state ?? {};
    if (!Array.isArray(nodeIds) || typeof treeVersion !== 'string') {
      throw new Error('captureSpecState returned a malformed tree state');
    }
    return { allocatedNodeIds: [...(nodeIds as number[])], treeVersion, state: result.state };
  }

  /** Restore a tree snapshot exactly; throws when the engine cannot reproduce it. */
  async restoreTree(snapshot: TreeSnapshot): Promise<void> {
    return this.withLock(() => this.restoreTreeUnlocked(snapshot));
  }

  private async restoreTreeUnlocked(snapshot: TreeSnapshot): Promise<void> {
    // An unchanged tree is left alone (see restoreTreeAndItemsUnlocked).
    if ((await this.verifyTreeUnlocked(snapshot)).exact) return;
    this.assertTreeExact(await this.restoreTreeStateUnlocked(snapshot));
  }

  /** Restore without judging the result (restoreAll checks again once items are back). */
  private async restoreTreeStateUnlocked(snapshot: TreeSnapshot): Promise<TreeRestoreReport> {
    const result = await this.bridge.send<{ ok: true } & TreeRestoreReport>({
      cmd: 'restoreTreeState',
      state: snapshot.state,
    });
    return result;
  }

  private async verifyTreeUnlocked(snapshot: TreeSnapshot): Promise<TreeRestoreReport> {
    return this.bridge.send<{ ok: true } & TreeRestoreReport>({
      cmd: 'verifyTreeState',
      state: snapshot.state,
    });
  }

  private assertTreeExact(report: TreeRestoreReport): void {
    if (report.exact !== true) {
      throw new Error(
        `Passive tree restore was not exact (${describeTreeMismatch(report)}); call reset_build to return to the loaded build`,
      );
    }
  }

  async allocNode(nodeId: number): Promise<Stats> {
    return this.withLock(async () => {
      const result = await this.bridge.send<{ ok: true; stats: Stats }>({
        cmd: 'allocNode',
        nodeId,
      });
      return result.stats;
    });
  }

  async deallocNode(nodeId: number): Promise<Stats> {
    return this.withLock(async () => {
      const result = await this.bridge.send<{ ok: true; stats: Stats }>({
        cmd: 'deallocNode',
        nodeId,
      });
      return result.stats;
    });
  }

  // ------------------------------------------------------------------
  // Config snapshot/restore
  // ------------------------------------------------------------------

  async snapshotConfig(): Promise<ConfigSnapshot> {
    return this.withLock(() => this.snapshotConfigUnlocked());
  }

  private async snapshotConfigUnlocked(): Promise<ConfigSnapshot> {
    const result = await this.bridge.send<{ ok: true; input: Record<string, unknown> }>({
      cmd: 'getFullConfig',
    });
    // Bridge response is freshly JSON-parsed each send, so it cannot alias
    // PoB's live tables — no extra clone needed.
    return { input: result.input ?? {} };
  }

  async restoreConfig(snapshot: ConfigSnapshot): Promise<void> {
    return this.withLock(() => this.restoreConfigUnlocked(snapshot));
  }

  private async restoreConfigUnlocked(snapshot: ConfigSnapshot): Promise<void> {
    await this.bridge.send({
      cmd: 'restoreConfig',
      input: snapshot.input,
    });
  }

  async setConfig(options: Record<string, unknown>): Promise<Stats> {
    return this.withLock(async () => {
      await this.validateConfigOptionsUnlocked(options);
      return this.bridge.setConfig(options);
    });
  }

  // ------------------------------------------------------------------
  // Full snapshot/restore
  // ------------------------------------------------------------------

  async snapshotAll(): Promise<FullSnapshot> {
    return this.withLock(() => this.snapshotAllUnlocked());
  }

  private async snapshotAllUnlocked(): Promise<FullSnapshot> {
    // One bridge round-trip for every equipment slot the engine has.
    const items = await this.captureItemsStateUnlocked();
    const tree = await this.snapshotTreeUnlocked();
    const config = await this.snapshotConfigUnlocked();
    const skills = await this.snapshotSkillsUnlocked();
    const stats = await this.bridge.getStats();
    return { items, tree, config, skills, stats };
  }

  async restoreAll(snapshot: FullSnapshot): Promise<void> {
    return this.withLock(() => this.restoreAllUnlocked(snapshot));
  }

  private async restoreAllUnlocked(snapshot: FullSnapshot): Promise<void> {
    // Order matters: restore tree first (cheap, atomic; it also puts socketed
    // jewels back, which PoB keeps on the spec and which the tree state alone
    // owns), then config, then items: every slot re-selects its snapshot item
    // id and items added since are deleted. Once items are back the tree is
    // checked again and, if an item change moved it (or the first pass could
    // not finish without them), restored a second time; a tree or item state
    // that still differs is an error, never a silent difference. Skills are
    // restored last because item changes may add or drop granted-skill
    // groups; the skills snapshot fully replaces the gem list.
    await this.restoreTreeAndItemsUnlocked(
      snapshot.tree,
      snapshot.items,
      () => this.restoreConfigUnlocked(snapshot.config),
      () => this.restoreSkillsUnlocked(snapshot.skills),
    );
  }

  // ------------------------------------------------------------------
  // Safe comparison
  // ------------------------------------------------------------------

  async withTemporaryChange<T>(
    changeFn: (bridge: LuaBridge) => Promise<T>,
  ): Promise<T> {
    return this.withLock(async () => {
      const snapshot = await this.snapshotAllUnlocked();
      return probeThenRestore(
        () => changeFn(this.bridge),
        () => this.restoreAllUnlocked(snapshot),
      );
    });
  }

  /**
   * Evaluate what-if variants (nodes, items, gems, config) through PoB's own
   * calculator without changing the build (see src/probe.ts). Records nothing
   * in the undo stack or the crash-recovery journal.
   */
  async probe(request: ProbeRequest): Promise<ProbeResponse> {
    return this.withLock(() => this.probeUnlocked(request));
  }

  private probeUnlocked(request: ProbeRequest): Promise<ProbeResponse> {
    return runProbe(
      {
        send: (command) => this.bridge.send(command),
        validateConfig: (options) => this.validateConfigOptionsUnlocked(options),
        snapshot: () => this.snapshotAllUnlocked(),
        restore: (snapshot) => this.restoreAllUnlocked(snapshot as FullSnapshot),
        snapshotTree: () => this.snapshotTreeUnlocked(),
        restoreTree: (snapshot) => this.restoreTreeUnlocked(snapshot as TreeSnapshot),
        probeThenRestore,
      },
      request,
    );
  }

  /**
   * probe() whose variants may name passive nodes instead of giving ids, all
   * under one lock. Names resolve as in simulate_passive_change
   * (NodeNameResolver): a name several nodes share is refused with their ids.
   * A variant naming a node that does not exist, or an ambiguous name, gets a
   * user error and is not run; the others still are.
   */
  async probeNamed(request: Omit<ProbeRequest, 'variants'> & { variants: NamedProbeVariant[] }): Promise<ProbeResponse> {
    const names = new Set<string>();
    for (const v of request.variants) {
      for (const ref of [...(v.allocate ?? []), ...(v.deallocate ?? [])]) {
        if (typeof ref === 'string') names.add(ref.toLowerCase());
      }
    }
    if (names.size > MAX_NODE_NAMES) {
      throw new UserError(`${names.size} different node names in one call; at most ${MAX_NODE_NAMES} are allowed (pass node ids instead)`);
    }
    return this.withLock(async () => {
      const resolver = new NodeNameResolver((command) => this.bridge.send(command));
      const results: Array<ProbeVariantResult | undefined> = new Array(request.variants.length);
      const toRun: number[] = [];
      const resolved: ProbeVariant[] = [];
      for (let i = 0; i < request.variants.length; i++) {
        const { allocate, deallocate, ...rest } = request.variants[i];
        try {
          const variant: ProbeVariant = { ...rest };
          const allocIds = allocate && (await resolver.resolveAll(allocate, 'allocate'));
          const deallocIds = deallocate && (await resolver.resolveAll(deallocate, 'deallocate'));
          if (allocIds !== undefined) variant.allocate = allocIds;
          if (deallocIds !== undefined) variant.deallocate = deallocIds;
          resolved.push(variant);
          toRun.push(i);
        } catch (error) {
          if (!(error instanceof UserError)) throw error;
          results[i] = { stats: {}, error: error.message, userError: true };
        }
      }
      const { variants: _variants, ...options } = request;
      const probed = await this.probeUnlocked({ ...options, variants: resolved });
      toRun.forEach((index, j) => {
        results[index] = probed.results[j];
      });
      return { base: probed.base, results: results.map((r) => r ?? { stats: {}, error: 'variant was not run' }) };
    });
  }

  /** The one result of a single-variant probe; any error but a user error is thrown. */
  private async probeOneUnlocked(tool: string, request: ProbeRequest): Promise<ProbeVariantResult> {
    const r = (await this.probeUnlocked(request)).results[0];
    if (r.error !== undefined && !r.userError) throw new Error(`${tool}: ${r.error}`);
    return r;
  }

  // ------------------------------------------------------------------
  // Probe helpers (partial-snapshot what-if queries)
  // ------------------------------------------------------------------

  /**
   * Probe helpers for what-if queries that mutate one subsystem and restore.
   * Each MUST be called inside a withLock block already (they call the
   * *Unlocked variants directly). Use them when only one snapshot domain
   * is needed — withTemporaryChange snapshots everything and is overkill
   * for a tree-only or skills-only probe.
   */
  private async withTreeProbeUnlocked<T>(fn: () => Promise<T>): Promise<T> {
    const snap = await this.snapshotTreeUnlocked();
    return probeThenRestore(fn, () => this.restoreTreeUnlocked(snap));
  }

  private async withSkillsProbeUnlocked<T>(fn: () => Promise<T>): Promise<T> {
    const snap = await this.snapshotSkillsUnlocked();
    return probeThenRestore(fn, () => this.restoreSkillsUnlocked(snap));
  }

  // ------------------------------------------------------------------
  // Labeled snapshots
  // ------------------------------------------------------------------

  async takeSnapshot(label: string): Promise<Stats> {
    return this.withLock(async () => {
      const stats = await this.bridge.getStats();
      this.snapshots.set(label, { stats, timestamp: Date.now() });
      return stats;
    });
  }

  getSnapshot(label: string): Stats | null {
    return this.snapshots.get(label)?.stats ?? null;
  }

  diffSnapshots(labelA: string, labelB: string): StatDiff {
    const a = this.snapshots.get(labelA)?.stats;
    const b = this.snapshots.get(labelB)?.stats;
    if (!a) throw new UserError(`Snapshot not found: ${labelA}`);
    if (!b) throw new UserError(`Snapshot not found: ${labelB}`);
    return computeDiff(a, b);
  }

  // ------------------------------------------------------------------
  // Undo stack
  // ------------------------------------------------------------------

  async pushUndo(): Promise<void> {
    return this.withLock(async () => {
      const snapshot = await this.snapshotAllUnlocked();
      this.pushUndoEntryUnlocked({ kind: 'full', snapshot });
    });
  }

  async undoLastChange(): Promise<Stats> {
    return this.withLock(async () => {
      const entry = this.undoStack.pop();
      if (!entry) {
        throw new UserError(
          'Nothing to undo — the undo stack is empty' +
            (this.undoClearedByRestart
              ? ' (earlier undo history was cleared when the engine was restarted after a crash; ' +
                'reset_build still returns to the originally loaded build)'
              : ''),
        );
      }
      if (entry.kind === 'full') {
        await this.restoreAllUnlocked(entry.snapshot);
      } else if (entry.kind === 'spec') {
        await this.bridge.send({ cmd: 'restoreSpecState', state: entry.state });
        await this.refreshBuildInfoUnlocked();
      } else {
        await this.restoreConfigUnlocked(entry.snapshot);
      }
      // The commands this entry's change and any later ones recorded are reverted.
      if (entry.journal !== undefined) this.bridge.truncateCommitted(entry.journal);
      return this.bridge.getStats();
    });
  }

  undoStackDepth(): number {
    return this.undoStack.length;
  }

  private pushUndoEntryUnlocked(entry: UndoEntry, journal = this.bridge.committedCount()): void {
    this.undoStack.push({ ...entry, journal });
    while (this.undoStack.length > this.maxUndo) this.undoStack.shift();
  }

  /** Re-read class / tree version after a change that can alter them. */
  private async refreshBuildInfoUnlocked(): Promise<void> {
    const result = await this.bridge.send<{ ok: true; info: BuildInfo }>({ cmd: 'getBuildInfo' });
    this.buildInfo = result.info;
  }

  // ------------------------------------------------------------------
  // Misc
  // ------------------------------------------------------------------

  async exportXML(): Promise<string> {
    return this.withLock(async () => {
      const result = await this.bridge.send<{ ok: true; xml: string }>({ cmd: 'exportXML' });
      return result.xml;
    });
  }

  async getSkillBreakdown(skillIndex?: number): Promise<SkillBreakdown> {
    return this.withLock(async () => {
      const result = await this.bridge.send<{ ok: true; breakdown: SkillBreakdown }>({
        cmd: 'getSkillBreakdown',
        index: skillIndex,
      });
      return result.breakdown;
    });
  }

  async listEquippedItems(): Promise<EquippedItem[]> {
    return this.withLock(async () => {
      const result = await this.bridge.send<{ ok: true; items: EquippedItem[] }>({
        cmd: 'listEquippedItems',
      });
      return result.items;
    });
  }

  // ------------------------------------------------------------------
  // Trade searches (read-only: PoB's TradeQueryGenerator on the live build)
  // ------------------------------------------------------------------

  /**
   * Runs PoB's weighted trade query generator for one slot. It simulates every
   * candidate mod on the build (about 1-1.5s on the OccVortex fixture, far
   * longer on heavy builds), hence the long bridge timeout. Changes nothing.
   */
  async generateTradeQuery(command: Record<string, unknown>): Promise<TradeQueryRaw> {
    return this.withLock(async () => {
      const result = await this.bridge.send<{ ok: true } & TradeQueryRaw>(
        { ...command, cmd: 'tradeQuery' },
        TRADE_QUERY_TIMEOUT_MS,
      );
      return result;
    });
  }

  async searchTradeMods(slot: string, query: string, limit: number): Promise<TradeModsResult> {
    return this.withLock(async () => {
      const result = await this.bridge.send<{ ok: true } & TradeModsResult>({ cmd: 'searchTradeMods', slot, query, limit });
      return { itemCategory: result.itemCategory, total: result.total, mods: result.mods };
    });
  }

  // ------------------------------------------------------------------
  // Phase 3: item swap / compare
  // ------------------------------------------------------------------

  async getValidSlots(): Promise<SlotInfo[]> {
    return this.withLock(async () => {
      const result = await this.bridge.send<{ ok: true; slots: SlotInfo[] }>({
        cmd: 'getValidSlots',
      });
      return result.slots;
    });
  }

  async getItemInSlot(slot: string): Promise<SlotItem | null> {
    return this.withLock(async () => {
      const result = await this.bridge.send<{ ok: true; item: SlotItem & { itemId: number } }>({
        cmd: 'getItemInSlot',
        slot,
      });
      const item = result.item;
      if (!item || !item.itemId || item.itemId === 0 || !item.raw) return null;
      return item;
    });
  }

  async swapItemWithDiff(slot: string, itemText: string): Promise<StatDiffResult> {
    itemText = normalizeItemText(itemText);
    return this.withLock(() => this.itemMutationWithUndoUnlocked({ cmd: 'equipItem', slot, itemText }));
  }

  async unequipItemWithDiff(slot: string): Promise<StatDiffResult> {
    return this.withLock(() => this.itemMutationWithUndoUnlocked({ cmd: 'unequipItem', slot }));
  }

  /**
   * A committed item change with a full undo entry. The replaced item stays in
   * the build, so undo re-selects it by id (and deletes the added one). The
   * snapshot is taken before the change; it is not pushed when the bridge
   * refuses the change with a UserError, which it does before touching the
   * build (unknown slot, item that does not fit, unparseable text).
   */
  private async itemMutationWithUndoUnlocked(command: Record<string, unknown>): Promise<StatDiffResult> {
    const undoSnap = await this.snapshotAllUnlocked();
    const before = undoSnap.stats;
    const entry: UndoEntry = { kind: 'full', snapshot: undoSnap };
    const journal = this.bridge.committedCount();
    try {
      await this.bridge.send(command);
    } catch (err) {
      // A refusal changed nothing; any other failure may have (undo reverts it) unless the engine is gone.
      if (!(err instanceof UserError) && this.bridge.isRunning()) this.pushUndoEntryUnlocked(entry, journal);
      throw err;
    }
    return this.commitAfterUnlocked(entry, journal, command, async () => {
      const after = await this.bridge.getStats();
      return { before, after, diff: computeDiff(before, after) };
    });
  }

  async compareItems(slot: string, candidates: string[]): Promise<ComparisonResult> {
    return this.withLock(async () => {
      // An unknown slot, or one PoB hides on this tree, is refused for the
      // whole call rather than once per candidate.
      await this.bridge.send({ cmd: 'checkSlotUsable', slot });
      // Snapshot the slot's current item — still needed for the result's baseline.item field.
      const baselineItem = await this.snapshotSlotUnlocked(slot);
      const baselineStats = await this.bridge.getStats();

      // One probe variant per candidate, equipped as swap_item would and undone
      // (a passive-tree jewel socket or a skill-granting item takes the probe's
      // full-recalculation fallback). A candidate refused as input (does not
      // fit, cannot be parsed) gets its error; any other failure fails the call.
      const texts = candidates.map(normalizeItemText);
      const probed = await this.probeUnlocked({
        variants: texts.map((itemText) => ({ items: [{ slot, itemText }] })),
      });
      const results: ComparisonCandidate[] = texts.map((itemText, i) => {
        const r = probed.results[i];
        if (r.error !== undefined && !r.userError) throw new Error(`compare_items: candidate ${i}: ${r.error}`);
        const stats = r.error === undefined ? withoutNulls(r.stats) : null;
        return { index: i, itemText, stats, diff: stats ? computeDiff(baselineStats, stats) : {}, error: r.error ?? null };
      });

      const bestForKey = (key: string): number | null => {
        let bestIdx: number | null = null;
        let bestVal = -Infinity;
        for (const r of results) {
          if (!r.stats) continue;
          const v = Number(r.stats[key] ?? 0);
          if (Number.isFinite(v) && v > bestVal) {
            bestVal = v;
            bestIdx = r.index;
          }
        }
        return bestIdx;
      };

      return {
        baseline: { item: baselineItem, stats: baselineStats },
        candidates: results,
        bestForDPS: bestForKey('CombinedDPS'),
        bestForEHP: bestForKey('TotalEHP'),
        bestForLife: bestForKey('Life'),
      };
    });
  }

  // ------------------------------------------------------------------
  // Phase 4: passive tree analysis
  // ------------------------------------------------------------------

  /**
   * Move the active passive tree to PoB's latest tree version (keeping a
   * ruthless/alternate sub-type, like PoB's own convert button). Pushes a
   * spec-level undo entry carrying the old version; a no-op (already latest)
   * pushes nothing.
   */
  async convertTreeToLatest(): Promise<TreeConversionResult> {
    if (!this.buildInfo) throw new UserError('No build loaded — call load_build first');
    return this.withLock(async () => {
      const before = await this.bridge.getStats();
      // Undo state is taken before anything changes, so a conversion can never
      // land without one.
      const captured = await this.bridge.send<{ ok: true; state: SpecState & { treeVersion?: unknown } }>({
        cmd: 'captureSpecState',
      });
      const treeVersion = captured.state?.treeVersion;
      if (typeof treeVersion !== 'string') {
        throw new Error('captureSpecState returned no tree version');
      }
      const undoState = { ...captured.state, treeVersion };
      const spawn = this.bridge.getSpawnCount();
      let res: { ok: true; result: RawTreeConversion; stats: Stats };
      try {
        res = await this.bridge.send({ cmd: 'convertTreeToLatest' });
      } catch (err) {
        await this.rollBackTreeUnlocked(undoState, spawn);
        throw err;
      }
      const raw = res.result;
      if (!raw.converted) {
        return { converted: false, fromVersion: raw.fromVersion, toVersion: raw.toVersion };
      }
      const command = { cmd: 'convertTreeToLatest' };
      return this.commitAfterUnlocked({ kind: 'spec', state: undoState }, this.bridge.committedCount(), command, async () => {
        await this.refreshBuildInfoUnlocked();
        const after = res.stats;
        const list = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);
        return {
          converted: true,
          fromVersion: raw.fromVersion,
          toVersion: raw.toVersion,
          allocatedBefore: raw.allocatedBefore ?? 0,
          allocatedAfter: raw.allocatedAfter ?? 0,
          pointsBefore: raw.pointsBefore,
          pointsAfter: raw.pointsAfter,
          lostNodeCount: raw.lostNodeCount ?? 0,
          lostNodes: list(raw.lostNodes),
          lostNodesOmitted: raw.lostNodesOmitted ?? 0,
          changedNodeCount: raw.changedNodeCount ?? 0,
          changedNodes: list(raw.changedNodes),
          changedNodesOmitted: raw.changedNodesOmitted ?? 0,
          droppedMasteryCount: raw.droppedMasteryCount ?? 0,
          droppedMasteries: list(raw.droppedMasteries),
          droppedMasteriesOmitted: raw.droppedMasteriesOmitted ?? 0,
          droppedTattooCount: raw.droppedTattooCount ?? 0,
          droppedTattoos: list(raw.droppedTattoos),
          droppedTattoosOmitted: raw.droppedTattoosOmitted ?? 0,
          before,
          after,
          diff: computeDiff(before, after),
        };
      });
    });
  }

  /**
   * After a failed convert: the bridge already swaps the old spec back when
   * activating the new one fails, but a failure after a successful swap (e.g.
   * while building the report) would leave the tree converted with no undo
   * entry. Put the captured spec back whenever the tree version moved.
   * Skipped when the engine process stopped (crash, or killed after a
   * timeout) or was replaced: the captured spec belongs to the old process,
   * and the restarted engine reloads the last committed build anyway.
   */
  private async rollBackTreeUnlocked(state: SpecState & { treeVersion: string }, spawn: number): Promise<void> {
    if (!this.bridge.isRunning() || this.bridge.getSpawnCount() !== spawn) {
      console.error('[pob-mcp] tree conversion failed and the engine stopped; no rollback on a restarted engine');
      return;
    }
    try {
      const info = await this.bridge.send<{ ok: true; info: BuildInfo }>({ cmd: 'getBuildInfo' });
      if (info.info.treeVersion !== state.treeVersion) {
        await this.bridge.send({ cmd: 'restoreSpecState', state });
      }
      await this.refreshBuildInfoUnlocked();
    } catch (rollbackError) {
      console.error('[pob-mcp] could not roll back a failed tree conversion:', rollbackError);
    }
  }

  async getPassiveTree(): Promise<PassiveTreeInfo> {
    return this.withLock(async () => {
      const allocatedRes = await this.bridge.send<{ ok: true; nodes: TreeNodeInfo[] }>({
        cmd: 'getAllocatedNodesDetailed',
      });
      const summaryRes = await this.bridge.send<{ ok: true; summary: PassiveTreeSummary }>({
        cmd: 'getPassiveTreeSummary',
      });
      const allocated = allocatedRes.nodes ?? [];
      return {
        allocatedNodes: allocated,
        keystones: allocated.filter((n) => n.isKeystone),
        notables: allocated.filter((n) => n.isNotable),
        summary: summaryRes.summary,
      };
    });
  }

  async getReachableNodes(): Promise<TreeNodeInfo[]> {
    return this.withLock(async () => {
      const result = await this.bridge.send<{ ok: true; nodes: TreeNodeInfo[] }>({
        cmd: 'getReachableNodes',
      });
      return result.nodes ?? [];
    });
  }

  async getNodeInfo(ref: { nodeId?: number; name?: string }): Promise<TreeNodeInfo | null> {
    return this.withLock(async () => {
      const result = await this.bridge.send<{ ok: true; node: TreeNodeInfo | null }>({
        cmd: 'getNodeInfo',
        nodeId: ref.nodeId,
        name: ref.name,
      });
      return result.node;
    });
  }

  async isTreeConnected(): Promise<{ connected: boolean; orphanedNodes: number[] }> {
    return this.withLock(() => this.treeConnectedUnlocked());
  }

  private async treeConnectedUnlocked(): Promise<{ connected: boolean; orphanedNodes: number[] }> {
    const result = await this.bridge.send<{
      ok: true;
      result: { connected: boolean; orphanedNodes: number[] };
    }>({ cmd: 'isTreeConnected' });
    return result.result;
  }

  async simulatePassiveChange(
    allocate: Array<string | number> = [],
    deallocate: Array<string | number> = [],
  ): Promise<{ statDiff: StatDiff; valid: boolean; validationErrors: string[]; before: Stats; after: Stats }> {
    return this.withLock(async () => {
      const resolver = new NodeNameResolver((command) => this.bridge.send(command));
      const allocIds = await resolver.resolveAll(allocate, 'allocate');
      const deallocIds = await resolver.resolveAll(deallocate, 'deallocate');
      const before = await this.bridge.getStats();

      // Probe path: exactly one node to allocate on a connected tree. The probe
      // allocates it with its path as allocNodes does (same stats,
      // test/probe-test.ts), and a path from a connected tree keeps it
      // connected, so `valid` is what isTreeConnected would say. A node the
      // probe refuses (already allocated, unreachable, ...) goes through the
      // mutate path below, which gives its result or error as before. Every
      // other request (deallocations, several nodes) uses the mutate path.
      if (allocIds.length === 1 && deallocIds.length === 0 && (await this.treeConnectedUnlocked()).connected) {
        const r = await this.probeOneUnlocked('simulate_passive_change', { variants: [{ allocate: allocIds }] });
        if (r.error === undefined) {
          const probed = withoutNulls(r.stats);
          return { before, after: probed, statDiff: computeDiff(before, probed), valid: true, validationErrors: [] };
        }
      }

      let after: Stats = before;
      let connectionResult: { connected: boolean; orphanedNodes: number[] } = {
        connected: true,
        orphanedNodes: [],
      };

      await this.withTreeProbeUnlocked(async () => {
        if (deallocIds.length > 0) {
          await this.bridge.send({ cmd: 'deallocNodes', nodeIds: deallocIds });
        }
        if (allocIds.length > 0) {
          await this.bridge.send({ cmd: 'allocNodes', nodeIds: allocIds });
        }
        after = await this.bridge.getStats();
        const conn = await this.bridge.send<{
          ok: true;
          result: { connected: boolean; orphanedNodes: number[] };
        }>({ cmd: 'isTreeConnected' });
        connectionResult = conn.result;
      });

      return {
        before,
        after,
        statDiff: computeDiff(before, after),
        valid: connectionResult.connected,
        validationErrors: connectionResult.connected
          ? []
          : [`Tree disconnected — ${connectionResult.orphanedNodes.length} orphaned node(s)`],
      };
    });
  }

  /**
   * Unallocated nodes whose PoB path costs at most `maxPoints` points, ranked
   * by gain per point (or total gain), evaluated through the probe engine
   * (src/tree-search.ts). Changes nothing; pushes nothing to undo.
   */
  async findBestNextNodes(
    count = 10,
    optimizeFor = 'CombinedDPS',
    includeJewelSockets = false,
    maxPoints = DEFAULT_MAX_POINTS,
    rankBy: RankBy = 'perPoint',
  ): Promise<TreeSearchResult> {
    return this.withLock(() =>
      findBestNextNodes(this.treeSearchDeps(), { count, optimizeFor, includeJewelSockets, maxPoints, rankBy }),
    );
  }

  /**
   * Allocated nodes ranked by the loss of removing each together with the
   * nodes that depend on it, per refunded point (or in total), evaluated
   * through the probe engine (src/tree-search.ts). Changes nothing.
   */
  async findWorstAllocatedNodes(
    count = 10,
    optimizeFor = 'CombinedDPS',
    rankBy: RankBy = 'perPoint',
  ): Promise<TreeSearchResult> {
    return this.withLock(() => findWorstAllocatedNodes(this.treeSearchDeps(), { count, optimizeFor, rankBy }));
  }

  private treeSearchDeps(): { send<T>(command: object): Promise<T>; probe(request: ProbeRequest): Promise<ProbeResponse> } {
    return { send: (command) => this.bridge.send(command), probe: (request) => this.probeUnlocked(request) };
  }

  /**
   * Remove an allocated keystone (with the nodes depending on it) or allocate
   * an unallocated one (with its path), as deallocNode / allocNode would, in
   * one probe variant. A keystone no path reaches is a UserError.
   */
  async evaluateKeystone(keystoneName: string): Promise<KeystoneEvaluation> {
    return this.withLock(async () => {
      const lookup = await this.bridge.send<{ ok: true; node: TreeNodeInfo | null }>({
        cmd: 'getNodeInfo',
        name: keystoneName,
      });
      const node = lookup.node;
      if (!node) throw new UserError(`Keystone not found: "${keystoneName}"`);
      if (!node.isKeystone) throw new UserError(`"${keystoneName}" is not a keystone`);

      const isAllocated = node.alloc;
      const baselineStats = await this.bridge.getStats();
      const r = await this.probeOneUnlocked('evaluate_keystone', {
        variants: [isAllocated ? { deallocate: [node.id] } : { allocate: [node.id] }],
      });
      if (r.error !== undefined) throw new UserError(r.error);
      const after = withoutNulls(r.stats);

      return {
        keystone: node.name,
        nodeId: node.id,
        currentlyAllocated: isAllocated,
        action: isAllocated ? 'removed' : 'added',
        before: baselineStats,
        after,
        statDiff: computeDiff(baselineStats, after),
        nodeStats: node.stats ?? [],
      };
    });
  }

  // ------------------------------------------------------------------
  // Phase 5: skill gem inspection / mutation
  // ------------------------------------------------------------------

  async snapshotSkills(): Promise<SkillsSnapshot> {
    return this.withLock(() => this.snapshotSkillsUnlocked());
  }

  private async snapshotSkillsUnlocked(): Promise<SkillsSnapshot> {
    const result = await this.bridge.send<{ ok: true; snapshot: SkillsSnapshot }>({
      cmd: 'snapshotSkills',
    });
    // Bridge response is freshly JSON-parsed each send, so the snapshot object
    // is already independent from any in-Lua state.
    return result.snapshot;
  }

  async restoreSkills(snapshot: SkillsSnapshot): Promise<void> {
    return this.withLock(() => this.restoreSkillsUnlocked(snapshot));
  }

  private async restoreSkillsUnlocked(snapshot: SkillsSnapshot): Promise<void> {
    await this.bridge.send({ cmd: 'restoreSkills', snapshot });
  }

  async listSkillGroups(): Promise<SkillGroupInfo[]> {
    return this.withLock(async () => {
      const result = await this.bridge.send<{ ok: true; groups: SkillGroupInfo[] }>({
        cmd: 'getSocketGroups',
      });
      return result.groups ?? [];
    });
  }

  async getGemByName(name: string): Promise<GemDataInfo> {
    return this.withLock(async () => {
      const result = await this.bridge.send<{ ok: true; gem: GemDataInfo }>({
        cmd: 'getGemByName',
        name,
      });
      return result.gem;
    });
  }

  async getAvailableSupports(
    activeSkillTags?: string[],
    includeAwakened = false,
  ): Promise<GemDataInfo[]> {
    return this.withLock(async () => {
      const result = await this.bridge.send<{ ok: true; supports: GemDataInfo[] }>({
        cmd: 'getAvailableSupports',
        activeSkillTags,
        includeAwakened,
      });
      return result.supports ?? [];
    });
  }

  /**
   * Evaluate gem-change variants on one socket group (each list of changes is
   * one variant), returning each variant's stats or its user error; any other
   * failure fails the call. A normal group goes through the probe engine
   * (PoB's calculator, nothing changes); a group granted by an item or the
   * passive tree (the probe refuses those) keeps the old path: change the
   * gems through the bridge, full recalc, exact skills restore.
   */
  private async gemVariantsUnlocked(
    tool: string,
    groupIndex: number,
    variants: ProbeGemChange[][],
  ): Promise<Array<{ stats: Stats | null; error: string | null }>> {
    const groups = (await this.bridge.send<{ ok: true; groups: SkillGroupInfo[] }>({ cmd: 'getSocketGroups' })).groups ?? [];
    if (!groups[groupIndex - 1]?.source) {
      const probed = await this.probeUnlocked({ variants: variants.map((gems) => ({ gems })) });
      return probed.results.map((r) => {
        if (r.error === undefined) return { stats: withoutNulls(r.stats), error: null };
        if (!r.userError) throw new Error(`${tool}: ${r.error}`);
        return { stats: null, error: r.error.replace(/^gems\[\d+\]: /, '') };
      });
    }
    const out: Array<{ stats: Stats | null; error: string | null }> = [];
    for (const changes of variants) {
      try {
        const stats = await this.withSkillsProbeUnlocked(async () => {
          for (const ch of changes) await this.sendGemChangeUnlocked(tool, ch);
          return this.bridge.getStats();
        });
        out.push({ stats, error: null });
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
        out.push({ stats: null, error: error.message });
      }
    }
    return out;
  }

  /** One gem change through the bridge's mutating gem commands (granted groups only, inside a skills probe). */
  private async sendGemChangeUnlocked(tool: string, ch: ProbeGemChange): Promise<void> {
    if (ch.op === 'remove') {
      await this.bridge.send({ cmd: 'removeGem', groupIndex: ch.group, gemIndex: ch.index });
    } else if (ch.op === 'set' && ch.name !== undefined) {
      await this.bridge.send({ cmd: 'setGem', groupIndex: ch.group, gemIndex: ch.index, gemName: ch.name, level: ch.level, quality: ch.quality });
    } else if (ch.op === 'set' && ch.enabled === undefined) {
      await this.bridge.send({ cmd: 'setGemLevel', groupIndex: ch.group, gemIndex: ch.index, level: ch.level, quality: ch.quality });
    } else {
      throw new Error(`${tool}: gem change ${ch.op} is not supported on a granted skill group`);
    }
  }

  /**
   * Swap one gem (as setGem does) and return the stat diff, without changing
   * the build (gemVariantsUnlocked). A refused change is a UserError.
   */
  async swapGemWithDiff(
    skillGroupIndex: number,
    gemIndex: number,
    newGemName: string,
    level?: number,
    quality?: number,
  ): Promise<StatDiffResult> {
    return this.withLock(async () => {
      const before = await this.bridge.getStats();
      const [r] = await this.gemVariantsUnlocked('swap_gem', skillGroupIndex, [
        [{ op: 'set', group: skillGroupIndex, index: gemIndex, name: newGemName, level, quality }],
      ]);
      if (!r.stats) throw new UserError(r.error ?? 'swap_gem: the change was refused');
      return { before, after: r.stats, diff: computeDiff(before, r.stats) };
    });
  }

  /**
   * The weakest enabled support of a group (the smallest CombinedDPS loss when
   * removed), then each candidate in its place at level 20 / quality 20. A
   * candidate the engine refuses (unknown gem, ...) carries its error and
   * null numbers; any other failure fails the call.
   */
  async compareSupports(
    skillGroupIndex: number,
    candidates: string[],
  ): Promise<SupportComparison> {
    return this.withLock(async () => {
      const groupsRes = await this.bridge.send<{ ok: true; groups: SkillGroupInfo[] }>({
        cmd: 'getSocketGroups',
      });
      const group = groupsRes.groups[skillGroupIndex - 1];
      if (!group) throw new UserError(`Skill group ${skillGroupIndex} not found`);
      const supports = group.gems.filter((g) => g.isSupport && g.enabled);
      if (supports.length === 0) {
        throw new UserError(`Skill group ${skillGroupIndex} has no enabled support gems to swap`);
      }

      const baselineStats = await this.bridge.getStats();
      const baselineDPS = toNumber(baselineStats.CombinedDPS);

      // Phase 1: the weakest support, by removing each in turn.
      const removals = await this.gemVariantsUnlocked(
        'compare_supports',
        skillGroupIndex,
        supports.map((s) => [{ op: 'remove', group: skillGroupIndex, index: s.index }]),
      );
      let weakest: { name: string; index: number; loss: number } | null = null;
      for (const [i, support] of supports.entries()) {
        const r = removals[i];
        if (!r.stats) continue; // refused: cannot be ranked
        const loss = baselineDPS - toNumber(r.stats.CombinedDPS);
        if (weakest === null || loss < weakest.loss) weakest = { name: support.name, index: support.index, loss };
      }
      if (weakest === null) {
        throw new UserError(`No support of skill group ${skillGroupIndex} could be removed: ${removals[0]?.error ?? 'refused'}`);
      }
      const w = weakest;

      // Phase 2: each candidate in the weakest support's place.
      const swaps = await this.gemVariantsUnlocked(
        'compare_supports',
        skillGroupIndex,
        candidates.map((name) => [{ op: 'set', group: skillGroupIndex, index: w.index, name, level: 20, quality: 20 }]),
      );
      const results: SupportCandidate[] = candidates.map((name, i) => {
        const r = swaps[i];
        const dps = r.stats ? toNumber(r.stats.CombinedDPS) : null;
        return { name, dps, dpsDelta: dps === null ? null : dps - baselineDPS, error: r.error };
      });
      results.sort((a, b) => (b.dps ?? -Infinity) - (a.dps ?? -Infinity));

      return {
        weakestCurrentSupport: { name: w.name, gemIndex: w.index, dpsContribution: w.loss },
        slotTested: w.index,
        baselineDPS,
        candidates: results,
      };
    });
  }

  /** CombinedDPS at each gem level (as setGemLevel would set it), without changing the build. */
  async evaluateGemLevels(
    skillGroupIndex: number,
    gemIndex: number,
    levels?: number[],
  ): Promise<GemLevelScaling[]> {
    return this.withLock(async () => {
      const groupsRes = await this.bridge.send<{ ok: true; groups: SkillGroupInfo[] }>({
        cmd: 'getSocketGroups',
      });
      const group = groupsRes.groups[skillGroupIndex - 1];
      if (!group) throw new UserError(`Skill group ${skillGroupIndex} not found`);
      const gem = group.gems[gemIndex - 1];
      if (!gem) throw new UserError(`Gem ${gemIndex} not found in group ${skillGroupIndex}`);

      const currentLevel = gem.level ?? 20;
      const baselineStats = await this.bridge.getStats();
      const baselineDPS = toNumber(baselineStats.CombinedDPS);

      const testLevels = levels && levels.length > 0
        ? Array.from(new Set(levels)).sort((a, b) => a - b)
        : (() => {
            const arr: number[] = [];
            for (let lv = Math.max(1, currentLevel - 1); lv <= Math.min(currentLevel + 4, 24); lv++) {
              arr.push(lv);
            }
            return arr;
          })();

      const probed = await this.gemVariantsUnlocked(
        'evaluate_gem_levels',
        skillGroupIndex,
        testLevels.map((level) => [{ op: 'set', group: skillGroupIndex, index: gemIndex, level }]),
      );
      return testLevels.map((level, i) => {
        const r = probed[i];
        const dps = r.stats ? toNumber(r.stats.CombinedDPS) : null;
        return { level, dps, dpsDelta: dps === null ? null : dps - baselineDPS, error: r.error };
      });
    });
  }

  /**
   * The best support combination for an active skill in the main socket
   * group, searched on the probe engine (src/link-search.ts). Changes nothing.
   */
  async findOptimalLinks(
    activeSkill: string,
    availableSlots: number,
    constraints: string[] = [],
    options: { topN?: number; topAlternatives?: number } = {},
  ): Promise<OptimalLinksResult> {
    if (availableSlots < 1) throw new UserError('availableSlots must be >= 1');
    return this.withLock(() =>
      findOptimalLinks(
        { send: (command) => this.bridge.send(command), probe: (request) => this.probeUnlocked(request) },
        { activeSkill, supportSlots: availableSlots, constraints, topN: options.topN, topAlternatives: options.topAlternatives },
      ),
    );
  }

  // ------------------------------------------------------------------
  // Phase 6: Config and scenario tools
  // ------------------------------------------------------------------

  async getConfigMetadata(): Promise<ConfigVarMetadata[]> {
    return this.withLock(async () => [...(await this.getConfigMetaMapUnlocked()).values()]);
  }

  /**
   * Config metadata keyed by option var, fetched from the running engine and
   * cached until the next build load/reset (the engine's ConfigOptions can
   * differ between PoB installs, never within one loaded build).
   */
  private async getConfigMetaMapUnlocked(): Promise<Map<string, ConfigVarMetadata>> {
    if (this.configMetaCache) return this.configMetaCache;
    const result = await this.bridge.send<{ ok: true; metadata: ConfigVarMetadata[] }>({
      cmd: 'getConfigMetadata',
    });
    const map = new Map<string, ConfigVarMetadata>();
    for (const entry of result.metadata ?? []) map.set(entry.var, entry);
    if (map.size === 0) {
      // Don't cache a failed load: that would reject every key until the next build load.
      throw new Error('could not load PoB config metadata (engine returned no options); retry, or reset_build if it persists');
    }
    this.configMetaCache = map;
    return map;
  }

  /**
   * Reject config options PoB does not know (they would silently no-op) or
   * whose value type is clearly wrong. Pure check — mutates nothing.
   */
  private async validateConfigOptionsUnlocked(
    options: Record<string, unknown>,
    context?: string,
  ): Promise<void> {
    const meta = await this.getConfigMetaMapUnlocked();
    const where = context ? ` (${context})` : '';
    const unknown = Object.keys(options).filter(
      (k) => !meta.has(k) && !Object.hasOwn(EXTRA_CONFIG_KEYS, k),
    );
    if (unknown.length > 0) {
      const lines = unknown.map((k) => {
        const near = closestConfigKeys(k, [...meta.keys()]);
        return near.length > 0 ? `"${k}" (closest: ${near.join(', ')})` : `"${k}"`;
      });
      throw new UserError(
        `Unknown config key${unknown.length > 1 ? 's' : ''}${where}: ${lines.join('; ')}. ` +
          `Use get_config to list valid keys.`,
      );
    }
    for (const [key, value] of Object.entries(options)) {
      if (value === null || value === undefined) continue;
      const problem = describeConfigValueProblem(
        meta.get(key) ?? (Object.hasOwn(EXTRA_CONFIG_KEYS, key) ? EXTRA_CONFIG_KEYS[key] : undefined),
        value,
      );
      if (problem) throw new UserError(`Invalid value for config key "${key}"${where}: ${problem}`);
    }
  }

  async getConfigOrganized(): Promise<OrganizedConfig> {
    return this.withLock(async () => {
      const configRes = await this.bridge.send<{ ok: true; config: Record<string, unknown> }>({ cmd: 'getConfig' });
      const metaRes = await this.bridge.send<{ ok: true; metadata: ConfigVarMetadata[] }>({ cmd: 'getConfigMetadata' });
      const input = configRes.config ?? {};
      const metadata = metaRes.metadata ?? [];
      const sections: Record<string, ConfigEntry[]> = {};
      const seen = new Set<string>();
      for (const entry of metadata) {
        const sec = entry.section || 'Other';
        if (!sections[sec]) sections[sec] = [];
        const value = Object.prototype.hasOwnProperty.call(input, entry.var)
          ? input[entry.var]
          : null;
        sections[sec].push({
          key: entry.var,
          label: entry.label,
          type: entry.type,
          value: value as ConfigEntry['value'],
          validValues: entry.list,
        });
        seen.add(entry.var);
      }
      // Include any active config keys that are not in the metadata
      // (e.g. older fields PoB may still emit).
      const orphans: ConfigEntry[] = [];
      for (const [key, value] of Object.entries(input)) {
        if (!seen.has(key)) {
          orphans.push({
            key,
            label: key,
            type: 'unknown',
            value: value as ConfigEntry['value'],
          });
        }
      }
      if (orphans.length > 0) sections.Active = orphans;
      return { sections, raw: input };
    });
  }

  /**
   * Permanently apply config changes. Pushes an undo snapshot first so
   * the change can be reverted via undoLastChange.
   */
  async setConfigWithUndo(
    options: Record<string, unknown>,
  ): Promise<StatDiffResult> {
    return this.withLock(async () => {
      // Validate before the undo push so a rejected call changes nothing.
      await this.validateConfigOptionsUnlocked(options);
      const entry: UndoEntry = { kind: 'config', snapshot: await this.snapshotConfigUnlocked() };
      const journal = this.bridge.committedCount();
      const before = await this.bridge.getStats();
      try {
        await this.bridge.setConfig(options);
      } catch (err) {
        // The change may be partly applied: undo can revert it, but it is never replayed.
        if (this.bridge.isRunning()) this.pushUndoEntryUnlocked(entry, journal);
        throw err;
      }
      return this.commitAfterUnlocked(entry, journal, { cmd: 'setConfig', options: { ...options } }, async () => {
        const after = await this.bridge.getStats();
        return { before, after, diff: computeDiff(before, after) };
      });
    });
  }

  /**
   * Evaluate config variants (each validated like set_config, which the
   * caller has done) on the probe engine: each variant's stats, or its user
   * error; any other failure fails the call. The build never changes.
   */
  private async configVariantsUnlocked(
    tool: string,
    variants: Array<Record<string, unknown>>,
  ): Promise<Array<{ stats: Stats | null; error: string | null }>> {
    const probed = await this.probeUnlocked({ variants: variants.map((config) => ({ config })) });
    return probed.results.map((r) => {
      if (r.error === undefined) return { stats: withoutNulls(r.stats), error: null };
      if (!r.userError) throw new Error(`${tool}: ${r.error}`);
      return { stats: null, error: r.error };
    });
  }

  /**
   * Stats with config changes applied (as set_config applies them), evaluated
   * on the probe engine; the build never changes. An unknown key or a bad
   * value is a UserError.
   */
  async simulateConfig(
    options: Record<string, unknown>,
  ): Promise<StatDiffResult> {
    return this.withLock(async () => {
      await this.validateConfigOptionsUnlocked(options);
      const before = await this.bridge.getStats();
      const [r] = await this.configVariantsUnlocked('simulate config', [options]);
      if (!r.stats) throw new UserError(r.error ?? 'the config change was refused');
      return { before, after: r.stats, diff: computeDiff(before, r.stats) };
    });
  }

  async simulateScenario(scenario: string): Promise<ScenarioResult> {
    const preset = Object.hasOwn(SCENARIO_PRESETS, scenario) ? SCENARIO_PRESETS[scenario] : undefined;
    if (!preset) {
      throw new UserError(
        `Unknown scenario: "${scenario}". Valid: ${Object.keys(SCENARIO_PRESETS).join(', ')}`,
      );
    }
    const result = await this.simulateConfig(preset.options);
    return {
      scenario,
      description: preset.description,
      options: preset.options,
      ...result,
    };
  }

  /**
   * Every scenario as one probe variant. A preset key PoB does not have fails
   * the whole call before anything runs; a scenario the engine refuses
   * carries its error (null `after` / `diff`); any other failure fails the call.
   */
  async compareScenarios(scenarios: string[]): Promise<ScenarioComparison> {
    if (scenarios.length === 0) throw new UserError('compareScenarios requires at least one scenario');
    for (const s of scenarios) {
      if (!Object.hasOwn(SCENARIO_PRESETS, s)) {
        throw new UserError(`Unknown scenario: "${s}". Valid: ${Object.keys(SCENARIO_PRESETS).join(', ')}`);
      }
    }
    return this.withLock(async () => {
      // Fail loudly (before any probe) if a preset uses a key PoB doesn't have.
      for (const scenario of scenarios) {
        await this.validateConfigOptionsUnlocked(SCENARIO_PRESETS[scenario].options, `scenario "${scenario}"`);
      }
      const baseline = await this.bridge.getStats();
      const probed = await this.configVariantsUnlocked(
        'compare_scenarios',
        scenarios.map((s) => SCENARIO_PRESETS[s].options),
      );
      const results: ScenarioComparisonEntry[] = scenarios.map((scenario, i) => {
        const preset = SCENARIO_PRESETS[scenario];
        const after = probed[i].stats;
        return {
          scenario,
          description: preset.description,
          options: preset.options,
          before: baseline,
          after,
          diff: after ? computeDiff(baseline, after) : null,
          ...(probed[i].error !== null ? { error: probed[i].error as string } : {}),
        };
      });
      return { baseline, scenarios: results };
    });
  }

  /** Buffs / charges toggled as config options (BUFF_KEY_MAP aliases), through simulateConfig. */
  async toggleBuffs(buffs: Record<string, boolean | number | string>): Promise<StatDiffResult> {
    // Null-prototype so a "__proto__" key stays an own property (and gets rejected by validation).
    const options: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(buffs)) {
      const mapped = Object.hasOwn(BUFF_KEY_MAP, key) ? BUFF_KEY_MAP[key] : key;
      options[mapped] = value;
    }
    return this.simulateConfig(options);
  }

  static listScenarios(): Array<{ name: string; description: string; options: Record<string, unknown> }> {
    return Object.entries(SCENARIO_PRESETS).map(([name, preset]) => ({
      name,
      description: preset.description,
      options: preset.options,
    }));
  }

  // ------------------------------------------------------------------
  // Phase 7: optimization advisor
  // ------------------------------------------------------------------

  listSnapshotLabels(): string[] {
    return Array.from(this.snapshots.keys());
  }

  async diagnoseBuild(focus?: string): Promise<DiagnosticCheck[]> {
    return this.withLock(async () => {
      const snap = await this.bridge.send<{
        ok: true;
        stats: Stats;
        items: EquippedItem[];
        groups: SkillGroupInfo[];
        allocatedNodes: TreeNodeInfo[];
        passiveTreeSummary: PassiveTreeSummary;
      }>({ cmd: 'diagnoseSnapshot' });

      const tree: PassiveTreeInfo = {
        allocatedNodes: snap.allocatedNodes,
        keystones: snap.allocatedNodes.filter((n) => n.isKeystone),
        notables: snap.allocatedNodes.filter((n) => n.isNotable),
        summary: snap.passiveTreeSummary,
      };

      const checks: DiagnosticCheck[] = [];
      const want = (cat: 'defense' | 'offense' | 'qol'): boolean => {
        if (!focus || focus === 'balance') return true;
        return focus === cat;
      };

      if (want('defense')) checks.push(...runDefenseDiagnostics(snap.stats));
      if (want('offense')) checks.push(...runOffenseDiagnostics(snap.stats, snap.groups, tree));
      if (want('qol')) checks.push(...runQoLDiagnostics(snap.groups, snap.items));

      const order: Record<DiagnosticCheck['severity'], number> = { critical: 0, warning: 1, info: 2 };
      checks.sort((a, b) => order[a.severity] - order[b.severity]);
      return checks;
    });
  }

  async suggestUpgrades(
    targetSlot?: string,
    budget?: 'low' | 'medium' | 'high',
  ): Promise<UpgradeSuggestion[]> {
    return this.withLock(async () => {
      const baseline = await this.bridge.getStats();
      const groupsRes = await this.bridge.send<{ ok: true; groups: SkillGroupInfo[] }>({
        cmd: 'getSocketGroups',
      });
      const archetype = identifyArchetype(groupsRes.groups);

      const focusSlots = targetSlot
        ? [targetSlot]
        : ['Weapon 1', 'Weapon 2', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Belt'];

      const itemsRes = await this.bridge.send<{ ok: true; items: EquippedItem[] }>({
        cmd: 'listEquippedItems',
      });
      const itemsBySlot = new Map<string, EquippedItem>();
      for (const item of itemsRes.items) itemsBySlot.set(item.slot, item);

      // One probe variant per equipped slot: the slot emptied as unequip_item
      // would, then undone (a jewel socket or a skill-granting item takes the
      // probe's full-recalculation fallback). A slot refused as input gets its
      // error in the result; any other failure fails the call.
      const equipped = focusSlots.filter((slot) => itemsBySlot.has(slot));
      const probed = equipped.length > 0
        ? await this.probeUnlocked({ variants: equipped.map((slot) => ({ items: [{ slot, unequip: true as const }] })) })
        : { base: {}, results: [] };
      const out: UpgradeSuggestion[] = [];
      for (const slot of focusSlots) {
        const item = itemsBySlot.get(slot) ?? null;
        if (!item) {
          out.push({
            slot,
            currentItem: null,
            currentItemName: null,
            empty: true,
            dpsContribution: 0,
            ehpContribution: 0,
            priority: 100,
            suggestedMods: getSuggestedMods(slot, archetype, budget),
          });
          continue;
        }
        const r = probed.results[equipped.indexOf(slot)];
        if (r.error !== undefined && !r.userError) throw new Error(`suggest_upgrades: ${slot}: ${r.error}`);
        const without = r.error === undefined ? withoutNulls(r.stats) : null;
        const dpsLoss = without ? toNumber(baseline.CombinedDPS) - toNumber(without.CombinedDPS) : 0;
        const ehpLoss = without ? toNumber(baseline.TotalEHP) - toNumber(without.TotalEHP) : 0;
        out.push({
          slot,
          currentItem: item,
          currentItemName: item.name ?? item.baseName ?? null,
          empty: false,
          dpsContribution: dpsLoss,
          ehpContribution: ehpLoss,
          priority: without ? computeUpgradePriority(dpsLoss, ehpLoss, baseline) : 0,
          suggestedMods: getSuggestedMods(slot, archetype, budget),
          ...(r.error !== undefined ? { error: r.error } : {}),
        });
      }

      out.sort((a, b) => {
        if ((a.error === undefined) !== (b.error === undefined)) return a.error === undefined ? -1 : 1;
        if (a.empty && !b.empty) return -1;
        if (!a.empty && b.empty) return 1;
        return (a.dpsContribution + a.ehpContribution) - (b.dpsContribution + b.ehpContribution);
      });
      return out;
    });
  }

  async exportBuild(format: 'summary' | 'xml' | 'code' = 'summary'): Promise<string> {
    return this.withLock(async () => {
      switch (format) {
        case 'xml': {
          const result = await this.bridge.send<{ ok: true; xml: string }>({ cmd: 'exportXML' });
          return result.xml;
        }
        case 'code': {
          const result = await this.bridge.send<{ ok: true; xml: string }>({ cmd: 'exportXML' });
          return encodeBuildCode(result.xml);
        }
        case 'summary': {
          const info = this.buildInfo;
          if (!info) throw new UserError('No build loaded — call load_build first');
          const stats = await this.bridge.getStats();
          return formatBuildSummary(info, stats);
        }
        default:
          throw new UserError(`Unknown format: "${format}". Valid: "xml", "code", "summary"`);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Phase 6: Scenario presets and buff-name aliases
// ---------------------------------------------------------------------------

interface ScenarioPreset {
  description: string;
  options: Record<string, unknown>;
}

const SCENARIO_PRESETS: Record<string, ScenarioPreset> = {
  mapping: {
    description: 'Standard map-clear: full buffs, all charges, onslaught, flasks active.',
    options: {
      enemyIsBoss: 'None',
      usePowerCharges: true,
      useFrenzyCharges: true,
      useEnduranceCharges: true,
      buffOnslaught: true,
      buffFortification: true,
    },
  },
  map_boss: {
    description: 'Map boss tier: charges and onslaught up, flasks active, hit damage tracked.',
    options: {
      enemyIsBoss: 'Boss',
      usePowerCharges: true,
      useFrenzyCharges: true,
      useEnduranceCharges: true,
      buffOnslaught: true,
      buffFortification: true,
    },
  },
  pinnacle_boss: {
    description: 'Pinnacle / Sirus / Maven boss: limited flask uptime, frenzy harder to sustain.',
    options: {
      enemyIsBoss: 'Pinnacle',
      usePowerCharges: true,
      useFrenzyCharges: false,
      useEnduranceCharges: true,
      buffOnslaught: false,
      buffFortification: true,
    },
  },
  uber_boss: {
    description: 'Uber pinnacle boss: maximum incoming damage, no flask uptime, no onslaught.',
    options: {
      enemyIsBoss: 'Uber',
      usePowerCharges: true,
      useFrenzyCharges: false,
      useEnduranceCharges: true,
      buffOnslaught: false,
      buffFortification: true,
    },
  },
  no_buffs: {
    description: 'Worst-case: no charges, no auras-as-buffs, no flask uptime.',
    options: {
      enemyIsBoss: 'None',
      usePowerCharges: false,
      useFrenzyCharges: false,
      useEnduranceCharges: false,
      buffOnslaught: false,
      buffFortification: false,
    },
  },
  delirium: {
    description: 'Delirium / breach: dense trash, full charges and buffs.',
    options: {
      enemyIsBoss: 'None',
      usePowerCharges: true,
      useFrenzyCharges: true,
      useEnduranceCharges: true,
      buffOnslaught: true,
      buffFortification: true,
    },
  },
};

export const SCENARIO_NAMES = Object.keys(SCENARIO_PRESETS) as unknown as readonly [string, ...string[]];
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/**
 * Friendly buff names → PoB config keys. Unknown keys pass through
 * unchanged so callers can still pass raw config keys; every resulting key
 * is validated against the engine's config metadata before it is applied.
 * (No alias for "pinned": PoB has no player-pinned config option.)
 */
export const BUFF_KEY_MAP: Record<string, string> = {
  powerCharges: 'usePowerCharges',
  frenzyCharges: 'useFrenzyCharges',
  enduranceCharges: 'useEnduranceCharges',
  onslaught: 'buffOnslaught',
  fortify: 'buffFortification',
  flasks: 'conditionUsingFlask',
  flasksActive: 'conditionUsingFlask',
  unholyMight: 'buffUnholyMight',
  shocked: 'conditionShocked',
  chilled: 'conditionChilled',
  bossEnemy: 'enemyIsBoss',
};

/**
 * Keys PoB's config tab honours that are absent from ConfigOptions.lua.
 * `customMods` is the legacy free-text mod box (ConfigTab:BuildModList reads
 * input.customMods as a headless fallback).
 */
const EXTRA_CONFIG_KEYS: Record<string, ConfigVarMetadata> = {
  customMods: { var: 'customMods', type: 'text', label: 'Custom modifiers', section: 'Custom' },
};

/** A few valid keys resembling `key` (case-insensitive prefix/substring match). */
function closestConfigKeys(key: string, valid: string[], max = 5): string[] {
  const k = key.toLowerCase();
  const strip = (v: string): string => v.toLowerCase().replace(/^(condition|buff|use|override|multiplier)/, '');
  const core = strip(key);
  const scored: Array<{ v: string; score: number }> = [];
  for (const v of valid) {
    const lv = v.toLowerCase();
    let score = 0;
    if (lv === k) score = 100;
    else if (core.length >= 3 && strip(v) === core) score = 90;
    else if (lv.startsWith(k) || k.startsWith(lv)) score = 70;
    else if (lv.includes(k) || k.includes(lv)) score = 50;
    else if (core.length >= 4 && (lv.includes(core) || (strip(v).length >= 4 && core.includes(strip(v))))) score = 30;
    else {
      const sv = strip(v);
      let n = 0;
      while (n < core.length && n < sv.length && core[n] === sv[n]) n++;
      if (n >= 5) score = 10 + n;
    }
    if (score > 0) scored.push({ v, score });
  }
  scored.sort((a, b) => b.score - a.score || a.v.length - b.v.length);
  return scored.slice(0, max).map((x) => x.v);
}

/** Returns a description of a clearly wrong value type for the option, or null. */
function describeConfigValueProblem(meta: ConfigVarMetadata | undefined, value: unknown): string | null {
  if (!meta) return null;
  switch (meta.type) {
    case 'check':
      return typeof value === 'boolean' ? null : `expected true/false, got ${JSON.stringify(value)}`;
    case 'count':
    case 'countAllowZero':
    case 'integer':
    case 'float':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `expected a number, got ${JSON.stringify(value)}`;
    case 'text':
      return typeof value === 'string' ? null : `expected a string, got ${JSON.stringify(value)}`;
    case 'list': {
      if (!meta.list || meta.list.length === 0) return null;
      if (meta.list.some((c) => c.val === value)) return null;
      return `expected one of ${meta.list.map((c) => JSON.stringify(c.val)).join(', ')}, got ${JSON.stringify(value)}`;
    }
    default:
      return null;
  }
}

export interface GemDescription {
  nameSpec?: string;
  gemId?: string;
  skillId?: string;
  level?: number;
  quality?: number;
  enabled?: boolean;
  count?: number;
  isActive?: boolean;
}

export interface SkillBreakdown {
  index: number;
  label?: string;
  slot?: string;
  enabled: boolean;
  source?: string;
  mainActiveSkill?: number;
  isMainGroup: boolean;
  activeGem: GemDescription | null;
  gems: GemDescription[];
  stats?: Record<string, number | string | boolean | null | undefined> | null;
}

export interface ItemModLine {
  line: string;
  crafted: boolean;
  fractured: boolean;
  enchant: boolean;
  implicit: boolean;
}

export interface EquippedItem {
  slot: string;
  itemId: number;
  /** The slot is hidden by PoB on this passive tree (Wickerman off 3.30, grafts off 3.27). */
  hidden?: boolean;
  /** For a hidden slot: why, and whether PoB still counts the item. */
  note?: string;
  rarity?: string;
  name?: string;
  title?: string;
  baseName?: string;
  quality?: number;
  itemLevel?: number;
  requirements?: { level?: number };
  sockets?: number;
  corrupted?: boolean;
  shaper?: boolean;
  elder?: boolean;
  implicits: ItemModLine[];
  explicits: ItemModLine[];
  enchants: ItemModLine[];
  raw?: string;
}

export interface SlotInfo {
  slot: string;
  occupied: boolean;
  itemName?: string | null;
  baseName?: string | null;
}

export interface SlotItem {
  slot: string;
  itemId: number;
  raw?: string | null;
  rarity?: string;
  name?: string;
  baseName?: string;
}

export interface StatDiffResult {
  before: Stats;
  after: Stats;
  diff: StatDiff;
}

export interface ComparisonCandidate {
  index: number;
  itemText: string;
  stats: Stats | null;
  diff: StatDiff;
  error: string | null;
}

export interface ComparisonResult {
  baseline: { item: ItemSnapshot; stats: Stats };
  candidates: ComparisonCandidate[];
  bestForDPS: number | null;
  bestForEHP: number | null;
  bestForLife: number | null;
}

/** A probe variant whose passive nodes may be given by name (see BuildSession.probeNamed). */
export type NamedProbeVariant = Omit<ProbeVariant, 'allocate' | 'deallocate'> & {
  allocate?: Array<string | number>;
  deallocate?: Array<string | number>;
};

export interface TreeNodeInfo {
  id: number;
  name: string;
  type: string;
  isKeystone: boolean;
  isNotable: boolean;
  isJewelSocket: boolean;
  isMastery: boolean;
  isAscendancy: boolean;
  ascendancyName?: string | null;
  alloc: boolean;
  stats?: string[];
  linked?: number[];
}

export interface PassiveTreeSummary {
  totalPoints: number;
  ascendancyPoints: number;
  secondaryAscendancyPoints: number;
  maxNormalPoints: number;
  maxAscendancyPoints: number;
  extraPoints: number;
  counts: Record<string, number>;
  keystones: Array<{ id: number; name: string; ascendancy?: string | null }>;
  className?: string | null;
  ascendClassName?: string | null;
}

export interface ConvertedNode {
  id: number;
  name?: string;
  type?: string;
}

export interface RenamedNode {
  id: number;
  oldName?: string;
  newName?: string;
}

export interface DroppedMastery {
  nodeId: number;
  name?: string;
  effectId: number;
  effect?: string;
}

interface RawTreeConversion {
  converted: boolean;
  fromVersion: string;
  toVersion: string;
  allocatedBefore?: number;
  allocatedAfter?: number;
  pointsBefore?: number;
  pointsAfter?: number;
  lostNodeCount?: number;
  lostNodes?: ConvertedNode[];
  lostNodesOmitted?: number;
  changedNodeCount?: number;
  changedNodes?: RenamedNode[];
  changedNodesOmitted?: number;
  droppedMasteryCount?: number;
  droppedMasteries?: DroppedMastery[];
  droppedMasteriesOmitted?: number;
  droppedTattooCount?: number;
  droppedTattoos?: Array<{ nodeId: number; name: string }>;
  droppedTattoosOmitted?: number;
}

export type TreeConversionResult =
  | { converted: false; fromVersion: string; toVersion: string }
  | {
      converted: true;
      fromVersion: string;
      toVersion: string;
      allocatedBefore: number;
      allocatedAfter: number;
      pointsBefore?: number;
      pointsAfter?: number;
      lostNodeCount: number;
      lostNodes: ConvertedNode[];
      lostNodesOmitted: number;
      changedNodeCount: number;
      changedNodes: RenamedNode[];
      changedNodesOmitted: number;
      droppedMasteryCount: number;
      droppedMasteries: DroppedMastery[];
      droppedMasteriesOmitted: number;
      droppedTattooCount: number;
      droppedTattoos: Array<{ nodeId: number; name: string }>;
      droppedTattoosOmitted: number;
      before: Stats;
      after: Stats;
      diff: StatDiff;
    };

export interface PassiveTreeInfo {
  allocatedNodes: TreeNodeInfo[];
  keystones: TreeNodeInfo[];
  notables: TreeNodeInfo[];
  summary: PassiveTreeSummary;
}

export type { NodeRanking, RankBy, TreeSearchResult } from './tree-search.js';

export interface KeystoneEvaluation {
  keystone: string;
  nodeId: number;
  currentlyAllocated: boolean;
  action: 'added' | 'removed';
  before: Stats;
  after: Stats;
  statDiff: StatDiff;
  nodeStats: string[];
}

export interface SkillGemInstance {
  index: number;
  name: string;
  nameSpec?: string;
  gemId?: string;
  skillId?: string;
  level?: number;
  quality?: number;
  enabled: boolean;
  count?: number;
  isSupport: boolean;
  color?: number;
  errMsg?: string | null;
}

export interface SkillGroupInfo {
  index: number;
  label: string;
  slotName: string;
  enabled: boolean;
  isMainGroup: boolean;
  source?: string | null;
  mainActiveSkill?: number;
  gems: SkillGemInstance[];
}

export interface GemDataInfo {
  gemId?: string;
  name: string;
  baseTypeName?: string;
  variantId?: string;
  grantedEffectId?: string;
  isSupport: boolean;
  isVaal: boolean;
  isAwakened: boolean;
  naturalMaxLevel?: number;
  reqStr?: number;
  reqDex?: number;
  reqInt?: number;
  tags: string[];
  tagString?: string;
  color?: number;
}

/**
 * Opaque, JSON-safe skills state produced by the bridge's snapshotSkills and
 * fed back to restoreSkills: every skill set (groups and gem instances with
 * all their plain fields as sorted [key, value] pairs), the set order, the
 * active set, the skills tab settings and the main socket group. Equal
 * states encode to equal JSON.
 */
export interface SkillsSnapshot {
  version: number;
  activeSkillSetId: number;
  mainSocketGroup?: number;
  [key: string]: unknown;
}

export interface SupportCandidate {
  name: string;
  /** null when the candidate was refused (see error). */
  dps: number | null;
  dpsDelta: number | null;
  error: string | null;
}

export interface SupportComparison {
  weakestCurrentSupport: { name: string; gemIndex: number; dpsContribution: number };
  slotTested: number;
  baselineDPS: number;
  candidates: SupportCandidate[];
}

export interface GemLevelScaling {
  level: number;
  /** null when the level was refused (see error). */
  dps: number | null;
  dpsDelta: number | null;
  error: string | null;
}

export type { OptimalLinksResult } from './link-search.js';

// ---------------------------------------------------------------------------
// Phase 6: Config / scenario types
// ---------------------------------------------------------------------------

export interface ConfigVarMetadata {
  var: string;
  type: string; // 'check' | 'count' | 'list' | 'text' | 'integer' | ...
  label: string;
  section: string;
  list?: Array<{ val: unknown; label: string }>;
  defaultIndex?: number;
  defaultState?: boolean | number | string;
  ifMult?: string;
  ifFlag?: string;
  ifCond?: string;
  ifEnemyCond?: string;
  ifSkill?: string;
  ifSkillFlag?: string;
  ifSkillData?: string;
  ifSkillList?: string[];
  ifNode?: number;
  ifOption?: string;
  ifVer?: string;
}

export interface ConfigEntry {
  key: string;
  label: string;
  type: string;
  value: boolean | number | string | null;
  validValues?: Array<{ val: unknown; label: string }>;
}

export interface OrganizedConfig {
  sections: Record<string, ConfigEntry[]>;
  raw: Record<string, unknown>;
}

export interface ScenarioResult {
  scenario: string;
  description: string;
  options: Record<string, unknown>;
  before: Stats;
  after: Stats;
  diff: StatDiff;
}

/** A compare_scenarios entry: `after` and `diff` are null when the engine refused the scenario (see error). */
export interface ScenarioComparisonEntry extends Omit<ScenarioResult, 'after' | 'diff'> {
  after: Stats | null;
  diff: StatDiff | null;
  error?: string;
}

export interface ScenarioComparison {
  baseline: Stats;
  scenarios: ScenarioComparisonEntry[];
}

// ---------------------------------------------------------------------------
// Phase 7: optimization advisor helpers
// ---------------------------------------------------------------------------

export interface DiagnosticCheck {
  category: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  suggestion: string;
}

export interface UpgradeSuggestion {
  slot: string;
  currentItem: EquippedItem | null;
  currentItemName: string | null;
  empty: boolean;
  dpsContribution: number;
  ehpContribution: number;
  priority: number;
  suggestedMods: string[];
  /** The slot could not be measured (refused as input); its contributions are 0. */
  error?: string;
}

type BuildArchetype = 'archmage' | 'minion' | 'totem' | 'dot' | 'generic';

function identifyArchetype(groups: SkillGroupInfo[]): BuildArchetype {
  const main = groups.find((g) => g.isMainGroup) ?? groups[0];
  if (!main) return 'generic';
  const active = main.gems.find((g) => !g.isSupport);
  const supports = main.gems.filter((g) => g.isSupport).map((g) => g.name);
  const activeName = active?.name ?? '';

  if (supports.some((s) => /Archmage/i.test(s))) return 'archmage';
  if (
    supports.some((s) => /Minion/i.test(s)) ||
    /Summon|Raise|Animate/i.test(activeName)
  ) {
    return 'minion';
  }
  if (supports.some((s) => /Spell Totem|Ballista Totem/i.test(s))) return 'totem';
  if (supports.some((s) => /Deadly Ailments|Swift Affliction|Void Manipulation/i.test(s))) return 'dot';
  return 'generic';
}

function getSuggestedMods(
  slot: string,
  archetype: BuildArchetype,
  budget?: 'low' | 'medium' | 'high',
): string[] {
  const mods: string[] = [];
  if (['Helmet', 'Body Armour', 'Gloves', 'Boots', 'Belt'].includes(slot)) {
    mods.push('Maximum Life', 'Elemental Resistances');
  }
  switch (archetype) {
    case 'archmage':
      mods.push('Maximum Mana', 'Mana Regeneration');
      if (slot === 'Amulet') mods.push('-X to Total Mana Cost of Non-Channelling Skills');
      break;
    case 'minion':
      mods.push('Minion Damage', 'Minion Attack/Cast Speed');
      if (slot === 'Helmet') mods.push('+Level to Socketed Minion Gems');
      break;
    case 'dot':
      mods.push('Damage over Time Multiplier', '+Level to Skill Gems');
      break;
    case 'totem':
      mods.push('Totem Damage', '+1 Totem');
      break;
    default:
      if (slot === 'Weapon 1') mods.push('Increased Damage', 'Critical Strike Chance', 'Attack/Cast Speed');
      if (slot === 'Amulet') mods.push('Critical Strike Multiplier', '+Level to Skill Gems');
      break;
  }
  if (slot === 'Boots') mods.push('Movement Speed');
  if (slot === 'Gloves' && archetype !== 'minion') mods.push('Attack Speed', 'Accuracy');
  if (slot === 'Body Armour' && budget === 'high') mods.push('Astramentis', 'Saviour, Mageblood, or Headhunter pairings');
  return mods;
}

function computeUpgradePriority(dpsLoss: number, ehpLoss: number, baseline: Stats): number {
  const dpsBase = toNumber(baseline.CombinedDPS) || 1;
  const ehpBase = toNumber(baseline.TotalEHP) || 1;
  const dpsRatio = Math.max(0, dpsLoss) / dpsBase;
  const ehpRatio = Math.max(0, ehpLoss) / ehpBase;
  // Lower contribution = higher upgrade priority. Scale to 0-100.
  const score = (dpsRatio + ehpRatio) * 100;
  return Math.round(Math.max(0, 100 - score));
}

function pct(n: Stats[string]): number {
  return Math.round(toNumber(n));
}

function runDefenseDiagnostics(stats: Stats): DiagnosticCheck[] {
  const out: DiagnosticCheck[] = [];
  const elements: Array<['FireResist' | 'ColdResist' | 'LightningResist', string]> = [
    ['FireResist', 'Fire'],
    ['ColdResist', 'Cold'],
    ['LightningResist', 'Lightning'],
  ];
  for (const [key, label] of elements) {
    const val = pct(stats[key] ?? 0);
    if (val < 75) {
      out.push({
        category: 'defense',
        severity: 'critical',
        message: `${label} resistance is ${val}% (uncapped)`,
        suggestion: `Cap ${label} resistance at 75% before any other upgrades.`,
      });
    }
    const overKey = `${key}OverCap` as keyof Stats;
    const over = pct(stats[overKey] ?? 0);
    if (over > 50) {
      out.push({
        category: 'defense',
        severity: 'info',
        message: `${label} resistance overcapped by ${over}%`,
        suggestion: `Trade some excess ${label} res for offense or other defenses.`,
      });
    }
  }
  const chaos = pct(stats.ChaosResist ?? 0);
  if (chaos < 0) {
    out.push({
      category: 'defense',
      severity: 'warning',
      message: `Chaos resistance is ${chaos}%`,
      suggestion: 'Aim for 0%+ chaos resistance to survive endgame chaos damage.',
    });
  }
  const life = toNumber(stats.Life ?? 0);
  const es = toNumber(stats.EnergyShield ?? 0);
  if (life < 4000 && es < 3000) {
    out.push({
      category: 'defense',
      severity: 'critical',
      message: `Low effective HP pool: ${Math.round(life)} life, ${Math.round(es)} ES`,
      suggestion: 'Prioritize life on gear (5000+) or ES (8000+) for endgame survival.',
    });
  }
  const supp = pct(stats.SpellSuppressionChance ?? 0);
  if (supp > 0 && supp < 100) {
    out.push({
      category: 'defense',
      severity: 'warning',
      message: `Spell suppression at ${supp}% (not capped)`,
      suggestion: 'Spell suppression rounds down on each hit; cap at 100% or respec out.',
    });
  }
  return out;
}

function runOffenseDiagnostics(
  stats: Stats,
  groups: SkillGroupInfo[],
  tree: PassiveTreeInfo,
): DiagnosticCheck[] {
  const out: DiagnosticCheck[] = [];
  const crit = toNumber(stats.CritChance ?? 0);
  const hasRT = tree.summary.keystones.some((k) => /Resolute Technique/i.test(k.name));
  if (crit > 5 && crit < 40 && !hasRT) {
    out.push({
      category: 'offense',
      severity: 'warning',
      message: `Low crit chance (${crit.toFixed(1)}%) without Resolute Technique`,
      suggestion: 'Either invest in crit (50%+ effective) or take Resolute Technique.',
    });
  }
  const hit = toNumber(stats.HitChance ?? 100);
  if (hit < 95 && !hasRT) {
    out.push({
      category: 'offense',
      severity: 'warning',
      message: `Low hit chance (${hit.toFixed(0)}%)`,
      suggestion: 'Add accuracy on gear/tree or take Resolute Technique.',
    });
  }
  for (const group of groups) {
    if (!group.isMainGroup) continue;
    for (const gem of group.gems) {
      if (!gem.isSupport && (gem.level ?? 0) < 20) {
        out.push({
          category: 'offense',
          severity: 'info',
          message: `Main skill "${gem.name}" is only level ${gem.level ?? '?'}`,
          suggestion: 'Level 20 gems provide significant damage; level the gem in inventory if necessary.',
        });
      }
    }
  }
  return out;
}

function runQoLDiagnostics(groups: SkillGroupInfo[], _items: EquippedItem[]): DiagnosticCheck[] {
  const out: DiagnosticCheck[] = [];
  const allGemNames = groups.flatMap((g) => g.gems.map((gem) => gem.name));
  const movementSkills = ['Flame Dash', 'Shield Charge', 'Whirling Blades', 'Leap Slam', 'Dash', 'Frostblink', 'Lightning Warp'];
  if (!movementSkills.some((m) => allGemNames.includes(m))) {
    out.push({
      category: 'qol',
      severity: 'warning',
      message: 'No movement skill found',
      suggestion: 'Add a movement skill (Flame Dash is universally useful).',
    });
  }
  const guardSkills = ['Steelskin', 'Molten Shell', 'Immortal Call', 'Bone Armour', 'Arcane Cloak'];
  if (!guardSkills.some((g) => allGemNames.includes(g))) {
    out.push({
      category: 'qol',
      severity: 'info',
      message: 'No guard skill found',
      suggestion: 'Consider adding a guard skill (Molten Shell for armour builds, Steelskin otherwise).',
    });
  }
  return out;
}

function formatBuildSummary(info: BuildInfo, stats: Stats): string {
  const lines: string[] = [];
  lines.push(`${info.class ?? 'Unknown'} / ${info.ascendancy ?? 'Unknown'} (Level ${info.level ?? '?'})`);
  if (info.mainSkill) lines.push(`Main Skill: ${info.mainSkill}`);
  lines.push('');
  lines.push(`Combined DPS: ${Math.round(toNumber(stats.CombinedDPS ?? 0)).toLocaleString()}`);
  lines.push(`Life: ${Math.round(toNumber(stats.Life ?? 0)).toLocaleString()}`);
  lines.push(`Energy Shield: ${Math.round(toNumber(stats.EnergyShield ?? 0)).toLocaleString()}`);
  lines.push(`Total EHP: ${Math.round(toNumber(stats.TotalEHP ?? 0)).toLocaleString()}`);
  lines.push('');
  lines.push(`Fire Res: ${pct(stats.FireResist ?? 0)}%`);
  lines.push(`Cold Res: ${pct(stats.ColdResist ?? 0)}%`);
  lines.push(`Lightning Res: ${pct(stats.LightningResist ?? 0)}%`);
  lines.push(`Chaos Res: ${pct(stats.ChaosResist ?? 0)}%`);
  return lines.join('\n');
}
