import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}
export function put(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, text);
  return file;
}
export const input = (root,target,extra={}) => ({root,target,skills:[],subagents:[],rules:[],servers:[],...extra});
