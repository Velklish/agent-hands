import { type HookEntry, type HookTarget } from './hook-plan.js';
import { type TargetChange } from './hook-journal.js';
import { type OperationScope } from './hook-operation.js';
export interface ManagedHooks {
    readonly target: HookTarget;
    readonly document: string;
    readonly state: string;
    readonly intents: readonly HookEntry[];
    readonly release?: readonly string[];
    readonly restore?: readonly string[];
    readonly expectedState?: string | null;
    readonly reconcile?: boolean;
    readonly legacy?: {
        readonly document: string;
        readonly entries: readonly HookEntry[];
    };
    readonly projectDocument?: (text: string | null) => string | null;
}
export declare function confirmedHookIntents(spec: Pick<ManagedHooks, 'target' | 'document' | 'state'>): HookEntry[];
export declare function prepareHookDocument(spec: ManagedHooks): {
    changes: TargetChange[];
    shifted: boolean;
    released: readonly string[];
};
export declare function deliverHooks(scope: Omit<OperationScope, 'targets'>, documents: readonly ManagedHooks[], warnShift: () => void): void;
