import type { Artifacts } from './writer.js';
interface LayoutEntry {
    rel: string;
    newHash: string;
    mode?: number | null;
    buf: Buffer | string;
}
type Reason = 'broken-link' | 'outside-store' | 'not-directory' | 'foreign-files' | 'modified-artifact' | 'foreign-artifact-files';
interface Store {
    root: string;
    artifacts: string;
    renderer: unknown;
    nestedLinks?: ReadonlySet<string>;
    reject: (reason: Reason, location: string, files?: string[]) => never;
}
export declare function artifactLayout(groups: readonly string[], store: Omit<Store, 'reject'> & {
    reject?: Store['reject'];
}): Artifacts & {
    prepare(group: string, entries: readonly LayoutEntry[]): string | null;
};
export declare const artifactGroup: (groups: readonly string[], rel: string) => string | null;
export {};
