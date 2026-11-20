export function fields(value, label, allowed) {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new TypeError(`Expected an object: ${label}`);
    }
    const result = Object.create(null);
    for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!allowed.includes(key))
            throw new TypeError(`Unknown ${label} field: ${key}`);
        if (!('value' in property))
            throw new TypeError(`Expected a data field: ${label}.${key}`);
        result[key] = property.value;
    }
    return result;
}
export const serverFields = ['command', 'args', 'env', 'url', 'headers', 'type', 'required', 'tool_timeout_sec', 'http_headers_helper'];
export function preparedServer(value) {
    const { name, definition, source, placeholders } = fields(value, 'server', ['name', 'definition', 'source', 'placeholders']);
    if (typeof name !== 'string' || !name.trim())
        throw new TypeError('Expected a server name');
    if (source !== undefined && typeof source !== 'string')
        throw new TypeError('Expected a source label');
    if (placeholders !== undefined && placeholders !== 'native' && placeholders !== 'literal')
        throw new TypeError('Invalid server placeholder policy');
    const raw = fields(definition, 'definition', serverFields);
    const { command, args, url, type } = raw;
    const local = typeof command === 'string' && !!command.trim();
    const remote = typeof url === 'string' && !!url.trim();
    if (local === remote || (local && url !== undefined) || (remote && command !== undefined)) {
        throw new TypeError(`Expected exactly one of command or url for ${name}`);
    }
    if ((local && (raw.headers !== undefined || raw.http_headers_helper !== undefined))
        || (remote && (args !== undefined || raw.env !== undefined)))
        throw new TypeError(`Fields do not match the transport for ${name}`);
    if (type !== undefined && (local ? type !== 'stdio' : !['http', 'sse', 'streamable-http'].includes(type))) {
        throw new TypeError(`Invalid server type for ${name}`);
    }
    const result = {};
    for (const [key, entry] of Object.entries(raw)) {
        if (entry === undefined)
            continue;
        if (key === 'args')
            result[key] = stringList(entry, `Expected string arguments for ${name}`);
        else if (key === 'env' || key === 'headers') {
            const map = fields(entry, key, entry && typeof entry === 'object' ? Object.keys(entry) : []);
            if (Object.values(map).some(v => typeof v !== 'string'))
                throw new TypeError(`Expected string values in ${key} for ${name}`);
            result[key] = Object.fromEntries(Object.entries(map));
        }
        else if ((key === 'required' && typeof entry !== 'boolean')
            || (key === 'tool_timeout_sec' && (typeof entry !== 'number' || !Number.isFinite(entry) || entry <= 0))
            || (key === 'http_headers_helper' && (typeof entry !== 'string' || !entry.trim())))
            throw new TypeError(`Invalid ${key} for ${name}`);
        else
            result[key] = entry;
    }
    return [name, result];
}
export function stringList(args, message) {
    if (!Array.isArray(args))
        throw new TypeError(message);
    const strings = [];
    for (let index = 0; index < args.length; index++) {
        const arg = Object.getOwnPropertyDescriptor(args, index)?.value;
        if (typeof arg !== 'string')
            throw new TypeError(message);
        strings.push(arg);
    }
    return strings;
}
