export declare const envPattern: () => RegExp;
export declare const environmentNames: (value: unknown) => string[];
export declare function substituteValues(value: unknown, values: Record<string, unknown>): any;
export declare function resolveEnvironment(value: unknown, env: Readonly<Record<string, string>>): unknown;
export declare function valueEnvironmentNames(value: unknown): string[];
export declare const sameServerConfig: (a: unknown, b: unknown) => boolean;
export declare const serverHash: (value: unknown) => string;
export declare function object(value: unknown): value is Record<string, unknown>;
export declare function readServerMap(file: string, invalid?: (f: string) => string, shape?: (f: string) => string): Record<string, unknown>;
export interface ServerSource {
    label: string;
    file: string;
    provenance?: string | null;
    prepare?: (definition: unknown) => unknown;
}
export declare function collectServers(sources: ServerSource[], { read, reject, conflict, external, excludedVariables, }?: {
    read?: typeof readServerMap;
    reject?: (message: string) => void;
    conflict?: (name: string, previous: string, next: string) => string;
    external?: (definition: unknown) => boolean;
    excludedVariables?: ReadonlySet<string>;
}): {
    servers: {
        [k: string]: unknown;
    };
    externalServers: {
        [k: string]: unknown;
    };
    requiredVars: string[];
    serverOwner: {
        [k: string]: string | null;
    };
};
export declare const renderMcpJson: (servers: unknown) => string;
export declare function mergeMcpServers(document: Record<string, unknown>, definitions: Record<string, unknown>, previous: readonly string[], { adoptIdentical, key }?: {
    adoptIdentical?: boolean | undefined;
    key?: string | undefined;
}): {
    document: {
        [x: string]: unknown;
    };
    servers: Record<string, unknown>;
    owned: string[];
    kept: string[];
};
export declare function writeToolRecord(value: unknown): value is {
    source: string;
    write: string[];
};
export declare const writeToolKey: (names: string[]) => string;
