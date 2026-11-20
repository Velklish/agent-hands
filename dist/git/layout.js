import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
export const REPOS_ZONE = 'repos';
export const EXTERNAL_ZONE = 'external';
export const SANDBOX_ZONE = 'sandbox';
export const ZONES = [REPOS_ZONE, EXTERNAL_ZONE];
export const WORKSPACE_DIRS = [...ZONES, SANDBOX_ZONE];
export const SKIP_DIRS = new Set(['node_modules', 'bin', 'obj', 'packages', 'dist', 'build', 'target', 'vendor']);
export const isDirectory = (dir) => { try {
    return statSync(dir).isDirectory();
}
catch {
    return false;
} };
export function discoverRoot({ root, cwd = process.cwd() } = {}) {
    if (root !== undefined) {
        if (!isDirectory(root))
            throw new Error(`Workspace root is not a directory: ${root}`);
        return realpathSync(root);
    }
    for (let dir = path.resolve(cwd);;) {
        if (isDirectory(path.join(dir, '.agent-hands')))
            return realpathSync(dir);
        const parent = path.dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
const missingPath = (err) => ['ENOENT', 'ENOTDIR'].includes(err.code ?? '');
function canonical(abs) {
    const p = path.resolve(abs);
    try {
        return realpathSync(p);
    }
    catch (error) {
        if (!missingPath(error))
            throw error;
        try {
            lstatSync(p);
        }
        catch (missing) {
            if (!missingPath(missing))
                throw missing;
            return path.join(canonical(path.dirname(p)), path.basename(p));
        }
        throw new Error(`Cannot resolve symlink: ${p}`);
    }
}
export function relativeInside(root, abs) {
    const rel = path.relative(root, abs);
    return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : null;
}
export function zoneRoots(root) { return ZONES.map((z) => path.join(root, z)); }
export function collidesWithZoneName(segments) { return segments[0] === EXTERNAL_ZONE; }
export function isCloneDir(abs) { return existsSync(path.join(abs, '.git')); }
export function zoneOfNs(nsPath) { return String(nsPath).split('/')[0] === EXTERNAL_ZONE ? EXTERNAL_ZONE : REPOS_ZONE; }
export function nsSegments(nsPath) {
    const parts = String(nsPath).split('/').filter(Boolean);
    return zoneOfNs(nsPath) === EXTERNAL_ZONE ? parts.slice(1) : parts;
}
function zoneBase(root, zone) { return path.join(canonical(root), zone); }
function relUnder(root, zone, abs) {
    try {
        return relativeInside(zoneBase(root, zone), canonical(abs))?.split(path.sep) ?? null;
    }
    catch {
        return null;
    }
}
export function zoneRootAt(root, abs) {
    try {
        return ZONES.find((z) => zoneBase(root, z) === canonical(abs)) ?? null;
    }
    catch {
        return null;
    }
}
export function underTakenZoneName(root, abs) {
    return collidesWithZoneName(relUnder(root, REPOS_ZONE, abs) ?? []);
}
function nsOf(zone, parts) { return (zone === REPOS_ZONE ? parts : [zone, ...parts]).join('/'); }
export function nsUnderZone(root, abs) {
    for (const zone of ZONES) {
        const parts = relUnder(root, zone, abs);
        if (parts)
            return nsOf(zone, parts);
    }
    return null;
}
export function normalizeNs(root, nsPath) {
    const zone = zoneOfNs(nsPath);
    const parts = nsSegments(nsPath);
    if (!parts.length)
        return null;
    try {
        const base = zoneBase(root, zone);
        const dest = path.join(base, ...parts);
        const real = canonical(dest);
        const rel = relativeInside(base, dest);
        return rel && real.normalize('NFC') === dest.normalize('NFC') && !(zone === REPOS_ZONE && collidesWithZoneName(rel.split(path.sep)))
            ? nsOf(zone, rel.split(path.sep)) : null;
    }
    catch {
        return null;
    }
}
export function repoAbsPath(root, nsPath) {
    const dest = path.join(root, zoneOfNs(nsPath), ...nsSegments(nsPath));
    if (!normalizeNs(root, nsPath))
        throw new Error(`Repository path leaves its zone or uses a symlink: ${dest}`);
    return dest;
}
export function cloneOf(root, abs) {
    for (const zone of ZONES) {
        const parts = relUnder(root, zone, abs);
        if (!parts || (zone === REPOS_ZONE && collidesWithZoneName(parts)))
            continue;
        for (let i = 1; i <= parts.length; i += 1) {
            const dir = path.join(zoneBase(root, zone), ...parts.slice(0, i));
            if (isCloneDir(dir))
                return i >= (zone === REPOS_ZONE ? 2 : 1) ? { abs: dir, nsPath: nsOf(zone, parts.slice(0, i)) } : null;
        }
    }
    return null;
}
export function listClonedRepos(root, onCollision = (_abs) => { }) {
    const found = [];
    function walk(dir, parts, zone) {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name))
                continue;
            const abs = path.join(dir, entry.name);
            const rel = [...parts, entry.name];
            if (zone === REPOS_ZONE && collidesWithZoneName(rel))
                onCollision(abs);
            else if (isCloneDir(abs))
                found.push({ nsPath: nsOf(zone, rel), abs });
            else
                walk(abs, rel, zone);
        }
    }
    for (const zone of ZONES) {
        const dir = path.join(root, zone);
        if (zoneRootAt(root, dir) === zone)
            walk(dir, [], zone);
    }
    return found;
}
