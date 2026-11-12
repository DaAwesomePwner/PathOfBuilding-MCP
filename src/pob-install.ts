import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Inspection of a Path of Building Community directory on disk: layout,
 * version (from manifest.xml), PoE2-fork detection, and the on-disk state of
 * PoB's self-updater. Read-only — nothing here ever writes to a PoB folder.
 */

export type PoBLayout = 'installed' | 'source';

export interface PoBInstallInfo {
  dir: string;
  layout: PoBLayout;
  /** `<Version number="...">` from manifest.xml, or null when it can't be read. */
  version: string | null;
  manifestPath: string;
}

export type InspectResult =
  | { ok: true; info: PoBInstallInfo }
  | { ok: false; reason: 'missing' | 'not-pob' | 'poe2'; message: string };

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Read up to `maxBytes` from the start of a file (manifest.xml is ~MBs; the header is all we need). */
function readHead(file: string, maxBytes = 64 * 1024): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function readManifestVersion(manifestPath: string): string | null {
  const head = readHead(manifestPath);
  if (!head) return null;
  const m = head.match(/<Version\b[^>]*\bnumber\s*=\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

/**
 * Detect the Path of Exile 2 fork of PoB ("Path of Building Community (PoE2)").
 * Its files look exactly like PoE1 PoB, so we check content markers rather than
 * the folder name: the manifest's update URLs point at the PathOfBuilding-PoE2
 * repo, the launcher is "Path of Building-PoE2.exe", and GameVersions.lua
 * targets "0_x" tree versions (PoE1 targets "3_x").
 * Returns a description of the marker that matched, or null for PoE1.
 */
export function detectPoE2Marker(dir: string, layout: PoBLayout): string | null {
  const manifestHead = readHead(path.join(dir, 'manifest.xml'));
  if (manifestHead && /PathOfBuilding-PoE2/i.test(manifestHead)) {
    return 'manifest.xml update source is the PathOfBuilding-PoE2 repository';
  }
  if (isFile(path.join(dir, 'Path of Building-PoE2.exe'))) {
    return 'found "Path of Building-PoE2.exe"';
  }
  const gv = path.join(layout === 'source' ? path.join(dir, 'src') : dir, 'GameVersions.lua');
  const gvHead = readHead(gv, 8 * 1024);
  const live = gvHead?.match(/liveTargetVersion\s*=\s*["'](\d+)_/);
  if (live && live[1] === '0') {
    return `GameVersions.lua targets Path of Exile 2 tree versions (liveTargetVersion "0_x")`;
  }
  return null;
}

function detectLayout(dir: string): PoBLayout | null {
  const has = (base: string) =>
    isFile(path.join(base, 'Launch.lua')) && isFile(path.join(base, 'Modules', 'Build.lua'));
  if (has(dir)) return 'installed';
  if (has(path.join(dir, 'src'))) return 'source';
  return null;
}

/** Validate that `dir` is a usable PoE1 Path of Building Community install or source clone. */
export function inspectPoBInstall(dir: string): InspectResult {
  if (!isDir(dir)) {
    return { ok: false, reason: 'missing', message: `${dir} does not exist or is not a directory` };
  }
  const layout = detectLayout(dir);
  if (!layout) {
    return {
      ok: false,
      reason: 'not-pob',
      message:
        `${dir} is not a Path of Building install: expected Launch.lua and Modules/Build.lua ` +
        `(installed layout) or src/Launch.lua and src/Modules/Build.lua (source clone)`,
    };
  }
  const poe2 = detectPoE2Marker(dir, layout);
  if (poe2) {
    return {
      ok: false,
      reason: 'poe2',
      message:
        `${dir} is Path of Building for Path of Exile 2 (${poe2}). Only the Path of Exile 1 ` +
        `edition ("Path of Building Community") is supported — point at that install instead.`,
    };
  }
  const manifestPath = path.join(dir, 'manifest.xml');
  return { ok: true, info: { dir, layout, version: readManifestVersion(manifestPath), manifestPath } };
}

// ---------------------------------------------------------------------------
// Change / update detection
// ---------------------------------------------------------------------------

export interface InstallFingerprint {
  version: string | null;
  manifestMtimeMs: number | null;
}

export function fingerprintInstall(dir: string): InstallFingerprint {
  const manifestPath = path.join(dir, 'manifest.xml');
  let mtime: number | null = null;
  try {
    mtime = statSync(manifestPath).mtimeMs;
  } catch {
    mtime = null;
  }
  return { version: readManifestVersion(manifestPath), manifestMtimeMs: mtime };
}

/** True when manifest.xml's version or mtime differs from the recorded fingerprint. */
export function installChanged(start: InstallFingerprint, current: InstallFingerprint): boolean {
  return start.version !== current.version || start.manifestMtimeMs !== current.manifestMtimeMs;
}

/**
 * State of PoB's self-updater, derived from UpdateCheck.lua / UpdateApply.lua:
 *  - UpdateCheck downloads files into Update/, writes Update/manifest.xml, then
 *    Update/opFile.txt (+ opFileRuntime.txt for runtime parts) → 'staged'.
 *    The install itself is still the old, consistent version until PoB applies it.
 *  - UpdateApply deletes opFile.txt FIRST, then moves files into place, moving
 *    Update/manifest.xml last. So Update/manifest.xml (or opFileRuntime.txt)
 *    without opFile.txt means files are being replaced right now (or the apply
 *    was interrupted) → 'applying': the install is not safe to load.
 *
 * Known false positive: UpdateCheck.lua saves Update/manifest.xml (line ~300)
 * a moment before it writes Update/opFile.txt (line ~335); in between it only
 * creates directories, so that window is milliseconds long. Nothing on disk
 * distinguishes it from an apply in progress, so it is reported as 'applying'.
 * If a check is interrupted inside that window the state persists until PoB's
 * next update check rewrites Update/ — the 'applying' message tells the user to
 * open PoB once, which resolves both cases.
 */
export type UpdateState = 'none' | 'staged' | 'applying';

export function detectUpdateState(dir: string): UpdateState {
  const updateDir = path.join(dir, 'Update');
  if (existsSync(path.join(updateDir, 'opFile.txt'))) return 'staged';
  if (
    existsSync(path.join(updateDir, 'manifest.xml')) ||
    existsSync(path.join(updateDir, 'opFileRuntime.txt'))
  ) {
    return 'applying';
  }
  return 'none';
}
