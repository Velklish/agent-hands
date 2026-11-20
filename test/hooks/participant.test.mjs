import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { scratch, put } from '../fixtures.mjs';
import { applyWorkspaceHooks, applyPreparedWorkspaceHooks, prepareWorkspaceHooks, recoverWorkspaceHooks, inspectWorkspaceHookOperation,
  inspectWorkspaceRegistration } from 'agent-hands';

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
if (process.argv[2] === 'late-child') {
  const [, , ,root] = process.argv;
  await applyPreparedWorkspaceHooks(prepareWorkspaceHooks(lateInput(root)),lateParticipant(root,'kill'));
} else if (process.argv[2] === 'child') {
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

if (!process.argv[2]) test('explicit account lock is shared with workspace registration', async t => {
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
  const identity = {root,accountHome:home,marketplace,plugin};
  assert.deepEqual(inspectWorkspaceRegistration({...identity,plugin:'unrelated'}),{status:'missing'});
  assert.deepEqual(inspectWorkspaceRegistration(identity),{status:'retained',scope:'project',version});
  write(root,'.agent-hands/hooks/claude/registration.json',{plugin,marketplace,directory,fingerprint,version});
  assert.deepEqual(inspectWorkspaceRegistration(identity),{status:'current',scope:'project',version,fingerprint});
  assert.deepEqual(inspectWorkspaceRegistration({...identity,expectedVersion:'1.0.1'}),{status:'stale',scope:'project',version,fingerprint});
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
  const child = spawnSync(process.execPath,['--input-type=module','-e',`
    import {applyPreparedWorkspaceHooks,prepareWorkspaceHooks} from 'agent-hands';
    await applyPreparedWorkspaceHooks(prepareWorkspaceHooks(JSON.parse(process.argv[1])),{
      id:'native-fixture',async stage(){process.exit(78);},async finish(){}
    });
  `,JSON.stringify(project)],{encoding:'utf8'});
  assert.equal(child.status,78,child.stderr);
  const pointer = path.join(root,'.agent-hands/hooks/pending');
  const saved = fs.readFileSync(pointer);
  fs.unlinkSync(path.join(home,'.agent-hands/account-hooks/transaction/pending.json'));
  fs.unlinkSync(path.join(root,'.agent-hands/hooks/claude/registration.json'));
  const pending = inspectWorkspaceHookOperation({root,accountHome:home,evidence:true});
  assert.equal(pending.registration,true);
  const proof = {operationId:pending.reconciliation.operationId,evidence:pending.reconciliation.evidence,
    documents:[{target:'claude',action:'accept'}],participantSha256:fingerprint,
    registration:{marketplace,plugin,version,fingerprint}};
  const peer = {id:'native-fixture',stage:async()=>assert.fail(),finish:async()=>assert.fail(),verifyReconciliation:async()=>assert.fail()};
  assert.throws(() => recoverWorkspaceHooks({root,targets:['claude'],accountHome:home,reconcile:proof},peer),/requires verified native registration/);
  assert.deepEqual(fs.readFileSync(pointer),saved);
  for (const [file,bytes] of unchanged.slice(0,2)) assert.deepEqual(fs.readFileSync(file),bytes);
});

function lateInput(root, command = 'updated') {
  return {root,selections:['claude','cursor'].map(target => ({
    target,enabled:true,hooks:[{owner:'fixture',event:'SessionStart',command}],
    ...(target === 'claude' ? {preferences:{disabledSkills:[command]}} : {}),
  }))};
}

function images(root) {
  return [
    '.claude/settings.json','.cursor/hooks.json',
    '.agent-hands/hooks/claude/ownership.json','.agent-hands/hooks/cursor/ownership.json',
    '.agent-hands/hooks/claude/preferences.json',
  ].map(file => fs.readFileSync(path.join(root,file)));
}
function lateParticipant(root, phase, decisions = []) {
  const peer = participant(root);
  const manifest = path.join(root,'manifest');
  return {...peer,async beforeCommit() {
    for (const bytes of images(root)) assert.match(bytes.toString(),/updated/);
    fs.writeFileSync(manifest,'late');
    if (phase === 'reject') throw new Error('Late fixture failure');
    if (phase === 'kill') process.kill(process.pid,'SIGKILL');
  },async finish(id,decision) {
    assert.equal(fs.readFileSync(manifest,'utf8'),'late');
    decisions.push(decision);
    await peer.finish(id,decision);
  }};
}

if (!process.argv[2]) for (const phase of ['reject','kill']) {
  if (phase === 'kill' && process.platform === 'win32') continue;
  test(`late participant ${phase} restores exact files and can retry`,async t => {
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'peer-late-')));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    for (const name of ['first','second']) fs.mkdirSync(path.join(root,name));
    const manifest=path.join(root,'manifest'), alias=path.join(root,'alias'), journal=path.join(root,'peer.json');
    fs.writeFileSync(manifest,'first');
    fs.symlinkSync('first',alias);
    applyWorkspaceHooks(lateInput(root,'original'));
    const before=images(root), decisions=[];
    if (phase === 'reject') {
      await assert.rejects(applyPreparedWorkspaceHooks(prepareWorkspaceHooks(lateInput(root)),lateParticipant(root,phase,decisions)),/Late fixture failure/);
    } else {
      const child=spawnSync(process.execPath,[file,'late-child',root],{encoding:'utf8',timeout:10_000,killSignal:'SIGKILL'});
      assert.equal(child.error,undefined);
      assert.equal(child.signal,'SIGKILL',child.stderr);
      const interrupted=images(root);
      for (const bytes of interrupted) assert.match(bytes.toString(),/updated/);
      assert.equal(fs.readFileSync(manifest,'utf8'),'late');
      assert.equal(fs.readlinkSync(alias),'second');
      assert.deepEqual(inspectWorkspaceHookOperation({root}),{pending:true,registration:false,targets:['claude','cursor']});
      const scope={root,targets:['claude','cursor']}, peer=lateParticipant(root,'recover',decisions);
      await assert.rejects(recoverWorkspaceHooks(scope,{...peer,id:'unrelated'}),/original transaction participant/);
      assert.deepEqual(images(root),interrupted);
      assert.ok(fs.existsSync(journal));
      await recoverWorkspaceHooks(scope,peer);
    }
    assert.deepEqual(decisions,['rollback']);
    assert.deepEqual(images(root),before);
    assert.equal(fs.readFileSync(manifest,'utf8'),'first');
    assert.equal(fs.readlinkSync(alias),'first');
    assert.equal(fs.existsSync(journal),false);
    assert.equal(inspectWorkspaceHookOperation({root}).pending,false);

    await applyPreparedWorkspaceHooks(prepareWorkspaceHooks(lateInput(root)),lateParticipant(root,'retry',decisions));
    assert.deepEqual(decisions,['rollback','commit']);
    for (const bytes of images(root)) assert.match(bytes.toString(),/updated/);
    assert.equal(fs.readFileSync(manifest,'utf8'),'late');
    assert.equal(fs.readlinkSync(alias),'second');
    assert.equal(fs.existsSync(journal),false);
    assert.equal(inspectWorkspaceHookOperation({root}).pending,false);
  });
}

