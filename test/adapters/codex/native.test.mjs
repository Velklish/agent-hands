import test from 'node:test';import assert from 'node:assert/strict';import {parse as parseToml} from 'smol-toml';import {planLayout,applyLayout} from 'agent-hands';import {input,scratch,put} from '../../fixtures.mjs';import fs from 'node:fs';
const parse = text => JSON.parse(JSON.stringify(parseToml(text)));
import {codexTransportConflicts,renderCodexConfig} from '../../../dist/layout/adapters/codex/config.js';
test('Codex: TOML escaping, passthrough, exact timeout and untouched foreign config',async t=>{
 const root=scratch(t),prompt=`Try \\ and ''' with "quotes"\n`,a={name:'check',description:'A "quoted" description',model:'sample',tools:['read','glob'],prompt};const run=timeout=>planLayout(input(root,'codex',{subagents:[a],servers:[{name:'a.b',definition:{url:'https://example.test',http_headers_helper:'local-helper',required:false,headers:{token:'${TOKEN}',literal:'"\\'},tool_timeout_sec:timeout}},{name:'local',definition:{command:'node',env:{SAME:'${SAME}'}}}]}));
 for(const timeout of [180,0.0005]){const plan=run(timeout);const cfg=parse(plan.files.find(f=>f.path.endsWith('config.toml')).content).mcp_servers;assert.deepEqual(cfg['a.b'],{url:'https://example.test',http_headers_helper:'local-helper',required:false,http_headers:{literal:'"\\'},env_http_headers:{token:'TOKEN'},tool_timeout_sec:timeout});assert.deepEqual(cfg.local.env_vars,['SAME']);assert.deepEqual(parse(plan.files[0].content),{name:'check',description:a.description,model:'sample',sandbox_mode:'read-only',developer_instructions:prompt});}
 for(const value of [0,-1,Infinity,NaN,'180',null])assert.throws(()=>run(value),/tool_timeout_sec/);const f=put(root,'.codex/config.toml','keep');await assert.rejects(applyLayout(run(180)),/Output conflict/);assert.equal(fs.readFileSync(f,'utf8'),'keep');
});

test('Codex: transport comparisons distinguish conflicts without using a home config',()=>{
 const servers={remote:{url:'https://example.test'},local:{command:'node'}};
 assert.deepEqual(codexTransportConflicts(servers),[]);
 assert.deepEqual(codexTransportConflicts(servers,new Map([['remote','http'],['local','stdio']])),[]);
 assert.deepEqual(codexTransportConflicts(servers,new Map([['remote','stdio'],['local','http']])),[
  {name:'remote',ours:'http',theirs:'stdio'},{name:'local',ours:'stdio',theirs:'http'},
 ]);
});

test('Codex: native renderer reports unsupported fields, absent transport and unrepresentable placeholders',()=>{
 const result=renderCodexConfig({
  skipped:{unknown:'value'},
  remote:{url:'https://example.test',headers:{Authorization:'Bearer ${TOKEN}'},unexpected:true},
  local:{command:'node',env:{RENAMED:'${OTHER}'}},
 },{expandEnv:false});
 assert.deepEqual(result.skipped,['skipped']);
 assert.deepEqual(result.dropped,[{name:'remote',keys:['unexpected']}]);
 assert.deepEqual(result.unresolved.map(({name,where,why})=>({name,where,why})),[
  {name:'remote',where:'headers.Authorization',why:'embedded'},{name:'local',where:'env.RENAMED',why:'renamed'},
 ]);
 const {mcp_servers:native}=parse(result.text);
 assert.equal(native.remote.http_headers.Authorization,'Bearer ${TOKEN}');
 assert.equal(native.local.env.RENAMED,'${OTHER}');
 assert.equal(native.skipped,undefined);
});
