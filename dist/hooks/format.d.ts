import type { HookEntry, HookTarget, Slot } from './hook-plan.js';
import type { WorkspaceHookDiagnostic, WorkspacePreferences, WorkspaceRegistration, WorkspaceRegistrationPlan, WorkspaceRegistrationInspection, WorkspaceRegistrationStatus } from './options.js';
import type { TargetChange } from './hook-journal.js';
import type { ExternalHookChange } from './hook-operation.js';
export type Fields = Record<string, unknown>;
export interface HookFormat {
    preferences?(local: string, wanted: WorkspacePreferences, legacy?: WorkspacePreferences): {
        projectDocument: (text: string | null, original: string | null) => string | null;
        change: () => TargetChange;
        diagnostics: readonly WorkspaceHookDiagnostic[];
    };
    preferencePath?(local: string): string;
    plugin?(root: string, local: string, settings: TargetChange, input: WorkspaceRegistration): {
        changes: TargetChange[];
        steps: ExternalHookChange[];
        checkSource: () => void;
        registration: WorkspaceRegistrationPlan;
    };
    registrationFiles?(root: string, home: string, local: string): string[];
    registrationPath?(local: string): string;
    inspectProjectRegistration?(input: WorkspaceRegistrationInspection, local: string): WorkspaceRegistrationStatus;
    verifyRegistrationReceipt?(root: string, home: string | undefined, local: string): void;
    path: string;
    empty(): Fields;
    accepts(shell: Fields): boolean;
    groupIndices(list: unknown[], owned: ReadonlySet<number>): number[];
    grouped: boolean;
    slots(event: string, index: number, groups: unknown[]): Slot[];
    matches(a: Fields, b: Fields): boolean;
    append(list: unknown[], entry: HookEntry): void;
    entry(owner: string, event: string, command: string, matcher?: string): HookEntry;
}
export declare function format(target: HookTarget): HookFormat;