if (!process.argv[2] && process.platform !== 'win32') test('orphan accepts only checked targets and the original participant candidate', async t => {
  const root=fs.realpathSync(scratch(t));
  for (const name of ['first','second']) fs.mkdirSync(path.join(root,name));
  const manifest = put(root,'manifest','first'), peerJournal = path.join(root,'peer.json');
  const alias = path.join(root,'alias');
  fs.symlinkSync('first',alias);
  applyWorkspaceHooks(lateInput(root,'original'));
  const child = spawnSync(process.execPath,[file,'late-child',root],{encoding:'utf8',timeout:10_000});
  assert.equal(child.signal,'SIGKILL',child.stderr);
  const pointer = path.join(root,'.agent-hands/hooks/pending');
  const recorded = fs.readFileSync(pointer);
  fs.unlinkSync(path.join(root,'.agent-hands/hooks/transaction/pending.json'));
  const {targets,reconciliation} = inspectWorkspaceHookOperation({root,evidence:true});
  assert.equal(reconciliation.supported,true);
  assert.equal(reconciliation.participantRequired,true);
  assert.equal(reconciliation.evidence.length,5);
  const decisions = [];
  const digest = () => createHash('sha256').update(fs.readFileSync(peerJournal)).digest('hex');
  const candidate = images(root);
  let checked = 0;
  const peer = {...lateParticipant(root,'recover',decisions),async verifyReconciliation(operationId,expected) {
    checked++;
    assert.equal(operationId,JSON.parse(fs.readFileSync(peerJournal)).id);
    if (digest() !== expected) throw new Error('Participant evidence does not match');
    assert.deepEqual(images(root),candidate);
    assert.equal(fs.readFileSync(manifest,'utf8'),'late');
    assert.equal(fs.readlinkSync(alias),'second');
  }};
  const proof = {operationId:reconciliation.operationId,evidence:reconciliation.evidence,
    documents:targets.map(target=>({target,action:'accept'})),participantSha256:digest()};
  const run = (reconcile,participant) => recoverWorkspaceHooks({root,targets,reconcile},participant);
  assert.throws(()=>run({...proof,evidence:proof.evidence.slice(1)},peer),/does not match protected targets/);
  assert.throws(()=>run(proof,{...peer,id:'unrelated'}),/original participant/);
  assert.equal(checked,0);
  await assert.rejects(run({...proof,participantSha256:'0'.repeat(64)},peer),/Participant evidence does not match/);
  assert.deepEqual(fs.readFileSync(pointer),recorded);
  assert.deepEqual(images(root),candidate);
  assert.deepEqual(decisions,[]);
  await run(proof,peer);
  assert.equal(checked,2);
  assert.deepEqual(decisions,['commit']);
  assert.equal(fs.existsSync(peerJournal),false);
  assert.equal(fs.existsSync(pointer),false);
  assert.deepEqual(images(root),candidate);
});
