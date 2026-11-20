import { EXTERNAL_ZONE, REPOS_ZONE } from './layout.js';
export declare const isUrl: (target: unknown) => boolean;
export declare const isDiskPath: (target: unknown) => boolean;
export declare function urlAuthority(url: unknown): string | null;
export declare const urlHost: (url: unknown) => string | null;
export declare const barePath: (url: unknown) => string;
export declare function parseUrl(url: unknown): {
    nsPath: string;
    group: boolean;
};
export declare const httpsRepoUrl: (host: string, namespace: unknown) => string;
export type HostRoute = {
    zone: typeof REPOS_ZONE | typeof EXTERNAL_ZONE;
    gitlab?: boolean;
};
export type RouteHost = (authority: string) => HostRoute | undefined;
export declare class RouteError extends Error {
    readonly code: 'host' | 'empty' | 'owner' | 'unsafe' | 'reserved';
    readonly detail?: string | undefined;
    constructor(code: 'host' | 'empty' | 'owner' | 'unsafe' | 'reserved', detail?: string | undefined);
}
export declare function routeUrl(root: string, url: string, routeHost: RouteHost): {
    nsPath: string;
    group: boolean;
    url: string;
    authority: string;
};
export declare function sameRepositoryUrl(a: string, b: string, routeHost: RouteHost): boolean;
