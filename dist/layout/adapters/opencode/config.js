import { envPattern } from '../../mcp.js';
const MAPPED_KEYS = new Set(['url', 'headers', 'command', 'args', 'env', 'tool_timeout_sec']);
const IGNORED_KEYS = new Set(['type']);
function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}
function executionTimeoutMs(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0)
        return undefined;
    // Convert decimal places directly: binary multiplication can yield a fractional result.
    const decimal = String(seconds);
    if (!/^\d+(?:\.\d{1,3})?$/.test(decimal))
        return undefined;
    const [whole, fraction = ''] = decimal.split('.');
    const milliseconds = Number(whole + fraction.padEnd(3, '0'));
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}
function configValue(v, { expandEnv, note }) {
    if (expandEnv || typeof v !== 'string')
        return v;
    const translated = v.replace(envPattern(), (_, name) => `{env:${name}}`);
    if (translated.includes('${'))
        note('unsupported placeholder syntax');
    return translated;
}
export function renderOpencodeConfig(servers, { expandEnv = true } = {}) {
    const out = Object.create(null);
    const dropped = [];
    const skipped = [];
    const unresolved = [];
    const invalidTimeouts = [];
    for (const [name, cfg0] of Object.entries(servers ?? {})) {
        const cfg = isObject(cfg0) ? cfg0 : {};
        if (!cfg.url && !cfg.command) {
            skipped.push(name);
            continue;
        }
        const extra = Object.keys(cfg).filter((k) => !MAPPED_KEYS.has(k) && !IGNORED_KEYS.has(k));
        const note = (where, why) => unresolved.push({ name, where, why });
        const execution = executionTimeoutMs(cfg.tool_timeout_sec);
        const timeout = execution === undefined ? undefined : { execution };
        if (Object.hasOwn(cfg, 'tool_timeout_sec') && !timeout)
            invalidTimeouts.push(name);
        if (cfg.url) {
            const entry = { type: 'remote', url: configValue(cfg.url, { expandEnv, note: (why) => note('url', why) }), timeout };
            if (isObject(cfg.headers) && Object.keys(cfg.headers).length) {
                entry.headers = Object.create(null);
                for (const [h, v] of Object.entries(cfg.headers)) {
                    entry.headers[h] = configValue(v, { expandEnv, note: (why) => note(`headers.${h}`, why) });
                }
            }
            out[name] = entry;
        }
        else {
            const entry = { type: 'local', command: [
                    configValue(cfg.command, { expandEnv, note: (why) => note('command', why) }),
                    ...(Array.isArray(cfg.args) ? cfg.args : []).map((v, i) => configValue(v, { expandEnv, note: (why) => note(`args[${i}]`, why) })),
                ], timeout };
            if (isObject(cfg.env) && Object.keys(cfg.env).length) {
                entry.environment = Object.create(null);
                for (const [k, v] of Object.entries(cfg.env)) {
                    entry.environment[k] = configValue(v, { expandEnv, note: (why) => note(`env.${k}`, why) });
                }
            }
            out[name] = entry;
        }
        if (extra.length)
            dropped.push({ name, keys: extra });
    }
    const document = { $schema: 'https://opencode.ai/config.json', mcp: { servers: out } };
    const text = `${JSON.stringify(document, null, 2)}\n`;
    return { text, document, dropped, skipped, unresolved, invalidTimeouts };
}
