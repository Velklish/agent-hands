export declare function fields(value: unknown, label: string, allowed: string[]): Record<string, unknown>;
type LocalServer = {
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    type?: 'stdio';
};
type RemoteServer = {
    url: string;
    headers?: Readonly<Record<string, string>>;
    http_headers_helper?: string;
    type?: 'http' | 'sse' | 'streamable-http';
};
export type ServerDefinition = (LocalServer | RemoteServer) & {
    required?: boolean;
    tool_timeout_sec?: number;
};
export interface ServerEntry {
    name: string;
    definition: ServerDefinition | Readonly<Record<string, unknown>>;
    source?: string;
    placeholders?: 'native' | 'literal';
}
export declare const serverFields: string[];
export declare function preparedServer(value: unknown): readonly [string, Record<string, unknown>];
export declare function stringList(args: unknown, message: string): string[];
export {};
