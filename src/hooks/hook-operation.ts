import { lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { writeAtomic } from '../layout/fs.js';
import { applyTargets, checkSnapshots, finishReconciliation, parseHookJournal, rollbackTargets, snapshot, type TargetChange } from './hook-journal.js';

export interface OperationScope {
  readonly directory: string;
  readonly pointers: readonly string[];
  readonly targets: readonly string[];
}

export function assertHookOperationIdle(scope: Pick<OperationScope,'directory'|'pointers'>) {
  if (snapshot(path.join(scope.directory,'pending.json')) !== null || scope.pointers.some(p => snapshot(p) !== null)) throw new Error('Unfinished hook operation');
}

function exclusive<T>(scope: OperationScope, run: (journal: string) => T): T {
  const { directory, targets, pointers } = scope;
  if (path.resolve(directory) !== directory || !pointers.length || pointers.length > 32 || targets.length > 32 || !targets.length) throw new Error('Invalid operation scope');
  const files = [...targets,...pointers];
  if (new Set(files).size !== files.length || files.some(p => path.resolve(p) !== p || p === directory || p.startsWith(directory + path.sep))) throw new Error('Overlapping operation scope');
  mkdirSync(directory,{ recursive:true, mode:0o700 });
  const stat = lstatSync(directory);
  if (realpathSync(directory) !== directory || !stat.isDirectory() || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.()))) throw new Error('Private operation directory required');
  const lock = path.join(directory,'writer.lock');
  const attr = lstatSync(lock,{ throwIfNoEntry:false });
  if (attr && (!attr.isFile() || attr.nlink !== 1)) throw new Error('Invalid operation lock');
  const db = new DatabaseSync(lock);
  try {
    db.exec('BEGIN EXCLUSIVE');
    const file = path.join(directory,'pending.json');
    const result = run(file);
    if (result instanceof Promise) return result.finally(() => db.close()) as T;
    db.close();
    return result;
  } catch (error) { db.close(); throw error; }
}

function reference(scope: OperationScope, file: string, id: string, participant?: string | null) {
  return JSON.stringify({ id,journal:file,pointers:scope.pointers,targets:scope.targets,participant });
}
export function withAccountLock<T>(home:string|undefined,scope:OperationScope,run:()=>T):T {
  if (!home) return run();
  const project = path.join(path.dirname(scope.pointers[0]),'transaction');
  return exclusive({...scope,directory:project},() => {
    if (snapshot(path.join(project,'pending.json')) !== null) throw new Error('Unfinished local hook operation');
    return run();
  });
}

function checkReference(scope: OperationScope, file: string, raw: unknown): string {
  if (typeof raw === 'string') {
    let ref: unknown;
    try { ref = JSON.parse(raw); } catch { throw new Error('Invalid operation pointer'); }
    if (ref && typeof ref === 'object' && 'id' in ref && typeof ref.id === 'string' && /^[0-9a-f-]{36}$/.test(ref.id)) {
      const participant = 'participant' in ref ? ref.participant : undefined;
      if ((participant === undefined || participant === null || (typeof participant === 'string' && participant.length)) &&
          reference(scope,file,ref.id,participant) === raw) return raw;
    }
  }
  throw new Error('Recovery scope mismatch');
}

export function findHookOperation(directory: string, pointers: readonly string[]): OperationScope | null {
  const file = path.join(directory,'pending.json');
  const raw = snapshot(file);
  const pointer = pointers.map(snapshot).find(value => value !== null);
  if (raw === null && pointer === undefined) return null;
  try {
    const envelope: unknown = raw === null ? null : JSON.parse(raw);
    const encoded = envelope && typeof envelope === 'object' && 'reference' in envelope ? envelope.reference : pointer;
    if (typeof encoded !== 'string') throw new Error();
    const ref: unknown = JSON.parse(encoded);
    if (!ref || typeof ref !== 'object' || !('pointers' in ref) || !('targets' in ref) || !Array.isArray(ref.pointers) || !Array.isArray(ref.targets) || ![...ref.targets,...ref.pointers].every(p => typeof p === 'string' && path.isAbsolute(p))) throw new Error();
    const scope = { directory,pointers:ref.pointers as string[],targets:ref.targets as string[] };
    checkReference(scope,file,encoded);
    if (pointer !== undefined && pointer !== encoded) throw new Error();
    return scope;
  } catch { throw new Error('Invalid pending hook operation reference'); }
}

function clear(file: string, reference: string, pointers: readonly string[]) {
  for (const p of pointers) {
    const value = snapshot(p);
    if (value === reference) unlinkSync(p);
    else if (value !== null) throw new Error('Unrecognized operation pointer');
  }
  unlinkSync(file);
}

