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
  fs.writeFileSync(file,baseline);
  const registration = 'test/adapters/claude/registration.test.mjs';
  fs.mkdirSync(path.join(root,path.dirname(registration)),{recursive:true});
  fs.copyFileSync(registration,path.join(root,registration));
  const operation = 'test/hooks/hook-operation.test.mjs';
  fs.copyFileSync(operation,path.join(root,operation));
  const native = 'dist/layout/adapters/claude/registration.js';
  for (const [module,suite,from,to,reason,expected] of [
    [native,registration,'exit !== 0 || !project','!project','native failure','native failure cannot confirm'],
    [native,registration,"if (!registrationPostcondition(request, before.settings ?? '{}')(after.settings))",'if (false)','unverified settings','neighbor mutation cannot confirm'],
    [native,registration,"if (!record(entry) || entry.installLocation !== request.directory || !isDeepStrictEqual(entry.source, { source: 'directory', path: request.directory }))",'if (false)','missing marketplace','installation alone is not a marketplace'],
    [native,registration,'const rows = installed[subject];','if (after.installations === null) return true; const rows = installed[subject];','missing installation','marketplace alone is not an installation'],
    ['dist/hooks/hook-operation.js',operation,'    assertHookOperationIdle(scope);','    /* omitted */','re-entry into pending transaction','AssertionError'],
  ]) {
    const target = path.join(root,module), original = fs.readFileSync(target,'utf8');
    const invoke = () => spawnSync(process.execPath,[suite],{cwd:root,encoding:'utf8'});
    assert.equal(original.split(from).length,2); assert.equal(invoke().status,0);
    fs.writeFileSync(target,original.replace(from,to));
    const result = invoke(); assert.equal(result.status,1,reason); assert.ok(result.stderr.includes(expected),result.stderr);
    fs.writeFileSync(target,original); console.log('Killed:',reason);
  }
} finally { fs.rmSync(root,{recursive:true,force:true}); }
