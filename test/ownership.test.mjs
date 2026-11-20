import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import test from 'node:test';
import { applyLayout, planLayout, readLayoutState } from 'agent-hands';
import { input, put, scratch } from './fixtures.mjs';

test('supporting-file collisions name both sources and leave the workspace untouched', t => {
  const dir = scratch(t), root = path.join(dir, 'empty'); fs.mkdirSync(root);
  const first = put(dir, 'first/docs/guide.md', 'first'), second = put(dir, 'second/docs/guide.md', 'second');
  const options = input(root, 'cursor', { sharedDirs: ['first','second'].map(source => ({source,srcAbs:path.join(dir,source)})) });
  assert.throws(() => planLayout(options), /Output collision: .cursor\/skills\/_shared\/docs\/guide.md \(first \/ second\)/);
  assert.deepEqual(fs.readdirSync(root), []);
  fs.copyFileSync(first, second);
  assert.equal(planLayout(options).files.length, 1);
});

test('distinct supporting source trees merge into one native directory', async t => {
  const dir = scratch(t), root = path.join(dir,'workspace'); fs.mkdirSync(root);
  put(dir,'first/reference/a.md','first'); put(dir,'second/reference/b.md','second');
  const sharedDirs = ['first','second'].map(source => ({source,srcAbs:path.join(dir,source)}));
  const plan = planLayout(input(root,'cursor',{sharedDirs}));
  const {state,written} = await applyLayout(plan);
  const files = ['a.md','b.md'].map(name => `.cursor/skills/_shared/reference/${name}`);
  assert.deepEqual(written,files);
  assert.deepEqual(Object.keys(state.files),files);
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(root,file),'utf8')),['first','second']);
});

test('readLayoutState rejects unknown and cross-target per-key MCP paths without applying', () => {
  const nativePaths = {claude:'.mcp.json',cursor:'.cursor/mcp.json',opencode:'opencode.json'};
  const state = (rel,target) => ({target,files:{},serverKeys:{[rel]:{tool:'a'.repeat(64)}},createdMcp:[rel]});
  for (const target of [undefined,...Object.keys(nativePaths),'codex']) {
    for (const rel of ['other.json','../opencode.json','.codex/config.toml']) {
      assert.throws(() => readLayoutState(state(rel,target)),/Invalid MCP state path/);
    }
    for (const [owner,rel] of Object.entries(nativePaths)) {
      if (target === undefined || target === owner) assert.deepEqual(readLayoutState(state(rel,target)).createdMcp,[rel]);
      else assert.throws(() => readLayoutState(state(rel,target)),/Invalid MCP state path/);
    }
  }
  assert.throws(() => readLayoutState({target:'cursor',files:{},createdMcp:['.cursor/mcp.json']}),/Untracked created MCP path/);
});

test('root API mirrors executable status in both directions and reports mode-only updates', {skip:process.platform === 'win32'}, async t => {
  const dir = scratch(t), root = path.join(dir,'workspace'); fs.mkdirSync(root);
  const source = path.join(dir,'support'), script = put(source,'task.sh','stable bytes');
  const rel = '.cursor/skills/_shared/task.sh', file = path.join(root,rel);
  const plan = () => planLayout(input(root,'cursor',{sharedDirs:[{srcAbs:source}]}));
  let {state} = await applyLayout(plan());
  for (const mode of [0o755,0o644]) {
    fs.chmodSync(script,mode);
    const result = await applyLayout(plan(),state);
    assert.deepEqual(result.updated,[rel]);
    assert.deepEqual(result.state,state);
    assert.equal(fs.statSync(file).mode & 0o111,mode & 0o111);
    assert.equal(fs.readFileSync(file,'utf8'),'stable bytes');
    state=result.state;
    assert.deepEqual((await applyLayout(plan(),state)).updated,[]);
  }
});

