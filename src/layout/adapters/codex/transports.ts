import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { object } from '../../mcp.js';

export type CodexTransport = 'http' | 'stdio' | null;

// A server is a direct table. A nested URL or an array of tables is not a transport declaration.
export function codexServerTransports(text: string): Map<string, CodexTransport> {
  const { mcp_servers } = parse(text);
  const out = new Map<string, CodexTransport>();
  if (!object(mcp_servers)) return out;
  for (const [name, server] of Object.entries(mcp_servers)) {
    if (!name || !object(server)) continue;
    out.set(name, Object.hasOwn(server, 'url') ? 'http' : Object.hasOwn(server, 'command') ? 'stdio' : null);
  }
  return out;
}

export function readCodexServerTransports(file: string): Map<string, CodexTransport> {
  const text = readCodexTransportSource(file);
  return text === null ? new Map() : codexServerTransports(text);
}

export function readCodexTransportSource(file: string): string | null {
  try { return readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
