import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTargets, parseHookJournal, rollbackTargets, snapshot } from '../../dist/hooks/hook-journal.js';

const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(),'hook-journal-')));
try {
  const files = ['config','ownership'].map(name => path.join(dir,name));
  const targets = files.map(file => ({ file,before:null,after:'managed' }));
  const journal = parseHookJournal(JSON.stringify({ version:1, phase:'pending', targets }),files);
  writeFileSync(files[1],'manual');
  assert.throws(() => applyTargets(journal));
  assert.equal(snapshot(files[0]),null);
  rmSync(files[1]);
  applyTargets(journal);
  writeFileSync(files[0],'manual');
  assert.throws(() => rollbackTargets(journal));
  assert.equal(snapshot(files[0]),'manual');
  assert.equal(snapshot(files[1]),'managed');
  writeFileSync(files[0],'managed');
  assert.throws(() => rollbackTargets({ ...journal,phase:'committed' }));
  assert.throws(() => parseHookJournal(JSON.stringify(journal),files.toReversed()));
  rollbackTargets(journal);
  assert.deepEqual(files.map(snapshot),[null,null]);
} finally { rmSync(dir,{ recursive:true,force:true }); }
console.log('Bounded rollback checks passed');
