import { type TargetChange } from '../../../hooks/hook-journal.js';
import type { WorkspaceHookDiagnostic, WorkspacePreferences } from '../../../hooks/options.js';
export declare function preferencePath(root: string): string;
export declare function preferences(root: string, wanted: WorkspacePreferences, legacy?: WorkspacePreferences): {
    projectDocument: (text: string | null, original: string | null) => string | null;
    diagnostics: WorkspaceHookDiagnostic[];
    change: () => TargetChange;
};