function orphanPointer(scope:OperationScope, file:string) {
  if (snapshot(file) !== null) return null;
  const refs = scope.pointers.map(snapshot);
  const found = refs.find(ref => ref !== null);
  if (found === undefined) return null;
  const reference = checkReference(scope,file,found);
  if (refs.some(ref => ref !== null && ref !== reference)) throw new Error('Unrecognized operation pointer');
  const decoded = JSON.parse(reference) as {id:string;participant?:string|null};
  return {reference,refs,...decoded};
}
export function inspectOrphanedHookOperation(scope:OperationScope) {
  const orphan = orphanPointer(scope,path.join(scope.directory,'pending.json'));
  return orphan && {id:orphan.id,participant:orphan.participant};
}
interface ReconciliationProof {
  operationId: string;
  participantSha256?: string;
}
function* reconcile(file:string,scope:OperationScope,changes:readonly TargetChange[],proof?:ReconciliationProof,peer?:WorkspaceParticipant):Generator<Promise<void>,void> {
    const orphan = orphanPointer(scope,file);
    if (!orphan || changes.some(change => change.observed)) throw new Error('Reconciliation requires a missing journal and surviving operation pointer');
    const {reference,refs,id,participant} = orphan;
    if (proof && (proof.operationId !== id || participant === undefined)) throw new Error('Reconciliation operation proof does not match');
    if ((peer?.id ?? null) !== (participant ?? null)) throw new Error('Reconciliation requires the original transaction participant');
    const journal = parseHookJournal(JSON.stringify({ version:1,phase:'reconciling',targets:changes }),scope.targets);
    checkSnapshots(journal.targets,'before');
    if (peer) {
      if (!peer.verifyReconciliation || !proof?.participantSha256) throw new Error('Reconciliation requires verified participant evidence');
      yield peer.verifyReconciliation(id,proof.participantSha256);
      if (orphanPointer(scope,file)?.reference !== reference) throw new Error('Reconciliation operation pointer changed');
      checkSnapshots(journal.targets,'before');
    }
    const save = (phase:'reconciling'|'committed') => {
      const encoded = JSON.stringify({ reference,participant:peer?.id,journal:{ ...journal,phase } });
      if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw new Error('Operation exceeds snapshot limit');
      writeAtomic(file,encoded,{ mode:0o600 });
    };
    save('reconciling');
    scope.pointers.forEach((pointer,i) => { if (refs[i] === null) writeAtomic(pointer,reference,{ mode:0o600 }); });
    finishReconciliation(journal);
    save('committed');
    if (peer) yield peer.finish(id,'commit');
    clear(file,reference,scope.pointers);
}
export function reconcileOrphanedHookOperation(scope:OperationScope,changes:readonly TargetChange[],proof?:ReconciliationProof,peer?:WorkspaceParticipant) {
  return exclusive(scope,file => {
    const work = reconcile(file,scope,changes,proof,peer);
    if (peer) return drive(work);
    work.next();
  });
}

export interface ExternalHookChange {
  readonly files: readonly string[];
  readonly retain?: readonly string[];
  readonly run: () => number | null;
  readonly verify: (before: readonly (string | null)[], after: readonly (string | null)[], exit: number | null) => boolean;
  readonly verifyFailure?: (before: readonly (string | null)[], after: readonly (string | null)[]) => boolean;
}

