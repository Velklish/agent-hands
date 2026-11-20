type ObjectValue = Record<string, unknown>;
export type HookTarget = 'claude' | 'codex' | 'cursor';
export type HookEntry = {
    owner: string;
    event: string;
    shell: ObjectValue;
    callback: ObjectValue & {
        command: string;
    };
};
export type HookHistory = {
    kind: 'confirmed';
    entries: HookEntry[];
} | {
    kind: 'legacy' | 'unfinished';
};
export type HookInput = {
    target: HookTarget;
    documentJson: string | null;
    historyJson: string | null;
    intentsJson: string;
};
type Reason = 'invalid-document' | 'invalid-input' | 'invalid-intents' | 'corrupt-history' | 'legacy' | 'unfinished' | 'missing' | 'ambiguous' | 'collision';
type Location = {
    eventIndex: number;
    groupIndex: number | null;
    callbackIndex: number;
};
type Action = {
    kind: 'keep' | 'replace' | 'remove' | 'add';
    index: number;
    location?: Location;
};
export type HookPlan = {
    ok: false;
    reason: Reason;
    index?: number;
} | {
    ok: true;
    document: ObjectValue | null;
    next: HookEntry[];
    actions: Action[];
    shifted: boolean;
};
export type Slot = {
    event: string;
    shell: ObjectValue;
    value: unknown;
    list: unknown[];
    location: Location;
};
export declare function planHooks(input: HookInput): HookPlan;
export declare function planHooksFromUnknown(input: unknown): HookPlan;
export {};
