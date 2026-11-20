import { isDeepStrictEqual } from 'node:util';
const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const name = (s) => /^[a-z0-9][a-z0-9-]*$/.test(s) && !Object.hasOwn(Object.prototype, s);
const id = (s) => s.split('@').length === 2 && s.split('@').every(name);
const dictionary = (value, accepts) => record(value) && Object.entries(value).every(([k, v]) => accepts(k, v));
const source = (v) => record(v) && keys(v, ['source']) && record(v.source) && keys(v.source, ['source', 'path']) && v.source.source === 'directory' && typeof v.source.path === 'string' && v.source.path.startsWith('/');
const callback = (v, timeouts) => record(v) && keys(v, ['type', 'command', 'timeout']) && v.type === 'command' && typeof v.command === 'string' && v.command.length > 0 && (!Object.hasOwn(v, 'timeout') || (typeof v.timeout === 'number' && timeouts.includes(v.timeout)));
const question = 'AskUserQuestion|AskQuestion|request_user_input';
const identifier = '[a-z][a-z0-9]*(?:_[a-z0-9]+)*';
const pairedTools = new RegExp(`^mcp__${identifier}__\\(${identifier}\\|${identifier}\\)$`);
const macMatchers = {
    SessionStart: ['startup|resume'], Stop: [], PreToolUse: [question, 'Write'],
    PostToolUse: [question], PostToolUseFailure: [question],
};
const linuxKeys = ['hooks', 'env', 'enabledPlugins', 'extraKnownMarketplaces'];
const macKeys = Object.keys({ hooks: true, enableAllProjectMcpServers: true, skillOverrides: true, enabledPlugins: true, extraKnownMarketplaces: true });
function group(value, event, mac) {
    if (!record(value) || !keys(value, ['matcher', 'hooks']) || !Array.isArray(value.hooks) || !value.hooks.every(row => callback(row, mac ? [4, 30] : [4])))
        return false;
    if (!mac)
        return event === 'PreToolUse' && value.matcher === 'Write';
    return Object.hasOwn(macMatchers, event) && (!Object.hasOwn(value, 'matcher') || (typeof value.matcher === 'string' && (macMatchers[event].includes(value.matcher) ||
        (event === 'PostToolUse' && pairedTools.test(value.matcher)))));
}
function readSettings(text, platform) {
    let doc;
    try {
        doc = JSON.parse(text);
    }
    catch {
        throw new Error('Unsupported project settings');
    }
    // Reject duplicate members and lossy numeric conversions before trusting parsed values.
    const tokens = text.match(/"(?:\\.|[^"\\])*"|[^\s]/gs)?.join('');
    const registrationOnly = platform === 'darwin' && record(doc) && keys(doc, ['enabledPlugins', 'extraKnownMarketplaces']);
    const projected = (platform === 'darwin' && !registrationOnly) || (record(doc) && Object.hasOwn(doc, 'enableAllProjectMcpServers'));
    if (JSON.stringify(doc) !== tokens || !record(doc) || !keys(doc, registrationOnly ? ['enabledPlugins', 'extraKnownMarketplaces'] : projected ? macKeys : linuxKeys)
        || (projected && (!macKeys.every(k => Object.hasOwn(doc, k)) || doc.enableAllProjectMcpServers !== true || !dictionary(doc.skillOverrides, (k, v) => name(k) && v === 'off')))
        || ('hooks' in doc && !dictionary(doc.hooks, (k, v) => (projected ? Object.hasOwn(macMatchers, k) : k === 'PreToolUse') && Array.isArray(v) && v.every(row => group(row, k, projected))))
        || ('env' in doc && !dictionary(doc.env, (k, v) => /^[A-Z_][A-Z0-9_]*$/.test(k) && typeof v === 'string'))
        || ('enabledPlugins' in doc && !dictionary(doc.enabledPlugins, (k, v) => id(k) && typeof v === 'boolean'))
        || ('extraKnownMarketplaces' in doc && !dictionary(doc.extraKnownMarketplaces, (k, v) => name(k) && source(v))))
        throw new Error('Unsupported project settings');
    return doc;
}
export function registrationPostcondition(request, before) {
    const binary = request.platform === 'linux' ? '2e2496c9a8065df93acb0fca2d341f59a6b8777649b2e025ab8c9bcd5eef61f3'
        : request.platform === 'darwin' ? '85d8c08707fcfd1e78ffa0204eefbc6ec9e4fe22f375fb2767ef85d957ed3161' : null;
    if (binary === null || request.binarySha256 !== binary || request.version !== '2.1.311 (Claude Code)' || request.arch !== 'arm64')
        throw new Error('Unsupported registration binary');
    if (!name(request.marketplace) || !name(request.plugin) || !request.directory.startsWith('/') || !['add', 'install', 'update'].includes(request.step))
        throw new Error('Unsupported registration request');
    const expected = readSettings(before, request.platform);
    const known = expected.extraKnownMarketplaces;
    const desired = { source: { source: 'directory', path: request.directory } };
    if (known && Object.hasOwn(known, request.marketplace) && !isDeepStrictEqual(known[request.marketplace], desired))
        throw new Error('Conflicting marketplace source');
    const enabled = expected.enabledPlugins;
    const subject = `${request.plugin}@${request.marketplace}`;
    if (enabled?.[subject] === false)
        throw new Error('Plugin disabled by project');
    if (request.step === 'add')
        expected.extraKnownMarketplaces = { ...known, [request.marketplace]: desired };
    if (request.step === 'install')
        expected.enabledPlugins = { ...enabled, [subject]: true };
    return after => {
        try {
            if (after === null)
                return false;
            const actual = readSettings(after, request.platform);
            if (request.step === 'add' && !Object.hasOwn(expected, 'enabledPlugins') && isDeepStrictEqual(actual.enabledPlugins, {}))
                delete actual.enabledPlugins;
            return isDeepStrictEqual(actual, expected);
        }
        catch {
            return false;
        }
    };
}
export function registrationUnchanged(request, before, after) {
    if (before.marketplaces !== after.marketplaces || before.installations !== after.installations)
        return false;
    if (before.settings === after.settings)
        return true;
    if (before.settings === null || after.settings === null)
        return false;
    try {
        const expected = readSettings(before.settings, request.platform);
        const current = readSettings(after.settings, request.platform);
        if (!Object.hasOwn(expected, 'enabledPlugins') && isDeepStrictEqual(current.enabledPlugins, {}))
            delete current.enabledPlugins;
        return isDeepStrictEqual(expected, current);
    }
    catch {
        return false;
    }
}
export function registrationPreflight(request, project, before) {
    registrationPostcondition(request, before.settings ?? '{}');
    return inspectRegistration(request, project, before);
}
export function inspectRegistration(request, project, before) {
    const markets = registry(before.marketplaces);
    const installs = registry(before.installations);
    if (before.installations !== null && (!keys(installs, ['version', 'plugins']) || installs.version !== 2 || !record(installs.plugins)))
        throw new Error('Unsupported installation registry');
    const rows = installs.plugins?.[`${request.plugin}@${request.marketplace}`] ?? [];
    if (!Array.isArray(rows) || !rows.every(record))
        throw new Error('Unsupported plugin rows');
    const matching = rows.filter(row => row.scope === 'project' && row.projectPath === project);
    if (matching.length > 1)
        throw new Error('Ambiguous project installation');
    const source = markets[request.marketplace];
    if (source !== undefined && (!record(source) || source.installLocation !== request.directory || !isDeepStrictEqual(source.source, { source: 'directory', path: request.directory })))
        throw new Error('Conflicting registered marketplace');
    if (matching.length && source === undefined)
        throw new Error('Incomplete project registration');
    return { marketplace: source !== undefined, installed: matching.length === 1, version: matching[0]?.version, installPath: matching[0]?.installPath };
}
function registry(raw) {
    if (raw === null)
        return {};
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new Error('Unsupported plugin registry');
    }
    if (!record(value) || JSON.stringify(value) !== raw.match(/"(?:\\.|[^"\\])*"|[^\s]/gs)?.join(''))
        throw new Error('Unsupported plugin registry');
    return value;
}
export function registrationEvidence(request, project, version, before, after, exit, expectedPath) {
    if (exit !== 0 || !project.startsWith('/') || !version)
        return false;
    try {
        if (!registrationPostcondition(request, before.settings ?? '{}')(after.settings))
            return false;
        const previousMarkets = registry(before.marketplaces);
        const markets = registry(after.marketplaces);
        const entry = markets[request.marketplace];
        if (!record(entry) || entry.installLocation !== request.directory || !isDeepStrictEqual(entry.source, { source: 'directory', path: request.directory }))
            return false;
        if (request.step === 'add') {
            if (Object.hasOwn(previousMarkets, request.marketplace))
                return false;
            delete markets[request.marketplace];
            return isDeepStrictEqual(previousMarkets, markets) && before.installations === after.installations;
        }
        if (before.marketplaces !== after.marketplaces)
            return false;
        const load = (raw) => {
            if (raw === null)
                return {};
            const doc = registry(raw);
            if (!keys(doc, ['version', 'plugins']) || doc.version !== 2 || !record(doc.plugins))
                throw new Error('Unknown installation registry');
            return doc.plugins;
        };
        const previous = load(before.installations);
        const installed = load(after.installations);
        const subject = `${request.plugin}@${request.marketplace}`;
        const rows = installed[subject];
        const ours = (r) => record(r) && r.scope === 'project' && r.projectPath === project;
        if (!Array.isArray(rows))
            return false;
        const selected = rows.filter(ours);
        if (selected.length !== 1 || selected[0].version !== version || typeof selected[0].installPath !== 'string' || !selected[0].installPath.startsWith('/') || (expectedPath !== undefined && selected[0].installPath !== expectedPath))
            return false;
        const prior = Object.hasOwn(previous, subject) ? previous[subject] : [];
        if (!Array.isArray(prior) || prior.filter(ours).length !== (request.step === 'update' ? 1 : 0))
            return false;
        previous[subject] = prior.filter(r => !ours(r));
        installed[subject] = rows.filter(r => !ours(r));
        return isDeepStrictEqual(previous, installed);
    }
    catch {
        return false;
    }
}
