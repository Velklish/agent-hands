import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { put, scratch } from '../../fixtures.mjs';
import { codexServerTransports, readCodexServerTransports } from '../../../dist/layout/adapters/codex/transports.js';
import { codexTransportConflicts } from '../../../dist/layout/adapters/codex/config.js';

const cases = [
  ['native tables, quoted names and inline tables', [
    '[mcp_servers.section_http]', 'url = "https://example.test"',
    '[mcp_servers.section_stdio]', 'command = "node"',
    '[mcp_servers."quoted.name"]', 'command = "node"',
    '[mcp_servers]', 'inline_http = { url = "https://example.test" }',
    '[model_providers.other]', 'command = "node"',
  ], {section_http:'http',section_stdio:'stdio','quoted.name':'stdio',inline_http:'http'}],
  ['dotted keys in the root', [
    'mcp_servers.http = { url = "https://example.test" }',
    'mcp_servers."quoted.stdio" = { command = "node", args = ["serve"] }',
  ], {http:'http','quoted.stdio':'stdio'}],
  ['dotted keys inside an unrelated array table are not root declarations', [
    '[[entries]]', 'mcp_servers.ghost = { url = "https://example.test" }',
  ], {}],
  ['comments on section headers do not change the section or its neighbor', [
    '[mcp_servers.command] # comment', 'command = "node"',
    '[mcp_servers.next]', 'url = "https://example.test"',
  ], {command:'stdio',next:'http'}],
  ['array tables under the MCP prefix do not impersonate servers', [
    '[[mcp_servers.ghost]]', 'url = "https://example.test"',
    '[mcp_servers.next]', 'command = "node"',
  ], {next:'stdio'}],
  ['quoted multiline notes cannot create fake root declarations', [
    'notes = """', 'mcp_servers.ghost = { url = "https://example.test" }',
    '[mcp_servers.ghost_header]', 'command = "node"', '"""',
    'mcp_servers.real = { url = "https://example.test" }',
    '[mcp_servers.next]', 'command = "node"',
  ], {real:'http',next:'stdio'}],
  ['literal multiline notes close only with their own delimiter', [
    "notes = '''", 'mcp_servers.ghost = { url = "https://example.test" }',
    'Three double quotes """ are content', "'''", '[mcp_servers.next]', 'url = "https://example.test"',
  ], {next:'http'}],
  ['triple quotes inside an ordinary string do not open a multiline note', [
    `notes = "Ordinary string with '''"`, '[mcp_servers.next]', 'command = "node"',
  ], {next:'stdio'}],
  ['nested URLs are not transports of the parent or a separate server', [
    '[mcp_servers.local]', 'command = "node"', '[mcp_servers.local.auth]', 'url = "https://example.test"',
  ], {local:'stdio'}],
];

for (const [name,lines,expected] of cases) test(`Codex config: ${name}`, () => {
  assert.deepEqual(Object.fromEntries(codexServerTransports(lines.join('\n'))),expected);
});

test('Codex config: absence is distinct from invalid TOML; transport checks use only declared server tables', t => {
  const dir = scratch(t), file = path.join(dir,'config.toml');
  assert.equal(readCodexServerTransports(file).size,0);
  put(dir,'config.toml','[broken');
  assert.throws(() => readCodexServerTransports(file));
  put(dir,'config.toml',cases[0][1].join('\n'));
  const transports = readCodexServerTransports(file);
  assert.deepEqual(codexTransportConflicts({section_http:{command:'node'},inline_http:{url:'https://other.test'}},transports),[
    {name:'section_http',ours:'stdio',theirs:'http'},
  ]);
});
