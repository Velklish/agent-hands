const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const TOML_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const TOML_CONTROL_G = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function tomlKey(name: unknown) {
  const s = String(name ?? '');
  return BARE_KEY.test(s) ? s : tomlQuote(s);
}

export function tomlQuote(raw: unknown) {
  const body = String(raw ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(TOML_CONTROL_G, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `"${body}"`;
}

export function tomlBlock(raw: unknown) {
  const s = String(raw ?? '');
  if (s.includes("'''") || s.endsWith("'") || TOML_CONTROL.test(s)) return tomlQuote(s);
  return `'''\n${s}'''`;
}
