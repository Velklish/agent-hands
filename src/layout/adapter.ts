import type { AgentDefinition } from './subagents.js';
import type { LayoutFile } from './engine.js';
export type Target = 'claude' | 'cursor' | 'codex' | 'opencode';
export interface McpDocument { path: string; schema?: string; section?: string; key: string; servers: Record<string, unknown> }
export interface LayoutAdapter {
  target: Target; skillsDir: string; agentsDir: string; ext: string; configPath: string;
  renderAgent(agent: AgentDefinition): string;
  renderMcp(servers: Record<string, unknown>): {file: LayoutFile; document?: McpDocument};
}
export function requireMcpSupport(target: Target, issues: { dropped: { name: string; keys: string[] }[]; skipped: string[]; unresolved: { name: string; where: string }[] }) {
  const details = [
    ...issues.dropped.map(issue => `${issue.name}: unsupported fields ${issue.keys.join(', ')}`),
    ...issues.skipped.map(name => `${name}: unsupported transport`),
    ...issues.unresolved.map(issue => `${issue.name}: unresolved placeholder in ${issue.where}`),
  ];
  if (details.length) throw new TypeError(`Unsupported ${target} MCP configuration: ${details.join('; ')}`);
}
