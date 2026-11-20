import type { AgentDefinition } from './subagents.js';
import type { LayoutFile } from './engine.js';
import { type LayoutDiagnostic, type LayoutMcpPolicy } from './mcp-policy.js';
declare const targets: readonly ["claude", "cursor", "codex", "opencode"];
export type Target = typeof targets[number];
export declare const isTarget: (value: unknown) => value is Target;
export declare const mergedMcpPath: Readonly<{
    claude: string;
    cursor: string;
    opencode: string;
}>;
export declare function isMergedMcpPath(rel: string, target?: Target): boolean;
export interface McpDocument {
    path: string;
    schema?: string;
    section?: string;
    key: string;
    servers: Record<string, unknown>;
}
export interface McpRendering {
    file: LayoutFile;
    document?: McpDocument;
    legacyHashes?: Record<string, string>;
    empty: boolean;
}
export interface McpContext {
    policy: LayoutMcpPolicy;
    literal: ReadonlySet<string>;
    report(diagnostic: Omit<LayoutDiagnostic, 'path' | 'target'> & {
        path?: string;
    }, summary: string, fatal?: boolean): void;
}
export interface LayoutAdapter {
    target: Target;
    skillsDir: string;
    agentsDir: string;
    ext: string;
    configPath: string;
    preservesServerSettings?: boolean;
    acceptsMcpReference?: boolean;
    renderAgent(agent: AgentDefinition): string;
    renderMcp(servers: Record<string, unknown>, context: McpContext): McpRendering;
    agentResets?(names: readonly string[]): McpDocument;
}
export declare function reportMcpIssues(context: McpContext, issues: {
    dropped: {
        name: string;
        keys: string[];
    }[];
    skipped: string[];
    unresolved: {
        name: string;
        where: string;
        why?: string;
    }[];
}): void;
export declare function mcpReporter(adapter: LayoutAdapter, policy: LayoutMcpPolicy, diagnostics: LayoutDiagnostic[]): McpContext['report'];
export {};
