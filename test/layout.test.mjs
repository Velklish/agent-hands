import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyLayout, parseLayout, planLayout } from '../dist/layout/plan.js';
import { directoryLink } from '../dist/layout/fs.js';
import { parse as parseToml } from 'smol-toml';
function check(label, condition, detail) { test(label, () => assert.ok(condition, detail && String(detail))); }
const scratch = tmpdir();
const box = mkdtempSync(path.join(scratch, 'layout-fixture-'));
process.once('exit', () => rmSync(box, { recursive: true, force: true }));
const fixtureRoot = (root, prefix) => mkdtempSync(path.join(root, prefix));
const directRoot = fixtureRoot(box, 'direct-');
const config = { command: 'node', args: ['server.mjs', '--stdio'] };
const server = { name: 'example', definition: config, source: 'personal' };
const direct = { root: directRoot, target: 'cursor', skills: [], servers: [server], subagents: [], rules: [] };
const expectedFile = { path: '.cursor/mcp.json', content: JSON.stringify({ mcpServers: { example: config } }, null, 2) + '\n' };
const local = planLayout(direct);
check('direct content plans the expected Cursor config in the explicit root', local.root === directRoot && isDeepStrictEqual(local.files, [expectedFile]), local);
const other = planLayout({ ...direct, root: fixtureRoot(box, 'other-'), servers: [{ ...server, source: 'another source' }] });
check('different roots and provenance yield byte-identical files', isDeepStrictEqual(other.files, local.files));
function refuses(label, input, expected) {
    let message;
    try {
        parseLayout(input);
    }
    catch (error) {
        message = error.message;
    }
    check(label, message === expected, message ?? 'accepted');
}
refuses('rejects unknown input fields', { ...direct, unknown: {} }, 'Unknown layout field: unknown');
refuses('requires an absolute root', { ...direct, root: '.' }, 'Expected an absolute workspace root');
refuses('rejects unknown harness', { ...direct, target: 'other' }, 'Unsupported layout target');
refuses('rejects missing rules', { ...direct, rules: undefined }, 'Expected an array: rules');
refuses('requires a skill record', { ...direct, skills: ['file'] }, 'Expected an object: skill');
refuses('requires a subagent record', { ...direct, subagents: ['file'] }, 'Expected an object: subagent');
refuses('requires absolute rule sources', { ...direct, rules: ['file'] }, 'Expected an absolute rule file: file');
refuses('refuses unknown metadata on a prepared server', { ...direct, servers: [{ ...server, activate: {} }] }, 'Unknown server field: activate');
refuses('refuses unknown metadata inside MCP config', { ...direct, servers: [{ ...server, definition: { ...config, execute: [] } }] }, 'Unknown definition field: execute');
refuses('refuses invalid stdio arguments', { ...direct, servers: [{ ...server, definition: { ...config, args: [false] } }] }, 'Expected string arguments for example');
refuses('refuses a hole in stdio arguments', { ...direct, servers: [{ ...server, definition: { ...config, args: new Array(1) } }] }, 'Expected string arguments for example');
let serializedInput = false;
const customArgs = Object.assign([...config.args], { toJSON() { serializedInput = true; return ['changed']; } });
const customPlan = planLayout({ ...direct, servers: [{ ...server, definition: { ...config, args: customArgs } }] });
check('serializes only validated strings without calling input toJSON', !serializedInput && isDeepStrictEqual(customPlan, local), JSON.stringify({ serializedInput, files: customPlan.files }));
refuses('refuses conflicting definitions', { ...direct, servers: [server, { ...server, definition: { command: 'other' } }] }, 'Duplicate server: example');
function put(root, rel, text) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
}
const inputRoot = fixtureRoot(box, 'inputs-');
const skill = '---\nname: sample\ndescription: Example skill\n---\nUse the reference.\n';
put(inputRoot, 'sample/SKILL.md', skill);
put(inputRoot, 'sample/refs/example.md', 'Supporting file\n');
put(inputRoot, 'shared/ref.md', 'Shared supporting file\n');
const ruleOne = put(inputRoot, 'one.md', 'First rule\n');
const ruleTwo = put(inputRoot, 'two.md', 'Second rule\n');
const skills = [{ name: 'sample', dirAbs: path.join(inputRoot, 'sample') }];
const subagents = [{ name: 'checker', description: 'Checks changes', prompt: 'Read the diff.', tools: ['read'] }];
const classifier = { example: { source: 'manual', write: ['edit', 'edit'] } };
const populated = { ...direct, skills, subagents, rules: [ruleTwo, ruleOne],
    sharedDirs: [{ srcAbs: path.join(inputRoot, 'shared') }], writeTools: classifier,
    servers: [{ name: 'example', definition: { url: 'https://localhost/mcp', headers: { token: '${LAYOUT_TOKEN}' } } }],
    env: { LAYOUT_TOKEN: 'text with "quotes"' } };
