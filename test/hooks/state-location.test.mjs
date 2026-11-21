import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {applyPreparedWorkspaceHooks, applyWorkspaceHooks, inspectWorkspaceHookOperation, inspectWorkspaceHookOwnership,
  inspectWorkspaceRegistration, migrateWorkspaceHookState, planWorkspaceHooks, prepareWorkspaceHooks, recoverWorkspaceHooks} from 'agent-hands';
import {put, scratch} from '../fixtures.mjs';

const original = '.agent-hands/hooks';
const nested = '.agents/agent-hands/hooks';
const codex = {target:'codex',enabled:true,hooks:[{owner:'notice',event:'SessionStart',command:'node --version'}]};
const peer = {id:'layout',async stage(){},async finish(){}};
const json = (root,file,value) => put(root,file,JSON.stringify(value));

test('a new nested location is read-only until apply and leaves the default directory absent',t=>{
  const root = scratch(t);
  const selection = {root,stateLocation:'agents',...codex};
  assert.equal(planWorkspaceHooks(selection).changed,true);
  assert.equal(inspectWorkspaceHookOwnership(selection),null);
  assert.deepEqual(inspectWorkspaceHookOperation(selection),{pending:false,registration:false});
  assert.deepEqual(migrateWorkspaceHookState(selection),{changed:false});
  assert.deepEqual(fs.readdirSync(root),[]);
  applyWorkspaceHooks(selection);
  assert.equal(fs.existsSync(path.join(root,'.agent-hands')),false);
  assert.ok(fs.existsSync(path.join(root,nested,'codex/ownership.json')));
  assert.deepEqual(inspectWorkspaceHookOwnership(selection),{owners:['notice'],released:[]});
  assert.equal(planWorkspaceHooks(selection).changed,false);
});

test('move confirmed receipts in both directions without changing native files', async t=>{
  const base = fs.realpathSync(scratch(t));
  const root = path.join(base,'project'), accountHome = path.join(base,'account');
  const directory = path.join(root,'market'), marketplace = 'fixture-market', plugin = 'fixture';
  const version = '1.0.0', fingerprint = 'a'.repeat(64);
  fs.mkdirSync(directory,{recursive:true});
  const markets = json(accountHome,'.claude/plugins/known_marketplaces.json',{[marketplace]:{source:{source:'directory',path:directory},installLocation:directory}});
  const installs = json(accountHome,'.claude/plugins/installed_plugins.json',{version:2,plugins:{[`${plugin}@${marketplace}`]:[
    {scope:'project',projectPath:root,version,installPath:path.join(accountHome,'.claude/plugins/cache',marketplace,plugin,version)},
  ]}});
  const receipt = json(root,`${original}/claude/registration.json`,{plugin,marketplace,directory,fingerprint,version});
  const document = json(root,'.claude/settings.json',{env:{FOREIGN:'keep'}});
  const registration = {marketplace,plugin,directory,version,fingerprint,executable:process.execPath,accountHome};
  const claude = {target:'claude',enabled:true,hooks:[{...codex.hooks[0],owner:'session'}],preferences:{disabledSkills:['sample']},registration};
  const batch = {root,accountHome,selections:[claude,codex]};
  const next = {...batch,stateLocation:'agents'};
  const doctor = {root,accountHome,marketplace,plugin};
  applyWorkspaceHooks(batch);
  const preparedBeforeMove = prepareWorkspaceHooks(batch);
  const saved = [document,markets,installs,path.join(root,'.codex/hooks.json')].map(file=>[file,fs.readFileSync(file),fs.statSync(file).ino]);
  const receipts = ['claude/preferences.json','claude/registration.json','claude/ownership.json','codex/ownership.json'];
  const bytes = dir => receipts.map(file=>fs.readFileSync(path.join(root,dir,file)));
  const oldBytes = bytes(original);
  const accountLock = path.join(accountHome,'.agent-hands/account-hooks/transaction/writer.lock');
  const accountInode = fs.statSync(accountLock).ino;
  assert.equal(planWorkspaceHooks(batch).changed,false);
  assert.throws(()=>planWorkspaceHooks(next),/Migrate it explicitly/);
  assert.throws(()=>inspectWorkspaceRegistration({...doctor,stateLocation:'agents'}),/Migrate it explicitly/);
  assert.equal(fs.existsSync(path.join(root,nested)),false);
  assert.throws(()=>migrateWorkspaceHookState({root,stateLocation:'agents'}),/original hook account/);
  assert.deepEqual(migrateWorkspaceHookState(next),{changed:true});
  assert.deepEqual(migrateWorkspaceHookState(next),{changed:false});
  assert.deepEqual(bytes(nested),oldBytes);
  await assert.rejects(applyPreparedWorkspaceHooks(preparedBeforeMove,peer),/Migrate it explicitly/);
  assert.equal(fs.existsSync(path.join(root,'.agent-hands')),false);
  assert.equal(fs.existsSync(receipt),false);
  assert.equal(fs.statSync(accountLock).ino,accountInode);
  assert.deepEqual(inspectWorkspaceHookOwnership({root,target:'claude',stateLocation:'agents'}),{owners:['session'],released:[]});
  const status = {status:'current',scope:'project',version,fingerprint};
  assert.deepEqual(inspectWorkspaceRegistration({...doctor,stateLocation:'agents'}),status);
  assert.equal(planWorkspaceHooks(next).changed,false);
  assert.equal(applyWorkspaceHooks(next).changed,false);
  assert.deepEqual(migrateWorkspaceHookState({...next,stateLocation:'default'}),{changed:true});
  assert.deepEqual(bytes(original),oldBytes);
  assert.deepEqual(inspectWorkspaceRegistration(doctor),status);
  assert.equal(fs.existsSync(path.join(root,nested)),false);
  for (const [file,content,inode] of saved) {
    assert.deepEqual(fs.readFileSync(file),content);
    assert.equal(fs.statSync(file).ino,inode);
  }
});

