/**
 * Community build samples: `add_sample_builds`, `list_samples` and
 * `remove_sample_builds` on the sample store (src/sample-store.ts), plus
 * `freshSampleSnapshots` for the gap report. Sample builds are read in one
 * temporary engine per call (readInTemporaryEngine, as compare_builds does),
 * so the loaded build, its undo stack and its crash journal are never touched.
 * Builds come only from what the caller supplies; nothing contacts poe.ninja
 * (validateBuildSource refuses its links).
 */
import { z } from 'zod';
import { decodeBuildCode, encodeBuildCode } from './build-source.js';
import {
  type BuildSnapshot,
  checkedSource,
  COMPARE_STAT_KEYS,
  normalizeSnapshot,
  type RawSnapshot,
  readInTemporaryEngine,
  resolvedSource,
  type TemporaryRead,
  TemporaryEngineError,
} from './compare-builds.js';
import type { EngineManager, TemporaryEngineOptions } from './engine-manager.js';
import {
  buildIdFor,
  MAX_SAMPLE_BUILDS,
  MAX_SAMPLE_FILE_BYTES,
  MAX_SAMPLE_LABEL,
  MAX_SAMPLES,
  SAMPLE_SNAPSHOT_FORMAT,
  type SampleBuild,
  type SampleFile,
  SampleStore,
  sampleSlug,
} from './sample-store.js';
import type { ToolRegistrar } from './tool-registry.js';
import { detectBuildSourceKind, parseBuildURL, UserError } from './validation.js';

export const MAX_ADD_BUILDS = 20;
export const MAX_REMOVE_IDS = 50;
/** Stored as a snapshot's version when the install's manifest has none. */
const UNKNOWN_VERSION = 'unknown';
const PURPOSE = 'the sample builds';
const LOAD_NAME = 'sample build';
const TOP_N = 3;
/**
 * Bytes a new build is assumed to add to its sample file, per character of its
 * build code (the code plus its snapshot with item text). Measured on the test
 * fixtures at 3.2-3.9 (an 8-11 KB code gives a 33-35 KB entry); 5 leaves room
 * for builds with more items per code byte. Only an early refusal: the store
 * checks the real size before writing.
 */
const ENTRY_BYTES_PER_CODE_CHAR = 5;

// ---------------------------------------------------------------------------
// Snapshots: reading, staleness, summaries
// ---------------------------------------------------------------------------

/** A stored snapshot read back (null when missing or not a snapshot object). */
function storedSnapshot(b: SampleBuild): BuildSnapshot | null {
  const data = b.snapshot?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  try {
    return normalizeSnapshot(data as RawSnapshot);
  } catch {
    return null;
  }
}

