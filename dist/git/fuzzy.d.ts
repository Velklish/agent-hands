export declare function normalize(name: unknown): string;
export declare function tokens(name: unknown): string[];
export declare function score(hint: unknown, repoName: unknown, slug?: string): {
    value: number;
    kind: string;
};
export declare function gitRemote(repoAbs: string): string;
export declare function remoteSlug(remote: string): string;
export declare function topScored<T extends {
    value: number;
    nsPath: string;
}>(scored: T[]): T[];
export declare function findRepo(root: string, hint: unknown, { personal, onCollision }?: {
    personal?: ((_ns: string) => boolean) | undefined;
    onCollision?: ((_abs: string) => void) | undefined;
}): {
    readonly status: "NOTFOUND";
    readonly nsPath?: undefined;
    readonly kind?: undefined;
    readonly candidates?: undefined;
} | {
    readonly status: "RESOLVED";
    readonly nsPath: string;
    readonly kind: string;
    readonly candidates?: undefined;
} | {
    readonly status: "AMBIGUOUS";
    readonly candidates: {
        nsPath: string;
        kind: string;
        personal: boolean;
    }[];
    readonly nsPath?: undefined;
    readonly kind?: undefined;
};
export interface Candidate {
    nsPath: string;
    kind: string;
    personal?: boolean;
}
export declare function pickProjects(name: unknown, found: unknown[]): Candidate[];
