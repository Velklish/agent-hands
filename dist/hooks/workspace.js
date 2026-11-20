import path from 'node:path';
import { realpathSync } from 'node:fs';
import { isTarget } from '../layout/adapter.js';
import { format } from './format.js';
import { inspectHookOwnership, prepareHookDocument } from './hook-delivery.js';
import { assertHookOperationIdle, commitHookOperation, commitWithParticipant, findHookOperation, recoverWithParticipant, recoverHookOperation, withAccountLock } from './hook-operation.js';
import { snapshot } from './hook-journal.js';
import { sha256 } from '../layout/fs.js';
function locations({ root, target }) {
    if (!isTarget(target) || target === 'opencode')
        throw new TypeError('Unsupported workspace command hook target');
    if (!path.isAbsolute(root))
        throw new TypeError('Absolute workspace path required');
    const base = realpathSync(root);
    const native = format(target);
    const local = path.join(base, '.agent-hands', 'hooks');
    const document = path.join(base, native.path);
    const state = path.join(local, target, 'ownership.json');
    return { base, native, target, document, state, scope: { directory: path.join(local, 'transaction'), pointers: [path.join(local, 'pending')], targets: [document, state] } };
}
function prepareSelection(input) {
    if (Object.keys(input).some(k => !['root', 'target', 'enabled', 'hooks', 'release', 'restore', 'legacy', 'preferences', 'registration'].includes(k)))
        throw new TypeError('Unknown workspace hook field');
    for (const list of [input.release, input.restore])
        if (list !== undefined && (!Array.isArray(list) || list.some(v => typeof v !== 'string' || !v) || new Set(list).size !== list.length))
            throw new TypeError('Invalid hook owner selection');
    const { base, native, target, document, state, scope } = locations(input);
    if (typeof input.enabled !== 'boolean' || !Array.isArray(input.hooks))
        throw new TypeError('Expected enabled flag and hook list');
    const convert = (h) => {
        if (!h || ![h.owner, h.event, h.command].every(v => typeof v === 'string' && v.length) || (h.matcher !== undefined && typeof h.matcher !== 'string') || (h.timeout !== undefined && (!Number.isSafeInteger(h.timeout) || h.timeout <= 0)) || Object.keys(h).some(k => !['owner', 'event', 'command', 'matcher', 'timeout'].includes(k)))
            throw new TypeError('Invalid workspace hook');
        const entry = native.entry(h.owner, h.event, h.command, h.matcher);
        if (h.timeout !== undefined)
            entry.callback.timeout = h.timeout;
        return entry;
    };
    const intents = input.hooks.map(convert);
    assertHookOperationIdle(scope);
    let legacy;
    if (input.legacy && snapshot(state) === null) {
        const raw = snapshot(document);
        if (raw === null || sha256(raw) !== input.legacy.documentSha256)
            throw new Error('Legacy hook snapshot changed');
        legacy = { document: raw, entries: input.legacy.hooks.map(convert) };
    }
    let wanted = input.preferences;
    if (input.registration) {
        if (!native.plugin || !input.enabled)
            throw new Error('Unsupported plugin registration operation');
        const r = input.registration;
        wanted = { ...wanted, localMarketplaces: { ...wanted?.localMarketplaces, [r.marketplace]: r.directory }, enabledPlugins: { ...wanted?.enabledPlugins, [`${r.plugin}@${r.marketplace}`]: true } };
    }
    if (wanted && !native.preferences)
        throw new Error('Unsupported hook preferences for target');
    const projection = wanted && native.preferences?.(base, wanted, legacy && input.legacy?.preferences);
    const { changes, shifted } = prepareHookDocument({ target, document, state, intents: input.enabled ? intents : [], legacy, release: input.release, restore: input.restore, projectDocument: projection?.projectDocument });
    if (projection)
        changes.push(projection.change());
    else if (native.preferencePath) {
        const file = native.preferencePath(base), before = snapshot(file);
        changes.push({ file, before, after: before });
    }
    let steps = [];
    let checkSource;
    if (input.registration) {
        const plan = native.plugin(base, changes[0], input.registration);
        changes.push(...plan.changes);
        steps = plan.steps;
        checkSource = plan.checkSource;
    }
    return { scope, changes, steps, checkSource, result: { changed: steps.length > 0 || changes.some(c => c.before !== c.after), shifted } };
}
function prepare(input) {
    if (!input || typeof input !== 'object' || ('selections' in input && (!Array.isArray(input.selections) || Object.keys(input).some(k => !['selections', 'root'].includes(k)))))
        throw new TypeError('Invalid workspace hook input');
    const selections = 'selections' in input ? input.selections.map(s => ({ ...s, root: input.root })) : [input];
    if (!selections.length || new Set(selections.map(s => s.target)).size !== selections.length)
        throw new TypeError('Expected distinct hook targets');
    const plans = [...selections].sort((a, b) => a.target.localeCompare(b.target)).map(prepareSelection);
    const changes = plans.flatMap(p => p.changes);
    const account = selections.find(s => s.registration)?.registration?.accountHome;
    const scope = accountScope({ ...plans[0].scope, targets: changes.map(row => row.file) }, account);
    assertHookOperationIdle(scope);
    return { changes, steps: plans.flatMap(p => p.steps), checkSources: () => plans.forEach(p => p.checkSource?.()), scope, account, result: { changed: plans.some(p => p.result.changed), shifted: plans.some(p => p.result.shifted) } };
}
function accountScope(scope, home) {
    if (!home)
        return scope;
    const privateRoot = path.join(realpathSync(home), '.agent-hands', 'account-hooks');
    return { ...scope, directory: path.join(privateRoot, 'transaction'), pointers: [...scope.pointers, path.join(privateRoot, 'pending')] };
}
const plans = new WeakMap();
export function prepareWorkspaceHooks(input) {
    const state = prepare(input);
    const token = Object.freeze({ ...state.result });
    plans.set(token, state);
    return token;
}
export function planWorkspaceHooks(input) { return prepare(input).result; }
export async function applyPreparedWorkspaceHooks(token, participant) {
    const plan = plans.get(token);
    if (!plan)
        throw new Error('Expected an unused prepared workspace hook plan');
    plans.delete(token);
    const peer = { id: participant.id, stage: async (id) => { await participant.stage(id); plan.checkSources(); }, beforeCommit: async (id) => { await participant.beforeCommit?.(id); plan.checkSources(); }, finish: (id, decision) => participant.finish(id, decision) };
    await withAccountLock(plan.account, plan.scope, () => commitWithParticipant(plan.scope, plan.changes, plan.steps, peer));
    return plan.result;
}
export function applyWorkspaceHooks(input) {
    const { scope, changes, result, steps, account, checkSources } = prepare(input);
    checkSources();
    if (result.changed)
        withAccountLock(account, scope, () => commitHookOperation(scope, changes, steps));
    return result;
}
export function inspectWorkspaceHookOwnership(input) {
    const { scope, target, document, state } = locations(input);
    assertHookOperationIdle(scope);
    return inspectHookOwnership({ target, document, state });
}
export function inspectWorkspaceHookOperation({ root, accountHome }) {
    if (!path.isAbsolute(root))
        throw new TypeError('Absolute workspace path required');
    const local = path.join(realpathSync(root), '.agent-hands', 'hooks'), pointer = path.join(local, 'pending');
    const localDirectory = path.join(local, 'transaction');
    const raw = snapshot(pointer);
    // A workspace pointer describes the selection; it never supplies a filesystem destination.
    let recorded = null;
    if (raw !== null) {
        const ref = JSON.parse(raw);
        if (!ref || !Array.isArray(ref.pointers) || !Array.isArray(ref.targets))
            throw new Error('Invalid workspace operation pointer');
        recorded = ref;
    }
    else {
        recorded = findHookOperation(localDirectory, [pointer]);
        if (!recorded && accountHome) {
            const shared = accountScope({ directory: localDirectory, pointers: [pointer] }, accountHome);
            const pending = findHookOperation(shared.directory, shared.pointers);
            if (pending?.pointers[0] === pointer)
                recorded = pending;
        }
    }
    if (!recorded)
        return { pending: false, registration: false };
    if (recorded.pointers[0] !== pointer || recorded.pointers.length > 2)
        throw new Error('Unexpected workspace operation scope');
    const targets = ['claude', 'codex', 'cursor'].filter(target => recorded.targets.includes(path.join(local, target, 'ownership.json')));
    if (!targets.length)
        throw new Error('Unrecognized workspace operation targets');
    return { pending: true, registration: recorded.pointers.length === 2, targets };
}
export function recoverWorkspaceHooks(input, participant) {
    const account = 'targets' in input ? input.accountHome : undefined;
    const scopes = ('targets' in input ? [...input.targets].sort() : [input.target]).map(target => {
        const { scope, base, native } = locations({ root: input.root, target });
        if (native.preferencePath)
            scope.targets.push(native.preferencePath(base));
        if (account && native.registrationFiles)
            scope.targets.push(...native.registrationFiles(base, account));
        return scope;
    });
    if (!scopes.length)
        throw new TypeError('Expected hook targets');
    const scope = accountScope({ ...scopes[0], targets: scopes.flatMap(s => s.targets) }, account);
    if (participant)
        return withAccountLock(account, scope, () => recoverWithParticipant(scope, participant));
    withAccountLock(account, scope, () => recoverHookOperation(scope));
}
