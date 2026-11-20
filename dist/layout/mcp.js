import { readFileSync } from 'node:fs';
import { sha256 } from './fs.js';
export const envPattern = () => /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
export const environmentNames = (value) => [...new Set([...JSON.stringify(value).matchAll(envPattern())].map(match => match[1]))];
export function substituteValues(value, values) {
    return JSON.parse(JSON.stringify(value).replace(envPattern(), (match, name) => Object.hasOwn(values, name) && values[name] != null ? JSON.stringify(values[name]).slice(1, -1) : match));
}
function mapStrings(value, map) {
    if (typeof value === 'string')
        return map(value);
    if (Array.isArray(value))
        return value.map(child => mapStrings(child, map));
    if (object(value))
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, map)]));
    return value;
}
export function resolveEnvironment(value, env) {
    return mapStrings(value, text => text.replace(envPattern(), (match, name) => Object.hasOwn(env, name) ? env[name] : match));
}
export function valueEnvironmentNames(value) {
    const names = new Set();
    mapStrings(value, text => {
        for (const match of text.matchAll(envPattern()))
            names.add(match[1]);
        return text;
    });
    return [...names];
}
function canonical(value) {
    if (Array.isArray(value))
        return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
            .map(([key, entry]) => [key, canonical(entry)]));
    }
    return value;
}
export const sameServerConfig = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const serverHash = (value) => sha256(JSON.stringify(canonical(value)));
export function object(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function readServerMap(file, invalid = (f) => `Invalid JSON: ${f}`, shape = (f) => `${f}: expected a map of server names to definitions`) {
    let value;
    try {
        value = JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        throw new Error(invalid(file));
    }
    if (!object(value))
        throw new Error(shape(file));
    return value;
}
export function collectServers(sources, { read = readServerMap, reject = (message) => { throw new Error(message); }, conflict = (name, previous, next) => `Server "${name}" has conflicting definitions from ${previous} and ${next}`, external = () => false, excludedVariables = new Set(), } = {}) {
    const merged = new Map();
    for (const source of sources) {
        let definitions;
        try {
            definitions = read(source.file);
        }
        catch (error) {
            reject(error.message);
            continue;
        }
        for (const [name, raw] of Object.entries(definitions)) {
            const definition = source.prepare ? source.prepare(raw) : raw;
            const previous = merged.get(name);
            if (previous && !sameServerConfig(previous.definition, definition)) {
                reject(conflict(name, previous.source.label, source.label));
                continue;
            }
            merged.set(name, { definition, source });
        }
    }
    const servers = Object.fromEntries([...merged].filter(([, entry]) => !external(entry.definition)).map(([name, entry]) => [name, entry.definition]));
    const externalServers = Object.fromEntries([...merged].filter(([, entry]) => external(entry.definition)).map(([name, entry]) => [name, entry.definition]));
    const serverOwner = Object.fromEntries([...merged].map(([name, entry]) => [name, entry.source.provenance ?? null]));
    const requiredVars = environmentNames(servers).filter(name => !excludedVariables.has(name));
    return { servers, externalServers, requiredVars, serverOwner };
}
export const renderMcpJson = (servers) => `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
export function mergeMcpServers(document, definitions, previous, { adoptIdentical = false, key = 'mcpServers' } = {}) {
    const servers = Object.assign(Object.create(null), document[key] ?? {});
    const owned = [];
    const kept = [];
    for (const name of previous)
        if (!Object.hasOwn(definitions, name))
            delete servers[name];
    for (const [name, definition] of Object.entries(definitions)) {
        if (Object.hasOwn(servers, name) && !previous.includes(name) && !(adoptIdentical && sameServerConfig(servers[name], definition))) {
            kept.push(name);
            continue;
        }
        servers[name] = definition;
        owned.push(name);
    }
    return { document: { ...document, [key]: servers }, servers, owned, kept };
}
export function writeToolRecord(value) {
    return object(value) && typeof value.source === 'string' && !!value.source.trim()
        && Array.isArray(value.write) && !value.write.some(tool => typeof tool !== 'string' || !tool.trim());
}
export const writeToolKey = (names) => JSON.stringify([...new Set(names)].sort());
