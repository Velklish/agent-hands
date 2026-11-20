import { type TargetChange } from '../../../hooks/hook-journal.js';
import type { ExternalHookChange } from '../../../hooks/hook-operation.js';
import type { WorkspaceRegistration } from '../../../hooks/options.js';
export declare function registrationFiles(root: string, home: string): string[];
export declare function plugin(root: string, settings: TargetChange, input: WorkspaceRegistration): {
    changes: {
        file: string;
        before: string | null;
        after: string | null;
    }[];
    steps: ExternalHookChange[];
};
