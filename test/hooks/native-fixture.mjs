import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {applyWorkspaceHooks} from 'agent-hands';
import {scratch} from '../fixtures.mjs';

export function assertNative(t,target,file,hooks,expected) {
  const root = scratch(t);
  applyWorkspaceHooks({root,target,enabled:true,hooks});
  assert.deepEqual(JSON.parse(readFileSync(path.join(root,file))),expected);
}
