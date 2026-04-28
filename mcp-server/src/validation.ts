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
 * before the Lua bridge gets involved.
 */
export type BuildSourceKind = 'xml' | 'url' | 'code';

export function detectBuildSourceKind(source: string): BuildSourceKind {
  const trimmed = source.trim();
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<PathOfBuilding')) return 'xml';
  if (/^https?:\/\//i.test(trimmed)) return 'url';
  return 'code';
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
    if (!/pastebin\.com|pobb\.in/i.test(trimmed)) {
      throw new UserError(
        'Unsupported URL — only pastebin.com and pobb.in URLs are accepted',
      );
    }
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
