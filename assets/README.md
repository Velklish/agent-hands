# agent-hands workspace instructions

These English files provide workspace instructions. They do not select a development workflow for your workspace.

- [Workspace rules](rules/AGENTS.md): read the selected sources and handle local preferences.
- [Workspace layout](rules/workspace.md): navigate repositories and distinguish source files from generated files.
- [Workspace template](templates/workspace/AGENTS.md): a starting point for the instructions you own.
- [Asking questions](skills/asking-questions/SKILL.md): an optional skill for writing decision and approval questions.

## Use the files directly

1. Keep this directory together so that relative links continue to work.
2. Copy the workspace template to your workspace root as `AGENTS.md` and fill in its source list. List the absolute paths to `rules/AGENTS.md` and `rules/workspace.md` from this directory, in that order. Add your own project instructions after the shared rules.
3. Ask your agent to read the listed files. If you want it to use a personal voice profile, add the path to your existing profile. To use the optional skill without installing it, ask your agent to read its `SKILL.md` for the current task.

## Apply the bundled rules and skill

With the package installed and its assets available in the current directory, run this JavaScript with an existing workspace directory as the first argument. Save the returned state separately for this target and delivery; pass it to the next `applyLayout` call.

```js
import path from 'node:path';
import { planLayout, applyLayout } from 'agent-hands';
const root = path.resolve(process.argv[2]);
const plan = planLayout({ root, target: 'cursor',
  rules: ['AGENTS.md', 'workspace.md'].map(name => path.resolve('assets/rules', name)),
  skills: [{ name: 'asking-questions', dirAbs: path.resolve('assets/skills/asking-questions') }],
  servers: [], subagents: [] });
const result = await applyLayout(plan);
console.log(JSON.stringify(result.state));
```

Select the delivered rule files in order when starting a session. The layout does not grant approval or run a command mentioned in a document.
