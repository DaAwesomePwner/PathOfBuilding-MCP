// Read-only what-if probes: request/response types and the orchestration
// BuildSession.probe runs under its lock.
//
// The bridge's `probe` command (lua/probe.lua) evaluates each variant through
// Path of Building's own calculator (CalcsTab:GetMiscCalculator, what PoB's
// tooltips use) without recalculating or changing the committed build.
// The base comes from the classify pass (or a variant-less probe), which
// reads the last full recalc and builds no calculator.
// Variant kinds the calculator cannot reproduce exactly come back marked
// `fallback`; those are run here one at a time through `probeCommit` (apply
// for real, full recalc, read) between a full build snapshot and its exact
// restore — the same path the what-if tools used before (a passive-tree
// snapshot and restore for a single node change touching no skill, as the
// tree what-if tools used). Variants go to the engine in chunks (PROBE_CHUNK)
// so no single bridge command nears its timeout. Nothing is pushed to the
// undo stack or the crash-recovery journal: the build never changes.

import type { Stats } from './lua-bridge.js';
import { UserError, validateItemText, validateSlot } from './validation.js';

/** One gem change; group and gem indices are 1-based, as in get_skill_breakdown. */
export type ProbeGemChange =
  /** Change gem `index` of group `group`: another gem by name (as swap_gem does), level, quality, enabled. */
  | { op: 'set'; group: number; index: number; name?: string; level?: number; quality?: number; enabled?: boolean }
  /** Remove gem `index` from group `group`. */
  | { op: 'remove'; group: number; index: number }
  /** Add a gem to group `group` (at `position`, default the end; level defaults to 20, quality to 0). */
  | { op: 'add'; group: number; name: string; level?: number; quality?: number; enabled?: boolean; position?: number };

export type ProbeItemChange = { slot: string; itemText: string } | { slot: string; unequip: true };

/**
 * One what-if variant of the committed build. Changes combine; they apply in
 * this order: config, gems (in list order; indices refer to the group as it
 * is when that change applies), items, then passive nodes.
 */
export interface ProbeVariant {
  /** Node ids to allocate, each together with its path from the allocated tree. Masteries are refused. */
  allocate?: number[];
  /** Allocated node ids to remove, each together with every node that depends on it. */
  deallocate?: number[];
  /**
   * Items to put in slots (PoB "Copy item" text), or `{ slot, unequip: true }`
   * to empty a slot as unequip_item does.
   */
  items?: ProbeItemChange[];
  gems?: ProbeGemChange[];
  /** Config options, validated like set_config. */
  config?: Record<string, unknown>;
}

export interface ProbeRequest {
  /** Stat keys to return; defaults to get_stats' keys. Unknown keys come back as null. */
  stats?: string[];
  /** Passed to PoB's calculator; false skips the Full DPS roll-up (FullDPS / FullDotDPS are then null). */
  useFullDPS?: boolean;
  variants: ProbeVariant[];
}

export interface ProbeVariantResult {
  /** Requested stats for the variant ({} when the variant failed). */
  stats: Stats;
  nodesAdded?: number[];
  nodesRemoved?: number[];
  /** Passive points the added / removed nodes use (ascendancy and class-start nodes are not counted). */
  pointsAdded?: number;
  pointsRemoved?: number;
  /** The variant needed a full recalculation (applied, recalculated and restored); why. */
  fallback?: boolean;
  fallbackReason?: string;
  error?: string;
  /** The variant's input was refused (bad node, item, gem or config); the other variants still ran. */
  userError?: boolean;
}

export interface ProbeResponse {
  /** Requested stats of the committed build. */
  base: Stats;
  results: ProbeVariantResult[];
}

export const MAX_PROBE_VARIANTS = 500;
/** Variants that need a full recalculation each take ~0.3-0.5 s. */
export const MAX_FALLBACK_VARIANTS = 50;
/**
 * Variants per bridge command. Calculator variants take ~3-5 ms on a typical
 * build; 50 keeps one command far below the 30 s bridge timeout even on a
 * build 50x heavier, so a large request never times out (and strikes) the engine.
 */
export const PROBE_CHUNK = 50;

