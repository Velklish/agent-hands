import { readOnlyAgent, yamlValue } from '../../subagents.js';
import { mergedMcpPath } from '../../adapter.js';
import { renderMcpJson } from '../../mcp.js';
export function transpileCursor(a) {
    const fm = ['---', `name: ${yamlValue(a.name)}`, `description: ${yamlValue(a.description)}`];
    if (a.model)
        fm.push(`model: ${yamlValue(a.model)}`);
    if (readOnlyAgent(a))
        fm.push('readonly: true');
    fm.push('---', '', String(a.prompt ?? ''));
    return fm.join('\n');
}
const target = 'cursor';
const path = mergedMcpPath.cursor;
export const adapter = {
    target, skillsDir: '.cursor/skills', agentsDir: '.cursor/agents', ext: 'md',
    renderAgent: transpileCursor, configPath: path, preservesServerSettings: true,
    renderMcp(servers) {
        return { file: { path, content: renderMcpJson(servers) }, document: { path, key: 'mcpServers', servers }, empty: !Object.keys(servers).length };
    },
};
