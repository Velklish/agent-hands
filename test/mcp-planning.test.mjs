import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {applyLayout, LayoutMcpError, parseLayout, planLayout, readLayoutState} from 'agent-hands';
import {input,put,scratch} from './fixtures.mjs';
import {Writer} from '../dist/layout/writer.js';

const paths = {claude:'.mcp.json',cursor:'.cursor/mcp.json',codex:'.codex/config.toml',opencode:'opencode.json'};
const server = (name,command='node') => ({name,definition:{command}});
const bytes = file => fs.readFileSync(file,'utf8');
const state = changes => readLayoutState(JSON.parse(JSON.stringify(changes.state)));

for (const [target,rel] of Object.entries(paths)) test(`${target}: scoped MCP staging reconciles once without pruning installed resources`,async t=>{
  const dir=scratch(t), root=path.join(dir,'project'); fs.mkdirSync(root);
  const rule=put(dir,'rule.md','Selected rule');
  const installed=await applyLayout(planLayout(input(root,target,{scope:'resources',rules:[rule]})));
  const rulesPath=`.agents/rules/${target}/0001.md`;
  const plan=planLayout(input(root,target,{scope:'mcp',servers:[server('tool')]}));
  assert.deepEqual(plan.files.map(file=>file.path),[rel]);
  let staged;
  const first=await applyLayout(plan,installed.state,{stage(changes){
    staged=changes; changes.assertCurrent();
    assert.deepEqual(changes.writes.map(file=>[file.path,file.secure]),[[rel,true]]);
    assert.deepEqual(changes.removes,[]);
    assert.equal(fs.existsSync(path.join(root,rel)),false);
    assert.ok(state(changes).files[rulesPath]);
  }});
  assert.equal(fs.existsSync(path.join(root,rel)),false);
  assert.deepEqual(first.state,staged.state);
  const actual=await applyLayout(plan,installed.state);
  assert.deepEqual(actual.state,first.state);
  assert.deepEqual(await applyLayout(plan,actual.state), {state:actual.state,written:[],updated:[],removed:[],diagnostics:[]});
  const retirement=planLayout(input(root,target,{scope:'mcp'}));
  await applyLayout(retirement,actual.state,{stage:changes=>assert.deepEqual(changes.removes,[rel])});
  await applyLayout(retirement,actual.state);
  assert.equal(bytes(path.join(root,rulesPath)),'Selected rule');
  assert.equal(fs.existsSync(path.join(root,rel)),false);
});

for (const [target,rel] of Object.entries(paths)) test(`${target}: replace emits an empty config and refuses an unowned document before staging`,async t=>{
  const root=scratch(t), file=put(root,rel,'manual');
  const plan=planLayout(input(root,target,{scope:'mcp',mcp:{mode:'replace',emitEmpty:true}}));
  assert.deepEqual(plan.files.map(entry=>entry.path),[rel]);
  await assert.rejects(applyLayout(plan,undefined,{stage:()=>assert.fail('called before preflight')}),/Output conflict/);
  assert.equal(bytes(file),'manual');
  fs.unlinkSync(file);
  const result=await applyLayout(plan);
  assert.deepEqual(Object.keys(result.state.files),[rel]);
  assert.deepEqual(result.state.serverKeys,{});
});

for (const target of ['claude','cursor','opencode']) test(`${target}: adopt-identical preserves differing foreign entries with structured diagnostics`,async t=>{
  const root=scratch(t), rel=paths[target];
  const join=servers=>target==='opencode'?{mcp:{servers,option:true},$schema:'custom'}:{mcpServers:servers,option:true};
  const native=command=>target==='opencode'?{type:'local',command:[command]}:{command};
  const file=put(root,rel,JSON.stringify(join({same:native('node'),foreign:native('manual')})));
  const plan=planLayout(input(root,target,{scope:'mcp',mcp:{unowned:'adopt-identical',compatibility:'report'},servers:[server('same'),server('foreign'),server('new')]}));
  const result=await applyLayout(plan);
  assert.deepEqual(Object.keys(result.state.serverKeys[rel]).sort(),['new','same']);
  assert.deepEqual(result.diagnostics,[{code:'foreign-server',server:'foreign',path:rel,target}]);
  assert.deepEqual(JSON.parse(bytes(file)),join({same:native('node'),foreign:native('manual'),new:native('node')}));
  const current=bytes(file);
  await applyLayout(plan,result.state,{stage:changes=>assert.deepEqual(changes.writes,[])});
  assert.equal(bytes(file),current);
});

for (const target of ['claude','cursor']) test(`${target}: report mode preserves canonical JSON without guessing a transport`,t=>{
  const root=scratch(t), servers=[
    {name:'metadata-only',definition:{type:'elsewhere',access:{groups:['demo']}}},
    {name:'canonical',definition:{command:'node',headers:{mixed:'literal'},args:['${ARG}']}},
  ];
  const plan=planLayout(input(root,target,{scope:'mcp',mcp:{compatibility:'report'},servers}));
  assert.deepEqual(JSON.parse(plan.files[0].content).mcpServers,Object.fromEntries(servers.map(server=>[server.name,server.definition])));
  assert.deepEqual(plan.diagnostics,[]);
  assert.throws(()=>planLayout(input(root,target,{servers})),TypeError);
  const unsafe={name:'unknown',definition:{setting:{toJSON(){throw new Error('invoked')}}}};
  assert.throws(()=>planLayout(input(root,target,{mcp:{compatibility:'report'},servers:[unsafe]})),/Expected an object/);
});

