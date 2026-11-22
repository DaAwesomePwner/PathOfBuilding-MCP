// Read-only what-if probes: request/response types and the orchestration
// BuildSession.probe runs under its lock.
//
// The bridge's `probe` command (lua/probe.lua) evaluates each variant through
// Path of Building's own calculator (CalcsTab:GetMiscCalculator, what PoB's
// tooltips use) without recalculating or changing the committed build.
// Variant kinds the calculator cannot reproduce exactly come back marked
// `fallback`; those are run here one at a time through `probeCommit` (apply
// for real, full recalc, read) between a full build snapshot and its exact
// restore — the same path the what-if tools used before. Nothing is pushed to
// the undo stack or the crash-recovery journal: the build never changes.

import type { Stats } from './lua-bridge.js';
import { UserError } from './validation.js';

/** One gem change; group and gem indices are 1-based, as in get_skill_breakdown. */
export type ProbeGemChange =
  /** Change gem `index` of group `group`: another gem by name (as swap_gem does), level, quality, enabled. */
  | { op: 'set'; group: number; index: number; name?: string; level?: number; quality?: number; enabled?: boolean }
  /** Remove gem `index` from group `group`. */
  | { op: 'remove'; group: number; index: number }
  /** Add a gem to group `group` (at `position`, default the end; level defaults to 20, quality to 0). */
  | { op: 'add'; group: number; name: string; level?: number; quality?: number; enabled?: boolean; position?: number };

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
  /** Items to put in slots (PoB "Copy item" text). */
  items?: Array<{ slot: string; itemText: string }>;
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

/** What probe needs from BuildSession; every call runs under its lock. */
export interface ProbeDeps {
  send<T>(command: object): Promise<T>;
  /** Throws a UserError when the options are not valid set_config options. */
  validateConfig(options: Record<string, unknown>): Promise<void>;
  /** Full build snapshot / exact restore (restore throws when it is not exact). */
  snapshot(): Promise<unknown>;
  restore(snapshot: unknown): Promise<void>;
}

interface BridgeProbeResult extends Partial<ProbeVariantResult> {
  reason?: string;
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

/** Checks done here rather than in the engine (config values use the TS set_config rules). */
async function checkVariant(deps: ProbeDeps, variant: unknown): Promise<void> {
  if (!isPlainObject(variant)) throw new UserError('each variant must be an object');
  if (variant.config !== undefined) {
    if (!isPlainObject(variant.config)) throw new UserError('config must be an object of config keys');
    await deps.validateConfig(variant.config);
  }
}

function failed(error: unknown): ProbeVariantResult {
  return { stats: {}, error: errorText(error), userError: error instanceof UserError };
}

/** Run one fallback variant: snapshot, apply for real, read, exact restore. */
async function runFallback(
  deps: ProbeDeps,
  variant: ProbeVariant,
  request: ProbeRequest,
  reason: string | undefined,
): Promise<ProbeVariantResult> {
  const snapshot = await deps.snapshot();
  let result: ProbeVariantResult;
  let probeError: unknown = null;
  try {
    const raw = await deps.send<BridgeProbeResult & { ok: true }>({
      cmd: 'probeCommit',
      variant,
      stats: request.stats,
      useFullDPS: request.useFullDPS,
    });
    const { ok: _ok, ...rest } = raw;
    result = { ...(rest as ProbeVariantResult), stats: raw.stats ?? {}, fallback: true, fallbackReason: reason };
  } catch (error) {
    probeError = error;
    result = { ...failed(error), fallback: true, fallbackReason: reason };
  }
  try {
    await deps.restore(snapshot);
  } catch (restoreError) {
    const prefix = probeError ? `${errorText(probeError)} (` : '';
    const suffix = probeError ? ')' : '';
    throw new Error(
      `${prefix}restoring the build after a probe variant failed: ${errorText(restoreError)}${suffix}; call reset_build`,
      { cause: probeError ?? restoreError },
    );
  }
  return result;
}

/** BuildSession.probe's body; the caller holds the session lock. */
export async function runProbe(deps: ProbeDeps, input: unknown): Promise<ProbeResponse> {
  const request = validateProbeRequest(input);
  const results: Array<ProbeVariantResult | undefined> = new Array(request.variants.length);
  const sent: ProbeVariant[] = [];
  const sentIndex: number[] = [];
  for (let i = 0; i < request.variants.length; i++) {
    try {
      await checkVariant(deps, request.variants[i]);
      sent.push(request.variants[i]);
      sentIndex.push(i);
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      results[i] = failed(error);
    }
  }

  const response = await deps.send<{ ok: true; base: Stats; results: BridgeProbeResult[] }>({
    cmd: 'probe',
    stats: request.stats,
    useFullDPS: request.useFullDPS,
    variants: sent,
  });

  const fallbacks: number[] = [];
  sent.forEach((_variant, j) => {
    const raw = response.results?.[j] ?? {};
    const i = sentIndex[j];
    if (raw.fallback) {
      fallbacks.push(j);
      return;
    }
    if (raw.error !== undefined) {
      results[i] = { stats: {}, error: raw.error, userError: raw.userError === true };
      return;
    }
    results[i] = { ...(raw as ProbeVariantResult), stats: raw.stats ?? {} };
  });

  if (fallbacks.length > MAX_FALLBACK_VARIANTS) {
    throw new UserError(
      `${fallbacks.length} variants need a full recalculation each (multi-node changes, jewel sockets, ` +
        `skill-granting nodes or items, two-handed weapon swaps); at most ${MAX_FALLBACK_VARIANTS} are allowed per call`,
    );
  }
  for (const j of fallbacks) {
    results[sentIndex[j]] = await runFallback(deps, sent[j], request, response.results[j].reason);
  }

  return { base: response.base, results: results.map((r) => r ?? { stats: {}, error: 'variant was not run' }) };
}
