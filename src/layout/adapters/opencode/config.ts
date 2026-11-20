import { envPattern } from '../../mcp.js';

const MAPPED_KEYS = new Set(['url', 'headers', 'command', 'args', 'env', 'tool_timeout_sec']);
const IGNORED_KEYS = new Set(['type']);

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function executionTimeoutMs(seconds: unknown): number | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  // Convert decimal places directly: binary multiplication can yield a fractional result.
  const decimal = String(seconds);
  if (!/^\d+(?:\.\d{1,3})?$/.test(decimal)) return undefined;
  const [whole, fraction = ''] = decimal.split('.');
  const milliseconds = Number(whole + fraction.padEnd(3, '0'));
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function configValue(v: unknown, { expandEnv, note }: { expandEnv: boolean; note: (why: string) => void }): unknown {
  if (expandEnv || typeof v !== 'string') return v;
  const translated = v.replace(envPattern(), (_, name) => `{env:${name}}`);
  if (translated.includes('${')) note('unsupported placeholder syntax');
  return translated;
}

export function renderOpencodeConfig(servers: Record<string, unknown> | null | undefined, { expandEnv = true } = {}) {
  const out: Record<string, unknown> = Object.create(null);
  const dropped = [];
  const skipped = [];
  const unresolved: { name: string; where: string; why: string }[] = [];
  const invalidTimeouts: string[] = [];
  for (const [name, cfg0] of Object.entries(servers ?? {})) {
    const cfg = isObject(cfg0) ? cfg0 : {};
    if (!cfg.url && !cfg.command) {
      skipped.push(name);
      continue;
    }
    const extra = Object.keys(cfg).filter((k) => !MAPPED_KEYS.has(k) && !IGNORED_KEYS.has(k));
    const note = (where: string, why: string) => unresolved.push({ name, where, why });
    const execution = executionTimeoutMs(cfg.tool_timeout_sec);
    const timeout = execution === undefined ? undefined : { execution };
    if (Object.hasOwn(cfg, 'tool_timeout_sec') && !timeout) invalidTimeouts.push(name);
    if (cfg.url) {
      const entry: { type: string; url: unknown; headers?: Record<string, unknown>; timeout: typeof timeout } = { type: 'remote', url: configValue(cfg.url, { expandEnv, note: (why) => note('url', why) }), timeout };
      if (isObject(cfg.headers) && Object.keys(cfg.headers).length) {
      entry.headers = Object.create(null) as Record<string, unknown>;
        for (const [h, v] of Object.entries(cfg.headers)) {
          entry.headers[h] = configValue(v, { expandEnv, note: (why) => note(`headers.${h}`, why) });
        }
      }
      out[name] = entry;
    } else {
      const entry: { type: string; command: unknown[]; environment?: Record<string, unknown>; timeout: typeof timeout } = { type: 'local', command: [
        configValue(cfg.command, { expandEnv, note: (why) => note('command', why) }),
        ...(Array.isArray(cfg.args) ? cfg.args : []).map((v, i) =>
          configValue(v, { expandEnv, note: (why) => note(`args[${i}]`, why) })),
      ], timeout };
      if (isObject(cfg.env) && Object.keys(cfg.env).length) {
        entry.environment = Object.create(null) as Record<string, unknown>;
        for (const [k, v] of Object.entries(cfg.env)) {
          entry.environment[k] = configValue(v, { expandEnv, note: (why) => note(`env.${k}`, why) });
        }
      }
      out[name] = entry;
    }
    if (extra.length) dropped.push({ name, keys: extra });
  }
  const document = { $schema: 'https://opencode.ai/config.json', mcp: { servers: out } };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  return { text, document, dropped, skipped, unresolved, invalidTimeouts };
}
