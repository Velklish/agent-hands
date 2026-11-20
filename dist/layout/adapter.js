import { LayoutMcpError } from './mcp-policy.js';
const targets = ['claude', 'cursor', 'codex', 'opencode'];
export const isTarget = (value) => targets.some(target => target === value);
// These document paths are also wire identifiers in persisted per-key ownership state.
export const mergedMcpPath = Object.freeze({
    claude: '.mcp.json', cursor: '.cursor/mcp.json', opencode: 'opencode.json',
});
export function isMergedMcpPath(rel, target) {
    return target === undefined ? Object.values(mergedMcpPath).some(path => path === rel)
        : target in mergedMcpPath && mergedMcpPath[target] === rel;
}
export function reportMcpIssues(context, issues) {
    for (const { name, keys } of issues.dropped)
        context.report({ code: 'unsupported-fields', server: name, keys }, `${name}: unsupported fields ${keys.join(', ')}`);
    for (const name of issues.skipped)
        context.report({ code: 'unsupported-transport', server: name }, `${name}: unsupported transport`);
    for (const { name, where, why } of issues.unresolved)
        context.report({ code: 'unresolved-placeholder', server: name, field: where, reason: why }, `${name}: unresolved placeholder in ${where}`);
}
export function mcpReporter(adapter, policy, diagnostics) {
    return (issue, summary, fatal = false) => {
        const diagnostic = { path: adapter.configPath, target: adapter.target, ...issue };
        if (fatal || policy.compatibility !== 'report')
            throw new LayoutMcpError(`Unsupported ${adapter.target} MCP configuration: ${summary}`, diagnostic);
        diagnostics.push(diagnostic);
    };
}
