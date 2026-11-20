export interface TargetChange {
    readonly file: string;
    readonly before: string | null;
    readonly after: string | null;
    readonly observed?: readonly (string | null)[];
}
export interface Journal {
    readonly version: 1;
    readonly phase: 'pending' | 'committed' | 'aborted' | 'reconciling';
    readonly targets: readonly TargetChange[];
}
export declare function snapshot(file: string): string | null;
export declare function parseHookJournal(raw: string, allowed: readonly string[]): Journal;
export declare function finishReconciliation(journal: Journal): void;
export declare function checkSnapshots(targets: readonly TargetChange[], direction: 'before' | 'after'): void;
export declare function applyTargets(journal: Journal): void;
export declare function rollbackTargets(journal: Journal): void;
