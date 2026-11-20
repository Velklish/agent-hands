import { type TargetChange } from './hook-journal.js';
export interface OperationScope {
    readonly directory: string;
    readonly pointers: readonly string[];
    readonly targets: readonly string[];
}
export declare function assertHookOperationIdle(scope: Pick<OperationScope, 'directory' | 'pointers'>): void;
export declare function withAccountLock<T>(home: string | undefined, scope: OperationScope, run: () => T): T;
export declare function findHookOperation(directory: string, pointers: readonly string[]): OperationScope | null;
export declare function inspectOrphanedHookOperation(scope: OperationScope): {
    id: string;
    participant: string | null | undefined;
} | null;
interface ReconciliationProof {
    operationId: string;
    participantSha256?: string;
}
export declare function reconcileOrphanedHookOperation(scope: OperationScope, changes: readonly TargetChange[], proof?: ReconciliationProof, peer?: WorkspaceParticipant): Promise<void> | undefined;
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
    finish(operationId: string, decision: 'commit' | 'rollback'): Promise<void>;
}
export declare function commitHookOperation(scope: OperationScope, changes: readonly TargetChange[], external?: readonly ExternalHookChange[]): void;
export declare function commitWithParticipant(scope: OperationScope, changes: readonly TargetChange[], external: readonly ExternalHookChange[], participant: WorkspaceParticipant): Promise<void>;
export declare function recoverHookOperation(scope: OperationScope, moved?: {
    from: string;
    to: string;
}): void;
export declare function recoverWithParticipant(scope: OperationScope, peer: WorkspaceParticipant): Promise<void>;
export {};
