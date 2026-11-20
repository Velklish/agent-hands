const targets = ['claude', 'cursor', 'codex', 'opencode'];
export const isTarget = (value) => targets.some(target => target === value);
export function requireMcpSupport(target, issues) {
    const details = [
        ...issues.dropped.map(issue => `${issue.name}: unsupported fields ${issue.keys.join(', ')}`),
        ...issues.skipped.map(name => `${name}: unsupported transport`),
        ...issues.unresolved.map(issue => `${issue.name}: unresolved placeholder in ${issue.where}`),
    ];
    if (details.length)
        throw new TypeError(`Unsupported ${target} MCP configuration: ${details.join('; ')}`);
}
