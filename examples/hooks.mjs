import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { planWorkspaceHooks } from 'agent-hands';

const root = path.resolve('hooks-workspace');
mkdirSync(root, { recursive:true });
const input = {
  root,
  selections: [
    { target:'codex', enabled:true, hooks:[
      { owner:'node-version', event:'SessionStart', command:'node --version', timeout:4 },
    ] },
    { target:'cursor', enabled:true, hooks:[
      { owner:'node-version', event:'sessionStart', command:'node --version', timeout:4 },
    ] },
  ],
};
console.log(JSON.stringify(planWorkspaceHooks(input)));
writeFileSync('hooks.json', JSON.stringify(input, null, 2) + '\n', { flag:'wx' });
