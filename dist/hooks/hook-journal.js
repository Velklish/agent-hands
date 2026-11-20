import { lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../layout/fs.js';
const limit = 4 * 1024 * 1024;
const text = (v) => v === null || (typeof v === 'string' && Buffer.byteLength(v) <= limit && Buffer.from(v).toString() === v);
const invalid = () => { throw new Error('Invalid protected operation'); };
function safePath(file) {
    if (!path.isAbsolute(file) || path.normalize(file) !== file || path.basename(file) === '')
        invalid();
    let parent = path.dirname(file);
    while (!lstatSync(parent, { throwIfNoEntry: false }))
        parent = path.dirname(parent);
    if (realpathSync(parent) !== parent)
        invalid();
}
export function snapshot(file) {
    safePath(file);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat)
        return null;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
        return invalid();
    const bytes = readFileSync(file);
    const value = bytes.toString();
    if (!Buffer.from(value).equals(bytes))
        return invalid();
    return value;
}
export function parseHookJournal(raw, allowed) {
    if (Buffer.byteLength(raw) > 32 * limit || allowed.length === 0 || allowed.length > 32 || new Set(allowed).size !== allowed.length)
        return invalid();
    let doc;
    try {
        doc = JSON.parse(raw);
    }
    catch {
        return invalid();
    }
    if (!doc || typeof doc !== 'object' || !('version' in doc) || doc.version !== 1 || !('phase' in doc) || (doc.phase !== 'pending' && doc.phase !== 'committed' && doc.phase !== 'aborted' && doc.phase !== 'reconciling') || !('targets' in doc) || !Array.isArray(doc.targets) || doc.targets.length !== allowed.length)
        return invalid();
    const targets = doc.targets.map((row, i) => {
        if (!row || typeof row !== 'object' || !('file' in row) || row.file !== allowed[i] || !('before' in row) || !text(row.before) || !('after' in row) || !text(row.after))
            return invalid();
        safePath(allowed[i]);
        const observed = 'observed' in row ? row.observed : [];
        if (!Array.isArray(observed) || observed.length > 4 || !observed.every(text))
            return invalid();
        return { file: allowed[i], before: row.before, after: row.after, ...(observed.length ? { observed } : {}) };
    });
    return { version: 1, phase: doc.phase, targets };
}
export function finishReconciliation(journal) {
    if (journal.phase !== 'reconciling')
        throw new Error('Operation is not a reconciliation');
    const targets = journal.targets.map(row => {
        const current = snapshot(row.file);
        if (current !== row.before && current !== row.after)
            throw new Error('Protected target has an unrecognized value');
        return { ...row, before: current };
    });
    applyTargets({ ...journal, phase: 'pending', targets });
}
export function checkSnapshots(targets, direction) {
    for (const row of targets)
        if (snapshot(row.file) !== row[direction])
            throw new Error('Protected target changed');
}
function writeTarget(row, value) {
    if (value === null)
        unlinkSync(row.file);
    else
        writeAtomic(row.file, value, { mode: (lstatSync(row.file, { throwIfNoEntry: false })?.mode ?? 0o600) & 0o777 });
}
export function applyTargets(journal) {
    if (journal.phase !== 'pending')
        throw new Error('Operation is terminal');
    checkSnapshots(journal.targets, 'before');
    for (const row of journal.targets) {
        checkSnapshots([row], 'before');
        if (row.before !== row.after)
            writeTarget(row, row.after);
    }
    checkSnapshots(journal.targets, 'after');
}
export function rollbackTargets(journal) {
    if (journal.phase !== 'pending')
        throw new Error('Operation is terminal');
    const current = (row) => {
        const value = snapshot(row.file);
        if (value !== row.before && value !== row.after && !row.observed?.includes(value))
            throw new Error('Protected target has an unrecognized value');
        return value;
    };
    journal.targets.forEach(current);
    for (const row of [...journal.targets].reverse())
        if (current(row) !== row.before)
            writeTarget(row, row.before);
    checkSnapshots(journal.targets, 'before');
}
