/**
 * Turning an untrusted `load_build` source (build code or pobb.in / pastebin
 * link) into PoB XML, with bounded network and decompression work. Every
 * failure a caller can cause is a UserError.
 */
import { Buffer } from 'buffer';
import { deflateRawSync, inflateRawSync, inflateSync } from 'zlib';
import { detectBuildSourceKind, parseBuildURL, UserError } from './validation.js';

/** Total time allowed for one build download, headers and body. */
export const BUILD_FETCH_TIMEOUT_MS = 15_000;
/** Largest build download accepted, enforced while streaming. */
export const BUILD_FETCH_MAX_BYTES = 2 * 1024 * 1024;
/** Longest build code accepted (characters, before base64 decoding). */
export const MAX_BUILD_CODE_LENGTH = 2 * 1024 * 1024;
/** Largest decoded build XML accepted (real builds are well under 1 MB). */
export const MAX_DECODED_BUILD_BYTES = 32 * 1024 * 1024;

const PASTE_CODE_HINT = 'You can paste the build code itself instead (PoB: Import/Export Build -> Generate -> Copy).';

export function encodeBuildCode(xml: string): string {
  const compressed = deflateRawSync(Buffer.from(xml, 'utf-8'));
  return compressed.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function isOutputTooLarge(err: unknown): boolean {
  return (
    err instanceof RangeError ||
    (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE')
  );
}

const oversizeBuildError = (): UserError =>
  new UserError(
    `Build code decodes to more than ${MAX_DECODED_BUILD_BYTES / (1024 * 1024)} MB, which is not a real Path of Building build.`,
  );

export function decodeBuildCode(code: string): string {
  const compact = code.replace(/\s+/g, '');
  if (!compact) {
    throw new UserError('Build code is empty');
  }
  if (compact.length > MAX_BUILD_CODE_LENGTH) {
    throw new UserError(
      `Build code is too long (${compact.length} characters; the limit is ${MAX_BUILD_CODE_LENGTH}).`,
    );
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(compact)) {
    throw new UserError('Invalid build code — contains characters outside the URL-safe base64 alphabet');
  }

  const buffer = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const options = { maxOutputLength: MAX_DECODED_BUILD_BYTES };
  let inflated: Buffer;
  try {
    inflated = inflateRawSync(buffer, options);
  } catch (rawErr) {
    if (isOutputTooLarge(rawErr)) throw oversizeBuildError();
    try {
      inflated = inflateSync(buffer, options);
    } catch (zlibErr) {
      if (isOutputTooLarge(zlibErr)) throw oversizeBuildError();
      throw new UserError('Invalid build code — it is not compressed Path of Building data. Check that it was copied completely.');
    }
  }

  const xml = inflated.toString('utf-8');
  if (!xml.includes('<PathOfBuilding')) {
    throw new UserError('Invalid build code — it decodes, but not to a Path of Building build.');
  }
  return xml;
}

export interface FetchBuildOptions {
  /** Override BUILD_FETCH_TIMEOUT_MS (tests). */
  timeoutMs?: number;
  /** Override BUILD_FETCH_MAX_BYTES (tests). */
  maxBytes?: number;
}

/**
 * Download and decode a build from a pobb.in or pastebin link. The caller's URL
 * is only parsed for its build id; the request goes to a constant origin, with
 * redirects refused, a total deadline and a streamed size cap.
 */
export async function fetchBuildFromURL(url: string, options: FetchBuildOptions = {}): Promise<string> {
  const { site, fetchURL } = parseBuildURL(url);
  const timeoutMs = options.timeoutMs ?? BUILD_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? BUILD_FETCH_MAX_BYTES;

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new UserError(`Downloading the build from ${site} timed out after ${Math.round(timeoutMs / 1000)} s. ${PASTE_CODE_HINT}`));
    }, timeoutMs);
  });
  deadline.catch(() => {});
  const withinDeadline = <T>(p: Promise<T>): Promise<T> => Promise.race([p, deadline]);

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    let resp: Response;
    try {
      resp = await withinDeadline(
        fetch(fetchURL, {
          redirect: 'error',
          signal: controller.signal,
          headers: { Accept: 'text/plain' },
        }),
      );
    } catch (err) {
      if (err instanceof UserError) throw err;
      throw new UserError(
        `Could not download the build from ${site} (network error or an unexpected redirect). ${PASTE_CODE_HINT}`,
      );
    }

    if (resp.type === 'opaqueredirect' || (resp.status >= 300 && resp.status < 400)) {
      throw new UserError(`${site} answered with a redirect, which is not followed. ${PASTE_CODE_HINT}`);
    }
    if (!resp.ok) {
      const hint = resp.status === 404 ? ' (build not found; check the link)' : '';
      throw new UserError(`Failed to fetch the build from ${site}: HTTP ${resp.status}${hint}. ${PASTE_CODE_HINT}`);
    }

    const tooLarge = () =>
      new UserError(`The ${site} download is larger than ${Math.round(maxBytes / 1024)} KB, which is not a real build. ${PASTE_CODE_HINT}`);
    const declared = Number(resp.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();

    const chunks: Buffer[] = [];
    let total = 0;
    if (resp.body) {
      reader = resp.body.getReader();
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await withinDeadline(reader.read());
        } catch (err) {
          if (err instanceof UserError) throw err;
          throw new UserError(`The ${site} download was interrupted. ${PASTE_CODE_HINT}`);
        }
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > maxBytes) throw tooLarge();
        chunks.push(Buffer.from(chunk.value));
      }
      reader = undefined;
    }

    return decodeBuildCode(Buffer.concat(chunks).toString('utf-8'));
  } finally {
    clearTimeout(timer);
    if (reader) reader.cancel().catch(() => {});
    controller.abort();
  }
}

/**
 * Resolve a `load_build` source to PoB XML: raw XML is passed through, links
 * are downloaded, anything else is decoded as a build code. Does no engine
 * work, so callers can run it before taking the session lock.
 */
export async function resolveBuildSource(source: string, options: FetchBuildOptions = {}): Promise<string> {
  const trimmed = source.trim();
  switch (detectBuildSourceKind(trimmed)) {
    case 'xml':
      return trimmed;
    case 'url':
      return fetchBuildFromURL(trimmed, options);
    default:
      return decodeBuildCode(trimmed);
  }
}
