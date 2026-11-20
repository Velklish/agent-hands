import { type AgentDefinition, type AgentField, readOnlyAgent, yamlValue } from '../../subagents.js';
import { type LayoutAdapter, requireMcpSupport } from '../../adapter.js';
import { object, renderMcpJson } from '../../mcp.js';
import { renderOpencodeConfig } from './config.js';

export function transpileOpencode(a: AgentDefinition) {
  const fm: (AgentField | undefined)[] = ['---', `description: ${yamlValue(a.description)}`, 'mode: subagent'];
  if (a.model) fm.push(`model: ${a.model}`);
  if (readOnlyAgent(a)) {
    fm.push('permissions:');
    fm.push('  - { action: "*", resource: "*", effect: deny }');
    const tools = new Set((a.tools as string[]).map((t) => t.toLowerCase()));
    for (const tool of tools) {
      fm.push(`  - { action: ${tool}, resource: "*", effect: allow }`);
    }
    if (tools.has('read')) {
      fm.push('  - { action: read, resource: "*.env", effect: ask }');
      fm.push('  - { action: read, resource: "*.env.*", effect: ask }');
      fm.push('  - { action: read, resource: "*.env.example", effect: allow }');
    }
  }
  fm.push('---', '', a.prompt);
  return fm.join('\n');
}

const target = 'opencode';
const path = 'opencode.json';
export const adapter: LayoutAdapter = {
  target, skillsDir: '.opencode/skills', agentsDir: '.opencode/agents', ext: 'md',
  renderAgent: transpileOpencode, configPath: path,
  renderMcp(servers) {
    const explicitSse = Object.entries(servers).filter(([, definition]) => object(definition) && definition.type === 'sse');
    if (explicitSse.length) throw new TypeError(`Unsupported ${target} MCP transport (sse): ${explicitSse.map(([name]) => name).join(', ')}`);
    const rendered = renderOpencodeConfig(servers, { expandEnv: false });
    if (rendered.invalidTimeouts.length) throw new TypeError(`Invalid OpenCode timeouts: ${rendered.invalidTimeouts.join(', ')}`);
    requireMcpSupport(target, rendered);
    const doc = JSON.parse(rendered.text);
    return { file: { path, content: rendered.text }, document: {
      path, schema: doc.$schema, section: 'mcp', key: 'servers', servers: doc.mcp.servers,
    } };
  },
};
