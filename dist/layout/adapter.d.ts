import type { AgentDefinition } from './subagents.js';
import type { LayoutFile } from './engine.js';
declare const targets: readonly ["claude", "cursor", "codex", "opencode"];
export type Target = typeof targets[number];
export declare const isTarget: (value: unknown) => value is Target;
export interface McpDocument {
    path: string;
    schema?: string;
    section?: string;
    key: string;
    servers: Record<string, unknown>;
}
export interface LayoutAdapter {
    target: Target;
    skillsDir: string;
    agentsDir: string;
    ext: string;
    configPath: string;
    renderAgent(agent: AgentDefinition): string;
    renderMcp(servers: Record<string, unknown>): {
        file: LayoutFile;
        document?: McpDocument;
    };
}
export declare function requireMcpSupport(target: Target, issues: {
    dropped: {
        name: string;
        keys: string[];
    }[];
    skipped: string[];
    unresolved: {
        name: string;
        where: string;
    }[];
}): void;
export {};
