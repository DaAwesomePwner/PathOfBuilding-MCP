import { fingerprintInstall, InstallFingerprint, installChanged } from './pob-install.js';

/**
 * Keeps the three-strike crash count per (pobPath, luajitPath) pair across
 * LuaBridge instances, so swapping bridges (reload_engine, a failed
 * configure_pob_path) can't reset the breaker. A pair starts a fresh count
 * only when its PoB install changed on disk since the crashes were recorded.
 */
export class CrashLedger {
  private readonly entries = new Map<string, { count: number; fingerprint: InstallFingerprint }>();

  private static key(pobPath: string, luajitPath: string): string {
    return `${pobPath}\u0000${luajitPath}`;
  }

  /** Remember the crash count of a bridge that is being retired. */
  record(pobPath: string, luajitPath: string, count: number): void {
    const key = CrashLedger.key(pobPath, luajitPath);
    if (count <= 0) {
      this.entries.delete(key);
      return;
    }
    const prev = this.entries.get(key);
    this.entries.set(key, { count, fingerprint: prev?.fingerprint ?? fingerprintInstall(pobPath) });
  }

  /** Crash count a new bridge for this pair must start with. */
  initialCount(pobPath: string, luajitPath: string): number {
    const key = CrashLedger.key(pobPath, luajitPath);
    const e = this.entries.get(key);
    if (!e) return 0;
    if (installChanged(e.fingerprint, fingerprintInstall(pobPath))) {
      this.entries.delete(key); // PoB changed on disk → fresh count
      return 0;
    }
    return e.count;
  }
}