const foreignManifest = 'Another delivery owns this state.\n';
put(directRoot, '.other/manifest.json', foreignManifest);
const mcpPath = put(directRoot, '.cursor/mcp.json', '{"callback":{"command":"keep"},"mcpServers":{"foreign":{"command":"keep"}}}');
const previousInode = lstatSync(mcpPath, { bigint: true }).ino;
const fullPlan = planLayout(populated);
const result = await applyLayout(fullPlan);
const text = (root, rel) => readFileSync(path.join(root, rel), 'utf8');
const paths = fullPlan.files.map(file => file.path);
if (process.platform !== 'win32')
    check('MCP merge atomically replaces the old inode with an owner-only file', (lstatSync(mcpPath).mode & 0o777) === 0o600 && lstatSync(mcpPath, { bigint: true }).ino !== previousInode);
check('planned skills include private and shared supporting files', ['sample/SKILL.md', 'sample/refs/example.md', '_shared/ref.md']
    .every(rel => paths.includes(`.cursor/skills/${rel}`)) && text(directRoot, '.cursor/skills/sample/SKILL.md') === skill);
check('canonical subagent and ordered rules are delivered', text(directRoot, '.cursor/agents/checker.md').includes('readonly: true')
    && isDeepStrictEqual(fullPlan.rules, [ruleTwo, ruleOne]) && text(directRoot, '.agents/rules/0001.md') === 'Second rule\n'
    && text(directRoot, '.agents/rules/0002.md') === 'First rule\n');
check('explicit environment values and write tools do not alter foreign config', JSON.parse(text(directRoot, '.cursor/mcp.json')).mcpServers.example.headers.token === populated.env.LAYOUT_TOKEN
    && JSON.parse(text(directRoot, '.cursor/mcp.json')).callback.command === 'keep'
    && isDeepStrictEqual(fullPlan.writeTools, [{ server: 'example', tool: 'edit' }]));
check('direct runtime neither reads nor replaces the foreign manifest', text(directRoot, '.other/manifest.json') === foreignManifest);
const repeated = await applyLayout(planLayout(populated), result.state);
check('repeated apply preserves output and ownership', isDeepStrictEqual(repeated.state, result.state)
    && !repeated.written.length && !repeated.updated.length && !repeated.removed.length);
async function fails(label, promise, pattern) {
    let message;
    try {
        await promise;
    }
    catch (error) {
        message = error.message;
    }
    check(label, typeof message === 'string' && pattern.test(message), message ?? 'accepted');
}
const conflictRoot = fixtureRoot(box, 'conflict-');
put(conflictRoot, '.cursor/skills/sample/SKILL.md', skill);
await fails('another delivery cannot claim identical managed files', applyLayout(planLayout({ ...direct, root: conflictRoot, skills, servers: [] })), /Output conflict: .cursor\/skills/);
check('conflict leaves all outputs untouched', !existsSync(path.join(conflictRoot, '.cursor/skills/sample/refs')));
put(directRoot, '.cursor/skills/foreign/SKILL.md', 'Foreign skill\n');
const ownedSkill = '.cursor/skills/sample/SKILL.md';
put(directRoot, ownedSkill, 'Manual edit\n');
await fails('prune refuses to remove an edited owned output', applyLayout(planLayout({ ...direct, servers: [] }), result.state), /edited output/);
put(directRoot, ownedSkill, skill);
const dropped = await applyLayout(planLayout({ ...direct, servers: [] }), result.state);
const leftover = JSON.parse(text(directRoot, '.cursor/mcp.json'));
check('prune removes only this delivery and leaves the foreign manifest, files, and config', dropped.removed.includes(ownedSkill)
    && !existsSync(path.join(directRoot, ownedSkill)) && text(directRoot, '.cursor/skills/foreign/SKILL.md') === 'Foreign skill\n'
    && leftover.callback.command === 'keep' && leftover.mcpServers.foreign.command === 'keep' && !leftover.mcpServers.example
    && text(directRoot, '.other/manifest.json') === foreignManifest);
await fails('an unrelated path cannot be claimed by a persisted ownership record', applyLayout(planLayout({ ...direct, servers: [] }), { files: { '.other/manifest.json': '0'.repeat(64) } }), /Invalid ownership path/);
await fails('invalid ownership hashes cannot authorize output changes', applyLayout(planLayout({ ...direct, servers: [] }), { files: { [ownedSkill]: 'not a hash' } }), /Invalid ownership hash/);
const identityRoot = fixtureRoot(box, 'identity-');
const literalName = '${SERVER}';
const identityPlan = planLayout({ ...direct, root: identityRoot,
    servers: [server, { name: literalName, definition: { command: 'node', args: ['${SERVER}'] } }],
    env: { SERVER: server.name }, writeTools: { [literalName]: { source: 'explicit', write: ['change'] }, example: { source: 'explicit', write: [] } } });
