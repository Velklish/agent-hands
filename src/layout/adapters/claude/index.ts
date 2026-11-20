import { type AgentDefinition, yamlValue } from '../../subagents.js';
import { mergedMcpPath, type LayoutAdapter } from '../../adapter.js';
import { renderMcpJson } from '../../mcp.js';

const CLAUDE_TOOLS = new Map([
  ['read', 'Read'], ['grep', 'Grep'], ['glob', 'Glob'], ['bash', 'Bash'],
  ['edit', 'Edit'], ['write', 'Write'], ['webfetch', 'WebFetch'], ['websearch', 'WebSearch'],
]);

export function transpileClaude(a: AgentDefinition) {
  const fm = ['---', `name: ${yamlValue(a.name)}`, `description: ${yamlValue(a.description)}`];
  if (Array.isArray(a.tools) && a.tools.length) {
    fm.push(`tools: ${yamlValue(a.tools.map((t) => CLAUDE_TOOLS.get(t.toLowerCase()) ?? t).join(', '))}`);
  }
  if (a.model) fm.push(`model: ${yamlValue(a.model)}`);
  fm.push('---', '', String(a.prompt ?? ''));
  return fm.join('\n');
}


const target = 'claude';
const path = mergedMcpPath.claude;
export const adapter: LayoutAdapter = {
  target, skillsDir: '.claude/skills', agentsDir: '.claude/agents', ext: 'md',
  renderAgent: transpileClaude, configPath: path, preservesServerSettings: true,
  renderMcp(servers) {
    return { file: { path, content: renderMcpJson(servers) }, document: { path, key: 'mcpServers', servers }, empty: !Object.keys(servers).length };
  },
};
