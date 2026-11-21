import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceHookStateScope } from './options.js';

export function physicalDirectory(root: string, directory: string) {
  const relative = path.relative(root,directory);
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current,component);
    const stat = lstatSync(current,{throwIfNoEntry:false});
    if (!stat) return false;
    if (!stat.isDirectory() || realpathSync(current) !== current) throw new Error('Expected a physical hook state directory');
  }
  return true;
}

export function hookStatePaths({root,stateLocation = 'default'}:WorkspaceHookStateScope) {
  if (!path.isAbsolute(root)) throw new TypeError('Absolute workspace path required');
  if (stateLocation !== 'default' && stateLocation !== 'agents') throw new TypeError('Unknown hook state location');
  const base = realpathSync(root);
  const standalone = path.join(base,'.agent-hands','hooks');
  const agents = path.join(base,'.agents','agent-hands','hooks');
  const local = stateLocation === 'agents' ? agents : standalone;
  const alternate = stateLocation === 'agents' ? standalone : agents;
  const checkLocation = () => {
    physicalDirectory(base,local);
    try {
      if (lstatSync(alternate,{throwIfNoEntry:false})) throw new Error('Hook state exists at the other location. Migrate it explicitly before use.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
    }
  };
  return {base,local,alternate,checkLocation};
}

export function hookStateScope(local: string) {
  return {directory:path.join(local,'transaction'),pointers:[path.join(local,'pending')]};
}
