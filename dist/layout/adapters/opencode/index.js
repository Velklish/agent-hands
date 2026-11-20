import { readOnlyAgent, yamlValue } from '../../subagents.js';
import { mergedMcpPath, requireMcpSupport } from '../../adapter.js';
import { object } from '../../mcp.js';
import { renderOpencodeConfig } from './config.js';
export function transpileOpencode(a) {
    const fm = ['---', `description: ${yamlValue(a.description)}`, 'mode: subagent'];
    if (a.model)
        fm.push(`model: ${yamlValue(a.model)}`);
    if (readOnlyAgent(a)) {
        fm.push('permissions:');
        fm.push('  - { action: "*", resource: "*", effect: deny }');
        const tools = new Set(a.tools.map((t) => t.toLowerCase()));
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
export const adapter = {
    target, skillsDir: '.opencode/skills', agentsDir: '.opencode/agents', ext: 'md',
    renderAgent: transpileOpencode, configPath: path,
    renderMcp(servers) {
        const explicitSse = Object.entries(servers).filter(([, definition]) => object(definition) && definition.type === 'sse');
        if (explicitSse.length)
            throw new TypeError(`Unsupported ${target} MCP transport (sse): ${explicitSse.map(([name]) => name).join(', ')}`);
        const rendered = renderOpencodeConfig(servers, { expandEnv: false });
        if (rendered.invalidTimeouts.length)
            throw new TypeError(`Invalid OpenCode timeouts: ${rendered.invalidTimeouts.join(', ')}`);
        requireMcpSupport(target, rendered);
        const doc = rendered.document;
        return { file: { path, content: rendered.text }, document: {
                path, schema: doc.$schema, section: 'mcp', key: 'servers', servers: doc.mcp.servers,
            } };
    },
};
