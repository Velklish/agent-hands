import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {applyLayout,LayoutMcpError,planLayout} from 'agent-hands';
import {input,put,scratch} from '../../fixtures.mjs';

test('OpenCode compatibility plans preserve literals, convert native placeholders, and omit invalid timeout without rounding',t=>{
  const root=scratch(t);
  const plan=planLayout(input(root,'opencode',{mcp:{compatibility:'report'},servers:[
    {name:'ready',placeholders:'literal',definition:{command:'node',args:['${LITERAL}']}},
    {name:'native',definition:{command:'${BIN}',args:['${ARG}','${X:-fallback}'],headers:{ignored:'opposite transport'},env:{TOKEN:'${TOKEN}'},tool_timeout_sec:0.007}},
    {name:'remote',definition:{url:'https://example.test/${SITE}',env:{IGNORED:'opposite transport'},headers:{auth:'Bearer ${TOKEN}'},tool_timeout_sec:0.0005,required:true}},
    {name:'bad',definition:{command:'node',tool_timeout_sec:'180',access:'secret data'}},
  ]}));
  const entries=JSON.parse(plan.files[0].content).mcp.servers;
  assert.deepEqual(entries.ready,{type:'local',command:['node','${LITERAL}']});
  assert.deepEqual(entries.native,{type:'local',command:['{env:BIN}','{env:ARG}','${X:-fallback}'],environment:{TOKEN:'{env:TOKEN}'},timeout:{execution:7}});
  assert.deepEqual(entries.remote,{type:'remote',url:'https://example.test/{env:SITE}',headers:{auth:'Bearer {env:TOKEN}'}});
  assert.deepEqual(entries.bad,{type:'local',command:['node']});
  assert.deepEqual(plan.diagnostics.find(issue=>issue.server==='remote' && issue.code==='unsupported-fields').keys,['required']);
  assert.deepEqual(plan.diagnostics.map(({code,server,field})=>[code,server,field]),[
    ['invalid-timeout','bad','tool_timeout_sec'],['unsupported-fields','bad',undefined],['invalid-timeout','remote','tool_timeout_sec'],
    ['unsupported-fields','remote',undefined],['unresolved-placeholder','native','args[1]'],
  ]);
  assert.doesNotMatch(JSON.stringify(plan.diagnostics),/secret data|fallback/);
  const sse=[{name:'alternate',definition:{type:'sse',url:'https://example.test'}}];
  assert.equal(JSON.parse(planLayout(input(root,'opencode',{mcp:{compatibility:'report'},servers:sse})).files[0].content).mcp.servers.alternate.type,'remote');
  assert.throws(()=>planLayout(input(root,'opencode',{servers:sse})),/unsupported transport/);
});

test('OpenCode compares the entire current key to the old fingerprint and supports idempotent repair',async t=>{
  const root=scratch(t), rel='opencode.json';
  const policy={compatibility:'report',removeEmpty:'keep'};
  const opts=input(root,'opencode',{scope:'mcp',mcp:policy,servers:[{name:'tool',definition:{command:'node',tool_timeout_sec:1}}]});
  const plan=planLayout(opts);
  assert.notEqual(plan.mcpFingerprints.current.tool,plan.mcpFingerprints.legacy.tool);
  const previous={target:'opencode',files:{},serverKeys:{[rel]:plan.mcpFingerprints.legacy}};
  const base={mcp:{servers:{tool:{type:'local',command:['node']}}},$schema:'foreign schema'};
  const file=put(root,rel,JSON.stringify(base));
  const migrated=await applyLayout(plan,previous);
  assert.deepEqual(migrated.state.serverKeys[rel],plan.mcpFingerprints.current);
  assert.deepEqual((await applyLayout(plan,previous)).updated,[]);
  const damaged=JSON.stringify({...base,mcp:{servers:{tool:{...base.mcp.servers.tool,timeout:{execution:44}}}}});
  fs.writeFileSync(file,damaged);
  await assert.rejects(applyLayout(plan,previous,{stage:()=>assert.fail()}),e=>e instanceof LayoutMcpError && e.diagnostic.code==='edited-server');
  assert.equal(fs.readFileSync(file,'utf8'),damaged);
  fs.writeFileSync(file,JSON.stringify(base));
  await applyLayout(planLayout({...opts,servers:[]}),previous);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{mcp:{servers:{}},$schema:'foreign schema'});
});

test('OpenCode stages root MCP and nested inherited resets together without adopting foreign resets',async t=>{
  const root=scratch(t), rel='.opencode/opencode.json';
  const existing={agents:{foreign:{disabled:true},other:{model:'custom'}},profile:'preserve'};
  const file=put(root,rel,JSON.stringify(existing));
  const options=input(root,'opencode',{scope:'mcp',mcp:{resetInheritedAgents:true,removeEmpty:'keep'},
    servers:[{name:'tool',definition:{command:'node'}}],
    subagents:['owned','foreign'].map(name=>({name,description:'Example',prompt:'Check it'}))});
  const plan=planLayout(options);
  await applyLayout(plan,undefined,{stage:changes=>{
    assert.deepEqual(changes.writes.map(file=>file.path),['opencode.json',rel]);
    assert.deepEqual(changes.state.agentResets,['owned']);
  }});
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),existing);
  const {state}=await applyLayout(plan);
  const retired=await applyLayout(planLayout({...options,subagents:[],servers:[]}),state);
  assert.deepEqual(retired.state.agentResets,[]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),existing);
  fs.writeFileSync(file,JSON.stringify({...existing,agents:{...existing.agents,foreign:{model:'edited'}}}));
  await assert.rejects(applyLayout(plan,undefined,{stage:()=>assert.fail()}),e=>e instanceof LayoutMcpError && e.diagnostic.code==='edited-agent-reset');
});
