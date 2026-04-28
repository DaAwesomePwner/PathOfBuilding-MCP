/**
 * Lightweight timing instrumentation. Set POB_TIMING=1 to enable per-call
 * stderr logging; the aggregate report is always available via Timer.report().
 */

const ENABLED = process.env.POB_TIMING === '1';

interface TimingStats {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
}

const TIMINGS = new Map<string, TimingStats>();

export function startTimer(label: string): () => number {
  const start = performance.now();
  return () => {
    const elapsed = performance.now() - start;
    let entry = TIMINGS.get(label);
    if (!entry) {
      entry = { count: 0, totalMs: 0, minMs: Infinity, maxMs: 0 };
      TIMINGS.set(label, entry);
    }
    entry.count++;
    entry.totalMs += elapsed;
    if (elapsed < entry.minMs) entry.minMs = elapsed;
    if (elapsed > entry.maxMs) entry.maxMs = elapsed;
    if (ENABLED) {
      // eslint-disable-next-line no-console
      console.error(`[TIMING] ${label}: ${elapsed.toFixed(1)}ms`);
    }
    return elapsed;
  };
}

export function timingReport(): Record<string, TimingStats & { avgMs: number }> {
  const out: Record<string, TimingStats & { avgMs: number }> = {};
  for (const [label, s] of TIMINGS) {
    out[label] = { ...s, avgMs: s.totalMs / Math.max(1, s.count) };
  }
  return out;
}

export function resetTimings(): void {
  TIMINGS.clear();
}
