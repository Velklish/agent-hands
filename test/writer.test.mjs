import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { artifactLayout } from '../dist/layout/artifacts.js';
import { removeTemporarySnapshot, sha256, writeAtomic } from '../dist/layout/fs.js';
import { Writer } from '../dist/layout/writer.js';
import { scratch, put } from './fixtures.mjs';

test('copied files keep executable bits and exclude only incidental entries', async t => {
  const dir = scratch(t), root = path.join(dir, 'out'), source = path.join(dir, 'source');
  for (const name of ['script.py', 'run', '.DS_Store', '.git/config', 'cache/__pycache__/stale.pyc', 'kept.pyc', '__pycache__']) put(source, name, name);
  const copy = (files = {}) => {
    const writer = new Writer(root, { files });
    writer.copyDir(source, 'skills');
    writer.apply();
    return writer;
  };
  const initial = copy();
  assert.deepEqual(Object.keys(initial.files).sort(), ['skills/__pycache__', 'skills/kept.pyc', 'skills/run', 'skills/script.py']);
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(source, 'run'), 0o755);
    const executable = copy(initial.files);
    assert.equal(fs.statSync(path.join(root, 'skills/run')).mode & 0o111, 0o111);
    assert.equal(executable.files['skills/run'],initial.files['skills/run']);
  }
  put(root, 'skills/foreign.pyc', 'foreign');
  fs.unlinkSync(path.join(source, 'kept.pyc'));
  const next = copy(initial.files);
  assert.equal(fs.existsSync(path.join(root, 'skills/kept.pyc')), false);
  assert.equal(fs.readFileSync(path.join(root, 'skills/foreign.pyc'), 'utf8'), 'foreign');
  assert.deepEqual(copy(next.files).files, next.files);
});

test('copy reports a skipped source link with origin instead of following it', t => {
  const root = scratch(t), source = path.join(root,'source');
  const regular = put(source,'regular','bytes'), link = path.join(source,'link');
  fs.symlinkSync(regular,link);
  const writer = new Writer(root,{files:{}}), diagnostics=[];
  writer.copyDir(source,'output',{origin:'catalog',skipped:entry=>diagnostics.push(entry)});
  writer.apply();
  assert.deepEqual(diagnostics,[{src:link,rel:'output/link',origin:'catalog',symbolic:true}]);
  assert.equal(fs.existsSync(path.join(root,'output/link')),false);
  assert.equal(fs.readFileSync(path.join(root,'output/regular'),'utf8'),'bytes');
});

test('duplicate bytes coalesce; divergent or escaping staging refuses before any write', t => {
  const root = scratch(t);
  const writer = new Writer(root, { files: {} });
  writer.stage('again', 'bytes', { origin: 'first' });
  writer.stage('again', 'bytes', { origin: 'second' });
  writer.apply();
  assert.deepEqual(writer.written, ['again']);
  for (const bad of ['divergent', 'escape']) {
    const pending = new Writer(root, { files: writer.files });
    pending.stage('new', 'some bytes');
    if (bad === 'divergent') pending.stage('new', 'different', { origin: 'another source' });
    else pending.stage('../outside', 'outside', { origin: 'other source' });
    assert.throws(() => pending.apply(), bad === 'divergent' ? /collision.*new.*another source/ : /escapes.*outside/);
    assert.equal(fs.existsSync(path.join(root, 'new')), false);
  }
});

test('state writes replace the inode, keep the old bytes on refusal, and leave no temporary file', t => {
  const root = scratch(t), file = path.join(root, 'nested/state.json'), old = path.join(root, 'old');
  writeAtomic(file, 'first', { mode: 0o600 });
  fs.linkSync(file, old);
  writeAtomic(file, 'second', { mode: 0o600 });
  assert.equal(fs.readFileSync(old, 'utf8'), 'first');
  assert.throws(() => writeAtomic(file, 'failed', { stagingDir: old }));
  assert.equal(fs.readFileSync(file, 'utf8'), 'second');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
  const occupied = path.join(root,'occupied');
  put(occupied,'foreign','keep');
  assert.throws(()=>writeAtomic(occupied,'third'));
  assert.deepEqual(fs.readdirSync(root).sort(),['nested','occupied','old']);
  assert.equal(fs.readFileSync(path.join(occupied,'foreign'),'utf8'),'keep');
});

