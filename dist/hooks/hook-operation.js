import { lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { writeAtomic } from '../layout/fs.js';
import { applyTargets, checkSnapshots, finishReconciliation, parseHookJournal, rollbackTargets, snapshot } from './hook-journal.js';
export function assertHookOperationIdle(scope) {
    if (snapshot(path.join(scope.directory, 'pending.json')) !== null || scope.pointers.some(p => snapshot(p) !== null))
        throw new Error('Unfinished hook operation');
}
function exclusive(scope, run) {
    const { directory, targets, pointers } = scope;
    if (path.resolve(directory) !== directory || !pointers.length || pointers.length > 32 || targets.length > 32 || !targets.length)
        throw new Error('Invalid operation scope');
    const files = [...targets, ...pointers];
    if (new Set(files).size !== files.length || files.some(p => path.resolve(p) !== p || p === directory || p.startsWith(directory + path.sep)))
        throw new Error('Overlapping operation scope');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (realpathSync(directory) !== directory || !stat.isDirectory() || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.())))
        throw new Error('Private operation directory required');
    const lock = path.join(directory, 'writer.lock');
    const attr = lstatSync(lock, { throwIfNoEntry: false });
    if (attr && (!attr.isFile() || attr.nlink !== 1))
        throw new Error('Invalid operation lock');
    const db = new DatabaseSync(lock);
    try {
        db.exec('BEGIN EXCLUSIVE');
        const file = path.join(directory, 'pending.json');
        const result = run(file);
        if (result instanceof Promise)
            return result.finally(() => db.close());
        db.close();
        return result;
    }
    catch (error) {
        db.close();
        throw error;
    }
}
function reference(scope, file, id) {
    return JSON.stringify({ id, journal: file, pointers: scope.pointers, targets: scope.targets });
}
export function withAccountLock(home, scope, run) {
    return home ? exclusive({ ...scope, directory: path.join(realpathSync(home), '.agent-hands', 'account-hooks', 'lock') }, run) : run();
}
function checkReference(scope, file, raw) {
    if (typeof raw === 'string') {
        let ref;
        try {
            ref = JSON.parse(raw);
        }
        catch {
            throw new Error('Invalid operation pointer');
        }
        if (ref && typeof ref === 'object' && 'id' in ref && typeof ref.id === 'string' && /^[0-9a-f-]{36}$/.test(ref.id) && reference(scope, file, ref.id) === raw)
            return raw;
    }
    throw new Error('Recovery scope mismatch');
}
export function findHookOperation(directory, pointers) {
    const file = path.join(directory, 'pending.json');
    const raw = snapshot(file);
    const pointer = pointers.map(snapshot).find(value => value !== null);
    if (raw === null && pointer === undefined)
        return null;
    try {
        const envelope = raw === null ? null : JSON.parse(raw);
        const encoded = envelope && typeof envelope === 'object' && 'reference' in envelope ? envelope.reference : pointer;
        if (typeof encoded !== 'string')
            throw new Error();
        const ref = JSON.parse(encoded);
        if (!ref || typeof ref !== 'object' || !('pointers' in ref) || !('targets' in ref) || !Array.isArray(ref.pointers) || !Array.isArray(ref.targets) || ![...ref.targets, ...ref.pointers].every(p => typeof p === 'string' && path.isAbsolute(p)))
            throw new Error();
        const scope = { directory, pointers: ref.pointers, targets: ref.targets };
        checkReference(scope, file, encoded);
        if (pointer !== undefined && pointer !== encoded)
            throw new Error();
        return scope;
    }
    catch {
        throw new Error('Invalid pending hook operation reference');
    }
}
function clear(file, reference, pointers) {
    for (const p of pointers) {
        const value = snapshot(p);
        if (value === reference)
            unlinkSync(p);
        else if (value !== null)
            throw new Error('Unrecognized operation pointer');
    }
    unlinkSync(file);
}
export function reconcileOrphanedHookOperation(scope, changes) {
    exclusive(scope, file => {
        if (snapshot(file) !== null || changes.some(change => change.observed))
            throw new Error('Reconciliation requires a missing journal');
        const refs = scope.pointers.map(snapshot);
        const reference = checkReference(scope, file, refs.find(ref => ref !== null));
        if (refs.some(ref => ref !== null && ref !== reference))
            throw new Error('Unrecognized operation pointer');
        const journal = parseHookJournal(JSON.stringify({ version: 1, phase: 'reconciling', targets: changes }), scope.targets);
        checkSnapshots(journal.targets, 'before');
        const save = (phase) => {
            const encoded = JSON.stringify({ reference, journal: { ...journal, phase } });
            if (Buffer.byteLength(encoded) > 4 * 1024 * 1024)
                throw new Error('Operation exceeds snapshot limit');
            writeAtomic(file, encoded, { mode: 0o600 });
        };
        save('reconciling');
        scope.pointers.forEach((pointer, i) => { if (refs[i] === null)
            writeAtomic(pointer, reference, { mode: 0o600 }); });
        finishReconciliation(journal);
        save('aborted');
        clear(file, reference, scope.pointers);
    });
}
function* commit(file, scope, changes, external, peer) {
    const id = randomUUID();
    const ref = reference(scope, file, id);
    assertHookOperationIdle(scope);
    let journal = parseHookJournal(JSON.stringify({ version: 1, phase: 'pending', targets: changes }), scope.targets);
    if (changes.some(c => c.observed) || external.length > 4 || external.some(step => !step.files.length || new Set(step.files).size !== step.files.length || step.files.some(f => !scope.targets.includes(f))))
        throw new Error('Invalid external step scope');
    checkSnapshots(journal.targets, 'before');
    const save = (phase) => {
        const saved = JSON.stringify({ reference: ref, participant: peer?.id, journal: { ...journal, phase } });
        if (Buffer.byteLength(saved) > 4 * 1024 * 1024)
            throw new Error('Operation exceeds snapshot limit');
        writeAtomic(file, saved, { mode: 0o600 });
    };
    save('pending');
    for (const p of scope.pointers)
        writeAtomic(p, ref, { mode: 0o600 });
    const latest = () => journal.targets.map(row => ({ ...row, before: row.observed?.length ? row.observed.at(-1) : row.before }));
    try {
        if (peer)
            yield peer.stage(id);
        for (const step of external) {
            const expected = latest();
            checkSnapshots(expected, 'before');
            const before = step.files.map(f => expected.find(row => row.file === f).before);
            const exit = step.run();
            const after = step.files.map(snapshot);
            checkSnapshots(expected.filter(row => !step.files.includes(row.file)), 'before');
            const confirmed = step.verify(before, after, exit);
            if (!confirmed && !(exit !== null && exit !== 0 && step.verifyFailure?.(before, after)))
                throw new Error('External hook step not confirmed');
            journal = { ...journal, targets: journal.targets.map(row => {
                    const i = step.files.indexOf(row.file);
                    if (i < 0 || before[i] === after[i])
                        return row;
                    return { ...row, observed: [...(row.observed ?? []), after[i]], after: step.retain?.includes(row.file) ? after[i] : row.after };
                }) };
            save('pending');
            if (!confirmed)
                throw new Error('External hook step failed');
        }
        applyTargets({ ...journal, targets: latest() });
    }
    catch (error) {
        // Reload the published checkpoint: an unrecorded external value is never authority for rollback.
        const persisted = parseHookJournal(JSON.stringify(JSON.parse(snapshot(file)).journal), scope.targets);
        rollbackTargets(persisted);
        journal = persisted;
        save('aborted');
        if (peer)
            yield peer.finish(id, 'rollback');
        clear(file, ref, scope.pointers);
        throw error;
    }
    save('committed');
    if (peer)
        yield peer.finish(id, 'commit');
    clear(file, ref, scope.pointers);
}
async function drive(steps) {
    let step = steps.next();
    while (!step.done) {
        try {
            await step.value;
        }
        catch (err) {
            step = steps.throw(err);
            continue;
        }
        step = steps.next();
    }
}
export function commitHookOperation(scope, changes, external = []) {
    exclusive(scope, file => commit(file, scope, changes, external).next());
}
export function commitWithParticipant(scope, changes, external, participant) {
    if (!participant.id || typeof participant.stage !== 'function' || typeof participant.finish !== 'function')
        throw new TypeError('Invalid workspace transaction participant');
    return exclusive(scope, file => drive(commit(file, scope, changes, external, participant)));
}
function* recover(file, scope, moved, peer) {
    const raw = snapshot(file);
    if (raw === null)
        throw new Error('Missing operation journal');
    let envelope;
    try {
        envelope = JSON.parse(raw);
    }
    catch {
        throw new Error('Invalid operation journal');
    }
    if (!envelope || typeof envelope !== 'object' || !('reference' in envelope) || !('journal' in envelope))
        throw new Error('Recovery scope mismatch');
    const reference = checkReference(scope, file, envelope.reference);
    if (('participant' in envelope ? envelope.participant : undefined) !== peer?.id)
        throw new Error('Recovery requires the original transaction participant');
    const original = parseHookJournal(JSON.stringify(envelope.journal), scope.targets);
    const move = (candidate) => moved && candidate.startsWith(moved.from + path.sep) ? path.join(moved.to, path.relative(moved.from, candidate)) : candidate;
    const additionalPointers = scope.pointers.map(move).filter(p => !scope.pointers.includes(p));
    const terminal = original.phase === 'committed' || original.phase === 'aborted';
    if (moved && (!additionalPointers.length || !additionalPointers.every(p => snapshot(p) === reference || (terminal && snapshot(p) === null))))
        throw new Error('Moved operation pointer does not match');
    const journal = { ...original, targets: original.targets.map(row => ({ ...row, file: move(row.file) })) };
    if (new Set(journal.targets.map(row => row.file)).size !== journal.targets.length)
        throw new Error('Overlapping recovery targets');
    if (scope.pointers.some(p => { const v = snapshot(p); return v !== null && v !== reference; }))
        throw new Error('Unrecognized operation pointer');
    if (!terminal) {
        if (journal.phase === 'pending')
            rollbackTargets(journal);
        else
            finishReconciliation(journal);
        writeAtomic(file, JSON.stringify({ reference, participant: peer?.id, journal: { ...original, phase: 'aborted' } }), { mode: 0o600 });
    }
    if (peer)
        yield peer.finish(JSON.parse(reference).id, journal.phase === 'committed' ? 'commit' : 'rollback');
    clear(file, reference, [...scope.pointers, ...additionalPointers]);
}
export function recoverHookOperation(scope, moved) {
    exclusive(scope, file => recover(file, scope, moved).next());
}
export function recoverWithParticipant(scope, peer) {
    return exclusive(scope, file => drive(recover(file, scope, undefined, peer)));
}
