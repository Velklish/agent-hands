import type { AgentDefinition } from './subagents.js';
import type { LayoutFile } from './engine.js';
import { LayoutMcpError, type LayoutDiagnostic, type LayoutMcpPolicy } from './mcp-policy.js';
const targets = ['claude', 'cursor', 'codex', 'opencode'] as const;
export type Target = typeof targets[number];
export const isTarget = (value: unknown): value is Target => targets.some(target => target === value);
// These document paths are also wire identifiers in persisted per-key ownership state.
export const mergedMcpPath = Object.freeze({
  claude: '.mcp.json', cursor: '.cursor/mcp.json', opencode: 'opencode.json',
} satisfies Partial<Record<Target, string>>);

export function isMergedMcpPath(rel: string, target?: Target) {
  return target === undefined ? Object.values(mergedMcpPath).some(path => path === rel)
    : target in mergedMcpPath && mergedMcpPath[target as keyof typeof mergedMcpPath] === rel;
}
export interface McpDocument { path: string; schema?: string; section?: string; key: string; servers: Record<string, unknown> }
export interface McpRendering {file: LayoutFile; document?: McpDocument; legacyHashes?: Record<string,string>; empty: boolean}
export interface McpContext {
  policy: LayoutMcpPolicy;
  literal: ReadonlySet<string>;
  watchSource(check: () => void): void;
  report(diagnostic: Omit<LayoutDiagnostic,'path'|'target'> & {path?: string}, summary: string, fatal?: boolean): void;
}
export interface LayoutAdapter {
  target: Target; skillsDir: string; agentsDir: string; ext: string; configPath: string;
  preservesServerSettings?: boolean;
  reportsInvalidTimeout?: boolean;
  acceptsMcpReference?: boolean;
  renderAgent(agent: AgentDefinition): string;
  renderMcp(servers: Record<string, unknown>, context: McpContext): McpRendering;
  agentResets?(names: readonly string[]): McpDocument & {entry:unknown};
}

export function reportMcpIssues(context: McpContext, issues: {
  dropped: { name: string; keys: string[] }[]; skipped: string[]; unresolved: { name: string; where: string; why?: string }[];
}) {
  for (const {name, keys} of issues.dropped) context.report({code:'unsupported-fields',server:name,keys}, `${name}: unsupported fields ${keys.join(', ')}`);
  for (const name of issues.skipped) context.report({code:'unsupported-transport',server:name}, `${name}: unsupported transport`);
  for (const {name,where,why} of issues.unresolved) context.report({code:'unresolved-placeholder',server:name,field:where,reason:why}, `${name}: unresolved placeholder in ${where}`);
}

export function mcpReporter(adapter: LayoutAdapter, policy: LayoutMcpPolicy, diagnostics: LayoutDiagnostic[]): McpContext['report'] {
  return (issue, summary, fatal = false) => {
    const diagnostic = {path:adapter.configPath,target:adapter.target,...issue};
    if (fatal || policy.compatibility !== 'report') throw new LayoutMcpError(`Unsupported ${adapter.target} MCP configuration: ${summary}`, diagnostic);
    diagnostics.push(diagnostic);
  };
}
