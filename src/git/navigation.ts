import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isDiskPath, isUrl, routeUrl, sameRepositoryUrl, type RouteHost } from './address.js';
import { findRepo, type Candidate } from './fuzzy.js';
import { discoverRoot, EXTERNAL_ZONE, isCloneDir, isDirectory, normalizeNs, nsUnderZone, repoAbsPath,
  relativeInside, underTakenZoneName, WORKSPACE_DIRS, zoneOfNs } from './layout.js';
import { freshenRepo } from './fresh.js';
import { gitClone, gitRun, gitToplevel } from './process.js';
import { scanZone } from './state.js';

export { discoverRoot, WORKSPACE_DIRS };
export type { RouteHost };

export function ensureWorkspaceDirs(root: string) {
  for (const name of WORKSPACE_DIRS) mkdirSync(path.join(root, name), { recursive: true });
}

export class NavigationError extends Error {
  constructor(message: string, readonly candidates: Candidate[] = []) { super(message); }
}

export function probeDisk(root: string, target: string, cwd = process.cwd()) {
  const abs = path.resolve(cwd, target);
  return { abs, nsPath: nsUnderZone(root, abs), exists: isDirectory(abs), reserved: underTakenZoneName(root, abs) };
}

function realPath(abs: string) {
  try { return realpathSync(abs); } catch { return null; }
}

function workZone(root: string | null, abs: string | null, includeZoneRoot = false) {
  if (!root || !abs) return undefined;
  return WORKSPACE_DIRS.find((zone) => {
    const dir = path.join(root, zone);
    return (includeZoneRoot && dir === abs) || relativeInside(dir, abs) !== null;
  });
}

export function enclosingZone(root: string, abs: string, top: string | null) {
  if (!top) return null;
  const realRoot = realPath(root);
  const zone = workZone(path.resolve(root), path.resolve(abs), true) ?? workZone(realRoot, realPath(abs), true);
  return zone && !workZone(realRoot, realPath(top)) ? zone : null;
}

export function isEnclosingRepo(root: string, abs: string, top: string | null) {
  return enclosingZone(root, abs, top) !== null;
}

export class OriginError extends NavigationError {
  constructor(readonly reason: 'unreadable' | 'ambiguous' | 'mismatch', abs: string) {
    super(reason === 'unreadable' ? `Cannot read the origin of the existing clone: ${abs}`
      : reason === 'ambiguous' ? `The existing clone has more than one origin URL: ${abs}`
        : `Repository destination is already occupied by a different or unknown origin: ${abs}`);
  }
}

export function checkOrigin(abs: string, url: string, routeHost: RouteHost, { allowMissing = false } = {}) {
  if (!isCloneDir(abs)) return;
  const metadata = path.join(abs, '.git');
  const directory = isDirectory(metadata);
  const metadataOnly = directory && !existsSync(path.join(metadata, 'HEAD'));
  const local = directory && !metadataOnly ? ['--git-dir', metadata] : [];
  const scope = metadataOnly ? ['--file', path.join(metadata, 'config')] : [];
  const result = gitRun(['-C', abs, ...local, 'config', ...scope, '--includes', '--null', '--get-all', 'remote.origin.url']);
  const missing = result.status === 1 && !result.error && !result.signal && !result.stderr && !result.stdout;
  if (missing && allowMissing) return;
  if (result.status !== 0 && !missing) throw new OriginError('unreadable', abs);
  const origins = result.status === 0 ? result.stdout.replace(/\0$/, '').split('\0') : [];
  if (origins.length > 1) throw new OriginError('ambiguous', abs);
  const origin = origins[0];
  if (!origin || !sameRepositoryUrl(origin, url, routeHost)) throw new OriginError('mismatch', abs);
}

interface RemoteCandidate extends Candidate { url: string }
export interface NavigationOptions {
  root?: string; cwd?: string; routeHost: RouteHost;
  search?: (name: string) => Promise<RemoteCandidate[] | null>;
  namespaceUrl?: (namespace: string) => string;
}

