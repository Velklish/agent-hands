import type { AgentDefinition } from './subagents.js';
import type { LayoutFile } from './engine.js';
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
