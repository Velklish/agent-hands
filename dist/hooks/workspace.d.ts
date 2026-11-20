import { type Target } from '../layout/adapter.js';
import { type WorkspaceParticipant } from './hook-operation.js';
import type { WorkspacePreferences, WorkspaceRegistration, WorkspaceRegistrationPlan, WorkspaceRegistrationOutcome } from './options.js';
export interface WorkspaceHook {
    owner: string;
    event: string;
    command: string;
    matcher?: string;
    timeout?: number;
}
export interface WorkspaceHookScope {
    root: string;
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
}
export interface WorkspaceHookBatch {
    root: string;
    selections: readonly Omit<WorkspaceHookInput, 'root'>[];
    accountHome?: string;
}
export interface WorkspaceHookBatchScope {
    root: string;
    targets: readonly Target[];
    accountHome?: string;
}
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
export type PendingWorkspaceHooks = {
    pending: false;
    registration: false;
} | {
    pending: true;
    registration: boolean;
    targets: Target[];
    accountScoped?: true;
};
export declare function inspectWorkspaceHookOperation({ root, accountHome }: {
    root: string;
    accountHome?: string;
}): PendingWorkspaceHooks;
export declare function recoverWorkspaceHooks(input: RecoveryScope): void;
export declare function recoverWorkspaceHooks(input: RecoveryScope, participant: WorkspaceParticipant): Promise<void>;
export {};
