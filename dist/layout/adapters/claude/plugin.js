import path from 'node:path';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sha256 } from '../../fs.js';
import { snapshot } from '../../../hooks/hook-journal.js';
import { inspectRegistration, registrationEvidence, registrationPreflight, registrationUnchanged } from './registration.js';
export function registrationFiles(root, home) {
    const profile = path.join(realpathSync(home), '.claude');
    return [path.join(profile, 'plugins/known_marketplaces.json'), path.join(profile, 'plugins/installed_plugins.json'), path.join(root, '.claude/settings.local.json'), path.join(profile, 'settings.json'), path.join(root, '.agent-hands/hooks/claude/registration.json')];
}
export function plugin(root, settings, input) {
    const { plugin, marketplace, version, fingerprint } = input;
    if (![plugin, marketplace].every(name => typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name) && !Object.hasOwn(Object.prototype, name)) || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version) || !/^[a-f0-9]{64}$/.test(fingerprint))
        throw new TypeError('Invalid plugin identity');
    if (![input.accountHome, input.directory, input.executable].every(v => path.isAbsolute(v) && path.normalize(v) === v))
        throw new TypeError('Expected absolute plugin paths');
    const directory = input.directory, home = realpathSync(input.accountHome);
    const relative = path.relative(root, directory);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative))
        throw new TypeError('Expected a workspace-local plugin source');
    const physical = input.expectedPhysicalDirectory;
    if (physical !== undefined) {
        if (typeof physical !== 'string' || !path.isAbsolute(physical) || path.normalize(physical) !== physical || !physical.startsWith(home + path.sep))
            throw new TypeError('Expected a pinned physical source under the selected account home');
    }
    const checkSource = () => {
        if (physical !== undefined && (realpathSync(path.dirname(directory)) !== path.dirname(directory) || !lstatSync(directory).isSymbolicLink() || !lstatSync(physical).isDirectory() || realpathSync(physical) !== physical))
            throw new Error('Unconfirmed plugin source alias');
        if (realpathSync(directory) !== (physical ?? directory))
            throw new Error('Plugin source changed');
    };
    const files = registrationFiles(root, home);
    const changes = files.map(file => { const before = snapshot(file); return { file, before, after: before }; });
    const read = ([settings, marketplaces, installations]) => ({ settings, marketplaces, installations });
    const before = read([settings.before, ...changes.slice(0, 2).map(c => c.before)]);
    const current = inspectRegistration({ marketplace, plugin, directory }, root, before);
    const receipt = changes.at(-1);
    const prior = receipt.before === null ? input.legacy : JSON.parse(receipt.before);
    if (receipt.before !== null && (!prior || JSON.stringify(prior) !== receipt.before || Object.keys(prior).length !== 5 || prior.plugin !== plugin || prior.marketplace !== marketplace || prior.directory !== directory))
        throw new Error('Invalid registration receipt or source mismatch');
    if (prior && (typeof prior.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(prior.version) || !/^[a-f0-9]{64}$/.test(prior.fingerprint)))
        throw new Error('Invalid plugin registration receipt');
    const destination = (v) => path.join(home, '.claude/plugins/cache', marketplace, plugin, v);
    if (current.installed !== !!prior || (prior && (prior.version !== current.version || current.installPath !== destination(prior.version))) || (current.marketplace && !current.installed))
        throw new Error('Unconfirmed project plugin registration');
    receipt.after = JSON.stringify({ plugin, marketplace, directory, fingerprint, version });
    const steps = [];
    if (prior?.fingerprint === fingerprint && current.version === version)
        return { changes, steps, checkSource };
    const binary = realpathSync(input.executable), binarySha256 = sha256(readFileSync(binary));
    const request = { binarySha256, version: '2.1.311 (Claude Code)', platform: process.platform, arch: process.arch, marketplace, plugin, directory, step: 'install' };
    registrationPreflight(request, root, before);
    for (const step of [...(current.marketplace ? [] : ['add']), current.installed ? 'update' : 'install']) {
        const config = { ...request, step }, protectedFiles = [settings.file, ...files.slice(0, 2)];
        steps.push({ files: protectedFiles, retain: files.slice(0, 2), run: () => {
                checkSource();
                if (sha256(readFileSync(binary)) !== binarySha256)
                    throw new Error('Plugin binary changed');
                const args = step === 'add' ? ['marketplace', 'add', directory] : [step, `${plugin}@${marketplace}`];
                const result = spawnSync(binary, ['plugin', ...args, '--scope', 'project'], { cwd: root, timeout: 120000, stdio: 'ignore', env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PATH: process.env.PATH, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' } });
                return result.status;
            }, verify: (a, b, exit) => { checkSource(); return registrationEvidence(config, root, version, read(a), read(b), exit, destination(version)); }, verifyFailure: (a, b) => registrationUnchanged(config, read(a), read(b)) });
    }
    return { changes, steps, checkSource };
}