test('root API propagates chmod failure and rolls back permissions already changed', {skip:process.platform === 'win32'}, async t => {
  const dir = scratch(t), root = path.join(dir,'workspace'); fs.mkdirSync(root);
  const srcAbs = path.join(dir,'support');
  const sources = ['a.sh','b.sh'].map(name=>put(srcAbs,name,'stable bytes'));
  const outputs = ['a.sh','b.sh'].map(name=>path.join(root,'.cursor/skills/_shared',name));
  const plan = () => planLayout(input(root,'cursor',{sharedDirs:[{srcAbs}]}));
  const {state} = await applyLayout(plan());
  for (const source of sources) fs.chmodSync(source,0o755);
  const chmod = fs.chmodSync;
  const injected = t.mock.method(fs,'chmodSync',(file,mode) => {
    if (file === outputs[1]) {
      assert.equal(fs.statSync(outputs[0]).mode & 0o111,0o111);
      throw Object.assign(new Error('injected chmod refusal'),{code:'EPERM'});
    }
    return chmod(file,mode);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(applyLayout(plan(),state),{code:'EPERM',message:'injected chmod refusal'}); }
  finally { injected.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(outputs.map(file=>fs.statSync(file).mode & 0o111),[0,0]);
  assert.deepEqual(outputs.map(file=>fs.readFileSync(file,'utf8')),['stable bytes','stable bytes']);
  assert.deepEqual((await applyLayout(plan(),state)).updated,['a.sh','b.sh'].map(name=>`.cursor/skills/_shared/${name}`));
});

test('malformed JSON and edited owned MCP keys cannot be reconciled by changing selection', async t => {
  const root = scratch(t), rel = 'opencode.json';
  const plan = () => planLayout(input(root,'opencode',{servers:[{name:'demo',definition:{command:'node'}}]}));
  const file = put(root,rel,'{ bad');
  await assert.rejects(applyLayout(plan()), SyntaxError);
  assert.equal(fs.readFileSync(file,'utf8'),'{ bad');
  put(root,rel,'{"model":"manual","mcp":{"unrelated":true,"servers":{"other":{"type":"local","command":["keep"]}}}}');
  const state = (await applyLayout(plan())).state;
  const data = JSON.parse(fs.readFileSync(file,'utf8'));
  data.mcp.servers.demo.command = ['edited'];
  const edited = JSON.stringify(data);
  put(root,rel,edited);
  await assert.rejects(applyLayout(planLayout(input(root,'opencode')),state),/Edited MCP server: demo/);
  assert.equal(fs.readFileSync(file,'utf8'),edited);
  data.mcp.servers.demo.command = ['node'];
  put(root,rel,JSON.stringify(data));
  const retired = await applyLayout(planLayout(input(root,'opencode')),state);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')), { model:'manual', mcp:{ unrelated:true, servers:{other:{type:'local',command:['keep']}}} });
  assert.deepEqual(retired.state.serverKeys,{});
});

test('display data cannot substitute for or mutate the applicable plan', async t => {
  const dir = scratch(t), root = path.join(dir,'workspace'); fs.mkdirSync(root);
  const rule = put(dir,'rule.md','Original rule');
  const plan = planLayout(input(root,'cursor',{rules:[rule]}));
  await assert.rejects(applyLayout({...plan}),/Expected a plan returned/);
  plan.files[0].content = 'changed';
  plan.files[0].path = 'would-escape';
  plan.root = dir;
  const result = await applyLayout(plan);
  assert.equal(fs.readFileSync(path.join(root,'.agents/rules/cursor/0001.md'),'utf8'),'Original rule');
  assert.deepEqual(readLayoutState(JSON.parse(JSON.stringify(result.state))),result.state);
  assert.throws(()=>readLayoutState({...result.state,target:'other'}),/Invalid ownership target/);
});

test('an owned resource update refuses to edit a foreign hard-link alias', async t => {
  const dir = scratch(t), root = path.join(dir,'workspace'); fs.mkdirSync(root);
  const rule = put(dir,'rule.md','Original');
  const plan = () => planLayout(input(root,'cursor',{rules:[rule]}));
  const { state } = await applyLayout(plan());
  const file = path.join(root,'.agents/rules/cursor/0001.md'), alias = path.join(dir,'unmanaged.md');
  fs.linkSync(file,alias);
  put(dir,'rule.md','New text');
  await assert.rejects(applyLayout(plan(),state),/Refusing hard-linked output/);
  assert.equal(fs.readFileSync(alias,'utf8'),'Original');
});
