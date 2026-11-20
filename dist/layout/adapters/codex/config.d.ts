import type { CodexTransport } from './transports.js';
export declare function renderCodexConfig(servers: Record<string, unknown>, { expandEnv: expandAll, literal, header }?: {
    expandEnv?: boolean | undefined;
    literal?: ReadonlySet<string> | undefined;
    header?: string | undefined;
}): {
    text: string;
    dropped: {
        name: string;
        keys: string[];
    }[];
    skipped: string[];
    unresolved: {
        name: string;
        where: string;
        why: "url" | "embedded" | "command" | "argument" | "renamed";
        variable?: string;
    }[];
    empty: boolean;
};
export declare function codexTransportConflicts(servers: Record<string, unknown> | null | undefined, userServers?: ReadonlyMap<string, CodexTransport> | null): {
    name: string;
    ours: "http" | "stdio";
    theirs: "http" | "stdio";
}[];
