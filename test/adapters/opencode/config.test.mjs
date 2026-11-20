import { renderOpencodeConfig } from '../../../dist/layout/adapters/opencode/config.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const check = (label, condition, detail) => test(label, () => assert.ok(condition, detail));
const servers = {
    remote: { type: 'http', url: 'http://example.test/mcp', headers: { api_key: 'lit' }, tool_timeout_sec: 180 },
    local: { type: 'stdio', command: 'python3', args: ['a.py'], env: { HOME_DIR: '/tmp' }, tool_timeout_sec: 180 },
    odd: { type: 'http', url: 'http://example.test/mcp', unsupported: true },
    broken: { type: 'http' },
};
const full = renderOpencodeConfig(servers);
const doc = JSON.parse(full.text);
check('remote endpoint and headers', doc.mcp.servers.remote.type === 'remote'
    && doc.mcp.servers.remote.url === 'http://example.test/mcp'
    && doc.mcp.servers.remote.headers.api_key === 'lit');
check('local command and environment', JSON.stringify(doc.mcp.servers.local.command) === JSON.stringify(['python3', 'a.py'])
    && doc.mcp.servers.local.type === 'local'
    && doc.mcp.servers.local.environment.HOME_DIR === '/tmp');
check('skipped transports and dropped fields', full.skipped.includes('broken') && !('broken' in doc.mcp.servers)
    && JSON.stringify(full.dropped) === JSON.stringify([{ name: 'odd', keys: ['unsupported'] }]));
check('seconds to milliseconds for both transports', doc.mcp.servers.remote.timeout?.execution === 180000 && doc.mcp.servers.local.timeout?.execution === 180000
    && !('timeout' in doc.mcp.servers.odd) && full.invalidTimeouts.length === 0);
check('schema URI', doc.$schema === 'https://opencode.ai/config.json');
const timeouts = [
    ['minimum', 0.001, 1], ['fraction', 1.001, 1001], ['aboveInt32', 2147483.648, 2147483648],
    ['nearSafeLimit', 9007199254740, 9007199254740000], ['unsafe', 9007199254740.992], ['overflow', Number.MAX_VALUE],
    ['subMs', 0.0005], ['fractionalMs', 1.0001], ['string', '180'], ['null', null], ['zero', 0],
    ['negative', -1], ['nan', NaN], ['infinity', Infinity],
];
for (const [name, seconds, expected] of timeouts) {
    const rendered = renderOpencodeConfig({ [name]: { command: 'probe', tool_timeout_sec: seconds } });
    const entry = JSON.parse(rendered.text).mcp.servers[name];
    check(`OpenCode timeout: ${name}`, entry.type === 'local' && rendered.dropped.length === 0
        && (expected === undefined
            ? !('timeout' in entry) && rendered.invalidTimeouts.length === 1 && rendered.invalidTimeouts[0] === name
            : entry.timeout?.execution === expected && rendered.invalidTimeouts.length === 0), rendered.text);
}
const proj = renderOpencodeConfig({
    h: { type: 'http', url: 'https://${HOST}:${PORT}/mcp/${HOST}', headers: {
            t: '${EXAMPLE_TOKEN}', half: 'a${X}b', Authorization: 'Bearer ${TOKEN}', repeated: '${A}${A}/${B}',
        } },
    e: { type: 'stdio', command: '${BIN_DIR}/${NODE}', args: ['x', 'a${Y}b', '${A}${B}${A}'], env: {
            SAME: '${SAME}', OTHER: '${DIFFERENT}', COMPOSITE: '${ROOT}/a/${ROOT}:${OTHER}', lower: '${lower_2}',
        } },
}, { expandEnv: false });
const pdoc = JSON.parse(proj.text);
check('whole header placeholder', pdoc.mcp.servers.h.headers.t === '{env:EXAMPLE_TOKEN}');
check('whole environment placeholder under another name', pdoc.mcp.servers.e.environment.SAME === '{env:SAME}'
    && pdoc.mcp.servers.e.environment.OTHER === '{env:DIFFERENT}');
check('Bearer token', pdoc.mcp.servers.h.headers.Authorization === 'Bearer {env:TOKEN}' && proj.unresolved.length === 0);
check('adjacent and repeated headers', pdoc.mcp.servers.h.headers.half === 'a{env:X}b'
    && pdoc.mcp.servers.h.headers.repeated === '{env:A}{env:A}/{env:B}');