export function createNavigation({ root: explicitRoot, cwd = process.cwd(), routeHost, search, namespaceUrl }: NavigationOptions) {
  const discovered = discoverRoot({ root: explicitRoot, cwd });
  if (!discovered) throw new NavigationError('Workspace root not found. Specify a root or create a .agent-hands directory.');
  const root: string = discovered;
  const fromUrl = (url: string) => {
    const routed = routeUrl(root, url, routeHost);
    if (routed.group) throw new NavigationError('Specify a repository, not a group');
    return { ...routed, source: 'url' as const, abs: repoAbsPath(root, routed.nsPath) };
  };
  const fromNs = (nsPath: string, source: 'disk' | 'namespace') => ({
    nsPath, source, abs: repoAbsPath(root, nsPath), url: undefined,
  });
  async function resolve(target: string) {
    if (!target) throw new NavigationError('Specify a repository name, path or URL');
    if (isUrl(target)) return fromUrl(target);
    const disk = probeDisk(root, target, cwd);
    const diskResult = () => {
      if (!disk.nsPath || disk.reserved) throw new NavigationError(`Path is outside the repository zones or reserved: ${disk.abs}`);
      return fromNs(disk.nsPath, 'disk');
    };
    if (isDiskPath(target)) return diskResult();
    if (target.includes('/') || (path.sep === '\\' && target.includes('\\'))) {
      const nsPath = normalizeNs(root, target);
      const firstSegment = target.split(path.sep === '\\' ? /[\\/]/ : '/')[0];
      const crossesExternal = disk.exists && firstSegment === EXTERNAL_ZONE && disk.nsPath !== null && zoneOfNs(disk.nsPath) !== EXTERNAL_ZONE;
      if (disk.reserved) throw new NavigationError(`Unsafe or reserved repository namespace: ${target}`);
      if (nsPath && isCloneDir(repoAbsPath(root, nsPath))) return fromNs(nsPath, 'namespace');
      if (crossesExternal) throw new NavigationError(`Unsafe or reserved repository namespace: ${target}`);
      if (disk.exists && disk.nsPath) return diskResult();
      if (!nsPath) throw new NavigationError(`Unsafe or reserved repository namespace: ${target}`);
      const candidate = fromNs(nsPath, 'namespace');
      return disk.exists ? { ...candidate, note: `Ignored directory outside the repository zones: ${disk.abs}` } : candidate;
    }
    const local = findRepo(root, target);
    if (local.status === 'RESOLVED') return { ...fromNs(local.nsPath, 'disk'), kind: local.kind };
    if (local.status === 'AMBIGUOUS') throw new NavigationError(`Repository name is ambiguous on disk: ${target}`, local.candidates);
    if (!search) throw new NavigationError(`No local match for ${target}; remote search is not configured. Specify a repository URL.`);
    const hits = await search(target);
    if (!hits) throw new NavigationError(`Remote search is unavailable for ${target}; specify a repository URL.`);
    if (hits.length > 1) throw new NavigationError(`Repository name is ambiguous remotely: ${target}`, hits);
    if (hits.length === 1) {
      const candidate = hits[0];
      const resolved = fromUrl(candidate.url);
      if (resolved.nsPath !== candidate.nsPath) throw new NavigationError('Remote candidate does not match its repository URL');
      return { ...resolved, kind: candidate.kind };
    }
    throw new NavigationError(`No local or remote match for ${target}`);
  }
  async function cloneResolved(resolved: Awaited<ReturnType<typeof resolve>>, options: Parameters<typeof gitClone>[2] = {}) {
    if (!resolved.url && isCloneDir(resolved.abs)) return { abs: resolved.abs, cloned: false };
    const address = resolved.url ?? (zoneOfNs(resolved.nsPath) !== EXTERNAL_ZONE ? namespaceUrl?.(resolved.nsPath) : undefined);
    let url;
    if (address) {
      const routed = fromUrl(address);
      if (routed.abs !== resolved.abs) throw new NavigationError(`Repository URL routes to another destination: ${routed.abs}`);
      url = routed.url;
      checkOrigin(resolved.abs, url, routeHost);
    }
    if (isCloneDir(resolved.abs)) return { abs: resolved.abs, cloned: false };
    if (!url) throw new NavigationError('No clone URL is configured. Specify a repository URL.');
    const result = gitClone(url, resolved.abs, options);
    if (!result.ok) throw new NavigationError(result.err);
    return { abs: resolved.abs, cloned: true };
  }
  async function clone(target: string, options: Parameters<typeof gitClone>[2] = {}) {
    return cloneResolved(await resolve(target), options);
  }
  async function repoPath(target: string, { clone: cloneMissing = false, fresh = false } = {}) {
    const resolved = await resolve(target);
    const { abs, url } = resolved;
    if (!isCloneDir(abs)) {
      if (existsSync(abs)) throw new NavigationError(`Not a clone root: ${abs}`);
      if (!cloneMissing) {
        const note = 'note' in resolved ? `${resolved.note}\n` : '';
        throw new NavigationError(`${note}Repository is not cloned: ${abs}`);
      }
      await cloneResolved(resolved);
      return { abs, state: null };
    }
    if (url) checkOrigin(abs, url, routeHost);
    const top = gitToplevel(abs);
    if (!top || realpathSync(top) !== realpathSync(abs)) throw new NavigationError(`Not a clone root: ${abs}`);
    return { abs, state: fresh ? freshenRepo(abs) : null };
  }
  async function fresh(target?: string) {
    const abs = path.resolve(cwd, target ?? '.');
    const relativePath = target && !isUrl(target) && (target.includes('/') || (path.sep === '\\' && target.includes('\\')));
    if (target && !isDiskPath(target)) {
      // A qualified target is a namespace first. A directory outside the lookup zones
      // can still be a fresh target, but a short name must never fall back to cwd.
      if (relativePath && isDirectory(abs) && !nsUnderZone(root, abs)) {
        const ns = normalizeNs(root, target);
        if (ns && !isCloneDir(repoAbsPath(root, ns))) return freshFromDisk(abs);
      }
      const { abs: checkout } = await repoPath(target);
      return { abs: checkout, state: freshenRepo(checkout) };
    }
    return freshFromDisk(abs);
  }
  function freshFromDisk(abs: string) {
    const top = gitToplevel(abs);
    if (!top || isEnclosingRepo(root, abs, top)) throw new NavigationError(`Not inside a Git clone: ${abs}`);
    return { abs: top, state: freshenRepo(top) };
  }
  return { resolve, clone, repoPath, fresh, scan: () => scanZone(root) };
}

