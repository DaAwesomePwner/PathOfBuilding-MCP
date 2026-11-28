import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { configDir } from './config-store.js';
import { UserError } from './validation.js';

/**
 * On-disk store for named "community build samples": user-supplied PoB builds
 * saved as one JSON file per sample under `<configDir()>/samples/` (never
 * inside the PoB install). Sample names come from tool arguments, so they
 * become file names only through `sampleSlug`.
 */

/** Bumped when the bridge's `compareSnapshot` output changes; older snapshots are stale. */
export const SAMPLE_SNAPSHOT_FORMAT = 1;
export const MAX_SAMPLE_BUILDS = 50;
export const MAX_SAMPLES = 100;
export const MAX_SAMPLE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_SAMPLE_NAME = 60;
export const MAX_SAMPLE_LABEL = 100;
/** Sample names listed in a "no such sample" error. */
const MAX_LISTED_NAMES = 20;

export interface SampleBuild {
  /** First 12 hex chars of sha256 of the decoded XML (`buildIdFor`). */
  id: string;
  label?: string;
  source: 'code' | 'xml' | 'pobb.in' | 'pastebin';
  /** Canonical link when the source was one. */
  url?: string;
  /** `encodeBuildCode(xml)`, so the build works offline. */
  code: string;
  addedAt: string;
  /** `compareSnapshot` reply; stale when `pobVersion` or `format` differs from the engine's. */
  snapshot?: { pobVersion: string; format: number; data: unknown };
}

export interface SampleFile {
  version: 1;
  name: string;
  createdAt: string;
  updatedAt: string;
  builds: SampleBuild[];
}

/** `buildIdFor`'s output shape. */
const BUILD_ID_RE = /^[0-9a-f]{12}$/;

const buildSchema = z.object({
  id: z.string().regex(BUILD_ID_RE, 'build id must be 12 lower-case hex characters'),
  label: z.string().optional(),
  source: z.enum(['code', 'xml', 'pobb.in', 'pastebin']),
  url: z.string().optional(),
  code: z.string(),
  addedAt: z.string(),
  snapshot: z.object({ pobVersion: z.string(), format: z.number(), data: z.unknown() }).optional(),
});
const fileSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  builds: z.array(buildSchema).max(MAX_SAMPLE_BUILDS, `more than ${MAX_SAMPLE_BUILDS} builds`),
});

const NAME_RE = /^[A-Za-z0-9 \-_.'()+]+$/;
/** Windows opens these as devices whatever the extension, so a file named after one is unusable. */
const RESERVED_SLUG_RE = /^(?:con|prn|aux|nul|com\d|lpt\d)$/;

/** Validates a sample name (UserError) and returns its file slug. */
export function sampleSlug(name: string): string {
  if (typeof name !== 'string') throw new UserError('Sample name must be a string.');
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_SAMPLE_NAME) {
    throw new UserError(`Sample name must be 1-${MAX_SAMPLE_NAME} characters.`);
  }
  if (!NAME_RE.test(trimmed)) {
    throw new UserError("Sample name may only contain letters, digits, spaces and - _ . ' ( ) +.");
  }
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new UserError('Sample name needs at least one letter or digit.');
  if (RESERVED_SLUG_RE.test(slug)) throw new UserError(`Sample name "${trimmed}" is a reserved file name; pick another.`);
  return slug;
}

/** Stable build id: the first 12 hex chars of sha256 over the XML's UTF-8 bytes. */
export function buildIdFor(xml: string): string {
  return createHash('sha256').update(xml, 'utf8').digest('hex').slice(0, 12);
}

export interface SampleListEntry {
  name: string;
  count: number;
  updatedAt: string;
  file: string;
  /** Set when the file could not be read or failed validation (name is then its slug). */
  error?: string;
}

/**
 * One chain per samples directory, shared by every store instance: PoB-free
 * read-modify-write needs no cross-process lock, only in-process ordering.
 */
const chains = new Map<string, Promise<unknown>>();
let tmpCounter = 0;
/** Directories whose stale tmp files were already swept by this process. */
const sweptDirs = new Set<string>();
/** A tmp file this old belongs to a writer that died before its rename. */
const STALE_TMP_MS = 10 * 60 * 1000;
const TMP_NAME_RE = /^[a-z0-9-]+\.json\.tmp-\d+-\d+$/;

/** File operations the store uses; tests replace `rename` to exercise write failures and retries. */
export interface SampleStoreFsOps {
  rename: typeof rename;
}

/**
 * Every method (reads too) runs under one in-process mutex shared by all
 * instances on the same directory. The lock is not re-entrant: calling any
 * store method from inside an `update` callback waits for itself and deadlocks.
 */
