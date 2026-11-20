import { tomlKey, tomlQuote } from '../../toml.js';
const MAPPED_KEYS = new Set(['url', 'headers', 'http_headers_helper', 'required', 'command', 'args', 'env', 'tool_timeout_sec']);
const IGNORED_KEYS = new Set(['type']);
function inlineTable(obj) {
    return `{ ${Object.entries(obj).map(([k, v]) => `${tomlKey(k)} = ${tomlQuote(v)}`).join(', ')} }`;
}
function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}
const WHOLE_PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
function placeholderName(value) {
    return WHOLE_PLACEHOLDER.exec(String(value ?? ''))?.[1] ?? null;
}
function hasPlaceholder(value) {
    return String(value ?? '').includes('${');
}
export function renderCodexConfig(servers, { expandEnv = true, header = '# Generated configuration. Edit the source to change it.' } = {}) {
    const blocks = [header];
    const dropped = [];
    const skipped = [];
    const unresolved = [];
    for (const [name, cfg0] of Object.entries(servers)) {
        const cfg = isObject(cfg0) ? cfg0 : {};
        const extra = Object.keys(cfg).filter((k) => !MAPPED_KEYS.has(k) && !IGNORED_KEYS.has(k));
        const lines = [`[mcp_servers.${tomlKey(name)}]`];
        const note = (where, why, variable) => unresolved.push({ name, where, why, variable });
        if (cfg.url) {
            lines.push(`url = ${tomlQuote(cfg.url)}`);
            if (!expandEnv && hasPlaceholder(cfg.url))
                note('url', 'url');
            if (cfg.http_headers_helper !== undefined) {
                if (typeof cfg.http_headers_helper !== 'string' || !cfg.http_headers_helper.trim())
                    throw new Error(`MCP server «${name}»: http_headers_helper must be a non-empty command`);
                lines.push(`http_headers_helper = ${tomlQuote(cfg.http_headers_helper)}`);
                if (!expandEnv && hasPlaceholder(cfg.http_headers_helper))
                    note('http_headers_helper', 'command');
            }
            if (isObject(cfg.headers) && Object.keys(cfg.headers).length) {
                const literal = Object.create(null);
                const byEnv = Object.create(null);
                for (const [h, v] of Object.entries(cfg.headers)) {
                    const varName = expandEnv ? null : placeholderName(v);
                    if (varName)
                        byEnv[h] = varName;
                    else {
                        literal[h] = v;
                        if (!expandEnv && hasPlaceholder(v))
                            note(`headers.${h}`, 'embedded');
                    }
                }
                if (Object.keys(literal).length)
                    lines.push(`http_headers = ${inlineTable(literal)}`);
                if (Object.keys(byEnv).length)
                    lines.push(`env_http_headers = ${inlineTable(byEnv)}`);
            }
        }
        else if (cfg.command) {
            lines.push(`command = ${tomlQuote(cfg.command)}`);
            if (!expandEnv && hasPlaceholder(cfg.command))
                note('command', 'command');
            if (Array.isArray(cfg.args) && cfg.args.length) {
                lines.push(`args = [${cfg.args.map((a) => tomlQuote(a)).join(', ')}]`);
                if (!expandEnv && cfg.args.some(hasPlaceholder))
                    note('args', 'argument');
            }
            if (isObject(cfg.env) && Object.keys(cfg.env).length) {
                const literal = Object.create(null);
                const passthrough = [];
                for (const [k, v] of Object.entries(cfg.env)) {
                    // Codex can pass a variable through under the same name, but cannot rename it.
                    const varName = expandEnv ? null : placeholderName(v);
                    if (varName === k)
                        passthrough.push(varName);
                    else {
                        literal[k] = v;
                        if (!expandEnv && hasPlaceholder(v)) {
                            note(`env.${k}`, varName ? 'renamed' : 'embedded', varName ?? undefined);
                        }
                    }
                }
                if (Object.keys(literal).length)
                    lines.push(`env = ${inlineTable(literal)}`);
                if (passthrough.length)
                    lines.push(`env_vars = [${passthrough.map((v) => tomlQuote(v)).join(', ')}]`);
            }
        }
        else {
            skipped.push(name);
            continue;
        }
        if (cfg.required !== undefined) {
            if (typeof cfg.required !== 'boolean')
                throw new Error(`MCP server «${name}»: required must be a boolean`);
            lines.push(`required = ${cfg.required}`);
        }
        if (cfg.tool_timeout_sec !== undefined) {
            if (typeof cfg.tool_timeout_sec !== 'number' || !Number.isFinite(cfg.tool_timeout_sec) || cfg.tool_timeout_sec <= 0)
                throw new Error(`MCP server «${name}»: tool_timeout_sec must be a positive finite number`);
            lines.push(`tool_timeout_sec = ${cfg.tool_timeout_sec}`);
        }
        if (extra.length)
            dropped.push({ name, keys: extra });
        blocks.push(lines.join('\n'));
    }
    return { text: `${blocks.join('\n\n')}\n`, dropped, skipped, unresolved };
}
export function codexTransportConflicts(servers, userServers) {
    const out = [];
    for (const [name, cfg] of Object.entries(servers ?? {})) {
        const ours = cfg?.url ? 'http' : (cfg?.command ? 'stdio' : null);
        const theirs = userServers?.get?.(name) ?? null;
        if (!ours || !theirs || ours === theirs)
            continue;
        out.push({ name, ours, theirs });
    }
    return out;
}
