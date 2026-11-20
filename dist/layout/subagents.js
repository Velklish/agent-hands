import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
export function collectSubagents(sources, { missing = (file, key) => `${file}: required field "${key}" is missing`, duplicate = (name, previous, source) => `Subagent "${name}" is defined twice: ${previous} and ${source}`, invalidLine, } = {}) {
    const agents = [];
    for (const { dirAbs, source } of sources) {
        if (!existsSync(dirAbs))
            continue;
        for (const e of readdirSync(dirAbs, { withFileTypes: true })) {
            if (!e.isFile() || !/\.ya?ml$/.test(e.name))
                continue;
            const file = path.join(dirAbs, e.name);
            const a = parseAgentYaml(readFileSync(file, 'utf8'), file, invalidLine);
            for (const key of ['name', 'description', 'prompt']) {
                if (!a[key])
                    throw new Error(missing(file, key));
            }
            agents.push({ ...a, source, file });
        }
    }
    const seen = new Map();
    for (const a of agents) {
        if (seen.has(a.name))
            throw new Error(duplicate(a.name, seen.get(a.name), a.source));
        seen.set(a.name, a.source);
    }
    return agents;
}
export function parseAgentYaml(text, file, invalid = (f, line) => `${f}: invalid line "${line}" (expected key: value, key: [a, b], or key: |)`) {
    const out = {};
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.trim() || line.trim().startsWith('#'))
            continue;
        let m;
        if ((m = line.match(/^(\w+):\s*\|\s*$/))) {
            const buf = [];
            let j = i + 1;
            while (j < lines.length && (lines[j].startsWith('  ') || !lines[j].trim())) {
                buf.push(lines[j].replace(/^ {2}/, ''));
                j += 1;
            }
            out[m[1]] = `${buf.join('\n').trimEnd()}\n`;
            i = j - 1;
        }
        else if ((m = line.match(/^(\w+):\s*\[(.*)\]\s*$/))) {
            out[m[1]] = m[2]
                .split(',')
                .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
                .filter(Boolean);
        }
        else if ((m = line.match(/^(\w+):\s*(.+?)\s*$/))) {
            out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
        }
        else {
            throw new Error(invalid(file, line));
        }
    }
    return out;
}
const YAML_UNSAFE = /^$|^[\s>|@`%&*!?{}[\],#'"-]|[\s]$|:(\s|$)|\s#/;
export function yamlValue(raw) {
    const s = String(raw ?? '');
    if (s.includes('\n') && !s.includes('\r') && s.trim() && !s.endsWith('\n')) {
        const body = s.split('\n').map((l) => `  ${l}`).join('\n');
        return `|2-\n${body}`;
    }
    if (YAML_UNSAFE.test(s) || /[\x00-\x1f\x7f]/.test(s))
        return JSON.stringify(s);
    try {
        return parse(s) === s ? s : JSON.stringify(s);
    }
    catch {
        return JSON.stringify(s);
    }
}
const READONLY_TOOLS = new Set(['read', 'grep', 'glob']);
export function readOnlyAgent(a) {
    return Array.isArray(a.tools) && a.tools.length && a.tools.every((t) => READONLY_TOOLS.has(t.toLowerCase()));
}
