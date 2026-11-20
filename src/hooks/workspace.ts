import path from 'node:path';
import { realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isTarget, type Target } from '../layout/adapter.js';
import { format } from './format.js';
import { confirmedHookIntents, inspectHookOwnership, prepareHookDocument } from './hook-delivery.js';
import { assertHookOperationIdle, commitHookOperation, commitWithParticipant, findHookOperation, inspectOrphanedHookOperation,
  reconcileOrphanedHookOperation, recoverWithParticipant, recoverHookOperation, withAccountLock, type ExternalHookChange, type WorkspaceParticipant } from './hook-operation.js';
import { snapshot, type TargetChange } from './hook-journal.js';
import { sha256 } from '../layout/fs.js';
import type { WorkspaceHookDiagnostic, WorkspacePreferences, WorkspaceRegistration, WorkspaceRegistrationPlan, WorkspaceRegistrationOutcome,
  WorkspaceRegistrationInspection, WorkspaceRegistrationStatus } from './options.js';

export interface WorkspaceHook { owner: string; event: string; command: string; matcher?: string; timeout?: number }
export interface WorkspaceHookScope { root: string; target: Target }
export interface WorkspaceHookInput extends WorkspaceHookScope {
  enabled: boolean;
  hooks: readonly WorkspaceHook[];
  mode?: 'ownership';
  release?: readonly string[];
  restore?: readonly string[];
  legacy?: { documentSha256: string; hooks: readonly WorkspaceHook[]; preferences?:WorkspacePreferences };
  preferences?: WorkspacePreferences;
  registration?: WorkspaceRegistration;
}
export interface WorkspaceHookResult { changed: boolean; shifted: boolean; diagnostics?: readonly WorkspaceHookDiagnostic[] }
export interface WorkspaceHookBatch { root: string; selections: readonly Omit<WorkspaceHookInput,'root'>[]; accountHome?:string }
type CommandTarget = Exclude<Target,'opencode'>;
const registrationParts = ['marketplaces','installations','localSettings','accountSettings','registration'] as const;
type EvidencePart = 'document'|'ownership'|'preferences'|typeof registrationParts[number];
export interface WorkspaceHookEvidence { target:CommandTarget; part:EvidencePart; sha256:string|null }
export type WorkspaceHookResolution = {target:CommandTarget;action:'accept'} |
  {target:CommandTarget;action:'release';owners:readonly string[]} |
  {target:CommandTarget;action:'restore';hooks:readonly WorkspaceHook[]};
export interface WorkspaceHookReconciliation {
  operationId:string;
  evidence:readonly WorkspaceHookEvidence[];
  documents:readonly WorkspaceHookResolution[];
  participantSha256?:string;
  registration?:{marketplace:string;plugin:string;version:string;fingerprint:string};
}
export interface WorkspaceHookBatchScope {
  root: string;
  targets: readonly Target[];
  accountHome?:string;
  reconcile?:WorkspaceHookReconciliation;
}

