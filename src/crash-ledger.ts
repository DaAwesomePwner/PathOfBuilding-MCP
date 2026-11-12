import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fingerprintInstall, InstallFingerprint, installChanged } from './pob-install.js';

/**
 * Keeps the three-strike crash count per (pobPath, luajitPath) pair across
 * LuaBridge instances, so swapping bridges (reload_engine, a failed
 * configure_pob_path) can't reset the breaker. A pair starts a fresh count
 * only when its PoB install changed on disk since the engine that crashed was
 * started.
 */
export class CrashLedger {
  private readonly entries = new Map<string, { count: number; fingerprint: InstallFingerprint }>();

  /**
   * Canonical form of a path for keying: real path (resolves case on
   * case-insensitive filesystems, 8.3 short names, junctions, subst drives),
   * falling back to path.resolve when it can't be resolved; lower-cased on
   * Windows.
   */
  static canonical(p: string): string {
    let out: string;
    try {
      out = realpathSync.native(p);
    } catch {
      out = path.resolve(p);
    }
    return process.platform === 'win32' ? out.toLowerCase() : out;
  }

  private static key(pobPath: string, luajitPath: string): string {
    return `${CrashLedger.canonical(pobPath)}\u0000${CrashLedger.canonical(luajitPath)}`;
  }

  /**
   * Remember the crash count of a bridge that is being retired.
   * `startedWith` is the install fingerprint taken when that bridge was
   * (last) booted — NOT the current one, or a PoB update that happened after
   * the crashes would be attributed to them and never clear the breaker.
   */
  record(pobPath: string, luajitPath: string, count: number, startedWith: InstallFingerprint): void {
    const key = CrashLedger.key(pobPath, luajitPath);
    if (count <= 0) {
      this.entries.delete(key);
      return;
    }
    this.entries.set(key, { count, fingerprint: startedWith });
  }

  /**
   * Crash count a new bridge for this pair must start with, plus the install
   * fingerprint those crashes belong to (null when starting fresh).
   */
  initial(pobPath: string, luajitPath: string): { count: number; fingerprint: InstallFingerprint | null } {
    const key = CrashLedger.key(pobPath, luajitPath);
    const e = this.entries.get(key);
    if (!e) return { count: 0, fingerprint: null };
    if (installChanged(e.fingerprint, fingerprintInstall(pobPath))) {
      this.entries.delete(key); // PoB changed on disk since those crashes → fresh count
      return { count: 0, fingerprint: null };
    }
    return { count: e.count, fingerprint: e.fingerprint };
  }

  initialCount(pobPath: string, luajitPath: string): number {
    return this.initial(pobPath, luajitPath).count;
  }
}
