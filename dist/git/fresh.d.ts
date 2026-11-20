import type { SpawnSyncReturns } from 'node:child_process';
import { type GitAuth } from './process.js';
type Issue = {
    timeoutMs: number;
} | {
    detail: string;
};
export type FreshWarning = {
    code: 'not-repo';
    repoAbs: string;
} | {
    code: 'no-origin' | 'unknown-default';
} | {
    code: 'fetch';
    issue: Issue;
} | {
    code: 'missing-local';
    branch: string;
    fetchOk: boolean;
} | {
    code: 'unknown-divergence';
    branch: string;
} | {
    code: 'blocked';
    branch: string;
    behind: number;
    ahead: number;
    tree: 'clean' | 'dirty' | 'unknown';
} | {
    code: 'update';
    branch: string;
    behind: number;
    issue: Issue;
};
export interface FreshResult<W = FreshWarning> {
    branch: string | null;
    checkout: string | null;
    behind: number | null;
    ahead: number | null;
    headBehindDefault: number | null;
    checkoutBehind: number | null;
    checkoutAhead: number | null;
    dirty: boolean | null;
    updated: boolean;
    fetchOk: boolean;
    warnings: W[];
}
export declare const DEFAULT_BRANCH_FALLBACK: string[];
export declare function branchOfOriginRef(ref: string): string;
export declare function defaultBranch(repoAbs: string, run?: (...args: string[]) => SpawnSyncReturns<string>): string | null;
export declare function freshenRepo(repoAbs: string, { timeoutMs, observeOnly, deadline, auth }?: {
    timeoutMs?: number;
    observeOnly?: boolean;
    deadline?: number;
    auth?: GitAuth | (() => GitAuth);
}): FreshResult<FreshWarning>;
export {};
