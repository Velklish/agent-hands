export declare const GIT_NET_TIMEOUT_MS = 30000;
export declare const GIT_LOCAL_TIMEOUT_MS = 5000;
export declare const GIT_CLONE_TIMEOUT_MS = 300000;
export declare const GIT_MAX_OUTPUT: number;
export interface GitAuth {
    args: string[];
    env: NodeJS.ProcessEnv;
    secret?: string | null;
}
export type ProcessResult = {
    error?: NodeJS.ErrnoException;
    signal?: NodeJS.Signals | null;
    status?: number | null;
    stderr?: string | Buffer | null;
};
type GitResult = {
    ok: true;
} | {
    ok: false;
    err: string;
    reason: 'timeout' | 'occupied' | 'git';
    previous?: string;
};
interface Options {
    auth?: GitAuth;
    timeoutMs?: number;
}
export declare function gitRun(args: string[], { auth, timeoutMs, inherit }?: Options & {
    inherit?: boolean;
}): import("node:child_process").SpawnSyncReturns<string>;
export declare const gitOutput: (r: {
    status: number | null;
    stdout?: string | null;
}) => string | null;
export declare const timedOut: (r: ProcessResult | null | undefined) => boolean;
export declare function gitError(r: ProcessResult, auth?: GitAuth, full?: boolean): string;
export declare function gitToplevel(dir: string): string | null;
export declare function repoHead(dir: string): string | null;
export declare function fetchTarget(dir: string): string;
export declare function gitLsRemoteTags(url: string, options?: Options): string[] | null;
export declare function gitClone(url: string, dest: string, { auth, branch, depth, timeoutMs }?: Options & {
    branch?: string;
    depth?: number;
}): GitResult;
export declare function gitCloneSha(url: string, dest: string, sha: string, { auth, timeoutMs }?: Options): GitResult;
export declare function gitFetch(dir: string, target: string, refs: string[], options?: Options & {
    flags?: string[];
}): import("node:child_process").SpawnSyncReturns<string>;
export type RefFetchResult = {
    ok: true;
} | {
    ok: false;
    status: number | null;
    timedOut: boolean;
    detail: string;
};
export declare function fetchRepositoryRef(dir: string, ref: string, { depth, ...options }?: Options & {
    depth?: number;
}): RefFetchResult;
export {};
