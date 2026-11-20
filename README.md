# agent-hands

Use one CLI or JavaScript import to find repositories and deliver selected rules, skills, agents and tool servers to Claude Code, Codex, Cursor or OpenCode. Change `target` to switch harnesses. Planning and repository lookup are read-only.

## Install

Requires Node.js 26 or newer and Git. Once the `v0.1.0` release tag is published:

```sh
npm install --save-exact git+https://github.com/Velklish/agent-hands.git#v0.1.0
```

The tag includes compiled ESM and TypeScript declarations. No build step, global CLI, Git hook or npm release is required. The consuming project's lockfile records the resolved commit.

## Try a layout

In an installed project, save this as `example.mjs` and run `node example.mjs`. It creates a workspace directory and an explicit configuration for the CLI.

```js
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bundledAssets, planLayout } from 'agent-hands';
const root = path.resolve('example-work');
mkdirSync(root, { recursive: true });
const input = { root, target: 'cursor', rules: bundledAssets.workspaceRules,
  skills: [{ name: 'asking-questions', dirAbs: bundledAssets.askingQuestions }],
  servers: [], subagents: [] };
console.log(planLayout(input).files.map(file => file.path));
writeFileSync('layout.json', JSON.stringify(input));
```

```sh
npx --no-install agent-hands plan --config layout.json
npx --no-install agent-hands apply --config layout.json --state cursor-state.json
```

Keep the state file in a trusted directory outside the workspace. Use one file per workspace and target. Reuse it to update owned files; apply empty lists with the same state to retire them. An existing unmanaged file or an edited owned file causes a refusal. Preview prints paths rather than configuration contents. See the [layout API](docs/reference/layout.md) and [bundled assets](assets/README.md).

## Find a repository

With `{"root":"/absolute/workspace"}` in `repos.json`, run `npx --no-install agent-hands path --config repos.json example`. The matching checkout must exist in `repos/` or `external/`. `zone` inspects local checkouts. `clone` and `fresh` explicitly contact remotes. For URL routing add `"hosts":{"github.com":"external"}`; no host is enabled by default. For JavaScript use `createNavigation` from `agent-hands`. See [repository navigation](docs/reference/repository-navigation.md).

The standalone [voice profile tool](profiles/my-voice/README.md) requires Python 3.10 or newer. `bundledAssets.voiceCalibration` locates its skill, template, references and scripts. Supplied samples do not require local history access.

## Development

`npm ci --registry=https://registry.npmjs.org` installs locked dependencies. `npm run test:all` checks strict types, the Node and Python suites, Git mutation probes and installed-package examples. `npm run test:package` checks the candidate tarball and simulates an exact-tag Git install in a temporary mirror. Neither creates a release tag in this project. `npx --no-install backslop gates` checks the [contributor workflow](https://github.com/Velklish/agent-hands/blob/main/AGENTS.md).

[MIT](LICENSE), copyright Velklish.
