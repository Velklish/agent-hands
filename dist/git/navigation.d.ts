import { type RouteHost } from './address.js';
import { type Candidate } from './fuzzy.js';
import { discoverRoot, WORKSPACE_DIRS } from './layout.js';
import { gitClone } from './process.js';
export { discoverRoot, WORKSPACE_DIRS };
export type { RouteHost };
export declare function ensureWorkspaceDirs(root: string): void;
export declare class NavigationError extends Error {
    readonly candidates: Candidate[];
    constructor(message: string, candidates?: Candidate[]);
}
export declare function probeDisk(root: string, target: string, cwd?: string): {
    abs: string;
    nsPath: string | null;
    exists: boolean;
    reserved: boolean;
};
export declare function enclosingZone(root: string, abs: string, top: string | null): "external" | "repos" | "sandbox" | null;
export declare function isEnclosingRepo(root: string, abs: string, top: string | null): boolean;
export declare class OriginError extends NavigationError {
    readonly reason: 'unreadable' | 'ambiguous' | 'mismatch';
    constructor(reason: 'unreadable' | 'ambiguous' | 'mismatch', abs: string);
}
export declare function checkOrigin(abs: string, url: string, routeHost: RouteHost, { allowMissing }?: {
    allowMissing?: boolean | undefined;
}): void;
interface RemoteCandidate extends Candidate {
    url: string;
}
export interface NavigationOptions {
    root?: string;
    cwd?: string;
    routeHost: RouteHost;
    search?: (name: string) => Promise<RemoteCandidate[] | null>;
    namespaceUrl?: (namespace: string) => string;
}
export declare function createNavigation({ root: explicitRoot, cwd, routeHost, search, namespaceUrl }: NavigationOptions): {
    resolve: (target: string) => Promise<{
        source: "url";
        abs: string;
        nsPath: string;
        group: boolean;
        url: string;
        authority: string;
    } | {
        nsPath: string;
        source: "namespace" | "disk";
        abs: string;
        url: undefined;
    } | {
        note: string;
        nsPath: string;
        source: "namespace" | "disk";
        abs: string;
        url: undefined;
    } | {
        kind: string;
        nsPath: string;
        source: "namespace" | "disk";
        abs: string;
        url: undefined;
    } | {
        kind: string;
        source: "url";
        abs: string;
        nsPath: string;
        group: boolean;
        url: string;
        authority: string;
    }>;
    clone: (target: string, options?: Parameters<typeof gitClone>[2]) => Promise<{
        abs: string;
        cloned: boolean;
    }>;
    repoPath: (target: string, { clone: cloneMissing, fresh }?: {
        clone?: boolean | undefined;
        fresh?: boolean | undefined;
    }) => Promise<{
        abs: string;
        state: import("./fresh.js").FreshResult<import("./fresh.js").FreshWarning> | null;
    }>;
    fresh: (target?: string) => Promise<{
        abs: string;
        state: import("./fresh.js").FreshResult<import("./fresh.js").FreshWarning>;
    }>;
    scan: () => Promise<import("./state.js").ZoneState[]>;
};
export declare const REPOSITORY_HELP = "clone <name|namespace|URL> | path <name|path|URL> [--clone] [--fresh] | fresh [name|path] | zone";
export declare function runRepositoryCommand(options: NavigationOptions, command: 'clone' | 'path' | 'fresh' | 'zone', { target, clone, fresh }?: {
    target?: string;
    clone?: boolean;
    fresh?: boolean;
}, io?: {
    out: (text: string) => void;
    err: (text: string) => void;
}): Promise<0 | 1>;
