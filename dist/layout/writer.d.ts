import { writeAtomic } from './fs.js';
export interface Ownership {
    files: Record<string, unknown>;
}
export interface Staged {
    rel: string;
    abs: string;
    buf: Buffer;
    newHash: string;
    oldHash: unknown;
    diskHash: string | null;
    mode: number | null;
}
interface AtomicOutputs {
    paths: ReadonlySet<string>;
    stagingDir?: string;
    restoreOriginalMode?: boolean;
}
type CopyOptions = {
    origin?: string | null;
    regularOnly?: boolean;
    skipped?: (file: CopyEntry & {
        symbolic: boolean;
    }) => void;
};
export interface CopyEntry {
    src: string;
    rel: string;
    origin: string | null;
}
type Outside = {
    rel: string;
    origin: string | null;
};
type Collision = {
    rel: string;
    a: string | null;
    b: string | null;
};
export interface WriterMessages {
    edited(rel: string, operation: 'write' | 'prune'): string;
    outside(paths: Outside[]): string;
    collision(paths: Collision[]): string;
    conflict(paths: string[]): string;
    nested(file: string, source: string | null, child: string, other?: string | null): string;
}
export interface Change {
    rollback(): void;
    finalize(): void;
}
export interface ArtifactChange extends Change {
    links: {
        rel: string;
        target: string | null | undefined;
    }[];
}
export interface Artifacts {
    group(rel: string): string | null;
    commit(root: string, staged: Staged[], old: Ownership): ArtifactChange;
}
export interface TransactionOptions {
    atomic?: AtomicOutputs;
    commitBindings?: () => Change;
}
export declare function copyEntries(srcAbs: string, destRel: string, options?: CopyOptions): Generator<CopyEntry>;
export declare class Writer {
    #private;
    readonly replacedFiles: Set<string>;
    readonly replacedDirs: Set<string>;
    readonly released: Set<string>;
    private createdDirs;
    private stagedParents;
    root: string;
    adopt: boolean;
    old: Ownership;
    staged: Staged[];
    conflicts: string[];
    collisions: Collision[];
    outside: Outside[];
    stagedRel: Map<string, {
        hash: string;
        origin: string | null;
    }>;
    files: Record<string, string>;
    written: string[];
    updated: string[];
    overwrittenEdits: string[];
    adopted: string[];
    execFiles: Set<string>;
    commitBindings?: () => Change;
    deferred?: boolean;
    sources?: Change;
    layout?: ArtifactChange;
    links?: ArtifactChange['links'];
    constructor(root: string, ownership: Ownership, { adopt, protectEdits, artifacts, text, reject, atomicWrite, }?: {
        adopt?: boolean;
        protectEdits?: boolean;
        artifacts?: Artifacts;
        text?: WriterMessages;
        reject?: (message: string) => never;
        atomicWrite?: typeof writeAtomic;
    });
    stage(relPath: string, content: string | Uint8Array, { origin, adopt, mode, conflictHint }?: {
        origin?: string | null;
        adopt?: boolean;
        mode?: number | null;
        conflictHint?: string | null;
    }): void;
    copyDir(srcAbs: string, destRel: string, options?: CopyOptions): void;
    copyFile({ src, rel, origin }: CopyEntry): void;
    transaction<T>(extraPaths: string[], apply: () => Promise<T>, { commitBindings, atomic }?: TransactionOptions): Promise<T>;
    commit(beforeWrites?: () => void, atomic?: AtomicOutputs): void;
    apply(beforeWrites?: () => void, atomic?: AtomicOutputs): string[];
    prune(): string[];
}
export {};
