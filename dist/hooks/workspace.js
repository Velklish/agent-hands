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
    if (Object.keys(input).some(k => !['root', 'target', 'enabled', 'hooks', 'mode', 'release', 'restore', 'legacy', 'preferences', 'registration'].includes(k)))
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
    const ownershipOnly = input.mode === 'ownership';
    if (input.mode !== undefined && (!ownershipOnly || !input.enabled || input.legacy || input.preferences || input.registration ||
        !(input.release?.length || input.restore?.length) || intents.length !== (input.restore?.length ?? 0) ||
        intents.some(intent => !input.restore?.includes(intent.owner)) || new Set(intents.map(intent => intent.owner)).size !== intents.length))
        throw new TypeError('Ownership changes require only the selected release owners and restore definitions');
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
    const { changes, shifted } = prepareHookDocument({ target, document, state, intents: input.enabled ? intents : [], ownershipOnly, legacy, release: input.release, restore: input.restore, projectDocument: projection?.projectDocument });
    if (projection)
        changes.push(projection.change());
    else if (native.preferencePath) {
        const file = native.preferencePath(base), before = snapshot(file);
        changes.push({ file, before, after: before });
    }
    let steps = [];
    let checkSource;
    let registration;
    if (input.registration) {
        const plan = native.plugin(base, changes[0], input.registration);
        changes.push(...plan.changes);
        steps = plan.steps;
        checkSource = plan.checkSource;
        registration = Object.freeze({ target: 'claude', ...plan.registration });
    }
    return { scope, changes, steps, checkSource, registration, diagnostics: projection?.diagnostics ?? [], result: { changed: steps.length > 0 || changes.some(c => c.before !== c.after), shifted } };
}
function prepare(input) {
    if (!input || typeof input !== 'object')
        throw new TypeError('Invalid workspace hook input');
    const batch = 'selections' in input ? input : undefined;
    if (batch && (!Array.isArray(batch.selections) || Object.keys(batch).some(k => !['selections', 'root', 'accountHome'].includes(k))))
        throw new TypeError('Invalid workspace hook batch');
    const selections = batch ? batch.selections.map(s => ({ ...s, root: batch.root })) : [input];
    if (!selections.length || new Set(selections.map(s => s.target)).size !== selections.length)
        throw new TypeError('Expected distinct hook targets');
    const explicitAccount = canonicalAccountHome(batch?.accountHome);
    const registrationAccount = canonicalAccountHome(selections.find(s => s.registration)?.registration?.accountHome);
    if (explicitAccount && registrationAccount && explicitAccount !== registrationAccount)
        throw new Error('Hook registration account does not match the batch account');
    const account = explicitAccount ?? registrationAccount;
    if (account) {
        const shared = accountScope(locations(selections[0]).scope, account);
        const pending = findAccountOperation(shared);
        if (pending && pending.pointers[0] !== shared.pointers[0])
            throw new Error('Account hook operation pending in another project');
    }
    const plans = [...selections].sort((a, b) => a.target.localeCompare(b.target)).map(prepareSelection);
    const changes = plans.flatMap(p => p.changes);
    const scope = accountScope({ ...plans[0].scope, targets: changes.map(row => row.file) }, account);
    assertHookOperationIdle(scope);
    const registrations = Object.freeze(plans.flatMap(p => p.registration ? [p.registration] : []));
    const diagnostics = plans.flatMap(p => p.diagnostics);
    return { changes, steps: plans.flatMap(p => p.steps), registrations, checkSources: () => plans.forEach(p => p.checkSource?.()), scope, account,
        result: { changed: plans.some(p => p.result.changed), shifted: plans.some(p => p.result.shifted), ...(diagnostics.length ? { diagnostics } : {}) } };
}
function canonicalAccountHome(home) {
    if (home === undefined)
        return undefined;
    if (!path.isAbsolute(home))
        throw new TypeError('Absolute hook account home required');
    return realpathSync(home);
}
function accountScope(scope, home) {
    if (!home)
        return scope;
    const privateRoot = path.join(home, '.agent-hands', 'account-hooks');
    return { ...scope, directory: path.join(privateRoot, 'transaction'), pointers: [...scope.pointers, path.join(privateRoot, 'pending')] };
}
function findAccountOperation(scope) {
    const accountPointer = scope.pointers[1];
    const pending = findHookOperation(scope.directory, [accountPointer]);
    if (pending && (pending.pointers.length !== 2 || pending.pointers[1] !== accountPointer))
        throw new Error('Unexpected account hook operation scope');
    return pending;
}
const plans = new WeakMap();
export function prepareWorkspaceHooks(input) {
    const state = prepare(input);
    const token = Object.freeze({ ...state.result, registrations: state.registrations });
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
    const statuses = { install: 'installed', update: 'updated', current: 'current' };
    return { ...plan.result, registrations: plan.registrations.map(({ action, ...row }) => ({ ...row, status: statuses[action] })) };
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
    const account = canonicalAccountHome(accountHome);
    const base = realpathSync(root);
    const local = path.join(base, '.agent-hands', 'hooks'), pointer = path.join(local, 'pending');
    const localDirectory = path.join(local, 'transaction');
    const raw = snapshot(pointer);
    // A workspace pointer describes the selection; it never supplies a filesystem destination.
    let recorded = null;
    if (raw !== null) {
        let ref;
        try {
            ref = JSON.parse(raw);
        }
        catch {
            throw new Error('Invalid workspace operation pointer');
        }
        if (!ref || !Array.isArray(ref.pointers) || !Array.isArray(ref.targets))
            throw new Error('Invalid workspace operation pointer');
        recorded = ref;
    }
    else {
        recorded = findHookOperation(localDirectory, [pointer]);
        if (!recorded && account) {
            const shared = accountScope({ directory: localDirectory, pointers: [pointer] }, account);
            const pending = findAccountOperation(shared);
            if (pending && pending.pointers[0] !== pointer)
                return { pending: false, registration: false, blockedBy: 'another-project' };
            recorded = pending;
        }
    }
    if (!recorded)
        return { pending: false, registration: false };
    if (recorded.pointers[0] !== pointer || recorded.pointers.length > 2)
        throw new Error('Unexpected workspace operation scope');
    if (account && recorded.pointers.length === 2 &&
        recorded.pointers[1] !== accountScope({ directory: localDirectory, pointers: [pointer] }, account).pointers[1])
        throw new Error('Hook operation account does not match');
    const targets = ['claude', 'codex', 'cursor'].filter(target => recorded.targets.includes(path.join(local, target, 'ownership.json')));
    if (!targets.length)
        throw new Error('Unrecognized workspace operation targets');
    const registrationPath = targets.includes('claude') ? format('claude').registrationPath?.(base) : undefined;
    const registration = registrationPath !== undefined && recorded.targets.includes(registrationPath);
    return { pending: true, registration, targets, ...(!registration && recorded.pointers.length === 2 && { accountScoped: true }) };
}
export function recoverWorkspaceHooks(input, participant) {
    const account = 'targets' in input ? canonicalAccountHome(input.accountHome) : undefined;
    const registration = account && inspectWorkspaceHookOperation({ root: input.root, accountHome: account }).registration;
    const scopes = ('targets' in input ? [...input.targets].sort() : [input.target]).map(target => {
        const { scope, base, native } = locations({ root: input.root, target });
        if (native.preferencePath)
            scope.targets.push(native.preferencePath(base));
        if (account && registration && native.registrationFiles)
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
