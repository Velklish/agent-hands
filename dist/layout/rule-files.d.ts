export type LayoutRule = string | {
    path: string;
    optional?: boolean;
};
export declare function selectRuleEntries(entries: readonly unknown[]): {
    file: string;
}[];
export declare function ruleFiles(files: readonly string[], { optional }?: {
    optional?: boolean | undefined;
}): string[];
export declare function readRule(file: string): NonSharedBuffer;
