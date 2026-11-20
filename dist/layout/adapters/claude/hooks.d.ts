import { preferences, preferencePath } from './preferences.js';
import { plugin, registrationFiles } from './plugin.js';
export declare const hooks: {
    path: string;
    preferences: typeof preferences;
    preferencePath: typeof preferencePath;
    plugin: typeof plugin;
    registrationFiles: typeof registrationFiles;
    matches: (a: import("../../../hooks/format.js").Fields, b: import("../../../hooks/format.js").Fields) => boolean;
    append: (list: unknown[], entry: import("../../../hooks/hook-plan.js").HookEntry) => void;
    empty: () => import("../../../hooks/format.js").Fields;
    entry: (owner: string, event: string, command: string, matcher?: string) => import("../../../hooks/hook-plan.js").HookEntry;
    accepts: (shell: import("../../../hooks/format.js").Fields) => boolean;
    groupIndices: (list: unknown[], owned: ReadonlySet<number>) => number[];
    grouped: boolean;
    slots: (event: string, index: number, groups: unknown[]) => import("../../../hooks/hook-plan.js").Slot[];
};