function locations({root,target}: WorkspaceHookScope) {
  if (!isTarget(target) || target === 'opencode') throw new TypeError('Unsupported workspace command hook target');
  if (!path.isAbsolute(root)) throw new TypeError('Absolute workspace path required');
  const base = realpathSync(root);
  const native = format(target);
  const local = path.join(base,'.agent-hands','hooks');
  const document = path.join(base,native.path);
  const state = path.join(local,target,'ownership.json');
  return {base,native,target,document,state,scope:{directory:path.join(local,'transaction'),pointers:[path.join(local,'pending')],targets:[document,state]}};
}
function prepareSelection(input: WorkspaceHookInput, reconciling = false) {
  if (Object.keys(input).some(k => !['root','target','enabled','hooks','mode','release','restore','legacy','preferences','registration'].includes(k))) throw new TypeError('Unknown workspace hook field');
  for (const list of [input.release,input.restore]) if (list !== undefined && (!Array.isArray(list) || list.some(v => typeof v !== 'string' || !v) || new Set(list).size !== list.length)) throw new TypeError('Invalid hook owner selection');
  const {base,native,target,document,state,scope} = locations(input);
  if (typeof input.enabled !== 'boolean' || !Array.isArray(input.hooks)) throw new TypeError('Expected enabled flag and hook list');
  const convert = (h: WorkspaceHook) => {
    if (!h || ![h.owner,h.event,h.command].every(v => typeof v === 'string' && v.length) || (h.matcher !== undefined && typeof h.matcher !== 'string') || (h.timeout !== undefined && (!Number.isSafeInteger(h.timeout) || h.timeout <= 0)) || Object.keys(h).some(k => !['owner','event','command','matcher','timeout'].includes(k))) throw new TypeError('Invalid workspace hook');
    const entry = native.entry(h.owner,h.event,h.command,h.matcher);
    if (h.timeout !== undefined) entry.callback.timeout = h.timeout;
    return entry;
  };
  const intents = input.hooks.map(convert);
  const ownershipOnly = input.mode === 'ownership';
  if (input.mode !== undefined && (!ownershipOnly || !input.enabled || input.legacy || input.preferences || input.registration ||
      !(input.release?.length || input.restore?.length) || intents.length !== (input.restore?.length ?? 0) ||
      intents.some(intent => !input.restore?.includes(intent.owner)) || new Set(intents.map(intent => intent.owner)).size !== intents.length))
    throw new TypeError('Ownership changes require only the selected release owners and restore definitions');
  if (!reconciling) assertHookOperationIdle(scope);
  let legacy;
  if (input.legacy && snapshot(state) === null) {
    const raw = snapshot(document);
    if (raw === null || sha256(raw) !== input.legacy.documentSha256) throw new Error('Legacy hook snapshot changed');
    legacy = {document:raw,entries:input.legacy.hooks.map(convert)};
  }
  let wanted = input.preferences;
  if (input.registration) {
    if (!native.plugin || !input.enabled) throw new Error('Unsupported plugin registration operation');
    const r = input.registration;
    wanted = {...wanted,localMarketplaces:{...wanted?.localMarketplaces,[r.marketplace]:r.directory},enabledPlugins:{...wanted?.enabledPlugins,[`${r.plugin}@${r.marketplace}`]:true}};
  }
  if (wanted && !native.preferences) throw new Error('Unsupported hook preferences for target');
  const projection = wanted && native.preferences?.(base,wanted,legacy && input.legacy?.preferences);
  const {changes,shifted} = prepareHookDocument({target,document,state,intents:input.enabled ? intents : [],ownershipOnly,legacy,release:input.release,restore:input.restore,projectDocument:projection?.projectDocument});
  if (projection) changes.push(projection.change());
  else if (native.preferencePath) { const file = native.preferencePath(base), before=snapshot(file); changes.push({file,before,after:before}); }
  let steps:ExternalHookChange[] = [];
  let checkSource: (() => void)|undefined;
  let registration: Readonly<WorkspaceRegistrationPlan & {target:'claude'}>|undefined;
  if (input.registration) {
    const plan = native.plugin!(base,changes[0],input.registration);
    changes.push(...plan.changes); steps = plan.steps; checkSource = plan.checkSource;
    registration = Object.freeze({target:'claude',...plan.registration});
  }
  return {scope,changes,steps,checkSource,registration,diagnostics:projection?.diagnostics ?? [],result:{changed:steps.length > 0 || changes.some(c => c.before !== c.after),shifted}};
}
function prepare(input: WorkspaceHookInput | WorkspaceHookBatch) {
  if (!input || typeof input !== 'object') throw new TypeError('Invalid workspace hook input');
  const batch = 'selections' in input ? input : undefined;
  if (batch && (!Array.isArray(batch.selections) || Object.keys(batch).some(k => !['selections','root','accountHome'].includes(k)))) throw new TypeError('Invalid workspace hook batch');
  const selections = batch ? batch.selections.map(s => ({...s,root:batch.root})) : [input as WorkspaceHookInput];
  if (!selections.length || new Set(selections.map(s => s.target)).size !== selections.length) throw new TypeError('Expected distinct hook targets');
  const explicitAccount = canonicalAccountHome(batch?.accountHome);
  const registrationAccount = canonicalAccountHome(selections.find(s => s.registration)?.registration?.accountHome);
  if (explicitAccount && registrationAccount && explicitAccount !== registrationAccount) throw new Error('Hook registration account does not match the batch account');
  const account = explicitAccount ?? registrationAccount;
  if (account) {
    const shared = accountScope(locations(selections[0]).scope,account);
    const pending = findAccountOperation(shared);
    if (pending && pending.pointers[0] !== shared.pointers[0]) throw new Error('Account hook operation pending in another project');
  }
  const plans = [...selections].sort((a,b) => a.target.localeCompare(b.target)).map(selection => prepareSelection(selection));
  const changes = plans.flatMap(p => p.changes);
  const scope = accountScope({...plans[0].scope,targets:changes.map(row => row.file)},account);
  assertHookOperationIdle(scope);
  const registrations = Object.freeze(plans.flatMap(p => p.registration ? [p.registration] : []));
  const diagnostics = plans.flatMap(p => p.diagnostics);
  return { changes,steps:plans.flatMap(p => p.steps),registrations,checkSources:() => plans.forEach(p => p.checkSource?.()),scope,account,
    result:{changed:plans.some(p => p.result.changed),shifted:plans.some(p => p.result.shifted),...(diagnostics.length ? {diagnostics} : {})} };
}
function canonicalAccountHome(home?:string) {
  if (home === undefined) return undefined;
  if (!path.isAbsolute(home)) throw new TypeError('Absolute hook account home required');
  return realpathSync(home);
}
function accountScope<T extends {pointers:string[];directory:string}>(scope:T,home?:string):T {
  if (!home) return scope;
  const privateRoot = path.join(home,'.agent-hands','account-hooks');
  return {...scope,directory:path.join(privateRoot,'transaction'),pointers:[...scope.pointers,path.join(privateRoot,'pending')]};
}
function findAccountOperation(scope: {pointers:readonly string[];directory:string}) {
  const accountPointer = scope.pointers[1];
  const pending = findHookOperation(scope.directory,[accountPointer]);
  if (pending && (pending.pointers.length !== 2 || pending.pointers[1] !== accountPointer)) throw new Error('Unexpected account hook operation scope');
  return pending;
}
declare const prepared: unique symbol;
export interface PreparedWorkspaceHooks extends WorkspaceHookResult {
  readonly [prepared]: true;
  readonly registrations: readonly Readonly<WorkspaceRegistrationPlan & {target:'claude'}>[];
}
export interface PreparedWorkspaceHookResult extends WorkspaceHookResult {
  readonly registrations: readonly Readonly<WorkspaceRegistrationOutcome & {target:'claude'}>[];
}
const plans = new WeakMap<PreparedWorkspaceHooks,ReturnType<typeof prepare>>();
export function prepareWorkspaceHooks(input: WorkspaceHookInput | WorkspaceHookBatch): PreparedWorkspaceHooks {
  const state = prepare(input);
  const token = Object.freeze({...state.result,registrations:state.registrations}) as PreparedWorkspaceHooks;
  plans.set(token,state);
  return token;
}
export function planWorkspaceHooks(input: WorkspaceHookInput | WorkspaceHookBatch): WorkspaceHookResult { return prepare(input).result; }
export async function applyPreparedWorkspaceHooks(token: PreparedWorkspaceHooks, participant: WorkspaceParticipant): Promise<PreparedWorkspaceHookResult> {
  const plan = plans.get(token);
  if (!plan) throw new Error('Expected an unused prepared workspace hook plan');
  plans.delete(token);
  const peer:WorkspaceParticipant = {id:participant.id,stage:async id => {await participant.stage(id);plan.checkSources();},beforeCommit:async id => {await participant.beforeCommit?.(id);plan.checkSources();},finish:(id,decision) => participant.finish(id,decision)};
  await withAccountLock(plan.account,plan.scope,() => commitWithParticipant(plan.scope,plan.changes,plan.steps,peer));
  const statuses = {install:'installed',update:'updated',current:'current'} as const;
  return {...plan.result,registrations:plan.registrations.map(({action,...row}) => ({...row,status:statuses[action]}))};
}
export function applyWorkspaceHooks(input: WorkspaceHookInput | WorkspaceHookBatch): WorkspaceHookResult {
  const {scope,changes,result,steps,account,checkSources} = prepare(input);
  checkSources();
  if (result.changed) withAccountLock(account,scope,() => commitHookOperation(scope,changes,steps));
  return result;
}
type RecoveryScope = WorkspaceHookScope | WorkspaceHookBatchScope;
export function inspectWorkspaceHookOwnership(input:WorkspaceHookScope) {
  const {scope,target,document,state} = locations(input);
  assertHookOperationIdle(scope);
  return inspectHookOwnership({target,document,state});
}
export function inspectWorkspaceRegistration(input:WorkspaceRegistrationInspection):WorkspaceRegistrationStatus {
  if (!path.isAbsolute(input.root)) throw new TypeError('Absolute workspace path required');
  const root = realpathSync(input.root);
  const accountHome = canonicalAccountHome(input.accountHome);
  if (!accountHome) throw new TypeError('Absolute hook account home required');
  const operation = inspectWorkspaceHookOperation({root,accountHome});
  if (operation.pending || operation.blockedBy) return {status:'stale'};
  return format('claude').inspectProjectRegistration!({...input,root,accountHome});
}
export interface WorkspaceHookReconciliationEvidence {
  operationId:string;
  evidence:readonly WorkspaceHookEvidence[];
  participantRequired:boolean;
  supported:boolean;
}
export type PendingWorkspaceHooks = {pending:false;registration:false;blockedBy?:'another-project'} |
  {pending:true;registration:boolean;targets:Target[];accountScoped?:true;reconciliation?:WorkspaceHookReconciliationEvidence};
