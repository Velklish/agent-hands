import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {parse} from 'smol-toml';
import {applyLayout,LayoutMcpError,planLayout} from 'agent-hands';
import {input,put,scratch} from '../../fixtures.mjs';

test('Codex prepared native and literal server policies compose in a single config',t=>{
  const root=scratch(t);
  const servers=[
    {name:'ready',placeholders:'literal',definition:{command:'node',args:['${SUPPLIED_LITERAL}']}},
    {name:'install',definition:{command:'node',env:{SAME:'${SAME}',RENAMED:'${OTHER}'},args:['${ARG}'],required:false,tool_timeout_sec:0.0005}},
    {name:'remote',definition:{url:'https://example.test',headers:{auth:'${TOKEN}',prefix:'Bearer ${TOKEN}'},access:'hidden data'}},
    {name:'skipped',definition:{other:true}},
  ];
  const plan=planLayout(input(root,'codex',{scope:'mcp',mcp:{compatibility:'report',comments:['Local project settings']},servers}));
  assert.match(plan.files[0].content,/^# Local project settings\n/);
  const {mcp_servers:mcp}=parse(plan.files[0].content);
  assert.deepEqual(mcp.ready.args,['${SUPPLIED_LITERAL}']);
  assert.deepEqual(mcp.install.env_vars,['SAME']);
  assert.equal(mcp.install.env.RENAMED,'${OTHER}');
  assert.equal(mcp.install.tool_timeout_sec,0.0005);
  assert.equal(mcp.install.required,false);
  assert.equal(mcp.remote.env_http_headers.auth,'TOKEN');
  assert.equal(mcp.remote.http_headers.prefix,'Bearer ${TOKEN}');
  assert.equal(mcp.skipped,undefined);
  assert.deepEqual(plan.diagnostics.map(({server,code,field})=>[server,code,field]),[
    ['remote','unsupported-fields',undefined],['skipped','unsupported-transport',undefined],
    ['install','unresolved-placeholder','args'],['install','unresolved-placeholder','env.RENAMED'],['remote','unresolved-placeholder','headers.prefix'],
  ]);
  assert.doesNotMatch(JSON.stringify(plan.diagnostics),/hidden data|Bearer|SUPPLIED_LITERAL/);
  assert.ok(!plan.requiredVars.includes('SUPPLIED_LITERAL'));
  assert.throws(()=>planLayout(input(root,'codex',{servers:[servers[1]]})),/unresolved placeholder/);
  assert.throws(()=>planLayout(input(root,'codex',{mcp:{compatibility:'report'},servers:[{name:'bad',definition:{command:'node',tool_timeout_sec:0}}]})),e=>e instanceof LayoutMcpError && e.diagnostic.code==='invalid-timeout');
  assert.throws(()=>planLayout(input(root,'codex',{mcp:{comments:['unsafe\n[grafted]']}})),/single-line/);
});

test('Codex conflict preflight reads only an explicit reference, and invalid or stale references do not silently pass',async t=>{
  const root=scratch(t), reference=put(root,'reference.toml','[mcp_servers.tool]\ncommand="other"\n');
  const run=definition=>planLayout(input(root,'codex',{scope:'mcp',mcp:{transportReference:reference,compatibility:'report'},servers:[{name:'tool',definition}]}));
  assert.throws(()=>run({url:'https://example.test'}),e=>e instanceof LayoutMcpError && e.diagnostic.code==='transport-conflict');
  const prepared=run({command:'node'});
  fs.writeFileSync(reference,'[invalid');
  await assert.rejects(applyLayout(prepared,undefined,{stage:()=>assert.fail()}),/Stale transport reference/);
  assert.equal(run({command:'node'}).diagnostics[0].code,'transport-reference-unavailable');
  assert.throws(()=>planLayout(input(root,'codex',{mcp:{transportReference:'relative.toml'}})),/absolute transport reference/);
});