/** Stale: no usable snapshot, another snapshot format, or (when `version` is known) another PoB version. */
function isStale(b: SampleBuild, version: string | null): boolean {
  if (!b.snapshot || b.snapshot.format !== SAMPLE_SNAPSHOT_FORMAT) return true;
  if (version !== null && b.snapshot.pobVersion !== version) return true;
  return storedSnapshot(b) === null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function summary(s: BuildSnapshot | null): { class: string | null; ascendancy: string | null; mainSkill: string | null; level: number | null } {
  const info = s?.info ?? {};
  return { class: str(info.class), ascendancy: str(info.ascendancy), mainSkill: str(info.mainSkill), level: num(info.level) };
}

const withLabel = (label: string | undefined): { label?: string } => (label !== undefined ? { label } : {});

function cleanLabel(label: unknown): string | undefined {
  if (label === undefined || label === null) return undefined;
  if (typeof label !== 'string') throw new UserError('A build label must be a string.');
  const t = label.trim();
  return t ? t.slice(0, MAX_SAMPLE_LABEL) : undefined;
}

/** How the build was given, and the canonical link for a pobb.in / pastebin source. */
function sourceOf(source: string): Pick<SampleBuild, 'source' | 'url'> {
  const kind = detectBuildSourceKind(source);
  if (kind === 'xml') return { source: 'xml' };
  if (kind === 'code') return { source: 'code' };
  const { site, id } = parseBuildURL(source);
  return { source: site, url: site === 'pobb.in' ? `https://pobb.in/${id}` : `https://pastebin.com/${id}` };
}

/**
 * Sample builds read in one temporary engine (item text included), one entry
 * per build in order; a build PoB refuses keeps its error. A crash, timeout or
 * failed start throws a TemporaryEngineError.
 */
async function readSampleBuilds(
  engine: EngineManager,
  builds: Array<{ label: string; xml: string }>,
  options: TemporaryEngineOptions,
  tool: string,
): Promise<TemporaryRead[]> {
  try {
    return await readInTemporaryEngine(engine, builds, [...COMPARE_STAT_KEYS], options, {
      purpose: PURPOSE,
      loadName: LOAD_NAME,
      itemText: true,
      collectRefusals: true,
    });
  } catch (e) {
    // withTemporaryEngine's crash-breaker refusal names compare_builds.
    if (e instanceof UserError && !(e instanceof TemporaryEngineError) && e.message.startsWith('compare_builds is refused')) {
      throw new UserError(`${tool}${e.message.slice('compare_builds'.length)}`);
    }
    throw e;
  }
}

const snapshotRecord = (snapshot: BuildSnapshot, version: string): NonNullable<SampleBuild['snapshot']> => ({
  pobVersion: version,
  format: SAMPLE_SNAPSHOT_FORMAT,
  data: snapshot,
});

// ---------------------------------------------------------------------------
// freshSampleSnapshots (the gap report's read of a sample)
// ---------------------------------------------------------------------------

export interface FreshSampleBuild {
  id: string;
  label?: string;
  /** compareSnapshot of the build, with item text. */
  snapshot: BuildSnapshot;
}

export interface FreshSamples {
  /** The sample as saved (with the refreshed snapshots). */
  file: SampleFile;
  builds: FreshSampleBuild[];
  /** Builds left out of this read: PoB refused them now. They stay in the file. */
  dropped: Array<{ id: string; label?: string; error: string }>;
}

/**
 * Every build of `sampleName` with a current snapshot. Stale snapshots (another
 * PoB version or snapshot format, or unreadable) are re-read in ONE temporary
 * engine and saved back (only for builds still in the file when it is saved).
 * A build PoB now refuses is listed under `dropped` with its error and kept in
 * the file; a temporary-engine failure throws (TemporaryEngineError). Call it
 * from inside engine.run() (a shared gate slot), as every temporary engine.
 */
export async function freshSampleSnapshots(
  engine: EngineManager,
  store: SampleStore,
  sampleName: string,
  options: TemporaryEngineOptions & { tool?: string } = {},
): Promise<FreshSamples> {
  const { tool = 'community_gap_report', ...temporary } = options;
  const file = await store.get(sampleName);
  const version = engine.pobVersion() ?? UNKNOWN_VERSION;
  const fresh = new Map<string, BuildSnapshot>();
  const dropped: FreshSamples['dropped'] = [];
  const toRead: Array<{ build: SampleBuild; xml: string }> = [];
  for (const b of file.builds.filter((x) => isStale(x, version))) {
    try {
      toRead.push({ build: b, xml: decodeBuildCode(b.code) });
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      dropped.push({ id: b.id, ...withLabel(b.label), error: `its saved build code does not decode: ${e.message}` });
    }
  }
  if (toRead.length) {
    const reads = await readSampleBuilds(engine, toRead.map(({ build, xml }) => ({ label: build.id, xml })), temporary, tool);
    reads.forEach((r, k) => {
      const b = toRead[k].build;
      if ('error' in r) dropped.push({ id: b.id, ...withLabel(b.label), error: r.error.message });
      else fresh.set(b.id, r.snapshot);
    });
  }
  let saved = file;
  if (fresh.size) {
    // update() without `create` refuses a sample removed meanwhile before calling back, so `cur` is set.
    saved = await store.update(sampleName, (cur) => {
      const next: SampleFile = {
        ...cur!,
        builds: cur!.builds.map((b) => (fresh.has(b.id) ? { ...b, snapshot: snapshotRecord(fresh.get(b.id)!, version) } : b)),
      };
      return { file: next, result: next };
    });
  }
  // Every build of the saved file is in `builds` or `dropped`: one another call
  // added during the refresh is used when its snapshot is current.
  const droppedIds = new Set(dropped.map((d) => d.id));
  const builds: FreshSampleBuild[] = [];
  for (const b of saved.builds) {
    if (droppedIds.has(b.id)) continue;
    const snapshot = fresh.get(b.id) ?? (isStale(b, version) ? null : storedSnapshot(b));
    if (snapshot) builds.push({ id: b.id, ...withLabel(b.label), snapshot });
    else dropped.push({ id: b.id, ...withLabel(b.label), error: 'added or changed while the sample was being refreshed; retry' });
  }
  return { file: saved, builds, dropped };
}

// ---------------------------------------------------------------------------
// add_sample_builds
// ---------------------------------------------------------------------------

export interface AddSampleBuildsArgs {
  sample: string;
  builds: Array<{ source: string; label?: string }>;
}

/** The sample's file when it exists; null when it does not and one more may be created. */
async function existingSample(store: SampleStore, name: string): Promise<SampleFile | null> {
  const file = await store.find(name);
  if (!file && (await store.sampleCount()) >= MAX_SAMPLES) {
    throw new UserError(`At most ${MAX_SAMPLES} samples can be saved; remove one first (remove_sample_builds deleteSample).`);
  }
  return file;
}

const fileBytes = (file: SampleFile): number => Buffer.byteLength(`${JSON.stringify(file)}\n`, 'utf8');

/**
 * Decode, deduplicate and read new builds (one temporary engine), then save
 * them. Nothing is saved when the temporary engine fails; a build PoB refuses
 * is reported under `failed` and the others are still added.
 */
export async function addSampleBuilds(
  engine: EngineManager,
  store: SampleStore,
  args: AddSampleBuildsArgs,
  options: TemporaryEngineOptions = {},
): Promise<Record<string, unknown>> {
  sampleSlug(args.sample);
  const name = args.sample.trim();
  if (!Array.isArray(args.builds) || args.builds.length < 1 || args.builds.length > MAX_ADD_BUILDS) {
    throw new UserError(`builds: give 1-${MAX_ADD_BUILDS} builds per call (got ${Array.isArray(args.builds) ? args.builds.length : 'none'}).`);
  }
  const inputs = args.builds.map((b, index) => ({
    index,
    arg: `builds[${index}].source`,
    source: checkedSource(b?.source, `builds[${index}].source`),
    label: cleanLabel(b?.label),
  }));
  const existing = await existingSample(store, name);

  // Downloads and decoding happen before any engine work.
  const resolved = await Promise.all(
    inputs.map(async (b) => {
      try {
        return { ...b, xml: await resolvedSource(b.source, b.arg) };
      } catch (e) {
        if (e instanceof UserError) return { ...b, error: e.message };
        throw e;
      }
    }),
  );
  const failed: Array<{ index: number; label?: string; error: string }> = [];
  const duplicates: Array<{ id: string; label?: string }> = [];
  const fresh: Array<(typeof inputs)[number] & { xml: string; id: string; code: string }> = [];
  const known = new Set(existing?.builds.map((b) => b.id) ?? []);
  for (const r of resolved) {
    if ('error' in r) {
      failed.push({ index: r.index, ...withLabel(r.label), error: r.error });
      continue;
    }
    const id = buildIdFor(r.xml);
    if (known.has(id)) {
      duplicates.push({ id, ...withLabel(r.label) });
      continue;
    }
    known.add(id);
    fresh.push({ ...r, id, code: encodeBuildCode(r.xml) });
  }
  const count = existing?.builds.length ?? 0;
  if (count + fresh.length > MAX_SAMPLE_BUILDS) {
    throw new UserError(
      `A sample holds at most ${MAX_SAMPLE_BUILDS} builds: "${name}" has ${count} and this call adds ${fresh.length} new ones. ` +
        'Remove builds first (remove_sample_builds) or add fewer. Nothing was added.',
    );
  }
  if (fresh.length) {
    const estimate =
      (existing ? fileBytes(existing) : 1024) + fresh.reduce((n, b) => n + b.code.length * ENTRY_BYTES_PER_CODE_CHAR, 0);
    if (estimate > MAX_SAMPLE_FILE_BYTES) {
      throw new UserError(
        `Sample "${name}" would grow past its ${MAX_SAMPLE_FILE_BYTES / (1024 * 1024)} MB file limit with these builds (about ${Math.ceil(estimate / 1024)} KB). ` +
          'Remove builds first (remove_sample_builds), add fewer, or start another sample. Nothing was added.',
      );
    }
  }
  const reply = (finalCount: number, added: SampleBuild[]): Record<string, unknown> => ({
    sample: name,
    count: finalCount,
    added: added.map((b) => ({ id: b.id, ...withLabel(b.label), ...summary(storedSnapshot(b)) })),
    duplicates,
    failed: failed.sort((x, y) => x.index - y.index),
  });
  if (!fresh.length) return reply(count, []);

  const reads = await readSampleBuilds(engine, fresh.map((b) => ({ label: `builds[${b.index}]`, xml: b.xml })), options, 'add_sample_builds');
  const version = engine.pobVersion() ?? UNKNOWN_VERSION;
  const now = new Date().toISOString();
  const readOk: SampleBuild[] = [];
  reads.forEach((r, k) => {
    const b = fresh[k];
    if ('error' in r) {
      failed.push({ index: b.index, ...withLabel(b.label), error: r.error.message });
      return;
    }
    readOk.push({ id: b.id, ...withLabel(b.label), ...sourceOf(b.source), code: b.code, addedAt: now, snapshot: snapshotRecord(r.snapshot, version) });
  });
  if (!readOk.length) return reply(count, []);

  // Another call may have added builds since the checks above: the cap is checked again on the file as it is now.
  const lateDuplicates: typeof duplicates = [];
  let saved: { count: number; added: SampleBuild[] };
  try {
    saved = await store.update(
      name,
      (cur) => {
        const base: SampleFile = cur ?? { version: 1, name, createdAt: now, updatedAt: now, builds: [] };
        const ids = new Set(base.builds.map((b) => b.id));
        const added: SampleBuild[] = [];
        for (const b of readOk) {
          // Added by another call in the meantime.
          if (ids.has(b.id)) lateDuplicates.push({ id: b.id, ...withLabel(b.label) });
          else {
            ids.add(b.id);
            added.push(b);
          }
        }
        if (base.builds.length + added.length > MAX_SAMPLE_BUILDS) {
          throw new UserError(
            `Nothing was added: sample "${name}" would exceed ${MAX_SAMPLE_BUILDS} builds (now ${base.builds.length}, this call adds ${added.length}; ` +
              'another call added builds meanwhile). Remove builds first (remove_sample_builds) or add fewer.',
          );
        }
        const builds = [...base.builds, ...added];
        return { file: { ...base, builds }, result: { count: builds.length, added } };
      },
      { create: true },
    );
  } catch (e) {
    // The store's own refusals (file size, sample count), raised before anything is written.
    if (e instanceof UserError && !e.message.startsWith('Nothing was added')) throw new UserError(`Nothing was added: ${e.message}`);
    throw e;
  }
  duplicates.push(...lateDuplicates);
  return reply(saved.count, saved.added);
}

// ---------------------------------------------------------------------------
// list_samples
// ---------------------------------------------------------------------------

export interface ListSamplesArgs {
  sample?: string;
  build?: string;
  slot?: string;
}

function top(values: Array<string | null>): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of values) if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_N)
    .map(([name, count]) => ({ name, count }));
}