export function inspectWorkspaceHookOperation({root,accountHome,evidence}:{root:string;accountHome?:string;evidence?:boolean}):PendingWorkspaceHooks {
  if (!path.isAbsolute(root)) throw new TypeError('Absolute workspace path required');
  const account = canonicalAccountHome(accountHome);
  const base = realpathSync(root);
  const local = path.join(base,'.agent-hands','hooks'), pointer = path.join(local,'pending');
  const localDirectory = path.join(local,'transaction');
  const raw = snapshot(pointer);
  // A workspace pointer describes the selection; it never supplies a filesystem destination.
  let recorded: {pointers:readonly string[];targets:readonly string[]}|null = null;
  if (raw !== null) {
    let ref;
    try { ref = JSON.parse(raw); } catch { throw new Error('Invalid workspace operation pointer'); }
    if (!ref || !Array.isArray(ref.pointers) || !Array.isArray(ref.targets)) throw new Error('Invalid workspace operation pointer');
    recorded = ref;
  } else {
    recorded = findHookOperation(localDirectory,[pointer]);
    if (!recorded && account) {
      const shared = accountScope({directory:localDirectory,pointers:[pointer]},account);
      const pending = findAccountOperation(shared);
      if (pending && pending.pointers[0] !== pointer) return {pending:false,registration:false,blockedBy:'another-project'};
      recorded = pending;
    }
  }
  if (!recorded) return {pending:false,registration:false};
  if (recorded.pointers[0] !== pointer || recorded.pointers.length > 2) throw new Error('Unexpected workspace operation scope');
  if (account && recorded.pointers.length === 2 &&
      recorded.pointers[1] !== accountScope({directory:localDirectory,pointers:[pointer]},account).pointers[1])
    throw new Error('Hook operation account does not match');
  const targets = (['claude','codex','cursor'] as const).filter(target => recorded.targets.includes(path.join(local,target,'ownership.json')));
  if (!targets.length) throw new Error('Unrecognized workspace operation targets');
  const registrationPath = targets.includes('claude') ? format('claude').registrationPath?.(base) : undefined;
  const registration = registrationPath !== undefined && recorded.targets.includes(registrationPath);
  const accountScoped = recorded.pointers.length === 2;
  let reconciliation;
  if (evidence) {
    if (accountScoped && !account) throw new Error('Expected the original hook account');
    const context = recoveryContext(base,targets,accountScoped ? account : undefined,registration);
    const orphan = inspectOrphanedHookOperation(context.scope);
    if (orphan) reconciliation = {operationId:orphan.id,evidence:readEvidence(context.parts).map(row=>row.evidence),
      participantRequired:typeof orphan.participant === 'string',supported:orphan.participant !== undefined};
  }
  return {pending:true,registration,targets,...(!registration && accountScoped && {accountScoped:true}),...(reconciliation && {reconciliation})};
}
function recoveryContext(root:string,targets:readonly Target[],account:string|undefined,registration:boolean) {
  if (!targets.length || new Set(targets).size !== targets.length) throw new TypeError('Expected distinct hook targets');
  const selections = [...targets].sort().map(target => locations({root,target}));
  const parts = selections.flatMap(({base,native,target,document,state}) => {
    const selected: {target:CommandTarget;part:EvidencePart;file:string}[] = [
      {target,part:'document',file:document}, {target,part:'ownership',file:state},
    ];
    if (native.preferencePath) selected.push({target,part:'preferences',file:native.preferencePath(base)});
    if (registration && account && native.registrationFiles) {
      const files = native.registrationFiles(base,account);
      for (let index = 0; index < registrationParts.length; index++)
        selected.push({target,part:registrationParts[index],file:files[index]});
    }
    return selected;
  });
  return {scope:accountScope({...selections[0].scope,targets:parts.map(part=>part.file)},account),parts,selections};
}
function readEvidence(parts:ReturnType<typeof recoveryContext>['parts']) {
  return parts.map(({file,target,part}) => {
    const before = snapshot(file);
    return {file,before,evidence:{target,part,sha256:before === null ? null : sha256(before)}};
  });
}
function reconcileWorkspaceHooks(input:WorkspaceHookBatchScope,account:string|undefined,peer?:WorkspaceParticipant) {
  const proof = input.reconcile;
  if (!proof || !Array.isArray(proof.evidence) || !Array.isArray(proof.documents) ||
      Object.keys(proof).some(key => !['operationId','evidence','documents','participantSha256','registration'].includes(key)))
    throw new TypeError('Expected complete hook reconciliation evidence');
  const pending = inspectWorkspaceHookOperation({root:input.root,accountHome:account});
  if (!pending.pending || Boolean(pending.registration || pending.accountScoped) !== Boolean(account))
    throw new Error('Expected a matching pending hook operation');
  const {scope,parts,selections} = recoveryContext(input.root,input.targets,account,pending.registration);
  const orphan = inspectOrphanedHookOperation(scope);
  if (!orphan || orphan.participant === undefined || orphan.id !== proof.operationId)
    throw new Error('Reconciliation operation proof does not match');
  if (orphan.participant !== (peer?.id ?? null) ||
      (peer && (!peer.verifyReconciliation || typeof proof.participantSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.participantSha256))) ||
      (!peer && proof.participantSha256 !== undefined)) throw new Error('Reconciliation requires verified evidence from the original participant');
  const images = readEvidence(parts);
  if (!isDeepStrictEqual(images.map(row=>row.evidence),proof.evidence)) throw new Error('Hook reconciliation evidence does not match protected targets');
  if (proof.documents.length !== selections.length) throw new Error('Reconciliation requires every selected hook document');
  if (pending.registration || proof.registration !== undefined) {
    if (!pending.registration || !proof.registration || !account ||
        Object.keys(proof.registration).some(key => !['marketplace','plugin','version','fingerprint'].includes(key)))
      throw new Error('Reconciliation requires verified native registration');
    const {marketplace,plugin,version,fingerprint} = proof.registration;
    const actual = format('claude').inspectProjectRegistration!({root:selections[0].base,accountHome:account,
      marketplace,plugin,expectedVersion:version,expectedFingerprint:fingerprint});
    if (actual.status !== 'current' || actual.version !== version || actual.fingerprint !== fingerprint)
      throw new Error('Reconciliation requires verified native registration');
  }
  const updates = new Map<string,TargetChange>();
  for (const {base:root,target,document,state} of selections) {
    const decisions = proof.documents.filter(row => row?.target === target);
    if (decisions.length !== 1) throw new Error('Reconciliation requires one decision per hook target');
    const decision: WorkspaceHookResolution = decisions[0];
    const location = {target,document,state};
    if (decision.action === 'accept') {
      if (Object.keys(decision).length !== 2) throw new Error('Unexpected hook reconciliation fields');
      const intents = confirmedHookIntents(location);
      const result = prepareHookDocument({...location,intents});
      if (result.changes.some(change=> change.before !== change.after))
        throw new Error('Current hook ownership is inconsistent');
      for (const change of result.changes) updates.set(change.file,change);
      continue;
    }
    if (peer || pending.registration) throw new Error('An external operation requires acceptance of the verified current hook state');
    if (Object.keys(decision).length !== 3) throw new Error('Unexpected hook reconciliation fields');
    const common = {root,target,enabled:true,mode:'ownership'} as const;
    const input = decision.action === 'release' && Array.isArray(decision.owners) ?
      {...common,hooks:[],release:decision.owners} : decision.action === 'restore' && Array.isArray(decision.hooks) ?
        {...common,hooks:decision.hooks,restore:decision.hooks.map(hook=>hook?.owner)} : undefined;
    if (!input) throw new Error('Invalid hook reconciliation decision');
    for (const change of prepareSelection(input,true).changes) updates.set(change.file,change);
  }
  const changes = images.map(({file,before}) => {
    const update = updates.get(file);
    if (update && update.before !== before) throw new Error('Protected target changed during reconciliation');
    return update ?? {file,before,after:before};
  });
  return withAccountLock(account,scope,() => reconcileOrphanedHookOperation(scope,changes,proof,peer));
}
export function recoverWorkspaceHooks(input: RecoveryScope): void;
export function recoverWorkspaceHooks(input: RecoveryScope, participant: WorkspaceParticipant): Promise<void>;
export function recoverWorkspaceHooks(input: RecoveryScope, participant?: WorkspaceParticipant): void | Promise<void> {
  const account = 'targets' in input ? canonicalAccountHome(input.accountHome) : undefined;
  if ('targets' in input && input.reconcile !== undefined) return reconcileWorkspaceHooks(input,account,participant);
  const registration = account && inspectWorkspaceHookOperation({root:input.root,accountHome:account}).registration;
  const {scope} = recoveryContext(input.root,'targets' in input ? input.targets : [input.target],account,Boolean(registration));
  if (participant) return withAccountLock(account,scope,() => recoverWithParticipant(scope,participant));
  withAccountLock(account,scope,() => recoverHookOperation(scope));
}
