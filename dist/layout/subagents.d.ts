export type AgentField = string | string[];
export type AgentDefinition = Record<string, AgentField | undefined>;
export type AgentSource = {
    dirAbs: string;
    source: string;
};
export declare function collectSubagents(sources: AgentSource[], { missing, duplicate, invalidLine, }?: {
    missing?: (file: string, key: string) => string;
    duplicate?: (name: AgentField | undefined, previous: string, source: string) => string;
    invalidLine?: (file: string, line: string) => string;
}): (AgentDefinition & {
    source: string;
    file: string;
})[];
export declare function parseAgentYaml(text: string, file: string, invalid?: (f: string, line: string) => string): AgentDefinition;
export declare function yamlValue(raw: unknown): string;
export declare function readOnlyAgent(a: AgentDefinition): boolean | 0;
