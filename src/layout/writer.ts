import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, rmdirSync, readdirSync, statSync, lstatSync, chmodSync,
} from 'node:fs';
import path from 'node:path';
import { sha256, toPosix, writeAtomic, isInnerRelPath } from './fs.js';

export interface Ownership { files: Record<string, unknown> }
export interface Staged { rel: string; abs: string; buf: Buffer; newHash: string; oldHash: unknown; diskHash: string | null; mode: number | null }
interface AtomicOutputs { paths: ReadonlySet<string>; stagingDir?: string; restoreOriginalMode?: boolean }
type CopyOptions = { origin?: string | null; regularOnly?: boolean; skipped?: (file: CopyEntry & { symbolic: boolean }) => void };
export interface CopyEntry { src: string; rel: string; origin: string | null }
type Outside = { rel: string; origin: string | null };
type Collision = { rel: string; a: string | null; b: string | null };
export interface WriterMessages {
  edited(rel: string, operation: 'write' | 'prune'): string;
  outside(paths: Outside[]): string;
  collision(paths: Collision[]): string;
  conflict(paths: string[]): string;
  nested(file: string, source: string | null, child: string, other?: string | null): string;
}
export interface Change { rollback(): void; finalize(): void }
export interface ArtifactChange extends Change { links: { rel: string; target: string | null | undefined }[] }
export interface Artifacts {
  group(rel: string): string | null;
  commit(root: string, staged: Staged[], old: Ownership): ArtifactChange;
}
export interface TransactionOptions { atomic?: AtomicOutputs; commitBindings?: () => Change }

const messages: WriterMessages = {
  edited: (rel) => `${rel}: edited output is no longer safe to replace or remove`,
  outside: (paths) => `Output escapes the root: ${paths.map(({ rel }) => rel).join(', ')}`,
  collision: (paths) => `Output collision: ${paths.map(({ rel, a, b }) => `${rel} (${a ?? '?'} / ${b ?? '?'})`).join(', ')}`,
  conflict: (paths) => `Output conflict: ${paths.join(', ')}`,
  nested: (file, source, child, other) => `Output collision: ${file} (${source ?? '?'}) is a file and a parent of ${child} (${other ?? '?'})`,
};

const EXEC_BITS = 0o111;

export function* copyEntries(srcAbs: string, destRel: string, options: CopyOptions = {}): Generator<CopyEntry> {
  const { origin = null, regularOnly, skipped } = options;
  for (const e of readdirSync(srcAbs, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === '.DS_Store' || (e.name === '__pycache__' && e.isDirectory())) continue;
    const src = path.join(srcAbs, e.name);
    const rel = toPosix(path.join(destRel, e.name));
    if (e.isDirectory()) yield* copyEntries(src, rel, options);
    else if (e.isFile()) yield { src, rel, origin };
    else {
      if (regularOnly) throw new Error(`${src}: expected a regular supporting file`);
      skipped?.({ src, rel, origin, symbolic: e.isSymbolicLink() });
    }
  }
}

