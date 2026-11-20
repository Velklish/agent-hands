export type HookOutcome = {
    owner: string;
    event: string;
    ok: true;
    exitStatus: 0;
} | {
    owner: string;
    event: string;
    ok: false;
    exitStatus: number | null;
};
/** Normalize the status of one invocation already completed by the host. */
export declare function workspaceHookOutcome(owner: string, event: string, exitStatus: number | null): HookOutcome;
