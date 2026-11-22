// Numeric reading of stat values (shared by BuildSession and the tree searches).

/** A stat value as a number: missing, null or non-numeric values count as 0. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return 0;
}
