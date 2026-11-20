export declare const sha256: (bytes: string | Uint8Array) => string;
export declare const toPosix: (file: string) => string;
export declare const isInnerRelPath: (file: unknown) => file is string;
export declare function writeAtomic(file: string, bytes: string | NodeJS.ArrayBufferView, { mode, stagingDir }?: {
    mode?: number | null;
    stagingDir?: string;
}): void;
export declare function directoryLink(target: string, destination: string): void;
export declare function removeEntry(file: string): void;
export declare function switchDirectoryBinding(destination: string, target: string | null, { hadOld, immediate }: {
    hadOld: boolean;
    immediate?: boolean;
}): {
    rollback(): void;
    finalize(): void;
};
export declare function isInside(root: string, file: string): boolean;
export declare function sealSnapshot(dir: string): void;
export declare function removeTemporarySnapshot(dir: string): void;
