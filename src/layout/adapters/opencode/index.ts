import { type AgentDefinition, readOnlyAgent, yamlValue } from '../../subagents.js';
import { mergedMcpPath, type LayoutAdapter, reportMcpIssues } from '../../adapter.js';
import { object, serverHash } from '../../mcp.js';
import { renderOpencodeConfig } from './config.js';

export function transpileOpencode(a: AgentDefinition) {
  const fm = ['---', `description: ${yamlValue(a.description)}`, 'mode: subagent'];
  if (a.model) fm.push(`model: ${yamlValue(a.model)}`);
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
  fm.push('---', '', String(a.prompt ?? ''));
  return fm.join('\n');
}

const target = 'opencode';
const path = mergedMcpPath.opencode;
export const adapter: LayoutAdapter = {
  target, skillsDir: '.opencode/skills', agentsDir: '.opencode/agents', ext: 'md',
  renderAgent: transpileOpencode, configPath: path, reportsInvalidTimeout: true,
  agentResets(names) {
    const entry = {disabled:true};
    return {path:'.opencode/opencode.json', key:'agents', entry, servers:Object.fromEntries(names.map(name=>[name,entry]))};
  },
  renderMcp(servers, context) {
    const usable = Object.fromEntries(Object.entries(servers).filter(([name, definition]) => {
      if (context.policy.compatibility === 'report' || !object(definition) || definition.type !== 'sse') return true;
      context.report({code:'unsupported-transport',server:name,reason:'sse'}, `${name}: unsupported transport (sse)`);
      return false;
    }));
    const rendered = renderOpencodeConfig(usable, { expandEnv: false, literal: context.literal });
    for (const name of rendered.invalidTimeouts) context.report({code:'invalid-timeout',server:name,field:'tool_timeout_sec'}, `Invalid OpenCode timeouts: ${name}`);
    reportMcpIssues(context, rendered);
    const doc = rendered.document;
    const legacyHashes = Object.fromEntries(Object.entries(doc.mcp.servers).map(([name,config]) => {
      const {timeout: _timeout,...previous} = config as Record<string,unknown>;
      return [name,serverHash(previous)];
    }));
    return { file: { path, content: rendered.text }, document: {
      path, schema: doc.$schema, section: 'mcp', key: 'servers', servers: doc.mcp.servers,
    }, legacyHashes, empty: !Object.keys(doc.mcp.servers).length };
  },
};