export class SampleStore {
  readonly dir: string;
  private readonly ops: SampleStoreFsOps;

  constructor(env: NodeJS.ProcessEnv = process.env, ops: Partial<SampleStoreFsOps> = {}) {
    this.ops = { rename, ...ops };
    this.dir = path.join(configDir(env), 'samples');
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(this.dir) ?? Promise.resolve();
    const next = prev.then(() => this.sweepStaleTmp()).then(fn, fn);
    chains.set(this.dir, next.catch(() => undefined));
    return next;
  }

  /** Once per process and directory: removes tmp files left by a writer that died mid-write. Best effort. */
  private async sweepStaleTmp(): Promise<void> {
    if (sweptDirs.has(this.dir)) return;
    sweptDirs.add(this.dir);
    try {
      const cutoff = Date.now() - STALE_TMP_MS;
      for (const f of await readdir(this.dir)) {
        if (!TMP_NAME_RE.test(f)) continue;
        const full = path.join(this.dir, f);
        try {
          if ((await stat(full)).mtimeMs < cutoff) await unlink(full);
        } catch {
          /* best effort */
        }
      }
    } catch {
      /* no directory yet, or unreadable: nothing to sweep */
    }
  }

  private fileFor(slug: string): string {
    return path.join(this.dir, `${slug}.json`);
  }

