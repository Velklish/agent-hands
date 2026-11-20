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
export function requireMcpSupport(target, issues) {
    const details = [
        ...issues.dropped.map(issue => `${issue.name}: unsupported fields ${issue.keys.join(', ')}`),
        ...issues.skipped.map(name => `${name}: unsupported transport`),
        ...issues.unresolved.map(issue => `${issue.name}: unresolved placeholder in ${issue.where}`),
    ];
    if (details.length)
        throw new TypeError(`Unsupported ${target} MCP configuration: ${details.join('; ')}`);
}
