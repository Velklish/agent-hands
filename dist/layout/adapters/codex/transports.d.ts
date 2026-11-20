export type CodexTransport = 'http' | 'stdio' | null;
export declare function codexServerTransports(text: string): Map<string, CodexTransport>;
export declare function readCodexServerTransports(file: string): Map<string, CodexTransport>;
