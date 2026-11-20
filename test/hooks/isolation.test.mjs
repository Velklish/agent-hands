import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { scratch } from '../fixtures.mjs';

for (const target of ['claude','codex','cursor']) test(`${target}: root hook operations work without sibling modules`,t => {
  const root = scratch(t), pkg = path.join(root,'node_modules','agent-hands');
  fs.mkdirSync(pkg,{recursive:true});
  fs.copyFileSync('package.json',path.join(pkg,'package.json'));
  fs.cpSync('dist',path.join(pkg,'dist'),{recursive:true,filter:file => !['opencode','cursor','codex','claude'].some(other => other !== target && path.basename(file) === other && path.basename(path.dirname(file)) === 'adapters')});
  fs.symlinkSync(path.resolve('node_modules'),path.join(pkg,'node_modules'),'dir');
  const program = `import {applyWorkspaceHooks} from 'agent-hands';applyWorkspaceHooks({root:process.cwd(),target:${JSON.stringify(target)},enabled:true,hooks:[{owner:'test',event:'Stop',command:'sample'}]});`;
  const run = () => execFileSync(process.execPath,['--input-type=module','-e',program],{cwd:root,stdio:'pipe'});
  run();
  fs.appendFileSync(path.join(pkg,'dist/layout/adapters',target,'hooks.js'),`\nimport '../${target === 'cursor' ? 'claude' : 'cursor'}/hooks.js';`);
  assert.throws(run,/ERR_MODULE_NOT_FOUND/);
});
