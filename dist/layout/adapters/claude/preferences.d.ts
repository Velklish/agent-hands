import { type TargetChange } from '../../../hooks/hook-journal.js';
import type { WorkspaceHookDiagnostic, WorkspacePreferences } from '../../../hooks/options.js';
export declare function preferencePath(local: string): string;
export declare function preferences(local: string, wanted: WorkspacePreferences, legacy?: WorkspacePreferences): {
    projectDocument: (text: string | null, original: string | null) => string | null;
    diagnostics: WorkspaceHookDiagnostic[];
    change: () => TargetChange;
};
