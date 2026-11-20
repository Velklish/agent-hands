import path from 'node:path';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { fields, preparedServer, stringList } from './stdio.js';
import { copyEntries, Writer } from './writer.js';
import { sha256, toPosix } from './fs.js';
import { SHARED_DIR, validateSkill } from './skills.js';
import { stageContent } from './content.js';
import { readRules } from './rule-files.js';
import { mergeMcpServers, object, resolveEnvironment, sameServerConfig, serverHash, valueEnvironmentNames, writeToolRecord } from './mcp.js';
import { isMergedMcpPath, isTarget } from './adapter.js';
const planBrand = Symbol('layout plan');
const applications = new WeakMap();
const rulesDir = (target) => `.agents/rules/${target}`;
function list(input, key) {
    const value = input[key];
    if (!Array.isArray(value))
        throw new TypeError(`Expected an array: ${key}`);
    return Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, i)?.value);
}
function segment(value, label) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value) || value.endsWith('.')) {
        throw new TypeError(`Expected a safe ${label} name: ${String(value)}`);
    }
    return value;
}
function unique(seen, name, label) {
    const key = name.toLowerCase();
    if (seen.has(key))
        throw new TypeError(`Duplicate ${label}: ${name}`);
    seen.add(key);
}
function directory(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || !lstatSync(value, { throwIfNoEntry: false })?.isDirectory()) {
        throw new TypeError(`Expected an absolute regular source directory: ${String(value)}`);
    }
    return value;
}
function sourceLabel(value) {
    if (value !== undefined && typeof value !== 'string')
        throw new TypeError('Expected a source label');
    return value;
}
export function prepare(value, select) {
    const input = fields(value, 'layout', ['root', 'target', 'skills', 'sharedDirs', 'servers', 'subagents', 'rules', 'env', 'writeTools']);
    const { root } = input;
    if (typeof root !== 'string' || !path.isAbsolute(root))
        throw new TypeError('Expected an absolute workspace root');
    const adapter = select(input.target);
    const skillNames = new Set([SHARED_DIR]);
    const skills = list(input, 'skills').map(entry => {
        const raw = fields(entry, 'skill', ['name', 'dirAbs', 'source']);
        const name = segment(raw.name, 'skill');
        unique(skillNames, name, 'skill');
        const dirAbs = directory(raw.dirAbs);
        const source = sourceLabel(raw.source);
        validateSkill(path.join(dirAbs, 'SKILL.md'), name, source);
        return { name, dirAbs, source };
    });
    const sharedDirs = input.sharedDirs === undefined ? [] : list(input, 'sharedDirs').map(entry => {
        const raw = fields(entry, 'supporting directory', ['srcAbs', 'source']);
        return { srcAbs: directory(raw.srcAbs), source: sourceLabel(raw.source) };
    });
    const agentNames = new Set();
    const subagents = list(input, 'subagents').map(entry => {
        const raw = fields(entry, 'subagent', ['name', 'description', 'prompt', 'model', 'tools', 'source', 'file']);
        const name = segment(raw.name, 'subagent');
        unique(agentNames, name, 'subagent');
        if (typeof raw.description !== 'string' || !raw.description.trim() || typeof raw.prompt !== 'string' || !raw.prompt.trim()) {
            throw new TypeError(`Expected non-empty description and prompt for ${name}`);
        }
        if (raw.model !== undefined && (typeof raw.model !== 'string' || !raw.model.trim() || /[\r\n]/.test(raw.model))) {
            throw new TypeError(`Invalid model for ${name}`);
        }
        const tools = raw.tools === undefined ? undefined : stringList(raw.tools, `Expected tool names for ${name}`);
        if (tools?.some(tool => !/^[\w.:-]+$/.test(tool)))
            throw new TypeError(`Invalid tool name for ${name}`);
        return { name, description: raw.description, prompt: raw.prompt, model: raw.model, tools };
    });
    const rules = readRules(stringList(input.rules, 'Expected an array: rules'));
    const serverNames = new Set();
    const definitions = Object.fromEntries(list(input, 'servers').map(entry => {
        const result = preparedServer(entry);
        unique(serverNames, result[0], 'server');
        return result;
    }));
    const env = input.env === undefined ? undefined : environment(input.env);
    const resolved = env ? Object.fromEntries(Object.entries(definitions).map(([name, definition]) => preparedServer({ name, definition: resolveEnvironment(definition, env) }))) : definitions;
    const requiredVars = valueEnvironmentNames(resolved);
    const writeTools = input.writeTools === undefined ? undefined : collectWriteTools(input.writeTools, definitions);
    const entries = new Map();
    const hashes = new Map();
    const origins = new Map();
    const sources = [];
    const stage = (rel, content, executable, origin = rel) => {
        const key = toPosix(rel).toLowerCase();
        const digest = sha256(content);
        const previous = entries.get(key);
        if (previous && (previous.path !== toPosix(rel) || hashes.get(key) !== digest || previous.executable !== executable)) {
            throw new Error(`Output collision: ${rel} (${origins.get(key)} / ${origin})`);
        }
        entries.set(key, { path: toPosix(rel), content, ...(executable === undefined ? {} : { executable }) });
        hashes.set(key, digest);
        origins.set(key, origin);
    };
    stageContent({ stage: (rel, content) => stage(rel, content), copyDir(src, dest, options) {
            const scan = () => [...copyEntries(directory(src), dest, { regularOnly: true })].sort((a, b) => a.rel.localeCompare(b.rel))
                .map(({ src: file, rel }) => ({ rel, content: readFileSync(file), executable: (lstatSync(file).mode & 0o111) !== 0 }));
            const fingerprint = (files) => JSON.stringify(files.map(({ rel, content, executable }) => [rel, sha256(content), executable]));
            const files = scan();
            const hash = fingerprint(files);
            sources.push(() => { if (fingerprint(scan()) !== hash)
                throw new Error(`Stale source: ${src}`); });
            for (const file of files)
                stage(file.rel, file.content, file.executable, options?.origin ?? src);
        } }, adapter, { skills, sharedDirs, subagents });
    for (const [index, rule] of rules.entries()) {
        const digest = sha256(rule.content);
        stage(`${rulesDir(adapter.target)}/${String(index + 1).padStart(4, '0')}.md`, rule.content);
        sources.push(() => { if (!lstatSync(rule.file, { throwIfNoEntry: false })?.isFile() || sha256(readFileSync(rule.file)) !== digest)
            throw new Error(`Stale source: ${rule.file}`); });
    }
    for (const { path: rel } of entries.values()) {
        for (let dir = path.posix.dirname(rel); dir !== '.'; dir = path.posix.dirname(dir)) {
            if (entries.has(dir.toLowerCase()))
                throw new Error(`Output collision: ${dir} is a parent of ${rel}`);
        }
    }
    const { file, document } = adapter.renderMcp(resolved);
    const files = [...entries.values(), ...(Object.keys(resolved).length ? [file] : [])];
    const result = { [planBrand]: true, root, files: files.map(f => ({ ...f, content: typeof f.content === 'string' ? f.content : Buffer.from(f.content) })),
        ...(rules.length ? { rules: rules.map(row => row.file) } : {}), ...(requiredVars.length ? { requiredVars } : {}), ...(writeTools ? { writeTools } : {}) };
    applications.set(result, { adapter, root, entries: files, mcp: document, checkSources: () => { for (const check of sources)
            check(); } });
    return result;
}
function environment(value) {
    const raw = fields(value, 'env', object(value) ? Object.keys(value) : []);
    return Object.fromEntries(Object.entries(raw).map(([name, entry]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof entry !== 'string')
            throw new TypeError('Expected named string environment values');
        return [name, entry];
    }));
}
function collectWriteTools(value, servers) {
    const names = Object.keys(servers);
    const records = fields(value, 'write tools', names);
    return names.flatMap(server => {
        const entry = fields(records[server], `write tools for ${server}`, ['source', 'write']);
        if (!writeToolRecord(entry))
            throw new TypeError(`Invalid write tools for ${server}`);
        return [...new Set(stringList(entry.write, `Expected write tool names for ${server}`))].map(tool => ({ server, tool }));
    });
}
function destination(root, rel) {
    if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) || rel.split('/').some(s => !s || s === '.' || s === '..' || s.includes('\\'))) {
        throw new Error(`Output escapes the root: ${rel}`);
    }
    let file = root;
    for (const part of rel.split('/')) {
        file = path.join(file, part);
        if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())
            throw new Error(`Refusing linked output: ${rel}`);
    }
    return file;
}
function readHashes(value) {
    const record = fields(value, 'ownership hashes', object(value) ? Object.keys(value) : []);
    return Object.fromEntries(Object.entries(record).map(([name, hash]) => {
        if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))
            throw new TypeError(`Invalid ownership hash: ${name}`);
        return [name, hash];
    }));
}
export function readLayoutState(value) {
    const { target, files, serverKeys, createdMcp } = fields(value, 'ownership state', ['target', 'files', 'serverKeys', 'createdMcp']);
    if (target !== undefined && !isTarget(target))
        throw new TypeError('Invalid ownership target');
    const ownedFiles = readHashes(files);
    const keyMap = serverKeys === undefined ? {} : fields(serverKeys, 'MCP ownership', object(serverKeys) ? Object.keys(serverKeys) : []);
    const ownedKeys = Object.fromEntries(Object.entries(keyMap).map(([rel, hashes]) => {
        if (!isMergedMcpPath(rel, target))
            throw new TypeError(`Invalid MCP state path: ${rel}`);
        return [rel, readHashes(hashes)];
    }));
    const created = createdMcp === undefined ? [] : stringList(createdMcp, 'Expected an array of created MCP paths');
    for (const rel of created) {
        if (!Object.hasOwn(ownedKeys, rel))
            throw new TypeError(`Untracked created MCP path: ${rel}`);
    }
    return { ...(target === undefined ? {} : { target }), files: ownedFiles, serverKeys: ownedKeys, createdMcp: created };
}
export async function applyLayout(plan, previous = { files: {} }) {
    const application = applications.get(plan);
    if (!application)
        throw new Error('Expected a plan returned by planLayout');
    const { root, entries, mcp, adapter } = application;
    if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory())
        throw new Error(`Expected a regular workspace root: ${root}`);
    application.checkSources();
    const state = readLayoutState(previous);
    if (state.target !== undefined && state.target !== adapter.target)
        throw new Error(`Ownership belongs to ${state.target}`);
    const writer = new Writer(root, { files: state.files });
    for (const rel of Object.keys(state.files)) {
        if (![adapter.skillsDir, adapter.agentsDir, rulesDir(adapter.target)].some(dir => rel.startsWith(dir + '/'))
            && !(rel === adapter.configPath && !mcp))
            throw new Error(`Invalid ownership path: ${rel}`);
        destination(root, rel);
    }
    for (const file of entries) {
        const abs = destination(root, file.path);
        if (file.path === mcp?.path)
            continue;
        const stat = lstatSync(abs, { throwIfNoEntry: false });
        if (stat && (!stat.isFile() || !Object.hasOwn(state.files, file.path)))
            throw new Error(`Output conflict: ${file.path}`);
        if (stat && stat.nlink > 1 && file.path !== adapter.configPath)
            throw new Error(`Refusing hard-linked output: ${file.path}`);
        writer.stage(file.path, file.content, { mode: file.executable === undefined ? null : file.executable ? 0o111 : 0 });
    }
    let serverKeys = { ...state.serverKeys };
    const extra = [];
    const erased = [];
    const created = new Set(state.createdMcp);
    for (const rel of new Set([...Object.keys(serverKeys), ...(mcp ? [mcp.path] : [])])) {
        if (!mcp || mcp.path !== rel)
            throw new Error(`Invalid MCP state path: ${rel}`);
        const commit = planMcp(root, mcp, serverKeys[rel] ?? {}, created.has(rel));
        if (!commit) {
            delete serverKeys[rel];
            created.delete(rel);
            continue;
        }
        if (commit.created)
            created.add(rel);
        if (Object.keys(commit.hashes).length)
            serverKeys = { ...serverKeys, [rel]: commit.hashes };
        else {
            delete serverKeys[rel];
            created.delete(rel);
        }
        extra.push(rel);
        if (commit.remove)
            erased.push(rel);
        else if (commit.changed) {
            writer.stage(rel, commit.content, { adopt: true });
            writer.released.add(rel);
        }
    }
    const atomic = { paths: new Set([adapter.configPath]), restoreOriginalMode: true };
    const removed = await writer.transaction(extra, async () => {
        const removed = writer.apply(undefined, atomic);
        for (const rel of erased)
            rmSync(path.join(root, rel));
        return [...removed, ...erased];
    }, { atomic });
    return { state: { target: adapter.target, files: { ...writer.files }, serverKeys, createdMcp: [...created] }, written: writer.written, updated: writer.updated, removed };
}
function planMcp(root, mcp, previous, created) {
    const file = destination(root, mcp.path);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    const previousNames = Object.keys(previous);
    if (!Object.keys(mcp.servers).length && (!stat || !previousNames.length))
        return null;
    const before = stat ? readFileSync(file, 'utf8') : null;
    const doc = before === null ? mcp.schema ? { $schema: mcp.schema } : {} : JSON.parse(before);
    if (!object(doc) || (mcp.section && doc[mcp.section] !== undefined && !object(doc[mcp.section])))
        throw new Error(`${mcp.path}: expected an MCP document`);
    const scope = mcp.section ? doc[mcp.section] ?? {} : doc;
    const key = mcp.key;
    const old = scope[key];
    if (old !== undefined && !object(old))
        throw new Error(`${mcp.path}: expected a server map`);
    for (const name of previousNames) {
        if (old && Object.hasOwn(old, name) && serverHash(old[name]) !== previous[name])
            throw new Error(`Edited MCP server: ${name}`);
    }
    const merged = mergeMcpServers(scope, mcp.servers, previousNames, { key });
    if (merged.kept.length)
        throw new Error(`MCP server conflict: ${merged.kept.join(', ')}`);
    const next = mcp.section ? { ...doc, [mcp.section]: merged.document } : merged.document;
    const content = `${JSON.stringify(next, null, 2)}\n`;
    const emptyScope = Object.keys(merged.document).every(k => k === key) && !Object.keys(merged.servers).length;
    const remove = !!stat && created && emptyScope && (!mcp.section
        || Object.keys(doc).every(k => k === mcp.section || (k === '$schema' && doc[k] === mcp.schema)));
    return { hashes: Object.fromEntries(merged.owned.map(name => [name, serverHash(mcp.servers[name])])), changed: !sameServerConfig(next, doc), content,
        created: !stat, remove };
}
