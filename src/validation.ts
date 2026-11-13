/**
 * Input validation helpers for the MCP boundary. UserError is the only
 * exception type that should reach the caller verbatim — everything else
 * is wrapped as "Internal error".
 */

export class UserError extends Error {
  readonly isUserError = true;
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/**
 * Heuristic detection of input kind so callers can reject obvious garbage
 * before the Lua bridge gets involved. Anything with a URL scheme (or a bare
 * `pobb.in/...` / `pastebin.com/...` link) is a URL; base64 build codes never
 * contain ':' or '.', so this cannot misclassify a real code.
 */
export type BuildSourceKind = 'xml' | 'url' | 'code';

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const BARE_BUILD_HOST_RE = /^(?:www\.)?(?:pastebin\.com|pobb\.in)\//i;

export function detectBuildSourceKind(source: string): BuildSourceKind {
  const trimmed = source.trim();
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<PathOfBuilding')) return 'xml';
  if (URL_SCHEME_RE.test(trimmed) || BARE_BUILD_HOST_RE.test(trimmed)) return 'url';
  return 'code';
}

// ------------------------------------------------------------------
// Build URLs
// ------------------------------------------------------------------

export type BuildSite = 'pastebin' | 'pobb.in';

export interface ParsedBuildURL {
  site: BuildSite;
  /** Build id, already checked against the site's id alphabet. */
  id: string;
  /** The URL we download from: a constant origin plus the id. Never the caller's URL. */
  fetchURL: string;
}

/** Hostnames accepted for build links, after lower-casing. */
const BUILD_URL_HOSTS: Record<string, BuildSite> = {
  'pastebin.com': 'pastebin',
  'www.pastebin.com': 'pastebin',
  'pobb.in': 'pobb.in',
  'www.pobb.in': 'pobb.in',
};

/** Accepted path forms per site (`/<id>` or the raw-download form), optional trailing slash. */
const BUILD_URL_PATHS: Record<BuildSite, RegExp> = {
  pastebin: /^\/(?:raw\/)?([A-Za-z0-9]+)\/?$/,
  'pobb.in': /^\/(?:pob\/)?([A-Za-z0-9_-]+)\/?$/,
};

/** Path prefixes that are never build ids on their own (`/raw/`, `/pob/` with the id missing). */
const RESERVED_BUILD_IDS: Record<BuildSite, string> = { pastebin: 'raw', 'pobb.in': 'pob' };

/** Constant download origins (Path of Building's own BuildSiteTools uses the same). */
const BUILD_FETCH_BASE: Record<BuildSite, string> = {
  pastebin: 'https://pastebin.com/raw/',
  'pobb.in': 'https://pobb.in/pob/',
};

const MAX_ECHOED_HOST_LENGTH = 80;

export const ACCEPTED_BUILD_URLS_HINT =
  'Only https links to pobb.in (https://pobb.in/<id>) and pastebin.com (https://pastebin.com/<id>) are accepted; ' +
  'you can also paste the build code itself.';

function describeHost(hostname: string): string {
  const shown =
    hostname.length > MAX_ECHOED_HOST_LENGTH ? `${hostname.slice(0, MAX_ECHOED_HOST_LENGTH)}...` : hostname;
  return shown ? `"${shown}"` : '(none)';
}

/**
 * The single parser that decides both whether a build URL is accepted and
 * what gets downloaded. Throws UserError for anything outside the allowlist;
 * error text echoes at most the hostname.
 */
export function parseBuildURL(input: string): ParsedBuildURL {
  let text = input.trim();
  if (BARE_BUILD_HOST_RE.test(text)) text = `https://${text}`;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new UserError(`Invalid build URL. ${ACCEPTED_BUILD_URLS_HINT}`);
  }

  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UserError(`Unsupported build URL scheme. ${ACCEPTED_BUILD_URLS_HINT}`);
  }
  const site = Object.prototype.hasOwnProperty.call(BUILD_URL_HOSTS, host) ? BUILD_URL_HOSTS[host] : undefined;
  if (!site) {
    throw new UserError(`Unsupported build URL host ${describeHost(host)}. ${ACCEPTED_BUILD_URLS_HINT}`);
  }
  if (url.username || url.password) {
    throw new UserError(`Build URLs must not contain a username or password. ${ACCEPTED_BUILD_URLS_HINT}`);
  }
  // http:// links to an allowed host are accepted: we never fetch the caller's
  // URL, the request below is always https. Only the https port is allowed.
  if (url.port !== '' && url.port !== '443') {
    throw new UserError(`Build URLs must not specify a port. ${ACCEPTED_BUILD_URLS_HINT}`);
  }

  // The WHATWG parser resolves "..", "." and backslashes in paths; require that the
  // path as typed is already canonical, so "https://pastebin.com/../x" is refused
  // rather than silently turned into "/x".
  const rawPath = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i.exec(text)?.[1] ?? '';
  const match = BUILD_URL_PATHS[site].exec(url.pathname);
  if (!match || rawPath !== url.pathname || match[1].toLowerCase() === RESERVED_BUILD_IDS[site]) {
    throw new UserError(
      `Could not find a build id in the ${describeHost(host)} link. ${ACCEPTED_BUILD_URLS_HINT}`,
    );
  }
  const id = match[1];
  return { site, id, fetchURL: `${BUILD_FETCH_BASE[site]}${id}` };
}

export function validateBuildSource(source: unknown): string {
  if (typeof source !== 'string') {
    throw new UserError('Build source must be a string');
  }
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    throw new UserError('Build source is empty');
  }
  const kind = detectBuildSourceKind(trimmed);
  if (kind === 'xml') {
    if (!trimmed.includes('<PathOfBuilding')) {
      throw new UserError('Invalid XML — missing <PathOfBuilding> root element');
    }
  } else if (kind === 'url') {
    parseBuildURL(trimmed);
  } else {
    // base64 build code — PoB uses URL-safe base64 (-,_) plus =, A-Z, a-z, 0-9
    if (!/^[A-Za-z0-9+/=_-]+$/.test(trimmed)) {
      throw new UserError(
        'Invalid build code — contains characters outside the URL-safe base64 alphabet',
      );
    }
    if (trimmed.length < 32) {
      throw new UserError(
        'Build code is too short to be a real PoB build (got ' + trimmed.length + ' chars)',
      );
    }
  }
  return trimmed;
}

export function validateSlot(slot: unknown, validSlots?: string[]): string {
  if (typeof slot !== 'string' || slot.trim().length === 0) {
    throw new UserError('Slot name must be a non-empty string');
  }
  if (validSlots && !validSlots.includes(slot)) {
    throw new UserError(
      `Invalid slot "${slot}". Valid slots: ${validSlots.join(', ')}`,
    );
  }
  return slot;
}

export function validateItemText(text: unknown): string {
  if (typeof text !== 'string') {
    throw new UserError('Item text must be a string');
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new UserError('Item text is empty');
  }
  if (!/^Rarity\s*:/im.test(trimmed)) {
    throw new UserError(
      'Item text must start with a "Rarity: ..." line (PoB item paste format)',
    );
  }
  return trimmed;
}
