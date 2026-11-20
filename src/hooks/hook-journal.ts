import { lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../layout/fs.js';

export interface TargetChange { readonly file: string; readonly before: string | null; readonly after: string | null; readonly observed?: readonly (string | null)[] }
export interface Journal { readonly version: 1; readonly phase: 'pending' | 'committed' | 'aborted' | 'reconciling'; readonly targets: readonly TargetChange[] }
const limit = 4 * 1024 * 1024;
const text = (v: unknown): v is string | null => v === null || (typeof v === 'string' && Buffer.byteLength(v) <= limit && Buffer.from(v).toString() === v);
const invalid = (): never => { throw new Error('Invalid protected operation'); };

function safePath(file: string) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || path.basename(file) === '') invalid();
  let parent = path.dirname(file);
  while (!lstatSync(parent,{ throwIfNoEntry: false })) parent = path.dirname(parent);
  if (realpathSync(parent) !== parent) invalid();
}

export function snapshot(file: string): string | null {
  safePath(file);
  const stat = lstatSync(file,{ throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) return invalid();
  const bytes = readFileSync(file);
  const value = bytes.toString();
  if (!Buffer.from(value).equals(bytes)) return invalid();
  return value;
}

export function parseHookJournal(raw: string, allowed: readonly string[]): Journal {
  if (Buffer.byteLength(raw) > 32 * limit || allowed.length === 0 || allowed.length > 32 || new Set(allowed).size !== allowed.length) return invalid();
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return invalid(); }
  if (!doc || typeof doc !== 'object' || !('version' in doc) || doc.version !== 1 || !('phase' in doc) || (doc.phase !== 'pending' && doc.phase !== 'committed' && doc.phase !== 'aborted' && doc.phase !== 'reconciling') || !('targets' in doc) || !Array.isArray(doc.targets) || doc.targets.length !== allowed.length) return invalid();
  const targets = doc.targets.map((row: unknown,i): TargetChange => {
    if (!row || typeof row !== 'object' || !('file' in row) || row.file !== allowed[i] || !('before' in row) || !text(row.before) || !('after' in row) || !text(row.after)) return invalid();
    safePath(allowed[i]);
    const observed = 'observed' in row ? row.observed : [];
    if (!Array.isArray(observed) || observed.length > 4 || !observed.every(text)) return invalid();
    return { file:allowed[i], before:row.before, after:row.after, ...(observed.length ? { observed } : {}) };
  });
  return { version:1, phase:doc.phase, targets };
}

export function finishReconciliation(journal: Journal) {
  if (journal.phase !== 'reconciling') throw new Error('Operation is not a reconciliation');
  const targets = journal.targets.map(row => {
    const current = snapshot(row.file);
    if (current !== row.before && current !== row.after) throw new Error('Protected target has an unrecognized value');
    return { ...row,before:current };
  });
  applyTargets({ ...journal,phase:'pending',targets });
}

export function checkSnapshots(targets: readonly TargetChange[], direction: 'before' | 'after') {
  for (const row of targets) if (snapshot(row.file) !== row[direction]) throw new Error('Protected target changed');
}

function writeTarget(row: TargetChange, value: string | null) {
  if (value === null) unlinkSync(row.file);
  else writeAtomic(row.file,value,{ mode:(lstatSync(row.file,{ throwIfNoEntry:false })?.mode ?? 0o600) & 0o777 });
}

export function applyTargets(journal: Journal) {
  if (journal.phase !== 'pending') throw new Error('Operation is terminal');
  checkSnapshots(journal.targets,'before');
  for (const row of journal.targets) {
    checkSnapshots([row],'before');
    if (row.before !== row.after) writeTarget(row,row.after);
  }
  checkSnapshots(journal.targets,'after');
}

export function rollbackTargets(journal: Journal) {
  if (journal.phase !== 'pending') throw new Error('Operation is terminal');
  const current = (row: TargetChange) => {
    const value = snapshot(row.file);
    if (value !== row.before && value !== row.after && !row.observed?.includes(value)) throw new Error('Protected target has an unrecognized value');
    return value;
  };
  journal.targets.forEach(current);
  for (const row of [...journal.targets].reverse()) if (current(row) !== row.before) writeTarget(row,row.before);
  checkSnapshots(journal.targets,'before');
}
