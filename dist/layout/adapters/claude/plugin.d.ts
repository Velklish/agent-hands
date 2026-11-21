import { type TargetChange } from '../../../hooks/hook-journal.js';
import type { ExternalHookChange } from '../../../hooks/hook-operation.js';
import type { WorkspaceRegistration, WorkspaceRegistrationPlan, WorkspaceRegistrationInspection, WorkspaceRegistrationStatus } from '../../../hooks/options.js';
export declare function registrationPath(local: string): string;
export declare function registrationFiles(root: string, home: string, local: string): string[];
export declare function inspectProjectRegistration(input: WorkspaceRegistrationInspection, local: string): WorkspaceRegistrationStatus;
export declare function verifyRegistrationReceipt(root: string, accountHome: string | undefined, local: string): void;
export declare function plugin(root: string, local: string, settings: TargetChange, input: WorkspaceRegistration): {
    changes: {
        file: string;
        before: string | null;
        after: string | null;
    }[];
    steps: ExternalHookChange[];
    checkSource: () => void;
    registration: WorkspaceRegistrationPlan;
};
