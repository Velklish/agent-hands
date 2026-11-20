import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const REPOS_ZONE = 'repos';
export const EXTERNAL_ZONE = 'external';
export const SANDBOX_ZONE = 'sandbox';
export const ZONES = [REPOS_ZONE, EXTERNAL_ZONE] as const;
export const WORKSPACE_DIRS = [...ZONES, SANDBOX_ZONE] as const;
type Zone = typeof ZONES[number];
export const SKIP_DIRS = new Set(['node_modules', 'bin', 'obj', 'packages', 'dist', 'build', 'target', 'vendor']);

export const isDirectory = (dir: string) => { try { return statSync(dir).isDirectory(); } catch { return false; } };

export function discoverRoot({ root, cwd = process.cwd() }: { root?: string; cwd?: string } = {}) {
  if (root !== undefined) {
    if (!isDirectory(root)) throw new Error(`Workspace root is not a directory: ${root}`);
    return realpathSync(root);
  }
  for (let dir = path.resolve(cwd);;) {
    if (isDirectory(path.join(dir, '.agent-hands'))) return realpathSync(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const missingPath = (err: unknown) => ['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '');

function canonical(abs: string): string {
  const p = path.resolve(abs);
  try { return realpathSync(p); } catch (error) {
    if (!missingPath(error)) throw error;
    try { lstatSync(p); } catch (missing) {
      if (!missingPath(missing)) throw missing;
      return path.join(canonical(path.dirname(p)), path.basename(p));
    }
    throw new Error(`Cannot resolve symlink: ${p}`);
  }
}

export function relativeInside(root: string, abs: string) {
  const rel = path.relative(root, abs);
  return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : null;
}

export function zoneRoots(root: string) { return ZONES.map((z) => path.join(root, z)); }
export function collidesWithZoneName(segments: string[]) { return segments[0] === EXTERNAL_ZONE; }
export function isCloneDir(abs: string) { return existsSync(path.join(abs, '.git')); }
export function zoneOfNs(nsPath: unknown) { return String(nsPath).split('/')[0] === EXTERNAL_ZONE ? EXTERNAL_ZONE : REPOS_ZONE; }
export function nsSegments(nsPath: unknown) {
  const parts = String(nsPath).split('/').filter(Boolean);
  return zoneOfNs(nsPath) === EXTERNAL_ZONE ? parts.slice(1) : parts;
}

function zoneBase(root: string, zone: Zone) { return path.join(canonical(root), zone); }
function relUnder(root: string, zone: Zone, abs: string) {
  try { return relativeInside(zoneBase(root, zone), canonical(abs))?.split(path.sep) ?? null; } catch { return null; }
}

export function zoneRootAt(root: string, abs: string) {
  try { return ZONES.find((z) => zoneBase(root, z) === canonical(abs)) ?? null; } catch { return null; }
}

export function underTakenZoneName(root: string, abs: string) {
  return collidesWithZoneName(relUnder(root, REPOS_ZONE, abs) ?? []);
}

function nsOf(zone: Zone, parts: string[]) { return (zone === REPOS_ZONE ? parts : [zone, ...parts]).join('/'); }

export function nsUnderZone(root: string, abs: string) {
  for (const zone of ZONES) {
    const parts = relUnder(root, zone, abs);
    if (parts) return nsOf(zone, parts);
  }
  return null;
}

export function normalizeNs(root: string, nsPath: unknown) {
  const zone = zoneOfNs(nsPath);
  const parts = nsSegments(nsPath);
  if (!parts.length) return null;
  try {
    const base = zoneBase(root, zone);
    const dest = path.join(base, ...parts);
    const real = canonical(dest);
    const rel = relativeInside(base, dest);
    return rel && real.normalize('NFC') === dest.normalize('NFC') && !(zone === REPOS_ZONE && collidesWithZoneName(rel.split(path.sep)))
      ? nsOf(zone, rel.split(path.sep)) : null;
  } catch { return null; }
}

export function repoAbsPath(root: string, nsPath: unknown) {
  const dest = path.join(root, zoneOfNs(nsPath), ...nsSegments(nsPath));
  if (!normalizeNs(root, nsPath)) throw new Error(`Repository path leaves its zone or uses a symlink: ${dest}`);
  return dest;
}

export function cloneOf(root: string, abs: string) {
  for (const zone of ZONES) {
    const parts = relUnder(root, zone, abs);
    if (!parts || (zone === REPOS_ZONE && collidesWithZoneName(parts))) continue;
    for (let i = 1; i <= parts.length; i += 1) {
      const dir = path.join(zoneBase(root, zone), ...parts.slice(0, i));
      if (isCloneDir(dir)) return i >= (zone === REPOS_ZONE ? 2 : 1) ? { abs: dir, nsPath: nsOf(zone, parts.slice(0, i)) } : null;
    }
  }
  return null;
}

export function listClonedRepos(root: string, onCollision = (_abs: string) => {}) {
  const found: { nsPath: string; abs: string }[] = [];
  function walk(dir: string, parts: string[], zone: Zone) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = [...parts, entry.name];
      if (zone === REPOS_ZONE && collidesWithZoneName(rel)) onCollision(abs);
      else if (isCloneDir(abs)) found.push({ nsPath: nsOf(zone, rel), abs });
      else walk(abs, rel, zone);
    }
  }
  for (const zone of ZONES) {
    const dir = path.join(root, zone);
    if (zoneRootAt(root, dir) === zone) walk(dir, [], zone);
  }
  return found;
}
