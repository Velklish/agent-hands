import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {createHash} from 'node:crypto';
import test from 'node:test';
import { applyWorkspaceHooks, planWorkspaceHooks, workspaceHookOutcome } from 'agent-hands';

const documents = { claude:'.claude/settings.json',cursor:'.cursor/hooks.json',codex:'.codex/hooks.json' };
const fixture = t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(),'workspace-hooks-')));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  return root;
};
const select = target => ({target,enabled:true,hooks:[{owner:'fixture',event:target === 'cursor' ? 'sessionStart' : 'SessionStart',command:'fixture',timeout:4}]});
for (const [target,file] of Object.entries(documents)) test(`${target}: registration and an observed fixture invocation`, t => {
  const root = fixture(t);
  const input = {...select(target),root};
  const hook = input.hooks[0];
  assert.equal(planWorkspaceHooks(input).changed,true);
  assert.deepEqual(readdirSync(root),[]);
  const document = path.join(root,file);
  // The stand-in reads the registered event. Only the constant local fixture can be dispatched.
  function dispatch(status) {
    const groups = existsSync(document) ? JSON.parse(readFileSync(document)).hooks?.[hook.event] ?? [] : [];
    return groups.flatMap(g => g.hooks ?? g).map(callback => {
      assert.equal(callback.command,'fixture');
      assert.equal(callback.timeout,4);
      const child = spawnSync(process.execPath,['-e',"require('node:fs').appendFileSync('calls','x');process.exit(Number(process.argv[1]))",String(status)],{cwd:root});
      if (child.error) throw child.error;
      return workspaceHookOutcome(hook.owner,hook.event,child.status);
    });
  }
  applyWorkspaceHooks({...input,enabled:false});
  assert.deepEqual(dispatch(0),[]);
  applyWorkspaceHooks(input);
  assert.equal(applyWorkspaceHooks(input).changed,false);
  assert.deepEqual(dispatch(0),[{owner:'fixture',event:hook.event,ok:true,exitStatus:0}]);
  assert.deepEqual(dispatch(7),[{owner:'fixture',event:hook.event,ok:false,exitStatus:7}]);
  applyWorkspaceHooks({...input,enabled:false});
  assert.deepEqual(dispatch(0),[]);
  assert.equal(readFileSync(path.join(root,'calls'),'utf8'),'xx');
});
test('all targets preflight before delivery and individual updates preserve siblings',t => {
  const root = fixture(t);
  const selections = Object.keys(documents).map(select);
  const cursor = path.join(root,documents.cursor);
  mkdirSync(path.dirname(cursor)); writeFileSync(cursor,'bad json');
  assert.throws(() => applyWorkspaceHooks({root,selections}));
  assert.deepEqual(readdirSync(root),['.cursor']);
  assert.equal(readFileSync(cursor,'utf8'),'bad json');
  rmSync(cursor); applyWorkspaceHooks({root,selections});
  const siblings = ['cursor','codex'].flatMap(target => [documents[target],`.agent-hands/hooks/${target}/ownership.json`]);
  const bytes = () => siblings.map(f => readFileSync(path.join(root,f),'utf8'));
  const before = bytes();
  applyWorkspaceHooks({root,...selections[0],enabled:false});
  assert.deepEqual(bytes(),before);
  assert.throws(() => applyWorkspaceHooks({root,...select('opencode')}),/Unsupported/);
});
test('confirmed legacy callbacks and named preferences migrate without adopting their neighbors',t => {
  const root = fixture(t), dir = path.join(root,'.claude'), file = path.join(dir,'settings.json');
  mkdirSync(dir);
  const hook = {owner:'old',event:'SessionStart',matcher:'startup|resume',command:'original',timeout:4};
  const unrelated = {type:'command',command:'neighbor'};
  const raw = JSON.stringify({hooks:{SessionStart:[{matcher:hook.matcher,hooks:[unrelated,{type:'command',command:hook.command,timeout:4}]}]},enabledPlugins:{'mine@fixture':true,'neighbor@fixture':false}});
  writeFileSync(file,raw);
  const input = {root,target:'claude',enabled:true,hooks:[{...hook,command:'replacement'}],preferences:{disabledSkills:['example']},legacy:{documentSha256:'0'.repeat(64),hooks:[hook],preferences:{enabledPlugins:{'mine@fixture':true}}}};
  assert.throws(() => applyWorkspaceHooks(input),/snapshot changed/); assert.equal(readFileSync(file,'utf8'),raw);
  input.legacy.documentSha256 = createHash('sha256').update(raw).digest('hex');
  applyWorkspaceHooks(input);
  const doc = JSON.parse(readFileSync(file));
  assert.deepEqual(doc.enabledPlugins,{'neighbor@fixture':false});assert.deepEqual(doc.skillOverrides,{example:'off'});
  assert.deepEqual(doc.hooks.SessionStart[0].hooks,[unrelated,{type:'command',command:'replacement',timeout:4}]);
  assert.equal(applyWorkspaceHooks(input).changed,false);
});