check('repeated URL variables', pdoc.mcp.servers.h.url === 'https://{env:HOST}:{env:PORT}/mcp/{env:HOST}');
check('command and argument variables', JSON.stringify(pdoc.mcp.servers.e.command) === JSON.stringify(['{env:BIN_DIR}/{env:NODE}', 'x', 'a{env:Y}b', '{env:A}{env:B}{env:A}']));
check('environment variables and lowercase names', pdoc.mcp.servers.e.environment.COMPOSITE === '{env:ROOT}/a/{env:ROOT}:{env:OTHER}'
    && pdoc.mcp.servers.e.environment.lower === '{env:lower_2}');
const invalid = renderOpencodeConfig({
    h: { url: 'https://${HOST}/${HOST:-default}', tool_timeout_sec: 'private-value', headers: { bad: '${9BAD} ${BAD-NAME} ${}', mixed: '${OK}/${BAD:-x}', unclosed: '${OPEN' } },
    e: { command: '${NODE:-node}', args: ['literal', '${ARG?error}'], env: { BAD: '${env:TOKEN}' } },
}, { expandEnv: false });
const idoc = JSON.parse(invalid.text);
check('malformed placeholders preserved and valid neighbors translated', idoc.mcp.servers.h.url === 'https://{env:HOST}/${HOST:-default}'
    && idoc.mcp.servers.h.headers.bad === '${9BAD} ${BAD-NAME} ${}'
    && idoc.mcp.servers.h.headers.mixed === '{env:OK}/${BAD:-x}'
    && idoc.mcp.servers.h.headers.unclosed === '${OPEN'
    && idoc.mcp.servers.e.command[0] === '${NODE:-node}'
    && idoc.mcp.servers.e.command[2] === '${ARG?error}'
    && idoc.mcp.servers.e.environment.BAD === '${env:TOKEN}');
check('all invalid fields reported without their values', JSON.stringify(invalid.unresolved.map(({ name, where }) => [name, where])) === JSON.stringify([
    ['h', 'url'], ['h', 'headers.bad'], ['h', 'headers.mixed'], ['h', 'headers.unclosed'],
    ['e', 'command'], ['e', 'args[1]'], ['e', 'env.BAD'],
]) && invalid.unresolved.every((u) => u.why === 'unsupported placeholder syntax'));
check('invalid timeout coexists with placeholder diagnostics', invalid.invalidTimeouts.length === 1 && invalid.invalidTimeouts[0] === 'h'
    && !('timeout' in idoc.mcp.servers.h) && !invalid.text.includes('private-value'));
const unchangedServers = {
    h: { url: 'https://example.test/mcp', headers: { literal: 'plain', native: 'Bearer {env:TOKEN}', special: 'quotes " slash \\ newline\n', number: 42 } },
    e: { command: 'node', args: ['literal', '$SHELL', '{env:NATIVE}'], env: { literal: 'x', native: '{env:NATIVE}' } },
};
check('literal and native placeholders', renderOpencodeConfig(unchangedServers, { expandEnv: false }).text === renderOpencodeConfig(unchangedServers).text
    && renderOpencodeConfig(unchangedServers, { expandEnv: false }).unresolved.length === 0);
const expanded = renderOpencodeConfig({
    h: { url: 'https://${HOST}/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
    e: { command: '${NODE}', args: ['${A}/${B}'], env: { BAD: '${X:-fallback}' } },
});
check('already expanded mode', JSON.parse(expanded.text).mcp.servers.h.headers.Authorization === 'Bearer ${TOKEN}'
    && JSON.parse(expanded.text).mcp.servers.h.url === 'https://${HOST}/mcp'
    && JSON.stringify(JSON.parse(expanded.text).mcp.servers.e.command) === JSON.stringify(['${NODE}', '${A}/${B}'])
    && JSON.parse(expanded.text).mcp.servers.e.environment.BAD === '${X:-fallback}'
    && expanded.unresolved.length === 0);
import {planLayout} from '../../../dist/layout/plan.js';import {parse as yaml} from 'yaml';import {input,scratch} from '../../fixtures.mjs';
test('OpenCode: deny by default with read exceptions only on read-only agents',t=>{for(const tools of [['read','grep'],['read','edit']]){const [file]=planLayout(input(scratch(t),'opencode',{subagents:[{name:'reader',description:'first: next',prompt:'Body',tools}]})).files;const fm=yaml(file.content.split('---')[1]);assert.equal(fm.mode,'subagent');assert.equal(fm.description,'first: next');if(tools.includes('edit'))assert.equal(fm.permissions,undefined);else assert.deepEqual(fm.permissions.map(v=>[v.action,v.resource,v.effect]),[['*','*','deny'],['read','*','allow'],['grep','*','allow'],['read','*.env','ask'],['read','*.env.*','ask'],['read','*.env.example','allow']])}});
