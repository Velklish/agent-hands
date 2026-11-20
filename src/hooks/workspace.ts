import path from 'node:path';
import { realpathSync } from 'node:fs';
import { isTarget, type Target } from '../layout/adapter.js';
import { format } from './format.js';
import { prepareHookDocument } from './hook-delivery.js';
import { assertHookOperationIdle, commitHookOperation, commitWithParticipant, recoverWithParticipant, recoverHookOperation, type WorkspaceParticipant } from './hook-operation.js';
import { snapshot } from './hook-journal.js';
import { sha256 } from '../layout/fs.js';
import type { WorkspacePreferences, WorkspaceRegistration } from './options.js';
import type { ExternalHookChange } from './hook-operation.js';
import { withAccountLock } from './hook-operation.js';

export interface WorkspaceHook { owner: string; event: string; command: string; matcher?: string; timeout?: number }
export interface WorkspaceHookScope { root: string; target: Target }
export interface WorkspaceHookInput extends WorkspaceHookScope {
  enabled: boolean;
  hooks: readonly WorkspaceHook[];
  release?: readonly string[];
  restore?: readonly string[];
  legacy?: { documentSha256: string; hooks: readonly WorkspaceHook[]; preferences?:WorkspacePreferences };
  preferences?: WorkspacePreferences;
  registration?: WorkspaceRegistration;
}
export interface WorkspaceHookResult { changed: boolean; shifted: boolean }
export interface WorkspaceHookBatch { root: string; selections: readonly Omit<WorkspaceHookInput,'root'>[] }
export interface WorkspaceHookBatchScope { root: string; targets: readonly Target[]; accountHome?:string }

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
function prepareSelection(input: WorkspaceHookInput) {
  const {base,native,target,document,state,scope} = locations(input);
  if (typeof input.enabled !== 'boolean' || !Array.isArray(input.hooks)) throw new TypeError('Expected enabled flag and hook list');
  const convert = (h: WorkspaceHook) => {
    if (!h || ![h.owner,h.event,h.command].every(v => typeof v === 'string' && v.length) || (h.matcher !== undefined && typeof h.matcher !== 'string') || (h.timeout !== undefined && (!Number.isSafeInteger(h.timeout) || h.timeout <= 0)) || Object.keys(h).some(k => !['owner','event','command','matcher','timeout'].includes(k))) throw new TypeError('Invalid workspace hook');
    const entry = native.entry(h.owner,h.event,h.command,h.matcher);
    if (h.timeout !== undefined) entry.callback.timeout = h.timeout;
    return entry;
  };
  const intents = input.hooks.map(convert);
  assertHookOperationIdle(scope);
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
  const {changes,shifted} = prepareHookDocument({target,document,state,intents:input.enabled ? intents : [],legacy,release:input.release,restore:input.restore,projectDocument:projection?.projectDocument});
  if (projection) changes.push(projection.change());
  else if (native.preferencePath) { const file = native.preferencePath(base), before=snapshot(file); changes.push({file,before,after:before}); }
  let steps:ExternalHookChange[] = [];
  if (input.registration) {
    const plan = native.plugin!(base,changes[0],input.registration);
    changes.push(...plan.changes); steps = plan.steps;
  }
  return {scope,changes,steps,result:{changed:steps.length > 0 || changes.some(c => c.before !== c.after),shifted}};
}
function prepare(input: WorkspaceHookInput | WorkspaceHookBatch) {
  const selections = 'selections' in input ? input.selections.map(s => ({...s,root:input.root})) : [input];
  if (!selections.length || new Set(selections.map(s => s.target)).size !== selections.length) throw new TypeError('Expected distinct hook targets');
  const plans = [...selections].sort((a,b) => a.target.localeCompare(b.target)).map(prepareSelection);
  const changes = plans.flatMap(p => p.changes);
  const account = selections.find(s => s.registration)?.registration?.accountHome;
  const scope = accountScope({...plans[0].scope,targets:changes.map(row => row.file)},account);
  assertHookOperationIdle(scope);
  return { changes,steps:plans.flatMap(p => p.steps),scope,account,result:{changed:plans.some(p => p.result.changed),shifted:plans.some(p => p.result.shifted)} };
}
function accountScope<T extends {pointers:string[]}>(scope:T,home?:string):T {
  return home ? {...scope,pointers:[...scope.pointers,path.join(realpathSync(home),'.agent-hands','account-hooks','pending')]} : scope;
}
declare const prepared: unique symbol;
export interface PreparedWorkspaceHooks extends WorkspaceHookResult { readonly [prepared]: true }
const plans = new WeakMap<PreparedWorkspaceHooks,ReturnType<typeof prepare>>();
export function prepareWorkspaceHooks(input: WorkspaceHookInput | WorkspaceHookBatch): PreparedWorkspaceHooks {
  const state = prepare(input);
  const token = Object.freeze({...state.result}) as PreparedWorkspaceHooks;
  plans.set(token,state);
  return token;
}
export function planWorkspaceHooks(input: WorkspaceHookInput | WorkspaceHookBatch): WorkspaceHookResult { return prepare(input).result; }
export async function applyPreparedWorkspaceHooks(token: PreparedWorkspaceHooks, participant: WorkspaceParticipant): Promise<WorkspaceHookResult> {
  const plan = plans.get(token);
  if (!plan) throw new Error('Expected an unused prepared workspace hook plan');
  plans.delete(token);
  await withAccountLock(plan.account,plan.scope,() => commitWithParticipant(plan.scope,plan.changes,plan.steps,participant));
  return plan.result;
}
export function applyWorkspaceHooks(input: WorkspaceHookInput | WorkspaceHookBatch): WorkspaceHookResult {
  const {scope,changes,result,steps,account} = prepare(input);
  if (result.changed) withAccountLock(account,scope,() => commitHookOperation(scope,changes,steps));
  return result;
}
type RecoveryScope = WorkspaceHookScope | WorkspaceHookBatchScope;
export function recoverWorkspaceHooks(input: RecoveryScope): void;
export function recoverWorkspaceHooks(input: RecoveryScope, participant: WorkspaceParticipant): Promise<void>;
export function recoverWorkspaceHooks(input: RecoveryScope, participant?: WorkspaceParticipant): void | Promise<void> {
  const account = 'targets' in input ? input.accountHome : undefined;
  const scopes = ('targets' in input ? [...input.targets].sort() : [input.target]).map(target => {
    const {scope,base,native} = locations({root:input.root,target});
    if (native.preferencePath) scope.targets.push(native.preferencePath(base));
    if (account && native.registrationFiles) scope.targets.push(...native.registrationFiles(base,account));
    return scope;
  });
  if (!scopes.length) throw new TypeError('Expected hook targets');
  const scope = accountScope({...scopes[0],targets:scopes.flatMap(s => s.targets)},account);
  if (participant) return withAccountLock(account,scope,() => recoverWithParticipant(scope,participant));
  withAccountLock(account,scope,() => recoverHookOperation(scope));
}