  /** Reads and validates one file; null when missing. A bad file is a UserError naming its path. */
  private async readFile(file: string, expectSlug?: string): Promise<SampleFile | null> {
    let raw: string;
    try {
      const info = await stat(file);
      if (info.size > MAX_SAMPLE_FILE_BYTES) {
        throw new UserError(`Sample file ${file} is larger than ${MAX_SAMPLE_FILE_BYTES} bytes; it was left untouched.`);
      }
      raw = await readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      if (e instanceof UserError) throw e;
      throw new UserError(`Cannot read sample file ${file}: ${String((e as Error)?.message ?? e)}`);
    }
    const bad = (why: string) =>
      new UserError(`Sample file ${file} is not a valid sample (${why}); it was left untouched. Fix or remove it by hand.`);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw bad(`not JSON: ${String((e as Error).message)}`);
    }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) throw bad(parsed.error.issues[0]?.message ?? 'schema mismatch');
    const data = parsed.data as SampleFile;
    const ids = new Set(data.builds.map((b) => b.id));
    if (ids.size !== data.builds.length) throw bad('duplicate build ids');
    if (expectSlug !== undefined) {
      let slug: string;
      try {
        slug = sampleSlug(data.name);
      } catch {
        throw bad(`invalid sample name "${data.name}"`);
      }
      if (slug !== expectSlug) throw bad(`its name "${data.name}" does not match its file name`);
    }
    return data;
  }

  private async slugsOnDisk(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir);
      return entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw e;
    }
  }

  /** Reads the sample for `name`, refusing a different name with the same slug. */
  private async load(name: string): Promise<{ slug: string; file: string; data: SampleFile | null }> {
    const slug = sampleSlug(name);
    const file = this.fileFor(slug);
    const data = await this.readFile(file, slug);
    if (data && data.name !== name.trim()) {
      throw new UserError(`A sample named "${data.name}" already exists and maps to the same file as "${name.trim()}"; use that name.`);
    }
    return { slug, file, data };
  }

  private async checkSampleCount(): Promise<void> {
    if ((await this.slugsOnDisk()).length >= MAX_SAMPLES) {
      throw new UserError(`At most ${MAX_SAMPLES} samples can be saved; remove one first.`);
    }
  }

  private async missing(name: string): Promise<UserError> {
    const slugs = await this.slugsOnDisk();
    const shown = slugs.slice(0, MAX_LISTED_NAMES);
    const names: string[] = [];
    for (const s of shown) {
      try {
        names.push((await this.readFile(this.fileFor(s)))?.name ?? s);
      } catch {
        names.push(s);
      }
    }
    const more = slugs.length > shown.length ? ` (and ${slugs.length - shown.length} more)` : '';
    return new UserError(
      `No sample named "${name.trim()}".` +
        (names.length ? ` Existing samples: ${names.map((n) => `"${n}"`).join(', ')}${more}.` : ' There are no samples yet.')
    );
  }

  list(): Promise<SampleListEntry[]> {
    return this.listWith(() => undefined).then((rows) => rows.map(({ summary: _summary, ...entry }) => entry));
  }

  /**
   * `list()` plus `summarize(file)` per readable sample, each file read once
   * and dropped after its summary (memory stays one file at a time).
   */
  listWith<T>(summarize: (file: SampleFile) => T): Promise<Array<SampleListEntry & { summary?: T }>> {
    return this.run(async () => {
      const out: Array<SampleListEntry & { summary?: T }> = [];
      for (const slug of await this.slugsOnDisk()) {
        const file = this.fileFor(slug);
        try {
          const data = await this.readFile(file, slug);
          if (data) out.push({ name: data.name, count: data.builds.length, updatedAt: data.updatedAt, file, summary: summarize(data) });
        } catch (e) {
          out.push({ name: slug, count: 0, updatedAt: '', file, error: (e as Error).message });
        }
      }
      return out;
    });
  }

  /** Number of sample files on disk (no file is read). */
  sampleCount(): Promise<number> {
    return this.run(async () => (await this.slugsOnDisk()).length);
  }

  /** The sample, or null when it does not exist; a bad file or a name clash is a UserError as in `get`. */
  find(name: string): Promise<SampleFile | null> {
    return this.run(async () => (await this.load(name)).data);
  }

  get(name: string): Promise<SampleFile> {
    return this.run(async () => {
      const { data } = await this.load(name);
      if (!data) throw await this.missing(name);
      return data;
    });
  }

  /**
   * Read-modify-write under the mutex. `fn` gets the current file (null when
   * absent and `create` is set) and returns the new file (the store stamps
   * `updatedAt`) or null to delete the sample. Caps are checked before anything
   * is written, so a refusal leaves the file as it was. Not re-entrant: `fn`
   * must not call any store method (it would wait on the lock it holds).
   */
  update<T>(
    name: string,
    fn: (file: SampleFile | null) => { file: SampleFile | null; result: T } | Promise<{ file: SampleFile | null; result: T }>,
    opts: { create?: boolean } = {}
  ): Promise<T> {
    return this.run(async () => {
      const { slug, file, data } = await this.load(name);
      if (!data && !opts.create) throw await this.missing(name);
      // Refuse before `fn` runs, so a caller doing expensive work in it learns early.
      if (!data) await this.checkSampleCount();
      const { file: next, result } = await fn(data);
      if (next === null) {
        if (data) await unlink(file).catch((e) => { if (e?.code !== 'ENOENT') throw e; });
        return result;
      }
      if (next.name !== name.trim()) throw new Error(`sample-store: update() must keep the sample name "${name.trim()}"`);
      if (!data) await this.checkSampleCount();
      if (next.builds.length > MAX_SAMPLE_BUILDS) {
        throw new UserError(`A sample holds at most ${MAX_SAMPLE_BUILDS} builds; it would have ${next.builds.length}.`);
      }
      const toWrite: SampleFile = {
        ...next,
        updatedAt: new Date().toISOString(),
        builds: next.builds.map((b) => (b.label !== undefined && b.label.length > MAX_SAMPLE_LABEL ? { ...b, label: b.label.slice(0, MAX_SAMPLE_LABEL) } : b)),
      };
      // The same schema as a read: a file this store would later refuse never reaches the disk.
      const check = fileSchema.safeParse(toWrite);
      if (!check.success) throw new Error(`sample-store: refusing to write an invalid sample: ${check.error.issues[0]?.message}`);
      if (new Set(toWrite.builds.map((b) => b.id)).size !== toWrite.builds.length) {
        throw new Error('sample-store: duplicate build ids');
      }
      const text = `${JSON.stringify(toWrite)}\n`;
      if (Buffer.byteLength(text, 'utf8') > MAX_SAMPLE_FILE_BYTES) {
        throw new UserError(`Sample "${toWrite.name}" would be larger than ${MAX_SAMPLE_FILE_BYTES} bytes; remove builds first.`);
      }
      await this.writeAtomic(file, text);
      return result;
    });
  }

  /** The one way to remove a sample file, including one that fails validation. */
  delete(name: string): Promise<void> {
    return this.run(async () => {
      const slug = sampleSlug(name);
      const file = this.fileFor(slug);
      try {
        // A corrupt file may be deleted, but only when its slug is the one asked for; a valid one must match the exact name.
        const data = await this.readFile(file, slug).catch(() => undefined);
        if (data && data.name !== name.trim()) {
          throw new UserError(`A sample named "${data.name}" already exists and maps to the same file as "${name.trim()}"; use that name.`);
        }
        await unlink(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') throw await this.missing(name);
        throw e;
      }
    });
  }

  /** Temp file in the same directory, then rename, so a reader never sees a partial file. */
  private async writeAtomic(file: string, text: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${++tmpCounter}`;
    try {
      await writeFile(tmp, text, 'utf8');
      for (let attempt = 0; ; attempt++) {
        try {
          await this.ops.rename(tmp, file);
          return;
        } catch (e) {
          // Windows reports EPERM/EBUSY while antivirus or an indexer briefly holds the target.
          const code = (e as NodeJS.ErrnoException)?.code;
          if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
          await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        }
      }
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
  }
}
