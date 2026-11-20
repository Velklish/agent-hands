import test from 'node:test';
import assert from 'node:assert/strict'; const check = (name,ok) => assert.ok(ok,name);
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTargets, rollbackTargets, snapshot } from '../../dist/hooks/hook-journal.js';
import { assertHookOperationIdle } from '../../dist/hooks/hook-operation.js';
import { applyWorkspaceHooks, planWorkspaceHooks, inspectWorkspaceHookOperation } from 'agent-hands';
import { put, scratch } from '../fixtures.mjs';
import { deliverHooks } from '../../dist/hooks/hook-delivery.js';

function refused(action,expected) {
  try { action(); return false; } catch (error) { return !expected || expected.test(error.message); }
}

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(),'hook-negative-')));
try {
  const config = path.join(root,'config');
  const state = path.join(root,'state');
  const targets = [config,state].map(file => ({ file,before:null,after:'new' }));
  const journal = { version:1,phase:'pending',targets };
  writeFileSync(state,'unexpected');
  const blocked = refused(() => applyTargets(journal));
  check('a changed later target prevents the first write',blocked && snapshot(config) === null && snapshot(state) === 'unexpected');

  writeFileSync(config,'new');
  const kept = refused(() => rollbackTargets(journal));
  check('third state prevents rollback of all targets',kept && snapshot(config) === 'new' && snapshot(state) === 'unexpected');

  const scope = { directory:root,pointers:[path.join(root,'other-project')] };
  writeFileSync(path.join(root,'pending.json'),'journal published before any pointer');
  check('another project detects the account journal before publishing pointers',refused(() => assertHookOperationIdle(scope)));
  rmSync(path.join(root,'pending.json'));

  const document = path.join(root,'settings');
  const receipt = path.join(root,'receipt');
  const spec = { target:'claude',document,state:receipt,intents:[{ owner:'subject',event:'Example',shell:{},callback:{ type:'command',command:'one' } }] };
  const deliveryScope = { directory:path.join(root,'operations'),pointers:[path.join(root,'pointer')] };
  const deliver = () => deliverHooks(deliveryScope,[spec],() => {});
  const duplicates = '{"field":"a","field":"b"}';
  writeFileSync(document,duplicates);
  const lossless = refused(deliver);
  check('ambiguous JSON spelling prevents delivery before resaving user values',lossless && snapshot(document) === duplicates && snapshot(receipt) === null);

  rmSync(document);
  rmSync(receipt,{ force:true });
  deliver();
  const previous = snapshot(receipt);
  const doubled = JSON.parse(snapshot(document));
  doubled.hooks.Example.push(doubled.hooks.Example[0]);
  const edited = JSON.stringify(doubled);
  writeFileSync(document,edited);
  const unique = refused(deliver,/ambiguous/);
  check('two exact callbacks refuse ownership without rewriting either file',unique && snapshot(document) === edited && snapshot(receipt) === previous);
} finally { rmSync(root,{recursive:true,force:true}); }


const malformed = '{"fixture-opaque":(}';
const request = root => ({root,target:'claude',enabled:true,hooks:[],preferences:{disabledSkills:['fixture']}});
const registration = (root,accountHome) => ({
  plugin:'subject',marketplace:'fixture',directory:path.join(root,'market'),executable:path.join(root,'claude'),
  version:'1.0.0',fingerprint:'a'.repeat(64),accountHome,
});
test('malformed settings, receipts and pending pointers refuse with sanitized errors', t => {
  for (const [file,message,check] of [
    ['.claude/settings.json','Invalid hook document',root=>applyWorkspaceHooks(request(root))],
    ['.agent-hands/hooks/claude/preferences.json','Invalid preference ownership',root=>applyWorkspaceHooks(request(root))],
    ['.agent-hands/hooks/claude/registration.json','Invalid registration receipt',(root,home)=>applyWorkspaceHooks({...request(root),registration:registration(root,home)})],
    ['.agent-hands/hooks/pending','Invalid workspace operation pointer',root=>inspectWorkspaceHookOperation({root})],
  ]) {
    const root=realpathSync(scratch(t)), home=realpathSync(scratch(t));
    const protectedFile=put(root,file,malformed);
    assert.throws(()=>check(root,home),error=>error.constructor === Error && error.message === message);
    assert.equal(snapshot(protectedFile),malformed);
    assert.equal(snapshot(path.join(root,'.agent-hands/hooks/claude/ownership.json')),null);
  }
});

test('public inspection reports another project blocking the account before or after pointer publication', t => {
  const root=realpathSync(scratch(t)), home=realpathSync(scratch(t)), other=realpathSync(scratch(t));
  const dir=path.join(home,'.agent-hands/account-hooks'), file=path.join(dir,'transaction/pending.json');
  const [foreignPointer,accountPointer]=[path.join(other,'.agent-hands/hooks/pending'),path.join(dir,'pending')];
  const targets=['.claude/settings.json','.agent-hands/hooks/claude/ownership.json','.agent-hands/hooks/claude/preferences.json']
    .map(file=>path.join(other,file));
  const reference=JSON.stringify({id:'abcdabcd-abcd-abcd-abcd-abcdabcdabcd',journal:file,pointers:[foreignPointer,accountPointer],targets,participant:'fixture-private'});
  const journal=JSON.stringify({reference,participant:'fixture-private',journal:{version:1,phase:'pending',targets:targets.map(file=>({file,before:'fixture-opaque',after:null}))}});
  put(home,path.relative(home,file),journal);
  for (const published of [false,true]) {
    if (published) put(home,path.relative(home,accountPointer),reference);
    assert.deepEqual(inspectWorkspaceHookOperation({root,accountHome:home}),{pending:false,registration:false,blockedBy:'another-project'});
    assert.deepEqual(inspectWorkspaceHookOperation({root}),{pending:false,registration:false});
    assert.deepEqual(inspectWorkspaceHookOperation({root:other,accountHome:home}),{pending:true,registration:false,targets:['claude'],accountScoped:true});
    const input={...request(root),registration:registration(root,home)};
    for (const check of [planWorkspaceHooks,applyWorkspaceHooks]) {
      assert.throws(()=>check(input),{message:'Account hook operation pending in another project'});
    }
    assert.equal(snapshot(file),journal);
    assert.equal(snapshot(accountPointer),published ? reference : null);
    for (const target of targets) assert.equal(snapshot(target),null);
    assert.equal(snapshot(path.join(root,'.claude/settings.json')),null);
  }
});