export const REPOSITORY_HELP = 'clone <name|namespace|URL> | path <name|path|URL> [--clone] [--fresh] | fresh [name|path] | zone';

export async function runRepositoryCommand(
  options: NavigationOptions,
  command: 'clone' | 'path' | 'fresh' | 'zone',
  { target, clone = false, fresh = false }: { target?: string; clone?: boolean; fresh?: boolean } = {},
  io = { out: (text: string) => console.log(text), err: (text: string) => console.error(text) },
) {
  try {
    if (command !== 'zone' && command !== 'fresh' && command !== 'clone' && command !== 'path') {
      throw new NavigationError(`Unknown repository command: ${command}. Usage: ${REPOSITORY_HELP}`);
    }
    const nav = createNavigation(options);
    if (command === 'zone') io.out(JSON.stringify(await nav.scan(), null, 2));
    else if (command === 'fresh') io.out(JSON.stringify(await nav.fresh(target), null, 2));
    else if (command === 'clone' || command === 'path') {
      if (!target) throw new NavigationError(`Expected a repository. Usage: ${REPOSITORY_HELP}`);
      if (command === 'clone') io.out((await nav.clone(target)).abs);
      else {
        const result = await nav.repoPath(target, { clone, fresh });
        if (result.state) io.err(JSON.stringify(result.state));
        io.out(result.abs);
      }
    }
    return 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    if (error instanceof NavigationError) for (const candidate of error.candidates) io.err(`  ${candidate.nsPath} (${candidate.kind})`);
    return 1;
  }
}
