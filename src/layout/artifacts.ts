import {
  existsSync, lstatSync, readFileSync, readdirSync, realpathSync, mkdirSync, mkdtempSync,
  writeFileSync, chmodSync, renameSync, rmdirSync,
} from 'node:fs';
import path from 'node:path';
import { sha256, toPosix, isInside, isInnerRelPath, switchDirectoryBinding, sealSnapshot, removeTemporarySnapshot } from './fs.js';
import type { Artifacts, OutputMutations, Ownership } from './writer.js';

interface LayoutEntry { rel: string; newHash: string; mode?: number | null; buf: Buffer | string }
type Reason = 'broken-link' | 'outside-store' | 'not-directory' | 'foreign-files' | 'modified-artifact' | 'foreign-artifact-files';
interface Store {
  root: string; artifacts: string; renderer: unknown; nestedLinks?: ReadonlySet<string>;
  reject: (reason: Reason, location: string, files?: string[]) => never;
}

function filesIn(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return filesIn(path.join(dir, entry.name), rel);
    return [rel];
  });
}

function validateOld(root: string, group: string, old: Ownership, store: Store) {
  const dir = path.join(root, group);
  let stat;
  try { stat = lstatSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (stat.isSymbolicLink()) {
    if (!existsSync(dir)) store.reject('broken-link', group);
    if (!isInside(store.root, dir)) store.reject('outside-store', group);
  } else if (!stat.isDirectory()) store.reject('not-directory', group);
  const files = filesIn(dir).flatMap((rel) => {
    const file = path.join(dir, rel);
    if (!store.nestedLinks?.has(`${group}/${rel}`) || !lstatSync(file).isSymbolicLink()) return [rel];
    if (!existsSync(file) || !isInside(store.root, file)) store.reject('outside-store', `${group}/${rel}`);
    return filesIn(file, rel);
  });
  const changed = files.filter((rel) => {
    const file = path.join(dir, rel);
    return !lstatSync(file).isFile() || old.files[`${group}/${rel}`] !== sha256(readFileSync(file));
  });
  if (changed.length) store.reject('foreign-files', group, changed);
  return true;
}

function publish(entries: LayoutEntry[], group: string, store: Store): string {
  if (entries.some(entry => !isInnerRelPath(entry.rel) || sha256(entry.buf) !== entry.newHash))
    throw new Error(`Invalid staged artifact: ${group}`);
  const rows: [string, string, number][] = entries.map((entry) => [entry.rel.slice(group.length + 1), entry.newHash, entry.mode ?? 0]);
  const digest = sha256(JSON.stringify([store.renderer, rows]));
  const root = store.artifacts;
  const dir = path.join(root, digest);
  if (existsSync(dir)) {
    for (const [rel, hash, mode] of rows) {
      const file = path.join(dir, rel);
      if (!existsSync(file) || !lstatSync(file).isFile() || sha256(readFileSync(file)) !== hash
        || (process.platform !== 'win32' && (lstatSync(file).mode & 0o111) !== (mode ? 0o111 : 0))) {
        store.reject('modified-artifact', dir);
      }
    }
    if (filesIn(dir).length !== rows.length) store.reject('foreign-artifact-files', dir);
    sealSnapshot(dir);
    return dir;
  }
  mkdirSync(root, { recursive: true });
  const temporary = mkdtempSync(path.join(root, '.artifact-'));
  try {
    for (const entry of entries) {
      const file = path.join(temporary, entry.rel.slice(group.length + 1));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, entry.buf);
      if (entry.mode && process.platform !== 'win32') chmodSync(file, lstatSync(file).mode | entry.mode);
    }
    sealSnapshot(temporary);
    try { renameSync(temporary, dir); }
    catch (error) { if (!existsSync(dir)) throw error; return publish(entries, group, store); }
    return dir;
  } finally { removeTemporarySnapshot(temporary); }
}

export function artifactLayout(groups: readonly string[], store: Omit<Store, 'reject'> & { reject?: Store['reject'] }): Artifacts & {
  prepare(group: string, entries: readonly LayoutEntry[]): string | null;
} {
  if (groups.some(group => !isInnerRelPath(group))) throw new TypeError('Expected relative artifact groups');
  const group = (rel: string) => artifactGroup(groups, rel);
  const reject = store.reject ?? ((reason, location, files) => {
    throw new Error(`${location}: ${reason}${files?.length ? ` (${files.join(', ')})` : ''}`);
  });
  const options = { ...store, reject };
  return {
    group,
    prepare(name, entries) {
      if (!groups.includes(name)) throw new Error(`Unknown artifact group: ${name}`);
      const selected = entries.filter(entry => group(entry.rel) === name).sort((a,b) => a.rel.localeCompare(b.rel));
      return selected.length ? publish(selected,name,options) : null;
    },
    commit: (root, staged, old, mutations) => commitLayout(root, staged, old, groups, group, options, mutations),
  };
}

export const artifactGroup = (groups: readonly string[], rel: string) => groups.find((prefix) => rel.startsWith(`${prefix}/`)) ?? null;

function commitLayout(root: string, staged: LayoutEntry[], old: Ownership, candidates: readonly string[], sharedGroup: Artifacts['group'], store: Store, mutations?: OutputMutations) {
  const groups = candidates.filter((group) => staged.some((entry) => sharedGroup(entry.rel) === group)
    || Object.keys(old.files).some((rel) => sharedGroup(rel) === group));
  const plan: { group: string; old: boolean; entries: LayoutEntry[]; target?: string | null }[] = groups.map((group) => ({
    group, old: validateOld(root, group, old, store),
    entries: staged.filter((entry) => sharedGroup(entry.rel) === group).sort((a, b) => a.rel.localeCompare(b.rel)),
  }));
  for (const item of plan) item.target = item.entries.length ? publish(item.entries, item.group, store) : null;
  const switched: { destination: string; binding: ReturnType<typeof switchDirectoryBinding> }[] = [];
  try {
    for (const item of plan) {
      const destination = path.join(root, item.group);
      if (item.target && item.old && lstatSync(destination).isSymbolicLink()
        && realpathSync(destination) === realpathSync(item.target)) continue;
      if (mutations) mutations.bind(destination, item.target ?? null);
      else switched.push({ destination, binding: switchDirectoryBinding(destination, item.target ?? null, { hadOld: item.old }) });
    }
  } catch (error) {
    for (const { binding } of switched.reverse()) binding.rollback();
    throw error;
  }
  return {
    links: plan.map((item) => ({ rel: toPosix(item.group), target: item.target })),
    finalize() {
      for (const { binding } of switched) binding.finalize();
      for (const item of switched) {
        let dir = path.dirname(item.destination);
        while (dir !== root && path.relative(root, dir) && existsSync(dir) && !readdirSync(dir).length) {
          rmdirSync(dir);
          dir = path.dirname(dir);
        }
      }
    },
    rollback() {
      for (const { binding } of [...switched].reverse()) binding.rollback();
    },
  };
}