/** What probe needs from BuildSession; every call runs under its lock. */
export interface ProbeDeps {
  send<T>(command: object): Promise<T>;
  /** Throws a UserError when the options are not valid set_config options. */
  validateConfig(options: Record<string, unknown>): Promise<void>;
  /** Full build snapshot / exact restore (restore throws when it is not exact). */
  snapshot(): Promise<unknown>;
  restore(snapshot: unknown): Promise<void>;
  /** Passive-tree snapshot / exact restore, for a fallback the engine marks `treeOnly`. */
  snapshotTree(): Promise<unknown>;
  restoreTree(snapshot: unknown): Promise<void>;
  /** BuildSession's probeThenRestore, so errors read like the other what-if tools'. */
  probeThenRestore<T>(probe: () => Promise<T>, restore: () => Promise<void>): Promise<T>;
}

interface BridgeProbeResult extends Partial<ProbeVariantResult> {
  reason?: string;
  /** A single node change touching no skill: a passive-tree snapshot/restore is enough around it. */
  treeOnly?: boolean;
}

interface PendingFallback {
  index: number;
  reason?: string;
  treeOnly: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Request-level shape checks; variant contents are checked per variant (by the engine). */
export function validateProbeRequest(request: unknown): ProbeRequest {
  if (!isPlainObject(request)) throw new UserError('probe request must be an object');
  const { variants, stats, useFullDPS } = request;
  if (!Array.isArray(variants)) throw new UserError('variants must be an array');
  if (variants.length > MAX_PROBE_VARIANTS) {
    throw new UserError(`variants has ${variants.length} entries; at most ${MAX_PROBE_VARIANTS} are allowed per call`);
  }
  if (stats !== undefined && (!Array.isArray(stats) || stats.some((s) => typeof s !== 'string' || s === ''))) {
    throw new UserError('stats must be an array of stat names');
  }
  if (useFullDPS !== undefined && typeof useFullDPS !== 'boolean') {
    throw new UserError('useFullDPS must be a boolean');
  }
  return request as unknown as ProbeRequest;
}

/**
 * Checks done here rather than in the engine, with the rules the mutating
 * tools use: swap_item's slot and item-text checks, set_config's config
 * validation (set_config's schema takes booleans, numbers and strings only,
 * so a null value is refused here too).
 */
async function checkVariant(deps: ProbeDeps, variant: unknown): Promise<void> {
  if (!isPlainObject(variant)) throw new UserError('each variant must be an object');
  if (Array.isArray(variant.items)) {
    for (const entry of variant.items) {
      if (!isPlainObject(entry)) throw new UserError('each item must be { slot, itemText } or { slot, unequip: true }');
      validateSlot(entry.slot);
      if (entry.unequip === true && entry.itemText === undefined) continue;
      if (entry.unequip !== undefined) throw new UserError('an item entry takes either itemText or unequip: true');
      validateItemText(entry.itemText);
    }
  }
  if (variant.config !== undefined) {
    if (!isPlainObject(variant.config)) throw new UserError('config must be an object of config keys');
    for (const [key, value] of Object.entries(variant.config)) {
      if (value === null || !['boolean', 'number', 'string'].includes(typeof value)) {
        throw new UserError(`Invalid value for config key "${key}": expected a boolean, number or string, got ${JSON.stringify(value)}`);
      }
    }
    await deps.validateConfig(variant.config);
  }
}

function checkFallbackCap(count: number): void {
  if (count > MAX_FALLBACK_VARIANTS) {
    throw new UserError(
      `${count} variants need a full recalculation each (several node changes in one variant, jewel ` +
        `sockets, skill-granting nodes or items); at most ${MAX_FALLBACK_VARIANTS} are allowed per call`,
    );
  }
}

/** Probe stats in get_stats' shape: a stat the engine does not report (null) is left out. */
export function withoutNulls(stats: Stats): Stats {
  const out: Stats = {};
  for (const [key, value] of Object.entries(stats)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

function failed(error: unknown): ProbeVariantResult {
  return { stats: {}, error: errorText(error), userError: error instanceof UserError };
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Run one fallback variant between a snapshot and its exact restore
 * (probeThenRestore): the passive tree's alone for a `treeOnly` variant, the
 * whole build's otherwise. A variant error with an exact restore is that
 * variant's error; a restore that fails ends the whole call (the build may differ).
 */
async function runFallback(
  deps: ProbeDeps,
  variant: ProbeVariant,
  request: ProbeRequest,
  { reason, treeOnly }: PendingFallback,
): Promise<ProbeVariantResult> {
  const snapshot = treeOnly ? await deps.snapshotTree() : await deps.snapshot();
  let restoreFailed = false;
  const restore = async (): Promise<void> => {
    try {
      await (treeOnly ? deps.restoreTree(snapshot) : deps.restore(snapshot));
    } catch (error) {
      restoreFailed = true;
      throw error;
    }
  };
  try {
    const raw = await deps.probeThenRestore(
      () => deps.send<BridgeProbeResult & { ok: true }>({
        cmd: 'probeCommit',
        variant,
        stats: request.stats,
        useFullDPS: request.useFullDPS,
      }),
      restore,
    );
    const { ok: _ok, reason: _reason, treeOnly: _treeOnly, ...rest } = raw;
    return { ...(rest as ProbeVariantResult), stats: raw.stats ?? {}, fallback: true, fallbackReason: reason };
  } catch (error) {
    if (restoreFailed) throw error;
    return { ...failed(error), fallback: true, fallbackReason: reason };
  }
}

/** BuildSession.probe's body; the caller holds the session lock for all of it. */
export async function runProbe(deps: ProbeDeps, input: unknown): Promise<ProbeResponse> {
  const request = validateProbeRequest(input);
  const results: Array<ProbeVariantResult | undefined> = new Array(request.variants.length);
  const toEngine: number[] = [];
  for (let i = 0; i < request.variants.length; i++) {
    try {
      await checkVariant(deps, request.variants[i]);
      toEngine.push(i);
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      results[i] = failed(error);
    }
  }

  // Classify first (validation only), so the fallback cap fails before any work.
  const fast: number[] = [];
  const fallbacks: PendingFallback[] = [];
  let base: Stats | undefined;
  for (const chunk of chunks(toEngine, PROBE_CHUNK)) {
    const res = await deps.send<{ ok: true; base: Stats; results: BridgeProbeResult[] }>({
      cmd: 'probe',
      classifyOnly: true,
      stats: request.stats,
      variants: chunk.map((i) => request.variants[i]),
    });
    base ??= res.base;
    chunk.forEach((i, j) => {
      const raw = res.results?.[j] ?? {};
      if (raw.error !== undefined) results[i] = { stats: {}, error: raw.error, userError: raw.userError === true };
      else if (raw.fallback) fallbacks.push({ index: i, reason: raw.reason, treeOnly: raw.treeOnly === true });
      else fast.push(i);
    });
  }
  checkFallbackCap(fallbacks.length);
  if (base === undefined) {
    // No variant reached the engine: a variant-less probe only reads the base.
    base = (await deps.send<{ ok: true; base: Stats }>({ cmd: 'probe', stats: request.stats, variants: [] })).base;
  }

  for (const chunk of chunks(fast, PROBE_CHUNK)) {
    const res = await deps.send<{ ok: true; base: Stats; results: BridgeProbeResult[] }>({
      cmd: 'probe',
      stats: request.stats,
      useFullDPS: request.useFullDPS,
      variants: chunk.map((i) => request.variants[i]),
    });
    chunk.forEach((i, j) => {
      const raw = res.results?.[j] ?? {};
      if (raw.fallback) {
        // Classified as calculator-safe a moment ago; the build has not changed.
        fallbacks.push({ index: i, reason: raw.reason, treeOnly: raw.treeOnly === true });
      } else if (raw.error !== undefined) {
        results[i] = { stats: {}, error: raw.error, userError: raw.userError === true };
      } else {
        results[i] = { ...(raw as ProbeVariantResult), stats: raw.stats ?? {} };
      }
    });
  }

  // Defensive: the run pass may report a fallback the classify pass did not.
  checkFallbackCap(fallbacks.length);
  for (const fallback of fallbacks) {
    results[fallback.index] = await runFallback(deps, request.variants[fallback.index], request, fallback);
  }

  return {
    base,
    results: results.map((r) => r ?? { stats: {}, error: 'variant was not run' }),
  };
}
