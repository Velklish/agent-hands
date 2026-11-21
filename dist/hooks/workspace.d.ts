import { type Target } from '../layout/adapter.js';
import { type WorkspaceParticipant } from './hook-operation.js';
import type { WorkspaceHookDiagnostic, WorkspacePreferences, WorkspaceRegistration, WorkspaceRegistrationPlan, WorkspaceRegistrationOutcome, WorkspaceRegistrationInspection, WorkspaceRegistrationStatus, WorkspaceHookStateLocation, WorkspaceHookStateScope } from './options.js';
export interface WorkspaceHook {
    owner: string;
    event: string;
    command: string;
    matcher?: string;
    timeout?: number;
}
export interface WorkspaceHookScope extends WorkspaceHookStateScope {
    target: Target;
}
export interface WorkspaceHookInput extends WorkspaceHookScope {
    enabled: boolean;
    hooks: readonly WorkspaceHook[];
    mode?: 'ownership';
    release?: readonly string[];
    restore?: readonly string[];
    legacy?: {
        documentSha256: string;
        hooks: readonly WorkspaceHook[];
        preferences?: WorkspacePreferences;
    };
    preferences?: WorkspacePreferences;
    registration?: WorkspaceRegistration;
}
export interface WorkspaceHookResult {
    changed: boolean;
    shifted: boolean;
    diagnostics?: readonly WorkspaceHookDiagnostic[];
}
export interface WorkspaceHookBatch extends WorkspaceHookStateScope {
    selections: readonly Omit<WorkspaceHookInput, keyof WorkspaceHookStateScope>[];
    accountHome?: string;
}
type CommandTarget = Exclude<Target, 'opencode'>;
declare const registrationParts: readonly ["marketplaces", "installations", "localSettings", "accountSettings", "registration"];
type EvidencePart = 'document' | 'ownership' | 'preferences' | typeof registrationParts[number];
export interface WorkspaceHookEvidence {
    target: CommandTarget;
    part: EvidencePart;
    sha256: string | null;
}
export type WorkspaceHookResolution = {
    target: CommandTarget;
    action: 'accept';
} | {
    target: CommandTarget;
    action: 'release';
    owners: readonly string[];
} | {
    target: CommandTarget;
    action: 'restore';
    hooks: readonly WorkspaceHook[];
};
export interface WorkspaceHookReconciliation {
    operationId: string;
    evidence: readonly WorkspaceHookEvidence[];
    documents: readonly WorkspaceHookResolution[];
    participantSha256?: string;
    registration?: {
        marketplace: string;
        plugin: string;
        version: string;
        fingerprint: string;
    };
}
export interface WorkspaceHookBatchScope extends WorkspaceHookStateScope {
    targets: readonly Target[];
    accountHome?: string;
    reconcile?: WorkspaceHookReconciliation;
}
export interface WorkspaceHookStateMigration extends WorkspaceHookStateScope {
    stateLocation: WorkspaceHookStateLocation;
    accountHome?: string;
}
export declare function migrateWorkspaceHookState(input: WorkspaceHookStateMigration): {
    changed: boolean;
};
declare const prepared: unique symbol;
export interface PreparedWorkspaceHooks extends WorkspaceHookResult {
    readonly [prepared]: true;
    readonly registrations: readonly Readonly<WorkspaceRegistrationPlan & {
        target: 'claude';
    }>[];
}
export interface PreparedWorkspaceHookResult extends WorkspaceHookResult {
    readonly registrations: readonly Readonly<WorkspaceRegistrationOutcome & {
        target: 'claude';
    }>[];
}
export declare function prepareWorkspaceHooks(input: WorkspaceHookInput | WorkspaceHookBatch): PreparedWorkspaceHooks;
export declare function planWorkspaceHooks(input: WorkspaceHookInput | WorkspaceHookBatch): WorkspaceHookResult;
export declare function applyPreparedWorkspaceHooks(token: PreparedWorkspaceHooks, participant: WorkspaceParticipant): Promise<PreparedWorkspaceHookResult>;
export declare function applyWorkspaceHooks(input: WorkspaceHookInput | WorkspaceHookBatch): WorkspaceHookResult;
type RecoveryScope = WorkspaceHookScope | WorkspaceHookBatchScope;
export declare function inspectWorkspaceHookOwnership(input: WorkspaceHookScope): {
    owners: string[];
    released: readonly string[];
} | null;
export declare function inspectWorkspaceRegistration(input: WorkspaceRegistrationInspection): WorkspaceRegistrationStatus;
export interface WorkspaceHookReconciliationEvidence {
    operationId: string;
    evidence: readonly WorkspaceHookEvidence[];
    participantRequired: boolean;
    supported: boolean;
}
export type PendingWorkspaceHooks = {
    pending: false;
    registration: false;
    blockedBy?: 'another-project';
} | {
    pending: true;
    registration: boolean;
    targets: Target[];
    accountScoped?: true;
    reconciliation?: WorkspaceHookReconciliationEvidence;
};
export declare function inspectWorkspaceHookOperation(input: WorkspaceHookStateScope & {
    accountHome?: string;
    evidence?: boolean;
}): PendingWorkspaceHooks;
export declare function recoverWorkspaceHooks(input: RecoveryScope): void;
export declare function recoverWorkspaceHooks(input: RecoveryScope, participant: WorkspaceParticipant): Promise<void>;
export {};
