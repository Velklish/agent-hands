import path from 'node:path';
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isTarget } from '../layout/adapter.js';
import { format } from './format.js';
import { confirmedHookIntents, inspectHookOwnership, prepareHookDocument } from './hook-delivery.js';
import { assertHookOperationIdle, commitHookOperation, commitWithParticipant, findHookOperation, inspectOrphanedHookOperation, reconcileOrphanedHookOperation, recoverWithParticipant, recoverHookOperation, withAccountLock, withHookStateLock } from './hook-operation.js';
import { snapshot } from './hook-journal.js';
import { hookStatePaths, hookStateScope, physicalDirectory } from './state-location.js';
import { sha256 } from '../layout/fs.js';
const commandTargets = ['claude', 'codex', 'cursor'];
const registrationParts = ['marketplaces', 'installations', 'localSettings', 'accountSettings', 'registration'];
function locations(input) {
    const { target } = input;
    if (!isTarget(target) || target === 'opencode')
        throw new TypeError('Unsupported workspace command hook target');
    const { base, local, checkLocation } = hookStatePaths(input);
    checkLocation();
    const native = format(target);
    const document = path.join(base, native.path);
    const state = path.join(local, target, 'ownership.json');
    return { base, local, native, target, document, state, scope: { ...hookStateScope(local), targets: [document, state], checkLocation } };
}
function prepareSelection(input, reconciling = false) {
    if (Object.keys(input).some(k => !['root', 'stateLocation', 'target', 'enabled', 'hooks', 'mode', 'release', 'restore', 'legacy', 'preferences', 'registration'].includes(k)))
        throw new TypeError('Unknown workspace hook field');
    for (const list of [input.release, input.restore])
        if (list !== undefined && (!Array.isArray(list) || list.some(v => typeof v !== 'string' || !v) || new Set(list).size !== list.length))
            throw new TypeError('Invalid hook owner selection');
    const { base, local, native, target, document, state, scope } = locations(input);
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
    if (!reconciling)
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
    const projection = wanted && native.preferences?.(local, wanted, legacy && input.legacy?.preferences);
    const { changes, shifted } = prepareHookDocument({ target, document, state, intents: input.enabled ? intents : [], ownershipOnly, legacy, release: input.release, restore: input.restore, projectDocument: projection?.projectDocument });
    if (projection)
        changes.push(projection.change());
    else if (native.preferencePath) {
        const file = native.preferencePath(local), before = snapshot(file);
        changes.push({ file, before, after: before });
    }
    let steps = [];
    let checkSource;
    let registration;
    if (input.registration) {
        const plan = native.plugin(base, local, changes[0], input.registration);
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
    if (batch && (!Array.isArray(batch.selections) || Object.keys(batch).some(k => !['selections', 'root', 'accountHome', 'stateLocation'].includes(k))))
        throw new TypeError('Invalid workspace hook batch');
    const selections = batch ? batch.selections.map(s => {
        if (Object.hasOwn(s, 'stateLocation'))
            throw new TypeError('Select the state location once per batch');
        return { ...s, root: batch.root, stateLocation: batch.stateLocation };
    }) : [input];
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
    const plans = [...selections].sort((a, b) => a.target.localeCompare(b.target)).map(selection => prepareSelection(selection));
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
function verifyHookState(base, local, account) {
    assertHookOperationIdle(hookStateScope(local));
    for (const entry of readdirSync(local)) {
        const directory = path.join(local, entry);
        if (!physicalDirectory(base, directory))
            throw new Error('Hook state changed during migration');
        if (entry === 'transaction') {
            for (const name of readdirSync(directory)) {
                const file = lstatSync(path.join(directory, name));
                if (name !== 'writer.lock' || !file.isFile() || file.nlink !== 1 || file.size !== 0)
                    throw new Error('Unexpected file in the hook transaction directory');
            }
            continue;
        }
        const target = commandTargets.find(candidate => candidate === entry);
        if (!target)
            throw new Error('Unexpected workspace hook state directory');
        const native = format(target);
        const state = path.join(directory, 'ownership.json');
        const preference = native.preferencePath?.(local);
        const registration = native.registrationPath?.(local);
        for (const name of readdirSync(directory)) {
            const file = path.join(directory, name);
            if (file !== state && file !== preference && file !== registration)
                throw new Error('Unexpected workspace hook state file');
            snapshot(file);
        }
        const document = path.join(base, native.path);
        inspectHookOwnership({ target, document, state });
        if (preference && snapshot(preference) !== null) {
            const settings = snapshot(document);
            native.preferences(local, {}).projectDocument(settings, settings);
        }
        native.verifyRegistrationReceipt?.(base, account, local);
    }
}
export function migrateWorkspaceHookState(input) {
    if (input.stateLocation === undefined)
        throw new TypeError('Select the destination hook state location');
    const { base, local: destination, alternate: source } = hookStatePaths(input);
    const account = canonicalAccountHome(input.accountHome);
    const sourceScope = hookStateScope(source);
    const shared = accountScope(sourceScope, account);
    const preflight = () => {
        const hasSource = physicalDirectory(base, source);
        const hasDestination = physicalDirectory(base, destination);
        if (hasSource && hasDestination)
            throw new Error('Hook state exists at both locations');
        assertHookOperationIdle(shared);
        if (hasSource)
            verifyHookState(base, source, account);
        else if (hasDestination)
            verifyHookState(base, destination, account);
        return { hasSource, hasDestination };
    };
    const clearEmptySourceParent = () => {
        try {
            rmdirSync(path.dirname(source));
        }
        catch (error) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code ?? ''))
                throw error;
        }
    };
    const before = preflight();
    if (!before.hasSource) {
        if (before.hasDestination)
            clearEmptySourceParent();
        return { changed: false };
    }
    const move = () => {
        if (!preflight().hasSource)
            throw new Error('Hook state changed during migration');
        const parent = path.dirname(destination);
        mkdirSync(parent, { recursive: true, mode: 0o700 });
        physicalDirectory(base, parent);
        if (lstatSync(destination, { throwIfNoEntry: false }))
            throw new Error('Hook state exists at both locations');
        renameSync(source, destination);
        return { changed: true };
    };
    const result = withHookStateLock(sourceScope.directory, () => account ? withHookStateLock(shared.directory, move) : move(), true);
    clearEmptySourceParent();
    return result;
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
export function inspectWorkspaceRegistration(input) {
    const { base: root, local } = hookStatePaths(input);
    const accountHome = canonicalAccountHome(input.accountHome);
    if (!accountHome)
        throw new TypeError('Absolute hook account home required');
    const operation = inspectWorkspaceHookOperation({ ...input, root, accountHome });
    if (operation.pending || operation.blockedBy)
        return { status: 'stale' };
    return format('claude').inspectProjectRegistration({ ...input, root, accountHome }, local);
}
export function inspectWorkspaceHookOperation(input) {
    const { accountHome, evidence, stateLocation } = input;
    const account = canonicalAccountHome(accountHome);
    const { base, local, checkLocation } = hookStatePaths(input);
    checkLocation();
    const { directory: localDirectory, pointers: [pointer] } = hookStateScope(local);
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
    const targets = commandTargets.filter(target => recorded.targets.includes(path.join(local, target, 'ownership.json')));
    if (!targets.length)
        throw new Error('Unrecognized workspace operation targets');
    const registrationPath = targets.includes('claude') ? format('claude').registrationPath?.(local) : undefined;
    const registration = registrationPath !== undefined && recorded.targets.includes(registrationPath);
    const accountScoped = recorded.pointers.length === 2;
    let reconciliation;
    if (evidence) {
        if (accountScoped && !account)
            throw new Error('Expected the original hook account');
        const context = recoveryContext({ root: base, stateLocation }, targets, accountScoped ? account : undefined, registration);
        const orphan = inspectOrphanedHookOperation(context.scope);
        if (orphan)
            reconciliation = { operationId: orphan.id, evidence: readEvidence(context.parts).map(row => row.evidence),
                participantRequired: typeof orphan.participant === 'string', supported: orphan.participant !== undefined };
    }
    return { pending: true, registration, targets, ...(!registration && accountScoped && { accountScoped: true }), ...(reconciliation && { reconciliation }) };
}
function recoveryContext(input, targets, account, registration) {
    if (!targets.length || new Set(targets).size !== targets.length)
        throw new TypeError('Expected distinct hook targets');
    const selections = [...targets].sort().map(target => locations({ ...input, target }));
    const parts = selections.flatMap(({ base, local, native, target, document, state }) => {
        const selected = [
            { target, part: 'document', file: document }, { target, part: 'ownership', file: state },
        ];
        if (native.preferencePath)
            selected.push({ target, part: 'preferences', file: native.preferencePath(local) });
        if (registration && account && native.registrationFiles) {
            const files = native.registrationFiles(base, account, local);
            for (let index = 0; index < registrationParts.length; index++)
                selected.push({ target, part: registrationParts[index], file: files[index] });
        }
        return selected;
    });
    return { scope: accountScope({ ...selections[0].scope, targets: parts.map(part => part.file) }, account), parts, selections };
}
function readEvidence(parts) {
    return parts.map(({ file, target, part }) => {
        const before = snapshot(file);
        return { file, before, evidence: { target, part, sha256: before === null ? null : sha256(before) } };
    });
}
function reconcileWorkspaceHooks(input, account, peer) {
    const proof = input.reconcile;
    if (!proof || !Array.isArray(proof.evidence) || !Array.isArray(proof.documents) ||
        Object.keys(proof).some(key => !['operationId', 'evidence', 'documents', 'participantSha256', 'registration'].includes(key)))
        throw new TypeError('Expected complete hook reconciliation evidence');
    const pending = inspectWorkspaceHookOperation({ ...input, accountHome: account });
    if (!pending.pending || Boolean(pending.registration || pending.accountScoped) !== Boolean(account))
        throw new Error('Expected a matching pending hook operation');
    const { scope, parts, selections } = recoveryContext(input, input.targets, account, pending.registration);
    const orphan = inspectOrphanedHookOperation(scope);
    if (!orphan || orphan.participant === undefined || orphan.id !== proof.operationId)
        throw new Error('Reconciliation operation proof does not match');
    if (orphan.participant !== (peer?.id ?? null) ||
        (peer && (!peer.verifyReconciliation || typeof proof.participantSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.participantSha256))) ||
        (!peer && proof.participantSha256 !== undefined))
        throw new Error('Reconciliation requires verified evidence from the original participant');
    const images = readEvidence(parts);
    if (!isDeepStrictEqual(images.map(row => row.evidence), proof.evidence))
        throw new Error('Hook reconciliation evidence does not match protected targets');
    if (proof.documents.length !== selections.length)
        throw new Error('Reconciliation requires every selected hook document');
    if (pending.registration || proof.registration !== undefined) {
        if (!pending.registration || !proof.registration || !account ||
            Object.keys(proof.registration).some(key => !['marketplace', 'plugin', 'version', 'fingerprint'].includes(key)))
            throw new Error('Reconciliation requires verified native registration');
        const { marketplace, plugin, version, fingerprint } = proof.registration;
        const actual = format('claude').inspectProjectRegistration({ root: selections[0].base, accountHome: account,
            marketplace, plugin, expectedVersion: version, expectedFingerprint: fingerprint }, selections[0].local);
        if (actual.status !== 'current' || actual.version !== version || actual.fingerprint !== fingerprint)
            throw new Error('Reconciliation requires verified native registration');
    }
    const updates = new Map();
    for (const { base: root, target, document, state } of selections) {
        const decisions = proof.documents.filter(row => row?.target === target);
        if (decisions.length !== 1)
            throw new Error('Reconciliation requires one decision per hook target');
        const decision = decisions[0];
        const location = { target, document, state };
        if (decision.action === 'accept') {
            if (Object.keys(decision).length !== 2)
                throw new Error('Unexpected hook reconciliation fields');
            const intents = confirmedHookIntents(location);
            const result = prepareHookDocument({ ...location, intents });
            if (result.changes.some(change => change.before !== change.after))
                throw new Error('Current hook ownership is inconsistent');
            for (const change of result.changes)
                updates.set(change.file, change);
            continue;
        }
        if (peer || pending.registration)
            throw new Error('An external operation requires acceptance of the verified current hook state');
        if (Object.keys(decision).length !== 3)
            throw new Error('Unexpected hook reconciliation fields');
        const common = { root, target, stateLocation: input.stateLocation, enabled: true, mode: 'ownership' };
        const selection = decision.action === 'release' && Array.isArray(decision.owners) ?
            { ...common, hooks: [], release: decision.owners } : decision.action === 'restore' && Array.isArray(decision.hooks) ?
            { ...common, hooks: decision.hooks, restore: decision.hooks.map(hook => hook?.owner) } : undefined;
        if (!selection)
            throw new Error('Invalid hook reconciliation decision');
        for (const change of prepareSelection(selection, true).changes)
            updates.set(change.file, change);
    }
    const changes = images.map(({ file, before }) => {
        const update = updates.get(file);
        if (update && update.before !== before)
            throw new Error('Protected target changed during reconciliation');
        return update ?? { file, before, after: before };
    });
    return withAccountLock(account, scope, () => reconcileOrphanedHookOperation(scope, changes, proof, peer));
}
export function recoverWorkspaceHooks(input, participant) {
    const account = 'targets' in input ? canonicalAccountHome(input.accountHome) : undefined;
    if ('targets' in input && input.reconcile !== undefined)
        return reconcileWorkspaceHooks(input, account, participant);
    const registration = account && inspectWorkspaceHookOperation({ ...input, accountHome: account }).registration;
    const { scope } = recoveryContext(input, 'targets' in input ? input.targets : [input.target], account, Boolean(registration));
    if (participant)
        return withAccountLock(account, scope, () => recoverWithParticipant(scope, participant));
    withAccountLock(account, scope, () => recoverHookOperation(scope));
}
