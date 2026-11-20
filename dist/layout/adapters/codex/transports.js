import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { object } from '../../mcp.js';
// A server is a direct table. A nested URL or an array of tables is not a transport declaration.
export function codexServerTransports(text) {
    const { mcp_servers } = parse(text);
    const out = new Map();
    if (!object(mcp_servers))
        return out;
    for (const [name, server] of Object.entries(mcp_servers)) {
        if (!name || !object(server))
            continue;
        out.set(name, Object.hasOwn(server, 'url') ? 'http' : Object.hasOwn(server, 'command') ? 'stdio' : null);
    }
    return out;
}
export function readCodexServerTransports(file) {
    let text;
    try {
        text = readFileSync(file, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return new Map();
        throw error;
    }
    return codexServerTransports(text);
}