await applyLayout(identityPlan);
const identityServers = JSON.parse(text(identityRoot, '.cursor/mcp.json')).mcpServers;
check('environment expansion preserves server names and classification identities', Object.keys(identityServers).join() === `example,${literalName}`
    && identityServers[literalName].args[0] === 'example' && identityPlan.writeTools?.[0].server === literalName && !identityPlan.requiredVars?.length);
refuses('OpenCode refuses an unsupported authorization field instead of dropping it', { ...direct, target: 'opencode', servers: [
        { name: 'remote', definition: { url: 'https://localhost/mcp', http_headers_helper: 'local-helper' } },
    ] }, 'Unsupported opencode MCP configuration: remote: unsupported fields http_headers_helper');
refuses('Codex refuses an unresolved placeholder it would serialize literally', { ...direct, target: 'codex', servers: [
        { name: 'stdio', definition: { command: 'node', args: ['${UNDEFINED_ARG}'] } },
    ] }, 'Unsupported codex MCP configuration: stdio: unresolved placeholder in args');
const rejectedRoot = fixtureRoot(box, 'invalid-server-');
for (const [target, field] of [['cursor', 'command'], ['claude', 'url']]) {
    for (const [kind, value] of [['empty', ''], ['blank', ' \t ']]) {
        refuses(`${target} refuses a ${kind} ${field} after substitution`, { ...direct, root: rejectedRoot, target,
            env: { TRANSPORT: value }, servers: [{ name: 'example', definition: { [field]: '${TRANSPORT}' } }] }, 'Expected exactly one of command or url for example');
    }
}
const helper = { name: 'private-service', definition: { url: 'https://localhost/mcp', http_headers_helper: '${HELPER}' } };
refuses('Codex refuses an unresolved authorization helper', { ...direct, root: rejectedRoot, target: 'codex', servers: [helper] }, 'Unsupported codex MCP configuration: private-service: unresolved placeholder in http_headers_helper');
check('unrepresentable definitions do not create config files', ['.cursor', '.mcp.json', '.codex'].every(rel => !existsSync(path.join(rejectedRoot, rel))));
const helperRoot = fixtureRoot(box, 'valid-helper-');
const helperCommand = 'local-helper --header';
await applyLayout(planLayout({ ...direct, root: helperRoot, target: 'codex', servers: [helper], env: { HELPER: helperCommand } }));
const nativeHelper = parseToml(text(helperRoot, '.codex/config.toml')).mcp_servers;
check('Codex renders a helper supplied through env without loss', nativeHelper['private-service'].http_headers_helper === helperCommand);
const keyRoot = fixtureRoot(box, 'literal-keys-');
const keyPlan = planLayout({ ...direct, root: keyRoot, env: { HEADER_KEY: 'ignored' }, servers: [
        { name: 'remote', definition: { url: 'https://localhost/mcp', headers: { '${HEADER_KEY}': '${ACTUAL_VALUE}' } } },
        { name: 'local', definition: { command: 'node', env: { '${ENV_KEY}': 'literal' } } },
    ] });
await applyLayout(keyPlan);
const keyedServers = JSON.parse(text(keyRoot, '.cursor/mcp.json')).mcpServers;
check('only string values contribute to requiredVars, not literal header or environment keys', isDeepStrictEqual(keyPlan.requiredVars, ['ACTUAL_VALUE'])
    && keyedServers.remote.headers['${HEADER_KEY}'] === '${ACTUAL_VALUE}' && keyedServers.local.env['${ENV_KEY}'] === 'literal');