export interface WorkspaceParticipant {
  readonly id: string;
  stage(operationId: string): Promise<void>;
  beforeCommit?(operationId: string): Promise<void>;
  verifyReconciliation?(operationId: string, proofSha256: string): Promise<void>;
  finish(operationId: string, decision: 'commit'|'rollback'): Promise<void>;
}
function* commit(file: string,scope: OperationScope, changes: readonly TargetChange[], external: readonly ExternalHookChange[], peer?: WorkspaceParticipant): Generator<Promise<void>,void> {
    const id = randomUUID();
    const ref = reference(scope,file,id,peer?.id ?? null);
    assertHookOperationIdle(scope);
    let journal = parseHookJournal(JSON.stringify({ version:1, phase:'pending', targets:changes }),scope.targets);
    if (changes.some(c => c.observed) || external.length > 4 || external.some(step => !step.files.length || new Set(step.files).size !== step.files.length || step.files.some(f => !scope.targets.includes(f)))) throw new Error('Invalid external step scope');
    checkSnapshots(journal.targets,'before');
    const save = (phase:'pending'|'committed'|'aborted') => {
      const saved = JSON.stringify({ reference:ref,participant:peer?.id,journal:{ ...journal,phase } });
      if (Buffer.byteLength(saved) > 4 * 1024 * 1024) throw new Error('Operation exceeds snapshot limit');
      writeAtomic(file,saved,{ mode:0o600 });
    };
    save('pending');
    for (const p of scope.pointers) writeAtomic(p,ref,{ mode:0o600 });
    const latest = () => journal.targets.map(row => ({ ...row,before:row.observed?.length ? row.observed.at(-1)! : row.before }));
    try {
      if (peer) yield peer.stage(id);
      for (const step of external) {
        const expected = latest();
        checkSnapshots(expected,'before');
        const before = step.files.map(f => expected.find(row => row.file === f)!.before);
        const exit = step.run();
        const after = step.files.map(snapshot);
        checkSnapshots(expected.filter(row => !step.files.includes(row.file)),'before');
        const confirmed = step.verify(before,after,exit);
        if (!confirmed && !(exit !== null && exit !== 0 && step.verifyFailure?.(before,after))) throw new Error('External hook step not confirmed');
        journal = { ...journal,targets:journal.targets.map(row => {
          const i = step.files.indexOf(row.file);
          if (i < 0 || before[i] === after[i]) return row;
          return { ...row,observed:[...(row.observed ?? []),after[i]],after:step.retain?.includes(row.file) ? after[i] : row.after };
        }) };
        save('pending');
        if (!confirmed) throw new Error('External hook step failed');
      }
      applyTargets({ ...journal,targets:latest() });
      if (peer?.beforeCommit) {
        yield peer.beforeCommit(id);
        checkSnapshots(journal.targets,'after');
      }
    } catch (error) {
      // Reload the published checkpoint: an unrecorded external value is never authority for rollback.
      const persisted = parseHookJournal(JSON.stringify(JSON.parse(snapshot(file)!).journal),scope.targets);
      rollbackTargets(persisted);
      journal = persisted;
      save('aborted');
      if (peer) yield peer.finish(id,'rollback');
      clear(file,ref,scope.pointers);
      throw error;
    }
    save('committed');
    if (peer) yield peer.finish(id,'commit');
    clear(file,ref,scope.pointers);
}
async function drive(steps: Generator<Promise<void>,void>) {
  let step = steps.next();
  while (!step.done) {
    try { await step.value; } catch (err) { step = steps.throw(err); continue; }
    step = steps.next();
  }
}
export function commitHookOperation(scope: OperationScope, changes: readonly TargetChange[], external: readonly ExternalHookChange[] = []) {
  exclusive(scope,file => commit(file,scope,changes,external).next());
}
export function commitWithParticipant(scope: OperationScope, changes: readonly TargetChange[], external: readonly ExternalHookChange[], participant: WorkspaceParticipant) {
  if (!participant.id || typeof participant.stage !== 'function' || typeof participant.finish !== 'function') throw new TypeError('Invalid workspace transaction participant');
  return exclusive(scope,file => drive(commit(file,scope,changes,external,participant)));
}
function* recover(file:string,scope: OperationScope, moved?: { from:string; to:string }, peer?: WorkspaceParticipant): Generator<Promise<void>,void> {
    const raw = snapshot(file);
    if (raw === null) throw new Error('Missing operation journal');
    let envelope: unknown;
    try { envelope = JSON.parse(raw); } catch { throw new Error('Invalid operation journal'); }
    if (!envelope || typeof envelope !== 'object' || !('reference' in envelope) || !('journal' in envelope)) throw new Error('Recovery scope mismatch');
    const reference = checkReference(scope,file,envelope.reference);
    if (('participant' in envelope ? envelope.participant : undefined) !== peer?.id) throw new Error('Recovery requires the original transaction participant');
    const original = parseHookJournal(JSON.stringify(envelope.journal),scope.targets);
    const move = (candidate: string) => moved && candidate.startsWith(moved.from + path.sep) ? path.join(moved.to,path.relative(moved.from,candidate)) : candidate;
    const additionalPointers = scope.pointers.map(move).filter(p => !scope.pointers.includes(p));
    const terminal = original.phase === 'committed' || original.phase === 'aborted';
    if (moved && (!additionalPointers.length || !additionalPointers.every(p => snapshot(p) === reference || (terminal && snapshot(p) === null)))) throw new Error('Moved operation pointer does not match');
    const journal = { ...original,targets:original.targets.map(row => ({ ...row,file:move(row.file) })) };
    if (new Set(journal.targets.map(row => row.file)).size !== journal.targets.length) throw new Error('Overlapping recovery targets');
    if (scope.pointers.some(p => { const v = snapshot(p); return v !== null && v !== reference; })) throw new Error('Unrecognized operation pointer');
    let decision: 'commit'|'rollback' = journal.phase === 'committed' ? 'commit' : 'rollback';
    if (!terminal) {
      if (journal.phase === 'pending') rollbackTargets(journal);
      else {
        finishReconciliation(journal);
        decision = 'commit';
      }
      writeAtomic(file,JSON.stringify({ reference,participant:peer?.id,journal:{ ...original,phase:decision === 'commit' ? 'committed' : 'aborted' } }),{ mode:0o600 });
    }
    if (peer) yield peer.finish(JSON.parse(reference).id,decision);
    clear(file,reference,[...scope.pointers,...additionalPointers]);
}
export function recoverHookOperation(scope: OperationScope, moved?: { from:string; to:string }) {
  exclusive(scope,file => recover(file,scope,moved).next());
}
export function recoverWithParticipant(scope: OperationScope, peer: WorkspaceParticipant) {
  return exclusive(scope,file => drive(recover(file,scope,undefined,peer)));
}
