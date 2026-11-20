export declare function ruleFiles(files: readonly string[], { optional }?: {
    optional?: boolean | undefined;
}): string[];
export declare function readRules(files: readonly string[]): {
    file: string;
    content: string;
}[];
