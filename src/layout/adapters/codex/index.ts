import { type AgentDefinition, readOnlyAgent } from '../../subagents.js';
import { type LayoutAdapter, reportMcpIssues } from '../../adapter.js';
import { object } from '../../mcp.js';
import { codexTransportConflicts, renderCodexConfig } from './config.js';
import { readCodexServerTransports } from './transports.js';
import { isAbsolute } from 'node:path';
import { tomlQuote, tomlBlock } from '../../toml.js';

export function transpileCodex(a: AgentDefinition) {
  const lines = [`name = ${tomlQuote(a.name)}`, `description = ${tomlQuote(a.description)}`];
  if (a.model) lines.push(`model = ${tomlQuote(a.model)}`);
  if (readOnlyAgent(a)) lines.push('sandbox_mode = "read-only"');
  lines.push(`developer_instructions = ${tomlBlock(a.prompt)}`);
  return `${lines.join('\n')}\n`;
}


const target = 'codex';
const path = '.codex/config.toml';
export const adapter: LayoutAdapter = {
  target, skillsDir: '.codex/skills', agentsDir: '.codex/agents', ext: 'toml',
  renderAgent: transpileCodex, configPath: path, acceptsMcpReference: true,
  renderMcp(servers, context) {
    const usable = Object.fromEntries(Object.entries(servers).filter(([name, definition]) => {
      if (!object(definition) || definition.type !== 'sse') return true;
      context.report({code:'unsupported-transport',server:name,reason:'sse'}, `${name}: unsupported transport (sse)`);
      return false;
    }));
    const reference = context.policy.transportReference;
    if (reference !== undefined) {
      if (!isAbsolute(reference)) throw new TypeError('Expected an absolute transport reference path');
      for (const {name,ours,theirs} of codexTransportConflicts(usable,readCodexServerTransports(reference))) {
        context.report({code:'transport-conflict',server:name,reason:`${ours}:${theirs}`}, `${name}: transport conflict (${ours} versus ${theirs})`, true);
      }
    }
    const header = context.policy.comments?.map(line => `# ${line}`).join('\n') || undefined;
    const rendered = renderCodexConfig(usable, { expandEnv: false, literal: context.literal, header });
    reportMcpIssues(context, rendered);
    return { file: { path, content: rendered.text }, empty: rendered.empty };
  },
};
