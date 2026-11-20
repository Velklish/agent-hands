export declare const hooks: {
    path: string;
    matches: (a: import("../../../hooks/format.js").Fields, b: import("../../../hooks/format.js").Fields) => boolean;
    append: (list: unknown[], entry: import("../../../hooks/hook-plan.js").HookEntry) => void;
    empty: () => import("../../../hooks/format.js").Fields;
    entry: (owner: string, event: string, command: string, matcher?: string) => import("../../../hooks/hook-plan.js").HookEntry;
    preferences?: ((root: string, wanted: import("../../../index.js").WorkspacePreferences, legacy?: import("../../../index.js").WorkspacePreferences) => {
        projectDocument: (text: string | null, original: string | null) => string | null;
        change: () => import("../../../hooks/hook-journal.js").TargetChange;
    }) | undefined;
    preferencePath?: ((root: string) => string) | undefined;
    plugin?: ((root: string, settings: import("../../../hooks/hook-journal.js").TargetChange, input: import("../../../index.js").WorkspaceRegistration) => {
        changes: import("../../../hooks/hook-journal.js").TargetChange[];
        steps: import("../../../hooks/hook-operation.js").ExternalHookChange[];
        checkSource: () => void;
        registration: import("../../../index.js").WorkspaceRegistrationPlan;
    }) | undefined;
    registrationFiles?: ((root: string, home: string) => string[]) | undefined;
    registrationPath?: ((root: string) => string) | undefined;
    accepts: (shell: import("../../../hooks/format.js").Fields) => boolean;
    groupIndices: (list: unknown[], owned: ReadonlySet<number>) => number[];
    grouped: boolean;
    slots: (event: string, index: number, groups: unknown[]) => import("../../../hooks/hook-plan.js").Slot[];
};
