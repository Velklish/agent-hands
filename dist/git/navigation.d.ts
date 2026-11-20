import { type RouteHost } from './address.js';
import { type Candidate } from './fuzzy.js';
import { discoverRoot, WORKSPACE_DIRS } from './layout.js';
import { gitClone } from './process.js';
export { discoverRoot, WORKSPACE_DIRS };
export type { RouteHost };
export declare function ensureWorkspaceDirs(root: string): void;
export type NavigationProblem = {
    code: 'empty' | 'search-disabled' | 'search-unavailable' | 'not-found' | 'other';
} | {
    code: 'ambiguous';
    source: 'local' | 'remote';
} | {
    code: 'reserved' | 'outside-zones' | 'unsafe-namespace' | 'not-checkout';
    abs: string;
    exists: boolean;
} | {
    code: 'enclosing-repo';
    abs: string;
    top: string;
    zone: typeof WORKSPACE_DIRS[number];
};
export declare class NavigationError extends Error {
    readonly candidates: Candidate[];
    readonly problem: NavigationProblem;
    constructor(message: string, candidates?: Candidate[], problem?: NavigationProblem);
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
    readonly reason: 'unreadable' | 'ambiguous' | 'missing' | 'mismatch';
    readonly abs: string;
    constructor(reason: 'unreadable' | 'ambiguous' | 'missing' | 'mismatch', abs: string);
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
    personal?: (namespace: string) => boolean;
    onCollision?: (absolutePath: string) => void;
}
export type RepositoryResolution = {
    nsPath: string;
    abs: string;
    kind?: string;
} & ({
    source: 'url' | 'remote';
    url: string;
    group: boolean;
    authority: string;
} | {
    source: 'disk' | 'namespace';
    url?: undefined;
    group?: undefined;
    disk?: ReturnType<typeof probeDisk>;
    note?: string;
});
export type CheckoutLocation = {
    abs: string;
};
export declare function createNavigation({ root: explicitRoot, cwd, routeHost, search, namespaceUrl, personal, onCollision }: NavigationOptions): {
    resolve: (target: string, { allowGroup }?: {
        allowGroup?: boolean | undefined;
    }) => Promise<RepositoryResolution>;
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
        state: import("./fresh.js").FreshResult<import("./fresh.js").FreshWarning>;
        abs: string;
    }>;
    locateCheckout: (target?: string) => CheckoutLocation;
    verifyOrigin: (abs: string, url: string, options?: Parameters<typeof checkOrigin>[3]) => void;
    scan: (namespaces?: readonly string[]) => Promise<import("./state.js").ZoneState[]>;
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