test('late failure restores secure MCP contents and the requested rollback mode', async t => {
  if (process.platform === 'win32') return;
  const root = scratch(t), rel = 'mcp.json', file = put(root,rel,'previous');
  for (const restoreOriginalMode of [false,true]) {
    fs.chmodSync(file,0o640);
    const writer = new Writer(root,{files:{}},{adopt:true});
    writer.stage(rel,'next');
    const atomic = {paths:new Set([rel]),restoreOriginalMode};
    await assert.rejects(writer.transaction([],async()=>{
      writer.commit(undefined,atomic);
      assert.equal(fs.statSync(file).mode & 0o777,0o600);
      throw new Error('late failure');
    },{atomic}),/late failure/);
    assert.equal(fs.readFileSync(file,'utf8'),'previous');
    assert.equal(fs.statSync(file).mode & 0o777,restoreOriginalMode ? 0o640 : 0o600);
  }
});

test('late failure restores executable permissions on changed and unchanged file bytes', async t => {
  if (process.platform === 'win32') return;
  const root=scratch(t), file=put(root,'script','old');
  fs.chmodSync(file,0o640);
  for (const bytes of ['new','old']) {
    const writer=new Writer(root,{files:{}},{adopt:true});
    writer.stage('script',bytes,{mode:0o111});
    await assert.rejects(writer.transaction([],async()=>{
      writer.commit();
      assert.equal(fs.statSync(file).mode & 0o111,0o111);
      throw new Error('late failure');
    }),/late failure/);
    assert.equal(fs.readFileSync(file,'utf8'),'old');
    assert.equal(fs.statSync(file).mode & 0o777,0o640);
  }
});

test('shared artifacts are immutable, isolated per consumer, and bindings roll back on a late refusal', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-artifacts-'));
  t.after(() => removeTemporarySnapshot(dir));
  const store = path.join(dir, 'store'), a = path.join(dir, 'one'), b = path.join(dir, 'two');
  fs.mkdirSync(a); fs.mkdirSync(b);
  const artifacts = artifactLayout(['native/skills'], { root: dir, artifacts: store, renderer: 1 });
  const rel = 'native/skills/check/SKILL.md', config = 'settings.json';
  const prepare = (root, files, body) => {
    const writer = new Writer(root, { files }, { artifacts });
    writer.stage(rel, body);
    writer.stage(config, body);
    return writer;
  };
  const first = prepare(a, {}, 'old'); first.apply();
  const peer = prepare(b, {}, 'old'); peer.apply();
  const binding = path.join(a, 'native/skills');
  const initialTarget = fs.realpathSync(binding);
  assert.equal(fs.realpathSync(path.join(b, 'native/skills')), initialTarget);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(a, rel)).mode & 0o222, 0);
  const pending = prepare(a, first.files, 'new');
  await assert.rejects(pending.transaction([], async () => {
    pending.apply();
    assert.notEqual(fs.realpathSync(binding), initialTarget);
    assert.equal(fs.readFileSync(path.join(a, config), 'utf8'), 'new');
    throw new Error('late refusal');
  }), /late refusal/);
  assert.equal(fs.realpathSync(binding), initialTarget);
  assert.equal(fs.readFileSync(path.join(a, config), 'utf8'), 'old');
  assert.equal(first.files[rel], sha256('old'));
  prepare(a, first.files, 'new').apply();
  assert.equal(fs.readFileSync(path.join(a, rel), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(b, rel), 'utf8'), 'old');
});
