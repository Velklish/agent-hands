// Wrap the process launch for this probe only. The package still selects the binary,
// arguments and native postcondition. No call can leave the fixture's OS sandbox.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { applyWorkspaceHooks,applyPreparedWorkspaceHooks,inspectWorkspaceHookOperation,planWorkspaceHooks,prepareWorkspaceHooks } from 'agent-hands';

const [base,executable,encoded,mode] = process.argv.slice(2), binary=fs.realpathSync(executable), prefix = JSON.parse(encoded), mac=process.platform==='darwin';
assert.ok(mac ? prefix[0] === '/usr/bin/sandbox-exec' : process.platform === 'linux' && process.getuid() !== 0 && fs.existsSync('/.dockerenv') && prefix.length === 0);
const suffix = mode === 'alias' ? '-alias' : '', fresh = ['empty','missing','declarations'].includes(mode);
const label=mode ? '-'+mode : '';
const root = path.join(base,'package-project'+label), home = path.join(base,'package-home'+label), directory = path.join(root,'market');
const write = (f,v) => { fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f,JSON.stringify(v)); };
fs.mkdirSync(home); fs.mkdirSync(root);
const oldBundle = path.join(home,'store','initial'), newBundle = path.join(home,'store','updated');
const link = target => {if(fs.existsSync(directory)) fs.unlinkSync(directory);fs.symlinkSync(target,directory,'dir');};
if (suffix) { fs.mkdirSync(oldBundle,{recursive:true});link(oldBundle); }
const source = path.join(directory,'subject/.claude-plugin/plugin.json');
const settingsFile = path.join(root,'.claude/settings.json');
const foreign = {hooks:[{type:'command',command:'printf neighbor'}]};
const initial = fresh ? (mode==='declarations' ? {enabledPlugins:{'neighbor@other':false},extraKnownMarketplaces:{other:{source:{source:'directory',path:path.join(root,'other')}}}} : {}) : mac ? {enableAllProjectMcpServers:true,skillOverrides:{fixture:'off'},enabledPlugins:{'neighbor@other':false},extraKnownMarketplaces:{},hooks:{Stop:[foreign]}} : {enabledPlugins:{'neighbor@other':false},hooks:{PreToolUse:[{matcher:'Write',...foreign}]}};
if(mac && !fresh) initial.hooks.PostToolUse = [foreign,{matcher:'mcp__sample_tools__(read_one|write_two)',hooks:[...foreign.hooks,{type:'command',command:'printf after',timeout:4}]},foreign];
write(path.join(directory,'.claude-plugin/marketplace.json'),{name:'fixture-package',owner:{name:'Fixture'},plugins:[{name:'subject',source:'./subject'}]});
write(settingsFile,initial);
const original = cp.spawnSync;
const calls=[];
cp.spawnSync = (bin,args,options) => {
  assert.equal(bin,binary); assert.equal(options.cwd,root);
  const r = original(prefix[0] ?? bin,prefix.length ? [...prefix.slice(1),bin,...args] : args,{...options,env:{HOME:home,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),TMPDIR:path.join(base,'tmp')},stdio:'pipe',encoding:'utf8'});
  calls.push([args,r.status]); return r;
};
syncBuiltinESMExports();
const registration = {marketplace:'fixture-package',plugin:'subject',directory,version:'1.0.0',fingerprint:'a'.repeat(64),executable:binary,accountHome:home};
if (suffix) registration.expectedPhysicalDirectory = oldBundle;
const input = {root,target:'claude',enabled:true,preferences:{enableProjectServers:true,disabledSkills:['example']},hooks:[
  {owner:'fixture',event:'SessionStart',matcher:'startup|resume',command:'printf fixture',timeout:4},
  {owner:'stop',event:'Stop',command:'printf end'},
  {owner:'start',event:'PreToolUse',matcher:'AskUserQuestion|AskQuestion|request_user_input',command:'printf begin',timeout:30},
  {owner:'after',event:'PostToolUse',matcher:'mcp__sample_tools__(read_one|write_two)',command:'printf managed-after'},
  {owner:'failure',event:'PostToolUseFailure',matcher:'AskUserQuestion|AskQuestion|request_user_input',command:'printf failure',timeout:30},
],registration};
const bad = structuredClone(initial); if(fresh) bad.externalField=true; else if(mac) bad.hooks.PostToolUse[1].matcher = 'mcp__sample_tools__(read_.*|write_two)'; else bad.hooks.PreToolUse[0].extra=true;
write(settingsFile,bad);
assert.throws(() => applyWorkspaceHooks(input),/Unsupported project settings/);
assert.equal(calls.length,0); assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile)),bad);
assert.equal(fs.existsSync(path.join(root,'.agent-hands')),false); assert.deepEqual(fs.readdirSync(home),suffix?['store']:[]);
write(settingsFile,initial);
if(mode==='missing') fs.unlinkSync(settingsFile);
assert.equal(planWorkspaceHooks(input).changed,true); assert.equal(calls.length,0);
const currentBytes=()=>fs.existsSync(settingsFile)?fs.readFileSync(settingsFile):null;
const beforeInstall = currentBytes();
assert.throws(() => applyWorkspaceHooks(input),/External hook step failed/);
assert.deepEqual(currentBytes(),beforeInstall);assert.equal(fs.existsSync(path.join(home,'.claude/plugins/known_marketplaces.json')),false);
assert.equal(fs.existsSync(path.join(root,'.agent-hands/hooks/claude/registration.json')),false);
write(source,{name:'subject',version:'1.0.0'});calls.length=0;
const applied = await applyPreparedWorkspaceHooks(prepareWorkspaceHooks(input),{id:'native-probe',async stage(){
  assert.deepEqual(inspectWorkspaceHookOperation({root,accountHome:home}),{pending:true,registration:true,targets:['claude']});
  assert.equal(fs.existsSync(path.join(root,'.agent-hands/hooks/transaction/pending.json')),false);
  assert.ok(fs.existsSync(path.join(home,'.agent-hands/account-hooks/transaction/pending.json')));
},async finish(_id,decision){assert.equal(decision,'commit');}});
assert.equal(applied.changed,true); assert.deepEqual(calls.map(c=>c[1]),[0,0]);
assert.equal(applyWorkspaceHooks(input).changed,false); assert.equal(calls.length,2);
const settings = JSON.parse(fs.readFileSync(settingsFile));
if(!fresh) { if(mac) assert.deepEqual(settings.hooks.Stop[0],foreign); else assert.deepEqual(settings.hooks.PreToolUse[0],initial.hooks.PreToolUse[0]); }
assert.equal(settings.enabledPlugins['neighbor@other'],initial.enabledPlugins?.['neighbor@other']);
if(mode==='declarations') assert.deepEqual(settings.extraKnownMarketplaces.other,initial.extraKnownMarketplaces.other);
if(mac && !fresh) assert.deepEqual(settings.hooks.PostToolUse.slice(0,initial.hooks.PostToolUse.length),initial.hooks.PostToolUse);
assert.equal(settings.enableAllProjectMcpServers,true);assert.equal(settings.skillOverrides.example,'off');
assert.equal(settings.enabledPlugins['subject@fixture-package'],true);
const registry = path.join(home,'.claude/plugins/installed_plugins.json');
const selected = () => JSON.parse(fs.readFileSync(registry)).plugins['subject@fixture-package'];
assert.deepEqual(selected().map(r=>[r.projectPath,r.version]),[[root,'1.0.0']]);
const manifest = path.join(root,'layout-manifest'), undo = path.join(root,'peer-undo');
write(manifest,{version:'1.0.0'});
const saved = [settingsFile,registry,path.join(root,'.agent-hands/hooks/claude/registration.json'),path.join(root,'.agent-hands/hooks/claude/ownership.json'),path.join(root,'.agent-hands/hooks/claude/preferences.json'),manifest,source].map(file=>[file,fs.readFileSync(file)]);
const update = {...input,preferences:{...input.preferences,disabledSkills:['example','second']},registration:{...registration,version:'1.0.1',fingerprint:'b'.repeat(64)}};
if (suffix) {
  fs.cpSync(oldBundle,newBundle,{recursive:true}); update.registration.expectedPhysicalDirectory=newBundle;
  write(path.join(newBundle,'subject/.claude-plugin/plugin.json'),{name:'subject',version:'1.0.1'});
  const n=calls.length;
  assert.throws(()=>applyWorkspaceHooks({...input,registration:{...registration,expectedPhysicalDirectory:newBundle}}),/source changed/);
  await assert.rejects(applyPreparedWorkspaceHooks(prepareWorkspaceHooks(update),{id:'wrong-binding',async stage(){},async finish(_,d){assert.equal(d,'rollback');}}),/source changed/);
  assert.equal(calls.length,n);
}
let fail = true;
const peer = {id:'payload-writer',async stage(id){write(undo,{id,payload:fs.readFileSync(source,'utf8'),manifest:fs.readFileSync(manifest,'utf8')});if(suffix) link(newBundle);else write(source,{name:'subject',version:'1.0.1'});},async beforeCommit(){
  assert.deepEqual(selected().map(r=>r.version),['1.0.1']);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile)).skillOverrides.second,'off');
  if(fail) throw new Error('Layout manifest not saved');write(manifest,{version:'1.0.1'});
},async finish(id,decision){const old=JSON.parse(fs.readFileSync(undo));assert.equal(old.id,id);if(decision==='rollback'){if(suffix) link(oldBundle);else fs.writeFileSync(source,old.payload);fs.writeFileSync(manifest,old.manifest);}fs.unlinkSync(undo);}};
await assert.rejects(applyPreparedWorkspaceHooks(prepareWorkspaceHooks(update),peer),/Layout manifest not saved/);
for(const [file,bytes] of saved) assert.deepEqual(fs.readFileSync(file),bytes,file);
assert.deepEqual(selected().map(r=>[r.projectPath,r.version]),[[root,'1.0.0']]);
fail=false;await applyPreparedWorkspaceHooks(prepareWorkspaceHooks(update),peer);
assert.equal(JSON.parse(fs.readFileSync(manifest)).version,'1.0.1');
assert.deepEqual(selected().map(r=>[r.projectPath,r.version]),[[root,'1.0.1']]);
const settingsBefore = fs.readFileSync(settingsFile), installedBefore = fs.readFileSync(registry);
const receiptFile = path.join(root,'.agent-hands/hooks/claude/registration.json');
const priorReceipt = fs.readFileSync(receiptFile);
fs.unlinkSync(receiptFile);
const legacy = {version:'1.0.1',fingerprint:'b'.repeat(64)}, updated = {...update.registration,...legacy};
assert.throws(() => applyWorkspaceHooks({...input,registration:{...updated,legacy:{...legacy,version:'0.0.1'}}}),/Unconfirmed/);
const beforeImport = calls.length;
assert.equal(applyWorkspaceHooks({...update,registration:{...updated,legacy}}).changed,true);
assert.equal(calls.length,beforeImport);assert.deepEqual(fs.readFileSync(receiptFile),priorReceipt);
fs.renameSync(path.dirname(path.dirname(source)),path.join(directory,'absent'));
assert.throws(() => applyWorkspaceHooks({...input,registration:{...updated,version:'1.0.2',fingerprint:'c'.repeat(64)}}));
assert.deepEqual(fs.readFileSync(settingsFile),settingsBefore);assert.deepEqual(fs.readFileSync(registry),installedBefore);
assert.deepEqual(fs.readFileSync(receiptFile),priorReceipt);
assert.equal(fs.existsSync(path.join(root,'.agent-hands/hooks/pending')),false);
console.log(JSON.stringify({check:'package plan, install, repeat, update and exact project identity',passed:true}));