for (const [target, config] of [['cursor', '.cursor/mcp.json'], ['claude', '.mcp.json'], ['opencode', 'opencode.json']]) {
    const root = fixtureRoot(box, `${target}-missing-`);
    const installed = await applyLayout(planLayout({ ...direct, root, target }));
    rmSync(path.join(root, config));
    const retired = await applyLayout(planLayout({ ...direct, root, target, servers: [] }), installed.state);
    check(`${target}: removal does not recreate an already missing MCP file`, !existsSync(path.join(root, config)) && !retired.written.length
        && !retired.updated.length && !Object.keys(retired.state.serverKeys ?? {}).length && !retired.state.createdMcp?.length);
}
if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const secured = path.join(identityRoot, '.cursor/mcp.json');
    const before = readFileSync(secured);
    const mode = lstatSync(secured).mode & 0o777;
    check('a new secret-bearing MCP document is owner-only', mode === 0o600);
    await fails('a separate apply cannot adopt existing server keys by matching text', applyLayout(identityPlan), /MCP server conflict/);
    const rollbackRoot = fixtureRoot(box, 'write-refusal-');
    const directory = path.join(rollbackRoot, '.cursor');
    put(rollbackRoot, '.cursor/mcp.json', '{"keep":true}\n');
    chmodSync(directory, 0o555);
    try {
        await fails('atomic MCP update refuses when the replacement cannot be staged', applyLayout(planLayout({ ...direct, root: rollbackRoot })), /EACCES|EPERM/);
        check('refused replacement leaves the original bytes intact', text(rollbackRoot, '.cursor/mcp.json') === '{"keep":true}\n' && readFileSync(secured).equals(before));
    }
    finally {
        chmodSync(directory, 0o755);
    }
}
refuses('rejects an escaping source namespace', { ...populated, skills: [{ ...skills[0], name: '../escape' }] }, 'Expected a safe skill name: ../escape');
refuses('rejects case-folded namespace collisions', { ...populated, skills: [...skills, { ...skills[0], name: 'SAMPLE' }] }, 'Duplicate skill: SAMPLE');
refuses('rejects incomplete write-tool metadata', { ...populated, writeTools: {} }, 'Expected an object: write tools for example');
const staleRoot = fixtureRoot(box, 'stale-');
const stale = planLayout({ ...populated, root: staleRoot, rules: [] });
put(inputRoot, 'sample/refs/example.md', 'Changed after planning\n');
await fails('changed source prevents all writes', applyLayout(stale), /Stale source/);
check('stale source leaves output untouched', !existsSync(path.join(staleRoot, '.cursor')));
const escape = fixtureRoot(box, 'escape-');
directoryLink(escape, path.join(staleRoot, '.cursor'));
await fails('linked destination outside root is refused', applyLayout(planLayout({ ...populated, root: staleRoot, rules: [] })), /Refusing linked output/);
check('linked output target stays untouched', !existsSync(path.join(escape, 'mcp.json')));
const sourceLink = path.join(inputRoot, 'sample/escape');
directoryLink(escape, sourceLink);
let sourceEscape;
try {
    planLayout(populated);
}
catch (error) {
    sourceEscape = error.message;
}
check('linked supporting source is not dereferenced', /expected a regular supporting file/.test(sourceEscape ?? ''), sourceEscape);
rmSync(sourceLink, { recursive: true, force: true });
put(inputRoot, 'sample/refs/example.md', 'Supporting file\n');
for (const [target, configPath, agentExt] of [
    ['cursor', '.cursor/mcp.json', 'md'], ['claude', '.mcp.json', 'md'], ['codex', '.codex/config.toml', 'toml'], ['opencode', 'opencode.json', 'md'],
]) {
    const root = fixtureRoot(box, `${target}-`);
    const selected = planLayout({ ...populated, root, target });
    const applied = await applyLayout(selected);
    const repeat = await applyLayout(planLayout({ ...populated, root, target }), applied.state);
    const configText = text(root, configPath);
    const doc = target === 'codex' ? parseToml(configText) : JSON.parse(configText);
    const native = target === 'codex' ? doc.mcp_servers.example : target === 'opencode' ? doc.mcp.servers.example : doc.mcpServers.example;
    const headers = target === 'codex' ? native.http_headers : native.headers;
    check(`${target}: native MCP has the selected endpoint and authorization`, native.url === populated.servers[0].definition.url
        && headers.token === populated.env.LAYOUT_TOKEN && (process.platform === 'win32' || (lstatSync(path.join(root, configPath)).mode & 0o777) === 0o600));
    check(`${target}: repeat preserves skill, supporting files, rules and subagent`, !repeat.written.length && !repeat.updated.length && !repeat.removed.length
        && isDeepStrictEqual(repeat.state, applied.state)
        && text(root, `.${target}/skills/sample/SKILL.md`) === skill
        && text(root, `.${target}/skills/sample/refs/example.md`) === 'Supporting file\n'
        && text(root, `.${target}/skills/_shared/ref.md`) === 'Shared supporting file\n'
        && text(root, '.agents/rules/0001.md') === 'Second rule\n' && text(root, '.agents/rules/0002.md') === 'First rule\n'
        && text(root, `.${target}/agents/checker.${agentExt}`).includes('Read the diff.'));
    const empty = planLayout({ ...direct, root, target, servers: [] });
    const removed = await applyLayout(empty, applied.state);
    check(`${target}: an empty apply removes the owned MCP output`, removed.removed.includes(configPath) && !existsSync(path.join(root, configPath)));
}
