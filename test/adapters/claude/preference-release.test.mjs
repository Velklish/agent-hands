import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {applyPreparedWorkspaceHooks,applyWorkspaceHooks,planWorkspaceHooks,prepareWorkspaceHooks} from 'agent-hands';
import {put,scratch} from '../../fixtures.mjs';

const empty = {extraKnownMarketplaces:{},enabledPlugins:{},skillOverrides:{}};
for (const [name,initial,expected] of [
  ['new settings file',null,null],
  ['existing settings file',{},{}],
  ['existing empty dictionaries',empty,empty],
  ['mixed origins',{enabledPlugins:{},theme:'dark'},{enabledPlugins:{},theme:'dark'}],
]) test(`release preserves ${name} according to its original ownership`,t => {
  const root = scratch(t), file = path.join(root,'.claude/settings.json');
  if (initial !== null) {fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,JSON.stringify(initial));}
  const input = {root,target:'claude',enabled:true,hooks:[],preferences:{enableProjectServers:true,localMarketplaces:{example:path.join(root,'market')},enabledPlugins:{'tool@example':true},disabledSkills:['example']}};
  applyWorkspaceHooks(input);assert.equal(applyWorkspaceHooks(input).changed,false);
  const release = {...input,enabled:false,preferences:{}};
  assert.equal(planWorkspaceHooks(release).changed,true);applyWorkspaceHooks(release);
  assert.deepEqual(fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null,expected);
  assert.equal(applyWorkspaceHooks(release).changed,false);
});
test('an external edit or an old field-only receipt is not proof of container creation',t => {
  for(const variant of ['edit','old']) {
    const root=scratch(t), file=path.join(root,'.claude/settings.json'), receipt=path.join(root,'.agent-hands/hooks/claude/preferences.json');
    const input={root,target:'claude',enabled:true,hooks:[],preferences:{disabledSkills:['example']}};
    applyWorkspaceHooks(input);
    if(variant==='edit') fs.writeFileSync(file,JSON.stringify({skillOverrides:{example:'off',neighbor:'on'},theme:'dark'}));
    else fs.writeFileSync(receipt,JSON.stringify({skillOverrides:{example:'off'}}));
    applyWorkspaceHooks({...input,preferences:{}});
    assert.deepEqual(JSON.parse(fs.readFileSync(file)),variant==='edit'?{skillOverrides:{neighbor:'on'},theme:'dark'}:{skillOverrides:{}});
  }
});


test('public hook operations report differing foreign preferences without exposing keys or values',async t => {
  const root=scratch(t);
  const settings={enableAllProjectMcpServers:false,skillOverrides:{'fixture-entry':'fixture-value',equal:'off'}};
  const file=put(root,'.claude/settings.json',JSON.stringify(settings));
  const input={root,target:'claude',enabled:true,hooks:[],preferences:{enableProjectServers:true,disabledSkills:['fixture-entry','equal']}};
  const expected={changed:false,shifted:false,diagnostics:[
    {code:'preference-conflict',target:'claude',field:'enableProjectServers'},
    {code:'preference-conflict',target:'claude',field:'disabledSkills'},
  ]};
  assert.deepEqual(planWorkspaceHooks(input),expected);
  assert.deepEqual(applyWorkspaceHooks(input),expected);
  const prepared = prepareWorkspaceHooks(input);
  assert.deepEqual(prepared.registrations,[]);
  assert.deepEqual(await applyPreparedWorkspaceHooks(prepared,{id:'fixture',async stage(){},async finish(){}}),{...expected,registrations:[]});
  assert.deepEqual(JSON.parse(fs.readFileSync(file)),settings);
  assert.equal(fs.existsSync(path.join(root,'.agent-hands/hooks/claude/preferences.json')),false);
});