for (const stateLocation of ['default','agents']) for (const published of [false,true]) test(
  `recover ${stateLocation} account state ${published ? 'after' : 'before'} the workspace pointer is published`,t=>{
  const base = fs.realpathSync(scratch(t)), root = path.join(base,'project'), accountHome = path.join(base,'account');
  fs.mkdirSync(root); fs.mkdirSync(accountHome);
  const input = {root,accountHome,stateLocation,selections:[codex]};
  const accountState = path.join(accountHome,'.agent-hands/account-hooks');
  const journal = path.join(accountState,'transaction/pending.json');
  const accountPointer = path.join(accountState,'pending');
  const localPointer = path.join(root,stateLocation === 'agents' ? nested : original,'pending');
  const child = spawnSync(process.execPath,['--input-type=module','-e',`
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import {applyWorkspaceHooks} from 'agent-hands';
    const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{rename(from,to);if(to===process.argv[2])process.exit(73);};
    syncBuiltinESMExports();
    applyWorkspaceHooks(JSON.parse(process.argv[1]));
  `,JSON.stringify(input),published ? accountPointer : journal],{encoding:'utf8'});
  assert.equal(child.status,73,child.stderr);
  const before = fs.readFileSync(journal);
  const pointer = published ? fs.readFileSync(localPointer) : null;
  if (published) assert.deepEqual(fs.readFileSync(accountPointer),pointer);
  else {
    assert.equal(fs.existsSync(localPointer),false);
    assert.equal(fs.existsSync(accountPointer),false);
  }
  assert.deepEqual(inspectWorkspaceHookOperation(input),{pending:true,registration:false,targets:['codex'],accountScoped:true});
  const to = stateLocation === 'agents' ? 'default' : 'agents';
  assert.throws(()=>migrateWorkspaceHookState({root,accountHome,stateLocation:to}),/Unfinished hook operation/);
  assert.deepEqual(fs.readFileSync(journal),before);
  if (published) {
    assert.deepEqual(fs.readFileSync(localPointer),pointer);
    assert.deepEqual(fs.readFileSync(accountPointer),pointer);
  }
  recoverWorkspaceHooks({root,accountHome,stateLocation,targets:['codex']});
  assert.equal(fs.existsSync(journal),false);
  assert.equal(fs.existsSync(localPointer),false);
  assert.equal(fs.existsSync(accountPointer),false);
  assert.equal(fs.existsSync(path.join(root,'.codex/hooks.json')),false);
  assert.deepEqual(migrateWorkspaceHookState({root,accountHome,stateLocation:to}),{changed:true});
});

test('moving refuses competing, foreign, and edited state without altering metadata',t=>{
  for (const problem of ['collision','foreign','edited','symlink']) {
    const root = scratch(t);
    const input = {root,...codex};
    applyWorkspaceHooks(input);
    const owned = path.join(root,original,'codex/ownership.json');
    const before = fs.readFileSync(owned);
    const document = path.join(root,'.codex/hooks.json');
    const extra = {
      collision:()=>put(root,`${nested}/extra`,'keep'),
      foreign:()=>put(root,`${original}/codex/extra`,'keep'),
      edited:()=>put(root,'.codex/hooks.json','{"hooks":{}}'),
      symlink:()=>{
        const outside = scratch(t);
        fs.symlinkSync(outside,path.join(root,'.agents'),process.platform === 'win32' ? 'junction' : 'dir');
        return put(outside,'extra','keep');
      },
    }[problem]();
    const extraBefore = fs.readFileSync(extra), settings = fs.readFileSync(document);
    assert.throws(()=>migrateWorkspaceHookState({root,stateLocation:'agents'}),/both locations|Unexpected workspace hook state file|missing|physical hook state directory/);
    assert.deepEqual(fs.readFileSync(owned),before);
    assert.deepEqual(fs.readFileSync(extra),extraBefore);
    assert.deepEqual(fs.readFileSync(document),settings);
  }
});

test('retry after an interrupted rename clears the empty previous state parent',t=>{
  const root = fs.realpathSync(scratch(t));
  applyWorkspaceHooks({root,...codex});
  const destination = path.join(root,nested);
  const child = spawnSync(process.execPath,['--input-type=module','-e',`
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import {migrateWorkspaceHookState} from 'agent-hands';
    const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{rename(from,to);if(to===process.argv[2])process.exit(74);};
    syncBuiltinESMExports();
    migrateWorkspaceHookState({root:process.argv[1],stateLocation:'agents'});
  `,root,destination],{encoding:'utf8'});
  assert.equal(child.status,74,child.stderr);
  assert.deepEqual(inspectWorkspaceHookOwnership({root,target:'codex',stateLocation:'agents'}),{owners:['notice'],released:[]});
  assert.deepEqual(migrateWorkspaceHookState({root,stateLocation:'agents'}),{changed:false});
  assert.equal(fs.existsSync(path.join(root,'.agent-hands')),false);
});
