import { readOnlyAgent } from '../../subagents.js';
import { requireMcpSupport } from '../../adapter.js';
import { object } from '../../mcp.js';
import { renderCodexConfig } from './config.js';
import { tomlQuote, tomlBlock } from '../../toml.js';
export function transpileCodex(a) {
    const lines = [`name = ${tomlQuote(a.name)}`, `description = ${tomlQuote(a.description)}`];
    if (a.model)
        lines.push(`model = ${tomlQuote(a.model)}`);
    if (readOnlyAgent(a))
        lines.push('sandbox_mode = "read-only"');
    lines.push(`developer_instructions = ${tomlBlock(a.prompt)}`);
    return `${lines.join('\n')}\n`;
}
const target = 'codex';
const path = '.codex/config.toml';
export const adapter = {
    target, skillsDir: '.codex/skills', agentsDir: '.codex/agents', ext: 'toml',
    renderAgent: transpileCodex, configPath: path,
    renderMcp(servers) {
        const explicitSse = Object.entries(servers).filter(([, definition]) => object(definition) && definition.type === 'sse');
        if (explicitSse.length)
            throw new TypeError(`Unsupported ${target} MCP transport (sse): ${explicitSse.map(([name]) => name).join(', ')}`);
        const rendered = renderCodexConfig(servers, { expandEnv: false });
        requireMcpSupport(target, rendered);
        return { file: { path, content: rendered.text } };
    },
};
