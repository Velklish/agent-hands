import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { scratch, put } from '../fixtures.mjs';
import { applyPreparedWorkspaceHooks, prepareWorkspaceHooks, recoverWorkspaceHooks, inspectWorkspaceHookOperation } from 'agent-hands';

const file = fileURLToPath(import.meta.url);
function participant(root,crash) {
  const manifest = path.join(root,'manifest'), alias = path.join(root,'alias'), journal = path.join(root,'peer.json');
  return {id:'fixture-layout',async stage(id) {
    fs.writeFileSync(journal,JSON.stringify({id,manifest:fs.readFileSync(manifest,'utf8'),link:fs.readlinkSync(alias)}),{flag:'wx'});
    fs.writeFileSync(manifest,'second'); fs.unlinkSync(alias); fs.symlinkSync('second',alias);
    if (crash === 'stage') process.exit(71);
  },async finish(id,decision) {
    if (!fs.existsSync(journal)) return;
    const before = JSON.parse(fs.readFileSync(journal,'utf8'));
    assert.equal(id,before.id);
    if (crash === 'finish') process.exit(72);
    if (decision === 'rollback') {
      fs.writeFileSync(manifest,before.manifest); fs.unlinkSync(alias); fs.symlinkSync(before.link,alias);
    }
    fs.unlinkSync(journal);
  }};
}
if (process.argv[2] === 'child') {
  const [, , ,root,phase,accountHome] = process.argv;
  const scope = {root,target:'claude'}, peer = participant(root,phase);
  const selection = {target:scope.target,enabled:true,hooks:[{owner:'fixture',command:'sample',event:'SessionStart'}]};
  if (phase === 'recover') await recoverWorkspaceHooks(accountHome ? {root,targets:['claude'],accountHome} : scope,peer);
  else await applyPreparedWorkspaceHooks(prepareWorkspaceHooks(accountHome ? {root,accountHome,selections:[selection]} : {root,...selection}),peer);
} else for (const phase of ['stage','finish']) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'peer-restart-')));
  try {
    for (const name of ['first','second']) fs.mkdirSync(path.join(root,name));
    fs.writeFileSync(path.join(root,'manifest'),'first'); fs.symlinkSync('first',path.join(root,'alias'));
    const accountHome = phase === 'finish' ? path.join(root,'first') : undefined;
    const run = phase => spawnSync(process.execPath,[file,'child',root,phase,...(accountHome ? [accountHome] : [])],{encoding:'utf8'});
    assert.equal(run(phase).status,phase === 'stage' ? 71 : 72);
    assert.deepEqual(inspectWorkspaceHookOperation({root,accountHome}),{pending:true,registration:false,targets:['claude'],...(accountHome && {accountScoped:true})});
    if (accountHome) assert.throws(() => recoverWorkspaceHooks({root,targets:['claude'],accountHome:path.join(root,'second')}),/account does not match/);
    assert.throws(() => recoverWorkspaceHooks(accountHome ? {root,targets:['claude'],accountHome} : {root,target:'claude'}),/original transaction participant/);
    const retry = run('recover'); assert.equal(retry.status,0,retry.stderr);
    const expected = phase === 'stage' ? 'first' : 'second';
    assert.equal(fs.readFileSync(path.join(root,'manifest'),'utf8'),expected);
    assert.equal(fs.readlinkSync(path.join(root,'alias')),expected);
    assert.equal(fs.existsSync(path.join(root,'.claude/settings.json')),phase === 'finish');
    assert.equal(fs.existsSync(path.join(root,'peer.json')),false);
    assert.deepEqual(inspectWorkspaceHookOperation({root,accountHome}),{pending:false,registration:false});
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}

if (process.argv[2] !== 'child') test('explicit account lock is shared with workspace registration', async t => {
  const base = fs.realpathSync(scratch(t)), home = path.join(base,'account'), root = path.join(base,'workspace');
  const directory = path.join(root,'market'), marketplace = 'fixture-market', plugin = 'fixture';
  const version = '1.0.0', fingerprint = 'a'.repeat(64);
  const registration = {marketplace,plugin,directory,version,fingerprint,executable:process.execPath,accountHome:home};
  const write = (base, rel, value) => put(base,rel,JSON.stringify(value));
  write(directory,'.claude-plugin/marketplace.json',{name:marketplace,owner:{name:'Fixture'},plugins:[{name:plugin,source:'./fixture'}]});
  write(directory,'fixture/.claude-plugin/plugin.json',{name:plugin,version});
  const markets = write(home,'.claude/plugins/known_marketplaces.json',{[marketplace]:{source:{source:'directory',path:directory},installLocation:directory}});
  const installed = write(home,'.claude/plugins/installed_plugins.json',{version:2,plugins:{[`${plugin}@${marketplace}`]:[
    {scope:'project',projectPath:root,version,installPath:path.join(home,'.claude/plugins/cache',marketplace,plugin,version)},
  ]}});
  write(root,'.agent-hands/hooks/claude/registration.json',{plugin,marketplace,directory,fingerprint,version});
  const settings = write(root,'.claude/settings.json',{env:{FOREIGN:'preserve'}});
  const project = {root,selections:[{target:'claude',enabled:true,hooks:[],registration}]};
  assert.throws(() => prepareWorkspaceHooks({...project,accountHome:root}),/does not match the batch account/);
  const prepared = prepareWorkspaceHooks(project);
  assert.deepEqual(prepared.registrations,[{target:'claude',action:'current',version,previousVersion:version}]);
  const machine = prepareWorkspaceHooks({root:home,accountHome:home,selections:[
    {target:'codex',enabled:true,hooks:[{owner:'fixture',event:'SessionStart',command:'node --version'}]},
  ]});
  const unchanged = [markets,installed,settings].map(file=>[file,fs.readFileSync(file)]);
  await applyPreparedWorkspaceHooks(machine,{id:'account-fixture',async stage() {
    assert.deepEqual(inspectWorkspaceHookOperation({root:home,accountHome:home}),
      {pending:true,registration:false,targets:['codex'],accountScoped:true});
    await assert.rejects(applyPreparedWorkspaceHooks(prepared,{id:'workspace-fixture',stage:async()=>assert.fail(),finish:async()=>assert.fail()}),
      /locked|Unfinished/);
    for (const [file,bytes] of unchanged) assert.deepEqual(fs.readFileSync(file),bytes);
  }, async finish(_id,decision) { assert.equal(decision,'commit'); }});
  const result = await applyPreparedWorkspaceHooks(prepareWorkspaceHooks({...project,accountHome:home}),{id:'workspace-fixture',
    async stage() { assert.deepEqual(inspectWorkspaceHookOperation({root,accountHome:home}),{pending:true,registration:true,targets:['claude']}); },
    async finish(_id,decision) { assert.equal(decision,'commit'); },
  });
  assert.deepEqual(result.registrations,[{target:'claude',status:'current',version,previousVersion:version}]);
  for (const [file,bytes] of unchanged.slice(0,2)) assert.deepEqual(fs.readFileSync(file),bytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings)).env,{FOREIGN:'preserve'});
});
