import { type AgentDefinition, type AgentField, readOnlyAgent, yamlValue } from '../../subagents.js';
import { type LayoutAdapter, requireMcpSupport } from '../../adapter.js';
import { object, renderMcpJson } from '../../mcp.js';

export function transpileCursor(a: AgentDefinition) {
  const fm: (AgentField | undefined)[] = ['---', `name: ${a.name}`, `description: ${yamlValue(a.description)}`];
  if (a.model) fm.push(`model: ${a.model}`);
  if (readOnlyAgent(a)) fm.push('readonly: true');
  fm.push('---', '', a.prompt);
  return fm.join('\n');
}


const target = 'cursor';
const path = '.cursor/mcp.json';
export const adapter: LayoutAdapter = {
  target, skillsDir: '.cursor/skills', agentsDir: '.cursor/agents', ext: 'md',
  renderAgent: transpileCursor, configPath: path,
  renderMcp(servers) {
    return { file: { path, content: renderMcpJson(servers) }, document: { path, key: 'mcpServers', servers } };
  },
};