function findBuild(file: SampleFile, id: string): SampleBuild {
  const want = id.trim().toLowerCase();
  const b = file.builds.find((x) => x.id === want);
  if (!b) {
    throw new UserError(
      `Sample "${file.name}" has no build "${id}".` +
        (file.builds.length ? ` Its builds: ${file.builds.map((x) => x.id).join(', ')}.` : ' It has no builds.'),
    );
  }
  return b;
}

function buildRow(b: SampleBuild, version: string | null): Record<string, unknown> {
  return {
    id: b.id,
    ...withLabel(b.label),
    ...summary(storedSnapshot(b)),
    addedAt: b.addedAt,
    ...(isStale(b, version) ? { stale: true } : {}),
  };
}

/** Every sample, one sample's builds, or one build's items (and one item's text). Read-only. */
export async function listSamples(engine: EngineManager, store: SampleStore, args: ListSamplesArgs = {}): Promise<Record<string, unknown>> {
  if (args.build !== undefined && args.sample === undefined) throw new UserError('`build` needs `sample`.');
  if (args.slot !== undefined && args.build === undefined) throw new UserError('`slot` needs `sample` and `build`.');
  const version = engine.pobVersion();
  if (args.sample === undefined) {
    // Each file is read once, and only its summary is kept.
    const rows = await store.listWith((file) => {
      const sums = file.builds.map((b) => summary(storedSnapshot(b)));
      return { ascendancies: top(sums.map((s) => s.ascendancy ?? s.class)), mainSkills: top(sums.map((s) => s.mainSkill)) };
    });
    const samples = rows.map((r) =>
      r.error !== undefined ? { name: r.name, error: r.error } : { name: r.name, count: r.count, updatedAt: r.updatedAt, ...r.summary },
    );
    return { samples };
  }

  const file = await store.get(args.sample);
  if (args.build === undefined) {
    return { sample: file.name, count: file.builds.length, updatedAt: file.updatedAt, builds: file.builds.map((b) => buildRow(b, version)) };
  }

  const b = findBuild(file, args.build);
  const snap = storedSnapshot(b);
  const items = snap?.items ?? [];
  const out: Record<string, unknown> = {
    sample: file.name,
    build: { ...buildRow(b, version), source: b.source, ...(b.url ? { url: b.url } : {}) },
    items: items.map((i) => ({
      slot: i.slot,
      name: i.name ?? null,
      base: i.base ?? null,
      rarity: i.rarity ?? null,
      ...(i.swap ? { swap: true } : {}),
      ...(i.inactive ? { inactive: true } : {}),
      ...(i.flaskActive === false ? { flaskActive: false } : {}),
    })),
    ...(snap ? {} : { note: 'This build has no readable snapshot yet; the next community_gap_report reads it again.' }),
  };
  if (args.slot !== undefined) {
    const want = args.slot.trim();
    // swap_item names passive-tree sockets "Jewel <id>"; the snapshot lists them as "Tree jewel <id>".
    const alias = /^Jewel (\d+)$/i.exec(want);
    const item =
      items.find((i) => i.slot.toLowerCase() === want.toLowerCase()) ??
      (alias ? items.find((i) => i.slot === `Tree jewel ${alias[1]}`) : undefined);
    if (!item) {
      throw new UserError(
        `Build ${b.id} has no item in slot "${want}".` + (items.length ? ` Its slots: ${items.map((i) => i.slot).join(', ')}.` : ''),
      );
    }
    if (typeof item.text !== 'string') {
      throw new UserError(`Path of Building gave no item text for "${item.slot}" of build ${b.id}, so it cannot be copied from the sample.`);
    }
    const tree = /^Tree jewel (\d+)$/.exec(item.slot);
    out.item = {
      slot: item.slot,
      itemText: item.text,
      ...(tree ? { note: `Passive-tree socket ${tree[1]}: swap_item takes this slot as "Jewel ${tree[1]}".` } : {}),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// remove_sample_builds
// ---------------------------------------------------------------------------

export interface RemoveSampleBuildsArgs {
  sample: string;
  ids?: string[];
  deleteSample?: boolean;
}

/** Remove builds by id (all ids checked first) or delete the whole sample. */
export async function removeSampleBuilds(store: SampleStore, args: RemoveSampleBuildsArgs): Promise<Record<string, unknown>> {
  const hasIds = args.ids !== undefined;
  if (hasIds === (args.deleteSample === true)) {
    throw new UserError('Pass either `ids` (builds to remove) or `deleteSample: true` (removes the whole sample), not both.');
  }
  if (args.deleteSample) {
    await store.delete(args.sample);
    return { sample: args.sample.trim(), deleted: true };
  }
  const ids = [...new Set((args.ids ?? []).map((id) => String(id).trim().toLowerCase()))];
  if (ids.length < 1 || ids.length > MAX_REMOVE_IDS) throw new UserError(`ids: give 1-${MAX_REMOVE_IDS} build ids.`);
  return store.update(args.sample, (cur) => {
    const file = cur!;
    const have = new Set(file.builds.map((b) => b.id));
    const unknown = ids.filter((id) => !have.has(id));
    if (unknown.length) {
      throw new UserError(
        `Sample "${file.name}" has no build ${unknown.map((id) => `"${id}"`).join(', ')}; nothing was removed.` +
          (file.builds.length ? ` Its builds: ${file.builds.map((b) => b.id).join(', ')}.` : ''),
      );
    }
    const builds = file.builds.filter((b) => !ids.includes(b.id));
    return { file: { ...file, builds }, result: { sample: file.name, removed: ids, count: builds.length } };
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const sampleName = z.string().min(1).max(80).describe("Sample name: 1-60 letters, digits, spaces and - _ . ' ( ) +.");

export function registerCommunitySamples(tools: ToolRegistrar, engine: EngineManager, store: SampleStore = new SampleStore()): void {
  tools.engine<AddSampleBuildsArgs>(
    'add_sample_builds',
    {
      description:
        'Add community builds to a named sample saved on disk (created if missing), for comparing the loaded build with what the community plays. ' +
        'Each build is anything load_build accepts (build code, pobb.in / pastebin link, raw XML; poe.ninja links are refused: copy the build code from its "Path of Building" button). ' +
        "The builds are read with Path of Building's own engine in a short-lived second engine started for this call; the loaded build and its undo history are never changed. " +
        'A build already in the sample is listed under `duplicates`, one Path of Building refuses (or that does not download) under `failed` with the reason; the others are still added. ' +
        `At most ${MAX_ADD_BUILDS} builds per call and ${MAX_SAMPLE_BUILDS} per sample. ` +
        'Returns { sample, count, added: [{ id, label, class, ascendancy, mainSkill, level }], duplicates, failed: [{ index, label, error }] }.',
      inputSchema: {
        sample: sampleName,
        builds: z
          .array(
            z.object({
              source: z.string().min(1).describe('Build code (base64), pobb.in URL, pastebin URL, or raw XML (as load_build takes).'),
              label: z.string().max(MAX_SAMPLE_LABEL).optional().describe('Short note, e.g. "poe.ninja #3 RF Chieftain".'),
            }),
          )
          .min(1)
          .max(MAX_ADD_BUILDS),
      },
    },
    async (args) => addSampleBuilds(engine, store, args),
  );

  tools.plain<ListSamplesArgs>(
    'list_samples',
    {
      description:
        'List saved community build samples. No arguments: every sample with its size and most common ascendancies / main skills. ' +
        '`sample`: its builds { id, label, class, ascendancy, mainSkill, level, addedAt, stale } (stale = read with another Path of Building version; the next gap report reads it again). ' +
        '`sample` + `build` (id): that build and its items by slot { slot, name, base, rarity }; with `slot` also that item\'s full text (`item.itemText`, the PoB "Copy item" text swap_item and apply_changes take). Read-only.',
      inputSchema: {
        sample: sampleName.optional(),
        build: z.string().min(1).max(40).optional().describe('Build id (from list_samples `sample`).'),
        slot: z.string().min(1).max(80).optional().describe('Item slot of that build (e.g. "Body Armour", "Ring 1", "Tree jewel 26725").'),
      },
    },
    async (args) => listSamples(engine, store, args),
  );

  tools.plain<RemoveSampleBuildsArgs>(
    'remove_sample_builds',
    {
      description:
        'Remove builds from a saved community sample by id (`ids`; an unknown id is refused and nothing is removed), or delete the whole sample (`deleteSample: true`). ' +
        'Never touches the loaded build.',
      inputSchema: {
        sample: sampleName,
        ids: z.array(z.string().min(1).max(40)).min(1).max(MAX_REMOVE_IDS).optional().describe('Build ids to remove (from list_samples).'),
        deleteSample: z.boolean().optional().describe('true removes the whole sample file.'),
      },
    },
    async (args) => removeSampleBuilds(store, args),
  );
}
