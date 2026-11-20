export declare const isRecord: (value: unknown) => value is Record<string, unknown>;
export declare function projectNamespace(value: unknown): string | null;
export type GitLabProblem = {
    code: 'host' | 'path' | 'json' | 'page-items' | 'next-page';
} | {
    code: 'http';
    status: number;
} | {
    code: 'network';
    timeout: boolean;
    detail: string;
};
export declare class GitLabError extends Error {
    readonly problem: GitLabProblem;
    constructor(message: string, problem: GitLabProblem);
    get status(): number | undefined;
}
export declare function gitLabClient(host: string, { token, timeoutMs, request }?: {
    token?: string | null;
    timeoutMs?: number;
    request?: typeof fetch;
}): {
    api: (pathname: string, { soft }?: {
        soft?: boolean | undefined;
    }) => Promise<{
        json: unknown;
        headers: Headers;
    } | null>;
    apiPaged: (pathname: string, { soft }?: {
        soft?: boolean | undefined;
    }) => Promise<unknown[] | null>;
};
