export interface RuntimeTarget {
    readonly node: string;
    readonly entrypoint: string;
}
export interface EntrypointOptions {
    readonly replaceProcess?: boolean;
}
export declare function parseRuntimeTarget(value: unknown): RuntimeTarget;
export declare function entrypointArgv(target: RuntimeTarget, args: readonly string[]): [entrypoint: string, ...args: string[]];
export declare function supportsNode(version: string, minimumMajor: number): boolean;
export declare function enterEntrypoint(target: RuntimeTarget, args: readonly string[], options?: EntrypointOptions): Promise<boolean>;