export class Writer {
  readonly replacedFiles = new Set<string>();
  readonly replacedDirs = new Set<string>();
  readonly released = new Set<string>();
  private createdDirs = new Set<string>();
  private stagedParents = new Map<string, string>();
  declare root: string;
  declare adopt: boolean;
  declare old: Ownership;
  declare staged: Staged[];
  declare conflicts: string[];
  declare collisions: Collision[];
  declare outside: Outside[];
  declare stagedRel: Map<string, { hash: string; origin: string | null }>;
  declare files: Record<string, string>;
  declare written: string[];
  declare updated: string[];
  declare overwrittenEdits: string[];
  declare adopted: string[];
  declare execFiles: Set<string>;
  declare commitBindings?: () => Change;
  declare deferred?: boolean;
  declare sources?: Change;
  declare layout?: ArtifactChange;
  declare links?: ArtifactChange['links'];
  constructor(root: string, ownership: Ownership, { adopt = false, protectEdits = true, artifacts, text = messages,
    reject = (message: string): never => { throw new Error(message); }, atomicWrite = writeAtomic,
  }: { adopt?: boolean; protectEdits?: boolean; artifacts?: Artifacts; text?: WriterMessages;
    reject?: (message: string) => never; atomicWrite?: typeof writeAtomic } = {}) {
    this.root = root;
    this.adopt = adopt;
    this.old = ownership;
    this.#configuration = { protectEdits, artifacts, text, reject, atomicWrite };
    this.staged = [];
    this.conflicts = [];
    this.collisions = [];
    this.outside = [];
    this.stagedRel = new Map();
    this.files = Object.create(null);
    this.written = [];
    this.updated = [];
    this.overwrittenEdits = [];
    this.adopted = [];
    this.execFiles = new Set();
  }
  #configuration: { protectEdits: boolean; artifacts?: Artifacts; text: WriterMessages;
    reject: (message: string) => never; atomicWrite: typeof writeAtomic };

  #group(rel: string) { return this.#configuration.artifacts?.group(rel); }

  stage(relPath: string, content: string | Uint8Array, { origin = null, adopt = false, mode = null, conflictHint = null }: { origin?: string | null; adopt?: boolean; mode?: number | null; conflictHint?: string | null } = {}) {
    const rel = toPosix(relPath);
    if (!isInnerRelPath(rel)) {
      this.outside.push({ rel, origin });
      return;
    }
    const abs = path.join(this.root, relPath);
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const newHash = sha256(buf);

    const prev = this.stagedRel.get(rel);
    if (prev) {
      if (prev.hash !== newHash) this.collisions.push({ rel, a: prev.origin, b: origin });
      return;
    }
    const nested = this.stagedParents.get(rel);
    if (nested) this.#rejectNested(rel, origin, nested, this.stagedRel.get(nested)?.origin);
    for (let dir = path.posix.dirname(rel); dir !== '.'; dir = path.posix.dirname(dir)) {
      const file = this.stagedRel.get(dir);
      if (file) this.#rejectNested(dir, file.origin, rel, origin);
      if (this.stagedParents.has(dir)) break;
      this.stagedParents.set(dir, rel);
    }
    this.stagedRel.set(rel, { hash: newHash, origin });

    const oldHash = Object.hasOwn(this.old.files, rel) ? this.old.files[rel] : undefined;
    const diskHash = existsSync(abs) && !this.replacedDirs.has(rel)
      && !(this.#group(rel) && lstatSync(abs).isDirectory()) ? sha256(readFileSync(abs)) : null;

    if (this.#configuration.protectEdits && !adopt && oldHash && diskHash !== null && diskHash !== oldHash && diskHash !== newHash) {
      this.conflicts.push(this.#configuration.text.edited(rel, 'write'));
      return;
    }

    if (diskHash !== null && !oldHash && diskHash !== newHash) {
      if (!this.adopt && !adopt) {
        this.conflicts.push(conflictHint ? `${rel} — ${conflictHint}` : rel);
        return;
      }
      this.adopted.push(rel);
    }
    this.staged.push({ rel, abs, buf, newHash, oldHash, diskHash, mode });
  }

  #rejectNested(file: string, source: string | null, child: string, other?: string | null): never {
    return this.#configuration.reject(this.#configuration.text.nested(file, source, child, other));
  }

  copyDir(srcAbs: string, destRel: string, options: CopyOptions = {}) {
    for (const file of copyEntries(srcAbs, destRel, options)) this.copyFile(file);
  }

  copyFile({ src, rel, origin }: CopyEntry) {
    const execAtSource = (statSync(src).mode & EXEC_BITS) !== 0;
    this.stage(rel, readFileSync(src), { origin, mode: execAtSource ? EXEC_BITS : 0 });
  }

  async transaction<T>(extraPaths: string[], apply: () => Promise<T>, { commitBindings, atomic }: TransactionOptions = {}) {
    const dirs = [...this.replacedDirs].map(rel => {
      const abs = path.join(this.root, rel);
      return { abs, mode: process.platform === 'win32' ? null : lstatSync(abs).mode & 0o7777 };
    });
    const paths = new Set([...this.staged.map((s) => s.rel), ...Object.keys(this.old.files as object).filter(rel => !this.released.has(rel)), ...extraPaths]);
    const saved = [...paths].filter((rel) => !this.#group(rel) && isInnerRelPath(rel)).map((rel) => {
      const abs = path.join(this.root, rel);
      const stat = existsSync(abs) ? lstatSync(abs) : undefined;
      const mode = process.platform !== 'win32' && stat?.isFile() ? stat.mode & 0o7777 : null;
      return { rel, abs, bytes: stat && !this.replacedDirs.has(rel) ? readFileSync(abs) : null, mode };
    });
    this.commitBindings = commitBindings;
    this.deferred = true;
    let result;
    try {
      result = await apply();
    } catch (error) {
      this.sources?.rollback();
      this.layout?.rollback();
      for (const { abs, bytes } of saved) {
        if (bytes === null && existsSync(abs) && !lstatSync(abs).isDirectory()) rmSync(abs);
      }
      for (const dir of [...this.createdDirs].sort((a, b) => b.length - a.length)) {
        try { rmdirSync(dir); } catch (e) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
        }
      }
      for (const { abs } of dirs) mkdirSync(abs, { recursive: true, mode: 0o700 });
      for (const { rel, abs, bytes, mode } of saved) {
        if (bytes === null) continue;
        const secure = atomic?.paths.has(rel) ? atomic : undefined;
        const restoredMode = secure && !secure.restoreOriginalMode ? 0o600 : mode;
        if (!existsSync(abs) || !readFileSync(abs).equals(bytes)) {
          mkdirSync(path.dirname(abs), { recursive: true });
          this.#configuration.atomicWrite(abs, bytes, { mode: restoredMode, stagingDir: secure?.stagingDir });
        } else if (mode !== null && restoredMode !== null) {
          const now = lstatSync(abs);
          if (now.isFile() && (now.mode & 0o7777) !== mode) chmodSync(abs, restoredMode);
        }
      }
      for (const { abs, mode } of dirs.reverse()) if (mode !== null) chmodSync(abs, mode);
      throw error;
    } finally { this.deferred = false; this.createdDirs.clear(); }
    this.sources?.finalize();
    this.layout?.finalize();
    return result;
  }

  commit(beforeWrites?: () => void, atomic?: AtomicOutputs) {
    if (this.#configuration.protectEdits) {
      for (const [rel, hash] of Object.entries(this.old.files as object)) {
        if (this.stagedRel.has(rel) || this.released.has(rel) || this.#group(rel) || !isInnerRelPath(rel)) continue;
        const file = path.join(this.root, rel);
        if (existsSync(file) && sha256(readFileSync(file)) !== hash) {
          this.conflicts.push(this.#configuration.text.edited(rel, 'prune'));
        }
      }
    }
    if (this.outside.length) {
      this.#configuration.reject(this.#configuration.text.outside(this.outside));
    }
    if (this.collisions.length) {
      this.#configuration.reject(this.#configuration.text.collision(this.collisions));
    }
    if (this.conflicts.length) {
      this.#configuration.reject(this.#configuration.text.conflict(this.conflicts));
    }
    beforeWrites?.();
    if (this.#configuration.artifacts) {
      this.layout = this.#configuration.artifacts.commit(this.root, this.staged, this.old);
      this.links = this.layout.links;
    }
    try {
    for (const rel of this.replacedFiles) rmSync(path.join(this.root, rel));
    for (const rel of [...this.replacedDirs].sort((a, b) => b.length - a.length)) rmdirSync(path.join(this.root, rel));
    for (const s of this.staged) {
      if (this.#group(s.rel)) {
        this.files[s.rel] = s.newHash;
        if (s.mode) this.execFiles.add(s.rel);
        if (s.diskHash !== s.newHash) (s.diskHash === null ? this.written : this.updated).push(s.rel);
        continue;
      }
      if (s.diskHash === s.newHash) {
        this.files[s.rel] = s.newHash;
        if (this.#applyMode(s)) this.updated.push(s.rel);
        continue;
      }
      if (s.oldHash && s.diskHash !== null && s.diskHash !== s.oldHash) this.overwrittenEdits.push(s.rel);
      const parent = path.dirname(s.abs);
      const firstCreated = mkdirSync(parent, { recursive: true });
      if (this.deferred && firstCreated) {
        const first = path.resolve(firstCreated);
        for (let dir = path.resolve(parent); dir === first || dir.startsWith(first + path.sep); dir = path.dirname(dir)) {
          this.createdDirs.add(dir);
          if (dir === first) break;
        }
      }
      if (atomic?.paths.has(s.rel)) this.#configuration.atomicWrite(s.abs, s.buf, { mode: 0o600, stagingDir: atomic.stagingDir });
      else writeFileSync(s.abs, s.buf);
      this.#applyMode(s);
      (s.diskHash === null ? this.written : this.updated).push(s.rel);
      this.files[s.rel] = s.newHash;
    }
    this.sources = this.commitBindings?.();
    } catch (error) {
      if (!this.deferred) this.layout?.rollback();
      throw error;
    }
    if (!this.deferred) this.layout?.finalize();
  }

  apply(beforeWrites?: () => void, atomic?: AtomicOutputs) {
    this.commit(beforeWrites, atomic);
    return this.prune();
  }

  #applyMode(s: Staged) {
    if (s.mode === null || process.platform === 'win32') return false;
    const current = statSync(s.abs).mode & 0o7777;
    const execute = s.mode & EXEC_BITS;
    const desired = (current & ~EXEC_BITS) | execute;
    if (desired !== current) chmodSync(s.abs, desired);
    if (execute) this.execFiles.add(s.rel);
    return desired !== current;
  }

  prune() {
    const removed = [];
    for (const rel of this.released) delete this.files[rel];
    // A case-only rename may identify the same file on a case-insensitive filesystem.
    const own = new Set(Object.keys(this.files).map((s) => s.toLowerCase()));
    for (const rel of Object.keys(this.old.files as object)) {
      if (this.replacedFiles.has(rel) || this.released.has(rel)) continue;
      if (this.#group(rel)) continue;
      if (this.files[rel]) continue;
      if (!isInnerRelPath(rel)) continue;
      const abs = path.join(this.root, rel);
      if (existsSync(abs)) {
        if (own.has(rel.toLowerCase())) {
          const old = lstatSync(abs, { bigint: true });
          const aliasesNew = Object.keys(this.files).some(next => {
            if (next.toLowerCase() !== rel.toLowerCase()) return false;
            const file = lstatSync(path.join(this.root, next), { bigint: true, throwIfNoEntry: false });
            return file && file.dev === old.dev && file.ino === old.ino;
          });
          if (aliasesNew) continue;
        }
        rmSync(abs);
        removed.push(rel);
        this.#rmEmptyParents(path.dirname(abs));
      }
    }
    return removed;
  }

  #rmEmptyParents(dir: string) {
    while (dir !== this.root && dir.startsWith(this.root)) {
      try {
        if (readdirSync(dir).length > 0) break;
        rmdirSync(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }
}
