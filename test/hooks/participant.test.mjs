import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { applyPreparedWorkspaceHooks, prepareWorkspaceHooks, recoverWorkspaceHooks } from 'agent-hands';

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
  const [, , ,root,phase] = process.argv;
  const scope = {root,target:'claude'}, peer = participant(root,phase);
  if (phase === 'recover') await recoverWorkspaceHooks(scope,peer);
  else await applyPreparedWorkspaceHooks(prepareWorkspaceHooks({...scope,enabled:true,hooks:[{owner:'fixture',command:'sample',event:'SessionStart'}]}),peer);
} else for (const phase of ['stage','finish']) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'peer-restart-')));
  try {
    for (const name of ['first','second']) fs.mkdirSync(path.join(root,name));
    fs.writeFileSync(path.join(root,'manifest'),'first'); fs.symlinkSync('first',path.join(root,'alias'));
    const run = phase => spawnSync(process.execPath,[file,'child',root,phase],{encoding:'utf8'});
    assert.equal(run(phase).status,phase === 'stage' ? 71 : 72);
    assert.throws(() => recoverWorkspaceHooks({root,target:'claude'}),/original transaction participant/);
    const retry = run('recover'); assert.equal(retry.status,0,retry.stderr);
    const expected = phase === 'stage' ? 'first' : 'second';
    assert.equal(fs.readFileSync(path.join(root,'manifest'),'utf8'),expected);
    assert.equal(fs.readlinkSync(path.join(root,'alias')),expected);
    assert.equal(fs.existsSync(path.join(root,'.claude/settings.json')),phase === 'finish');
    assert.equal(fs.existsSync(path.join(root,'peer.json')),false);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
