import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
