export declare const REPOS_ZONE = "repos";
export declare const EXTERNAL_ZONE = "external";
export declare const SANDBOX_ZONE = "sandbox";
export declare const ZONES: readonly ["repos", "external"];
export declare const WORKSPACE_DIRS: readonly ["repos", "external", "sandbox"];
export declare const SKIP_DIRS: Set<string>;
export declare const isDirectory: (dir: string) => boolean;
export declare function discoverRoot({ root, cwd }?: {
    root?: string;
    cwd?: string;
}): string | null;
export declare function relativeInside(root: string, abs: string): string | null;
export declare function zoneRoots(root: string): string[];
export declare function collidesWithZoneName(segments: string[]): boolean;
export declare function isCloneDir(abs: string): boolean;
export declare function zoneOfNs(nsPath: unknown): "repos" | "external";
export declare function nsSegments(nsPath: unknown): string[];
export declare function zoneRootAt(root: string, abs: string): "external" | "repos" | null;
export declare function underTakenZoneName(root: string, abs: string): boolean;
export declare function nsUnderZone(root: string, abs: string): string | null;
export declare function normalizeNs(root: string, nsPath: unknown): string | null;
export declare function repoAbsPath(root: string, nsPath: unknown): string;
export declare function cloneOf(root: string, abs: string): {
    abs: string;
    nsPath: string;
} | null;
export declare function listClonedRepos(root: string, onCollision?: (_abs: string) => void): {
    nsPath: string;
    abs: string;
}[];