test('staged preflight resists destination drift, and a receiver failure causes no second write',async t=>{
  const root=scratch(t), file=put(root,'.mcp.json','{"mcpServers":{"manual":{"command":"keep"}}}\n');
  const before=bytes(file), plan=planLayout(input(root,'claude',{scope:'mcp',servers:[server('tool')]}));
  let invalidate;
  await assert.rejects(applyLayout(plan,undefined,{stage:changes=>{
    assert.equal(changes.writes.length,1); invalidate=changes.assertCurrent;
    throw new Error('receiver transaction refused');
  }}),/receiver transaction refused/);
  assert.equal(bytes(file),before);
  fs.appendFileSync(file,'\n');
  assert.throws(invalidate,/Stale output: .mcp.json/);
});

test('a receiver can roll back staged MCP bytes and its own state in a single transaction',async t=>{
  const root=scratch(t), rel='.mcp.json', file=put(root,rel,'{"other":true}\n');
  const marker=put(root,'ownership.json','previous');
  const plan=planLayout(input(root,'claude',{scope:'mcp',servers:[server('tool')]}));
  await assert.rejects(applyLayout(plan,undefined,{stage:async changes=>{
    assert.equal(changes.writes.length,1);
    const writer=new Writer(root,{files:{}});
    const atomic={paths:new Set(changes.writes.filter(file=>file.secure).map(file=>file.path)),restoreOriginalMode:true};
    for(const patch of changes.writes) writer.stage(patch.path,patch.content,{adopt:true});
    writer.stage('ownership.json',JSON.stringify(changes.state),{adopt:true});
    await writer.transaction([],async()=>{
      writer.apply(changes.assertCurrent,atomic);
      assert.deepEqual(JSON.parse(bytes(file)),{other:true,mcpServers:{tool:{command:'node'}}});
      assert.ok(JSON.parse(bytes(marker)).serverKeys[rel].tool);
      throw new Error('late receiver failure');
    },{atomic});
  }}),/late receiver failure/);
  assert.equal(bytes(file),'{"other":true}\n');
  assert.equal(bytes(marker),'previous');
});

test('flat legacy key ownership retires only documents emptied by verified keys',async t=>{
  const root=scratch(t), rel='.mcp.json';
  const selected=planLayout(input(root,'claude',{scope:'mcp',servers:[server('old')]}));
  const previous={files:{},serverKeys:{[rel]:selected.mcpFingerprints.current}};
  const prune=planLayout(input(root,'claude',{scope:'mcp',mcp:{compatibility:'report',removeEmpty:'owned-keys'}}));
  for (const [document,removed] of [
    [{mcpServers:{old:{command:'node'}}},true],
    [{mcpServers:{}},false],
    [{mcpServers:{old:{command:'node'}},manual:true},false],
    [{mcpServers:{old:{command:'node'},manual:{command:'keep'}}},false],
  ]) {
    const file=put(root,rel,JSON.stringify(document));
    assert.deepEqual((await applyLayout(prune,previous)).removed,removed?[rel]:[]);
    if (!removed) assert.equal(fs.existsSync(file),true);
  }
  const file=put(root,rel,'{broken');
  await assert.rejects(applyLayout(prune,undefined,{stage:()=>assert.fail()}),e=>e instanceof LayoutMcpError && e.diagnostic.code==='invalid-document');
  assert.equal(bytes(file),'{broken');
});

test('rejects invalid JavaScript policy, path, callbacks, and prepared data rather than coercing them',async t=>{
  const root=scratch(t), base=input(root,'cursor');
  for (const options of [{scope:null},{rulesMode:[]},{mcp:{emitEmpty:'yes'}},{mcp:{unknown:0}},{mcp:{comments:['line']}},{mcp:{resetInheritedAgents:true}},{mcp:{unowned:'overwrite'}},{servers:[{...server('tool'),placeholders:null}]}]) {
    assert.throws(()=>parseLayout({...base,...options}),TypeError);
  }
  await assert.rejects(applyLayout(planLayout(base),undefined,{stage:'not callable'}),TypeError);
});

test('rule selection preserves candidate order without reading or replacing installed rule bytes',async t=>{
  const root=scratch(t), a=put(root,'a.md','First'), b=put(root,'b.md','Last');
  const rules=[{path:b,optional:true},{path:path.join(root,'missing.md'),optional:true},a];
  const base=input(root,'cursor',{scope:'resources',rules});
  const copy=planLayout(base);
  const initial=await applyLayout(copy);
  assert.deepEqual(copy.rules,[b,a]);
  assert.deepEqual(copy.files.map(file=>file.path),['.agents/rules/cursor/0001.md','.agents/rules/cursor/0002.md']);
  const pick=planLayout({...base,rulesMode:'select'});
  assert.deepEqual(pick.rules,[b,a]);
  assert.deepEqual(pick.files,[]);
  fs.writeFileSync(b,'Changed source after selection');
  const after=await applyLayout(pick,initial.state);
  assert.deepEqual(after.state,initial.state);
  assert.equal(bytes(path.join(root,'.agents/rules/cursor/0001.md')),'Last');
  assert.throws(()=>planLayout({...base,rules:[{path:'relative',optional:true}]}),/absolute rule/);
  assert.throws(()=>planLayout({...base,rules:[{path:a,optional:1}]}),/optional rule flag/);
  assert.throws(()=>planLayout({...base,rules:[path.join(root,'missing.md')]}),/regular rule/);
});
