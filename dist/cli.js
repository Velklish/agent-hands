import { closeSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseLayout, readLayoutState, applyLayout, runRepositoryCommand } from 'agent-hands';
const usage = `agent-hands <plan|apply|path|clone|fresh|zone> --config FILE [--state FILE] [TARGET]
plan previews paths; apply requires a trusted state file outside the workspace.
path and zone are local reads; clone and fresh explicitly contact remotes.`;
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function navigation(value) {
    if (!record(value) || typeof value.root !== 'string' || !path.isAbsolute(value.root) ||
        Object.keys(value).some(k => !['root', 'hosts'].includes(k)))
        throw Error('Expected an absolute root and optional hosts');
    const hosts = new Map();
    if ('hosts' in value) {
        if (!record(value.hosts))
            throw Error('Expected a host map');
        for (const [host, zone] of Object.entries(value.hosts)) {
            if (zone !== 'repos' && zone !== 'external')
                throw Error(`Unknown zone for ${host}`);
            hosts.set(host.toLowerCase(), zone);
        }
    }
    return { root: value.root, routeHost: authority => {
            const zone = hosts.get(authority.toLowerCase());
            return zone && { zone, gitlab: zone === 'repos' };
        } };
}
async function apply(plan, file, config) {
    const root = realpathSync(plan.root);
    const state = path.join(realpathSync(path.dirname(path.resolve(file))), path.basename(file));
    const relative = path.relative(root, state);
    if ((!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) || state === realpathSync(config))
        throw Error('Select a separate trusted ownership file outside the workspace');
    const lock = state + '.lock';
    const fd = openSync(lock, 'wx', 0o600);
    let committed = false;
    try {
        const stat = lstatSync(state, { throwIfNoEntry: false });
        let previous;
        if (stat) {
            if (!stat.isFile() || stat.nlink !== 1)
                throw Error('Expected a regular ownership file');
            const saved = json(state);
            if (!record(saved) || saved.root !== root || !record(saved.state))
                throw Error('Invalid ownership file for this workspace');
            previous = readLayoutState(saved.state);
        }
        const result = await applyLayout(plan, previous);
        writeFileSync(fd, JSON.stringify({ root, state: result.state }) + '\n');
        renameSync(lock, state);
        committed = true;
        return { written: result.written, updated: result.updated, removed: result.removed };
    }
    finally {
        closeSync(fd);
        // After rename the lock name is free for the next invocation.
        if (!committed)
            unlinkSync(lock);
    }
}
async function main() {
    const [command, ...args] = process.argv.slice(2);
    if (command === '--help' || command === 'help') {
        console.log(usage);
        return 0;
    }
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { config: { type: 'string' }, state: { type: 'string' } } });
    if (!values.config || !command)
        throw Error(usage);
    const cfg = json(values.config);
    if (command === 'plan' || command === 'apply') {
        if (positionals.length || (command === 'apply') !== Boolean(values.state))
            throw Error(usage);
        const plan = parseLayout(cfg);
        console.log(JSON.stringify(command === 'plan' ? { files: plan.files.map(f => f.path), requiredVars: plan.requiredVars } : await apply(plan, values.state, values.config)));
        return 0;
    }
    if (values.state || positionals.length > 1 || (command === 'zone' && positionals.length) ||
        (command !== 'path' && command !== 'zone' && command !== 'fresh' && command !== 'clone'))
        throw Error(usage);
    return runRepositoryCommand(navigation(cfg), command, { target: positionals[0] });
}
try {
    process.exitCode = await main();
}
catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
