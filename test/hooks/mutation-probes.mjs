import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(),'planner-mutations-'));
try {
  fs.cpSync('dist',path.join(root,'dist'),{recursive:true});
  fs.mkdirSync(path.join(root,'test','hooks'),{recursive:true});
  fs.copyFileSync('test/hooks/planner.test.mjs',path.join(root,'test','hooks','planner.test.mjs'));
  fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
  const file = path.join(root,'dist/hooks/hook-plan.js');
  const baseline = fs.readFileSync(file,'utf8');
  const run = () => spawnSync(process.execPath,['test/hooks/planner.test.mjs'],{cwd:root,encoding:'utf8'});
  assert.equal(run().status,0);
  for (const [from,to,expected] of [
    ['matches.length !== 1','matches.length < 1','duplicate physical callback is ambiguous'],
    ['s.list.splice(s.location.callbackIndex, 1)','s.list.splice(s.location.callbackIndex, 2)','flat removal preserves user fields and siblings'],
  ]) {
    assert.equal(baseline.split(from).length,2);
    fs.writeFileSync(file,baseline.replace(from,to));
    const result = run();
    assert.equal(result.status,1); assert.ok(result.stderr.includes(expected),result.stderr);
    console.log('Killed:',expected);
  }
} finally { fs.rmSync(root,{recursive:true,force:true}); }
