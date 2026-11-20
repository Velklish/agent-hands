export declare function renderOpencodeConfig(servers: Record<string, unknown> | null | undefined, { expandEnv }?: {
    expandEnv?: boolean | undefined;
}): {
    text: string;
    document: {
        $schema: string;
        mcp: {
            servers: Record<string, unknown>;
        };
    };
    dropped: {
        name: string;
        keys: string[];
    }[];
    skipped: string[];
    unresolved: {
        name: string;
        where: string;
        why: string;
    }[];
    invalidTimeouts: string[];
};
