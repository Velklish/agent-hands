import path from 'node:path';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { fields, preparedServer, serverFields, stringList } from './stdio.js';
import { copyEntries, Writer } from './writer.js';
import { sha256, toPosix } from './fs.js';
import { SHARED_DIR, validateSkill } from './skills.js';
import { stageContent } from './content.js';
import { readRule, selectRuleEntries } from './rule-files.js';
import { mergeMcpServers, object, resolveEnvironment, sameServerConfig, serverHash, valueEnvironmentNames, writeToolRecord } from './mcp.js';
import { isMergedMcpPath, isTarget, mcpReporter } from './adapter.js';
import { LayoutMcpError, readMcpPolicy } from './mcp-policy.js';
export class LayoutConflictError extends Error {
    output;
    first;
    second;
    constructor(output, first, second) {
        super(`Output collision: ${output} (${first ?? '?'} / ${second})`);
        this.output = output;
        this.first = first;
        this.second = second;
    }
}
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
    const input = fields(value, 'layout', ['root', 'target', 'skills', 'sharedDirs', 'servers', 'subagents', 'rules', 'rulesMode', 'env', 'writeTools', 'supportingFiles', 'scope', 'mcp']);
    const { root } = input;
    if (typeof root !== 'string' || !path.isAbsolute(root))
        throw new TypeError('Expected an absolute workspace root');
    const adapter = select(input.target);
    const scope = input.scope === undefined ? 'all' : input.scope;
    if (scope !== 'all' && scope !== 'resources' && scope !== 'mcp')
        throw new TypeError('Invalid layout scope');
    const rulesMode = input.rulesMode === undefined ? 'copy' : input.rulesMode;
    if (rulesMode !== 'copy' && rulesMode !== 'select')
        throw new TypeError('Invalid layout rule mode');
    const policy = readMcpPolicy(input.mcp);
    if (policy.mode === 'merge' && !isMergedMcpPath(adapter.configPath, adapter.target))
        throw new TypeError('Target does not support per-key MCP ownership');
    if (policy.resetInheritedAgents && !adapter.agentResets)
        throw new TypeError('Target does not support inherited agent resets');
    if ((policy.comments !== undefined || policy.transportReference !== undefined) && !adapter.acceptsMcpReference)
        throw new TypeError('Target does not support MCP comments or a transport reference');
    const diagnostics = [];
    const report = mcpReporter(adapter, policy, diagnostics);
    const supportingFiles = input.supportingFiles ?? 'strict';
    if (supportingFiles !== 'strict' && supportingFiles !== 'skip-nonregular')
        throw new TypeError('Unknown supporting file policy');
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
    const ruleEntries = list(input, 'rules');
    const rules = scope === 'mcp' ? [] : selectRuleEntries(ruleEntries);
    const serverEntries = list(input, 'servers');
    const serverNames = new Set();
    const literal = new Set();
    const definitions = Object.fromEntries((scope === 'resources' ? [] : serverEntries).flatMap(entry => {
        const raw = fields(entry, 'server', ['name', 'definition', 'source', 'placeholders']);
        if (typeof raw.name !== 'string' || !raw.name.trim())
            throw new TypeError('Expected a server name');
        const name = raw.name;
        unique(serverNames, name, 'server');
        if (raw.placeholders !== undefined && raw.placeholders !== 'native' && raw.placeholders !== 'literal')
            throw new TypeError('Invalid server placeholder policy');
        if ((raw.placeholders ?? policy.placeholders) === 'literal')
            literal.add(name);
        if (policy.compatibility !== 'report')
            return [preparedServer(entry)];
        const definition = prepareCompatibleServer(raw, adapter, report);
        return definition ? [[name, definition]] : [];
    }));
    const env = input.env === undefined ? undefined : environment(input.env);
    const resolved = env ? Object.fromEntries(Object.entries(definitions).flatMap(([name, definition]) => {
        if (literal.has(name))
            return [[name, definition]];
        const raw = { name, definition: resolveEnvironment(definition, env) };
        if (policy.compatibility !== 'report')
            return [preparedServer(raw)];
        const next = prepareCompatibleServer(raw, adapter, report);
        return next ? [[name, next]] : [];
    })) : definitions;
    const requiredVars = valueEnvironmentNames(Object.fromEntries(Object.entries(resolved).filter(([name]) => !literal.has(name))));
    const writeTools = input.writeTools === undefined ? undefined : collectWriteTools(input.writeTools, definitions);
    const entries = new Map();
    const hashes = new Map();
    const origins = new Map();
    const sources = [];
    const resources = new Map();
    const notices = [];
    const remember = (rel, relativePath, owner) => {
        const output = toPosix(rel);
        if (!resources.has(output))
            resources.set(output, { path: output, relativePath: toPosix(relativePath), owner });
    };
    const stage = (rel, content, executable, origin = rel) => {
        const key = toPosix(rel).toLowerCase();
        const digest = sha256(content);
        const previous = entries.get(key);
        if (previous && (previous.path !== toPosix(rel) || hashes.get(key) !== digest || previous.executable !== executable)) {
            throw new LayoutConflictError(toPosix(rel), origins.get(key), origin);
        }
        entries.set(key, { path: toPosix(rel), content, ...(executable === undefined ? {} : { executable }) });
        hashes.set(key, digest);
        origins.set(key, origin);
    };
    if (scope !== 'mcp')
        stageContent({ stage: (rel, content, owner) => { stage(rel, content); remember(rel, path.basename(rel), owner); }, copyDir(src, dest, owner, origin) {
                const scan = (initial = false) => [...copyEntries(directory(src), dest, { regularOnly: supportingFiles === 'strict', skipped: entry => {
                            if (initial)
                                notices.push({ code: 'skipped-supporting-file', symbolic: entry.symbolic,
                                    resource: { path: toPosix(entry.rel), relativePath: toPosix(path.relative(dest, entry.rel)), owner } });
                        } })].sort((a, b) => a.rel.localeCompare(b.rel))
                    .map(({ src: file, rel }) => ({ rel, content: readFileSync(file), executable: (lstatSync(file).mode & 0o111) !== 0 }));
                const fingerprint = (files) => JSON.stringify(files.map(({ rel, content, executable }) => [rel, sha256(content), executable]));
                const files = scan(true);
                const hash = fingerprint(files);
                sources.push(() => { if (fingerprint(scan()) !== hash)
                    throw new Error(`Stale source: ${src}`); });
                for (const file of files) {
                    stage(file.rel, file.content, file.executable, origin ?? src);
                    remember(file.rel, path.relative(dest, file.rel), owner);
                }
            } }, adapter, { skills, sharedDirs, subagents });
    if (rulesMode === 'copy')
        for (const [index, rule] of rules.entries()) {
            const bytes = readRule(rule.file);
            const digest = sha256(bytes);
            const name = `${String(index + 1).padStart(4, '0')}.md`;
            const rel = `${rulesDir(adapter.target)}/${name}`;
            const text = bytes.toString('utf8');
            stage(rel, Buffer.from(text).equals(bytes) ? text : bytes);
            sources.push(() => { if (!lstatSync(rule.file, { throwIfNoEntry: false })?.isFile() || sha256(readFileSync(rule.file)) !== digest)
                throw new Error(`Stale source: ${rule.file}`); });
        }
    for (const { path: rel } of entries.values()) {
        for (let dir = path.posix.dirname(rel); dir !== '.'; dir = path.posix.dirname(dir)) {
            if (entries.has(dir.toLowerCase()))
                throw new Error(`Output collision: ${dir} is a parent of ${rel}`);
        }
    }
    const mcp = scope === 'resources' ? undefined : adapter.renderMcp(resolved, { policy, literal, report, watchSource: check => sources.push(check) });
    const files = [...entries.values(), ...(mcp && (!mcp.empty || policy.emitEmpty) ? [mcp.file] : [])];
    const mcpFingerprints = mcp?.document && { path: mcp.document.path, current: hashEntries(mcp.document.servers), ...(mcp.legacyHashes && { legacy: mcp.legacyHashes }) };
    const result = { [planBrand]: true, root, files: files.map(f => ({ ...f, content: typeof f.content === 'string' ? f.content : Buffer.from(f.content) })),
        resources: [...resources.values()], notices, diagnostics: structuredClone(diagnostics), ...(mcpFingerprints && { mcpFingerprints }),
        ...(rules.length ? { rules: rules.map(row => row.file) } : {}), ...(requiredVars.length ? { requiredVars } : {}), ...(writeTools ? { writeTools } : {}) };
    const resets = scope !== 'resources' && policy.resetInheritedAgents ? adapter.agentResets?.(subagents.map(agent => agent.name)) : undefined;
    applications.set(result, { adapter, root, entries: files, mcp: policy.mode === 'replace' ? undefined : mcp?.document, resets, policy, scope, rulesMode, diagnostics,
        checkSources: () => { for (const check of sources)
            check(); } });
    return result;
}
function hashEntries(entries) {
    return Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, serverHash(entry)]));
}
function prepareCompatibleServer(raw, adapter, report) {
    const name = String(raw.name);
    sourceLabel(raw.source);
    const value = raw.definition;
    const doc = fields(value, 'definition', object(value) ? Object.keys(value) : []);
    if (adapter.preservesServerSettings) {
        return Object.fromEntries(Object.entries(doc).filter(([, value]) => value !== undefined).map(([key, value]) => [key, jsonData(value)]));
    }
    const command = typeof doc.command === 'string' && !!doc.command.trim();
    const url = typeof doc.url === 'string' && !!doc.url.trim();
    if ((doc.command === undefined || typeof doc.command === 'string') && (doc.url === undefined || typeof doc.url === 'string') && !command && !url) {
        report({ code: 'unsupported-transport', server: name }, `${name}: missing command or url`);
        return undefined;
    }
    const known = {};
    const dropped = [];
    for (const [key, value] of Object.entries(doc)) {
        if (value === undefined)
            continue;
        if (key === 'tool_timeout_sec' && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
            report({ code: 'invalid-timeout', server: name, field: key }, `${name}: invalid ${key}`, !adapter.reportsInvalidTimeout);
        }
        else if ((command && ['headers', 'http_headers_helper'].includes(key)) || (url && ['args', 'env'].includes(key)))
            continue;
        else if (serverFields.includes(key))
            known[key] = value;
        else
            dropped.push(key);
    }
    if (dropped.length)
        report({ code: 'unsupported-fields', server: name, keys: dropped }, `${name}: unsupported fields ${dropped.join(', ')}`);
    const [, definition] = preparedServer({ name, definition: known });
    return definition;
}
function jsonData(value, ancestors = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
        return value;
    if (ancestors.has(value))
        throw new TypeError('Expected acyclic JSON server settings');
    ancestors.add(value);
    try {
        if (Array.isArray(value))
            return Array.from({ length: value.length }, (_, i) => jsonData(Object.getOwnPropertyDescriptor(value, i)?.value, ancestors));
        const data = fields(value, 'server settings', object(value) ? Object.keys(value) : []);
        return Object.fromEntries(Object.entries(data).map(([key, item]) => [key, jsonData(item, ancestors)]));
    }
    finally {
        ancestors.delete(value);
    }
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
    const { target, files, serverKeys, createdMcp, agentResets } = fields(value, 'ownership state', ['target', 'files', 'serverKeys', 'createdMcp', 'agentResets']);
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
    const resets = agentResets === undefined ? undefined : stringList(agentResets, 'Expected an array of agent reset names');
    if (resets) {
        if (target !== undefined && target !== 'opencode')
            throw new TypeError('Invalid ownership target for inherited agent resets');
        const seen = new Set();
        for (const name of resets)
            unique(seen, segment(name, 'agent reset'), 'agent reset');
    }
    return { ...(target === undefined ? {} : { target }), files: ownedFiles, serverKeys: ownedKeys, createdMcp: created, ...(resets && { agentResets: resets }) };
}
export async function applyLayout(plan, previous = { files: {} }, options) {
    const application = applications.get(plan);
    if (!application)
        throw new Error('Expected a plan returned by planLayout');
    const requestedStage = options === undefined ? undefined : fields(options, 'layout apply options', ['stage']).stage;
    if (requestedStage !== undefined && typeof requestedStage !== 'function')
        throw new TypeError('Expected a layout stage callback');
    const { root, entries, mcp, adapter, scope, rulesMode, policy, resets } = application;
    if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory())
        throw new Error(`Expected a regular workspace root: ${root}`);
    application.checkSources();
    const state = readLayoutState(previous);
    if (state.target !== undefined && state.target !== adapter.target)
        throw new Error(`Ownership belongs to ${state.target}`);
    if (state.agentResets?.length && !adapter.agentResets)
        throw new Error('Invalid target for inherited agent reset state');
    const touchedFiles = Object.fromEntries(Object.entries(state.files).filter(([rel]) => {
        if (scope === 'mcp')
            return rel === adapter.configPath;
        if (scope === 'resources' && rel === adapter.configPath)
            return false;
        return rulesMode !== 'select' || !rel.startsWith(`${rulesDir(adapter.target)}/`);
    }));
    const retainedFiles = Object.fromEntries(Object.entries(state.files).filter(([rel]) => !Object.hasOwn(touchedFiles, rel)));
    if (mcp)
        delete touchedFiles[mcp.path];
    const diagnostics = structuredClone(application.diagnostics);
    const writer = new Writer(root, { files: touchedFiles });
    const watched = new Map();
    const snapshot = (rel) => {
        const file = destination(root, rel);
        const stat = lstatSync(file, { throwIfNoEntry: false });
        if (!stat)
            return null;
        if (!stat.isFile())
            throw new Error(`Output conflict: ${rel}`);
        return `${stat.mode}:${stat.nlink}:${sha256(readFileSync(file))}`;
    };
    const watch = (rel) => { if (!watched.has(rel))
        watched.set(rel, snapshot(rel)); };
    const assertCurrent = () => {
        if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory())
            throw new Error(`Expected a regular workspace root: ${root}`);
        application.checkSources();
        for (const [rel, before] of watched)
            if (snapshot(rel) !== before)
                throw new Error(`Stale output: ${rel}`);
    };
    for (const rel of Object.keys(touchedFiles)) {
        if (![adapter.skillsDir, adapter.agentsDir, rulesDir(adapter.target)].some(dir => rel.startsWith(dir + '/'))
            && !(rel === adapter.configPath && !mcp))
            throw new Error(`Invalid ownership path: ${rel}`);
        watch(rel);
    }
    for (const file of entries) {
        const abs = destination(root, file.path);
        if (file.path === mcp?.path)
            continue;
        watch(file.path);
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
    const securePaths = new Set([adapter.configPath]);
    for (const rel of scope === 'resources' ? [] : new Set([...Object.keys(serverKeys), ...(mcp ? [mcp.path] : [])])) {
        if (!mcp || mcp.path !== rel)
            throw new Error(`Invalid MCP state path: ${rel}`);
        watch(rel);
        const commit = planMcp(root, mcp, serverKeys[rel] ?? {}, created.has(rel), policy, adapter.target, diagnostics);
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
    let nextResets = state.agentResets;
    if (scope !== 'resources' && (resets || state.agentResets?.length)) {
        const document = resets ?? adapter.agentResets?.([]);
        if (!document)
            throw new Error('Invalid inherited agent reset state');
        watch(document.path);
        const reset = planAgentResets(root, document, state.agentResets ?? [], adapter.target);
        nextResets = reset.owned;
        if (reset.content !== undefined) {
            writer.stage(document.path, reset.content, { adopt: true });
            writer.released.add(document.path);
            extra.push(document.path);
        }
    }
    const nextState = (files) => ({ target: adapter.target, files: { ...retainedFiles, ...files }, serverKeys, createdMcp: [...created], ...(nextResets && { agentResets: nextResets }) });
    if (requestedStage) {
        writer.validate();
        const finalFiles = Object.fromEntries(writer.staged.filter(file => !writer.released.has(file.rel)).map(file => [file.rel, file.newHash]));
        const changed = writer.staged.filter(file => file.diskHash !== file.newHash || (process.platform !== 'win32' && file.mode !== null && (lstatSync(file.abs).mode & 0o111) !== file.mode));
        const removes = [...Object.keys(touchedFiles).filter(rel => !Object.hasOwn(finalFiles, rel) && !writer.released.has(rel) && watched.get(rel) !== null), ...erased];
        const writes = changed.map(file => ({ path: file.rel, content: Buffer.from(file.buf), secure: securePaths.has(file.rel), ...(file.mode !== null && { executable: !!file.mode }) }));
        const stagedState = nextState(finalFiles);
        await requestedStage({ writes, removes: [...removes], state: structuredClone(stagedState), diagnostics: structuredClone(diagnostics), assertCurrent });
        return { state: stagedState, written: changed.filter(file => file.diskHash === null).map(file => file.rel), updated: changed.filter(file => file.diskHash !== null).map(file => file.rel), removed: removes, diagnostics };
    }
    const atomic = { paths: securePaths, restoreOriginalMode: true };
    const removed = await writer.transaction(extra, async () => {
        const removed = writer.apply(assertCurrent, atomic);
        for (const rel of erased)
            rmSync(path.join(root, rel));
        return [...removed, ...erased];
    }, { atomic });
    return { state: nextState(writer.files), written: writer.written, updated: writer.updated, removed, diagnostics };
}
function planMcp(root, mcp, previous, created, policy, target, diagnostics) {
    const file = destination(root, mcp.path);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    const previousNames = Object.keys(previous);
    const noWork = !Object.keys(mcp.servers).length && (!stat || !previousNames.length) && (stat || !policy.emitEmpty);
    if (noWork && (!stat || policy.compatibility !== 'report'))
        return null;
    const before = stat ? readFileSync(file, 'utf8') : null;
    const invalid = (reason) => new LayoutMcpError(`${mcp.path}: ${reason}`, { code: 'invalid-document', target, path: mcp.path, reason });
    let doc;
    try {
        doc = before === null ? mcp.schema ? { $schema: mcp.schema } : {} : JSON.parse(before);
    }
    catch {
        throw policy.compatibility === 'report' ? invalid('invalid JSON') : new SyntaxError(`${mcp.path}: invalid JSON`);
    }
    if (!object(doc) || (mcp.section && doc[mcp.section] !== undefined && !object(doc[mcp.section])))
        throw invalid('expected an MCP document');
    const scope = mcp.section ? doc[mcp.section] ?? {} : doc;
    const key = mcp.key;
    const old = scope[key];
    if (old !== undefined && !object(old))
        throw invalid('expected a server map');
    if (noWork)
        return null;
    for (const name of previousNames) {
        if (old && Object.hasOwn(old, name) && serverHash(old[name]) !== previous[name]
            && !(policy.compatibility === 'report' && Object.hasOwn(mcp.servers, name) && sameServerConfig(old[name], mcp.servers[name]))) {
            throw new LayoutMcpError(`Edited MCP server: ${name}`, { code: 'edited-server', server: name, target, path: mcp.path });
        }
    }
    const merged = mergeMcpServers(scope, mcp.servers, previousNames, { key, adoptIdentical: policy.unowned === 'adopt-identical' });
    for (const server of merged.kept) {
        const diagnostic = { code: 'foreign-server', target, path: mcp.path, server };
        if (!policy.unowned || policy.unowned === 'refuse')
            throw new LayoutMcpError(`MCP server conflict: ${server}`, diagnostic);
        diagnostics.push(diagnostic);
    }
    const next = mcp.section ? { ...doc, [mcp.section]: merged.document } : merged.document;
    const content = `${JSON.stringify(next, null, 2)}\n`;
    const emptyScope = Object.keys(merged.document).every(k => k === key) && !Object.keys(merged.servers).length;
    const ownedRemoval = policy.removeEmpty === 'owned-keys' && !mcp.section && previousNames.some(name => old && Object.hasOwn(old, name));
    const remove = !!stat && policy.removeEmpty !== 'keep' && (created || ownedRemoval) && emptyScope && (!mcp.section
        || Object.keys(doc).every(k => k === mcp.section || (k === '$schema' && doc[k] === mcp.schema)));
    return { hashes: Object.fromEntries(merged.owned.map(name => [name, serverHash(mcp.servers[name])])), changed: !sameServerConfig(next, doc), content,
        created: !stat, remove };
}
function planAgentResets(root, document, previous, target) {
    if (!Object.keys(document.servers).length && !previous.length)
        return { owned: [] };
    const file = destination(root, document.path);
    const before = lstatSync(file, { throwIfNoEntry: false }) ? readFileSync(file, 'utf8') : null;
    if (before === null && !Object.keys(document.servers).length)
        return { owned: [] };
    const invalid = (reason) => new LayoutMcpError(`${document.path}: ${reason}`, { code: 'invalid-document', target, path: document.path, reason });
    let input;
    try {
        input = before === null ? {} : JSON.parse(before);
    }
    catch {
        throw invalid('invalid JSON');
    }
    if (!object(input))
        throw invalid('expected a configuration object');
    const old = input[document.key];
    if (old !== undefined && !object(old))
        throw invalid('expected an agent map');
    for (const name of new Set([...previous, ...Object.keys(document.servers)])) {
        if (old && Object.hasOwn(old, name) && !sameServerConfig(old[name], document.entry)) {
            throw new LayoutMcpError(`${document.path}: edited agent reset: ${name}`, { code: 'edited-agent-reset', target, path: document.path, server: name });
        }
    }
    const merged = mergeMcpServers(input, document.servers, previous, { key: document.key });
    if (!Object.keys(merged.servers).length)
        delete merged.document[document.key];
    const content = sameServerConfig(input, merged.document) ? undefined : `${JSON.stringify(merged.document, null, 2)}\n`;
    return { owned: merged.owned, content };
}
