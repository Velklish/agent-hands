import { type TargetChange } from '../../../hooks/hook-journal.js';
import type { WorkspacePreferences } from '../../../hooks/options.js';
export declare function preferencePath(root: string): string;
export declare function preferences(root: string, wanted: WorkspacePreferences, legacy?: WorkspacePreferences): {
    projectDocument: (text: string | null) => string | null;
    change: () => TargetChange;
};
