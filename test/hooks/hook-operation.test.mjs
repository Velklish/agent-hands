import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertHookOperationIdle, commitHookOperation, findHookOperation, reconcileOrphanedHookOperation, recoverHookOperation } from '../../dist/hooks/hook-operation.js';

function fixture(root) {
  const directory = path.join(root,'journal');
  const targets = ['config','metadata'].map(n => path.join(root,n));
  return { directory,targets,pointers:[path.join(root,'pointer')] };
}
const changes = scope => scope.targets.map(file => ({ file,before:null,after:'applied' }));
const [, ,child, root, boundary] = process.argv;
if (child === '--child') {
  const scope = fixture(root);
  let count = 0;
  const rename = fs.renameSync;
  fs.renameSync = (...args) => {
    rename(...args);
    if (++count === Number(boundary)) process.exit(73);
  };
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (...args) => { unlink(...args); if (++count === Number(boundary)) process.exit(73); };
  syncBuiltinESMExports();
  commitHookOperation(scope,changes(scope));
} else if (child === '--native-child') {
  const scope = fixture(root), file = scope.targets[0];
  commitHookOperation(scope,changes(scope),[{files:[file],run:() => { fs.writeFileSync(file,'partial native output'); process.exit(74); },verify:() => false}]);
} else {
  const nativeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'native-restart-')));
  try {
    const scope = fixture(nativeRoot);
    assert.equal(spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--native-child',nativeRoot]).status,74);
    assert.throws(() => recoverHookOperation(scope),/unrecognized value/);
    assert.equal(fs.readFileSync(scope.targets[0],'utf8'),'partial native output');
    assert.equal(fs.existsSync(scope.targets[1]),false);
    fs.unlinkSync(scope.targets[0]); recoverHookOperation(scope);
  } finally { fs.rmSync(nativeRoot,{recursive:true,force:true}); }
  for (const boundary of [1,2,3,4,5,6,7]) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hook-operation-')));
    try {
      const scope = fixture(root);
      assert.equal(spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--child',root,String(boundary)],{stdio:'inherit'}).status,73);
      if (boundary < 7) {
        assert.throws(() => commitHookOperation(scope,changes(scope)),/Unfinished/);
        assert.throws(() => recoverHookOperation({ ...scope,targets:[...scope.targets].reverse() }),/scope mismatch/);
        recoverHookOperation(scope);
      } else assert.equal(findHookOperation(scope.directory,scope.pointers),null);
      for (const file of scope.targets) assert.equal(fs.existsSync(file),boundary >= 5);
      assert.equal(fs.existsSync(scope.pointers[0]),false);
      assert.equal(fs.existsSync(path.join(scope.directory,'pending.json')),false);
      console.log(`PASS restart after write ${boundary}`);
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hook-operation-')));
  try {
    const scope = fixture(root);
    const [config,receipt] = scope.targets;
    const external = {
      files:[config],run:() => { fs.writeFileSync(config,'known normalization'); return 7; },
      verify:() => false,verifyFailure:(_before,after) => after[0] === 'known normalization',
    };
    assert.throws(() => commitHookOperation(scope,changes(scope),[external]),/External hook step failed/);
    assert.equal(fs.existsSync(config),false);
    assert.equal(fs.existsSync(receipt),false);
    assert.equal(findHookOperation(scope.directory,scope.pointers),null);
    console.log('PASS verified external failure rolls back exact values and permits re-entry');

    external.run = () => { fs.writeFileSync(config,'unrelated user value'); return 7; };
    assert.throws(() => commitHookOperation(scope,changes(scope),[external]),/unrecognized value/);
    assert.throws(() => assertHookOperationIdle({ ...scope,pointers:[path.join(root,'other-project')] }),/Unfinished/);
    assert.deepEqual(findHookOperation(scope.directory,scope.pointers),scope);
    assert.throws(() => recoverHookOperation(scope),/unrecognized value/);
    assert.equal(fs.readFileSync(config,'utf8'),'unrelated user value');
    assert.equal(fs.existsSync(receipt),false);
    fs.writeFileSync(config,'applied');
    recoverHookOperation(scope);
    assert.equal(fs.existsSync(config),false);
    console.log('PASS third value remains blocked across writers until exact state is reconciled');

    const oldProject = path.join(root,'old-project');
    const newProject = path.join(root,'moved-project');
    const moved = { ...scope,targets:[path.join(oldProject,'config')],pointers:[...scope.pointers,path.join(oldProject,'pending')] };
    assert.throws(() => commitHookOperation(moved,changes(moved),[{
      ...external,files:moved.targets,run:() => { fs.writeFileSync(moved.targets[0],'third value'); return 7; },
    }]),/unrecognized value/);
    fs.renameSync(oldProject,newProject);
    const movedPath = path.join(newProject,'config');
    assert.throws(() => recoverHookOperation(moved,{ from:oldProject,to:newProject }),/unrecognized value/);
    assert.equal(fs.readFileSync(movedPath,'utf8'),'third value');
    fs.writeFileSync(movedPath,'applied');
    recoverHookOperation(moved,{ from:oldProject,to:newProject });
    assert.equal(fs.existsSync(movedPath),false);
    assert.equal(fs.existsSync(path.join(newProject,'pending')),false);
    console.log('PASS moved scope requires matching pointer and preserves third values');

    assert.throws(() => commitHookOperation(scope,changes(scope),[external]),/unrecognized value/);
    fs.unlinkSync(path.join(scope.directory,'pending.json'));
    assert.throws(() => recoverHookOperation(scope),/Missing operation journal/);
    const reconciliation = [
      { file:config,before:'unrelated user value',after:'unrelated user value' },
      { file:receipt,before:null,after:'explicitly released' },
    ];
    assert.throws(() => reconcileOrphanedHookOperation(scope,reconciliation.slice(0,1)),/Invalid protected operation/);
    assert.throws(() => reconcileOrphanedHookOperation(scope,[{ ...reconciliation[0],before:'stale' },reconciliation[1]]),/changed/);
    assert.equal(fs.existsSync(scope.pointers[0]),true);
    reconcileOrphanedHookOperation(scope,reconciliation);
    assert.equal(fs.readFileSync(config,'utf8'),'unrelated user value');
    assert.equal(fs.readFileSync(receipt,'utf8'),'explicitly released');
    assert.equal(fs.existsSync(scope.pointers[0]),false);
    console.log('PASS lost journal requires complete exact snapshots and confirmed reconciliation');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
