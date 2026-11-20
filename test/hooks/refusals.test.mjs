import assert from 'node:assert/strict'; const check = (name,ok) => assert.ok(ok,name);
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTargets, rollbackTargets, snapshot } from '../../dist/hooks/hook-journal.js';
import { assertHookOperationIdle } from '../../dist/hooks/hook-operation.js';
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
