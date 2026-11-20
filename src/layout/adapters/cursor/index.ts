import { type AgentDefinition, readOnlyAgent, yamlValue } from '../../subagents.js';
import { mergedMcpPath, type LayoutAdapter } from '../../adapter.js';
import { renderMcpJson } from '../../mcp.js';

export function transpileCursor(a: AgentDefinition) {
  const fm = ['---', `name: ${yamlValue(a.name)}`, `description: ${yamlValue(a.description)}`];
  if (a.model) fm.push(`model: ${yamlValue(a.model)}`);
  if (readOnlyAgent(a)) fm.push('readonly: true');
  fm.push('---', '', String(a.prompt ?? ''));
  return fm.join('\n');
}


const target = 'cursor';
const path = mergedMcpPath.cursor;
export const adapter: LayoutAdapter = {
  target, skillsDir: '.cursor/skills', agentsDir: '.cursor/agents', ext: 'md',
  renderAgent: transpileCursor, configPath: path,
  renderMcp(servers) {
    return { file: { path, content: renderMcpJson(servers) }, document: { path, key: 'mcpServers', servers } };
  },
};
