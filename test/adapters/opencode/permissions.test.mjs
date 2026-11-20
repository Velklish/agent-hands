import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { applyLayout, planLayout } from 'agent-hands';
import { parse as yaml } from 'yaml';
import { input, scratch } from '../../fixtures.mjs';

const fixture = new URL('./fixtures/opencode-v2.0.20/', import.meta.url);
const upstream = file => readFileSync(new URL(file, fixture));
const canonical = [['read', 'src/app.js'], ['grep', 'TODO.*'], ['glob', '**/*.js']];
const subsets = [
  ['read'], ['grep'], ['glob'],
  ['read', 'grep'], ['read', 'glob'], ['grep', 'glob'],
  ['read', 'grep', 'glob'],
];
const denied = ['server_tool', 'subagent', 'edit', 'shell', 'execute', 'webfetch', 'skill', 'plugin_new_action'];
const sensitiveFiles = ['.env', '.env.local', 'config/secrets.env', 'config/secrets.env.production'];
const examples = ['.env.example', 'config/secrets.env.example'];

async function renderAgent(t, tools) {
  const root = scratch(t);
  const subagents = [{name:'reviewer', description:'Inspect the workspace', prompt:'Review the selected files.', tools}];
  const result = await applyLayout(planLayout(input(root, 'opencode', {subagents})));
  const file = '.opencode/agents/reviewer.md';
  assert.deepEqual(result.written, [file]);
  const markdown = readFileSync(path.join(root, file), 'utf8');
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, 'Expected YAML frontmatter in the applied agent file');
  const agent = yaml(frontmatter[1]);
  assert.equal(agent.mode, 'subagent');
  return agent;
}

test('OpenCode native permissions for every read-only subset and ordinary mode', async t => {
  const {assets} = JSON.parse(upstream('sources.json'));
  for (const file of ['LICENSE', 'defaults.txt', 'permission.ts', 'wildcard.ts']) {
    assert.equal(createHash('sha256').update(upstream(file)).digest('hex'), assets[file].fixtureSha256, file);
  }

  // Execute the pinned upstream excerpts after removing only exports and type annotations.
  const wildcard = upstream('wildcard.ts').toString()
    .replace('export * as Wildcard from "./wildcard.js"', '')
    .replace('export function match(input: string, pattern: string)', 'function match(input, pattern)');
  const permission = upstream('permission.ts').toString()
    .replace('export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule',
      'function evaluate(action, resource, ...rulesets)')
    .replace('export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset', 'function merge(...rulesets)');
  const {evaluate, merge} = runInNewContext(
    `${wildcard}\nconst Wildcard = {match};\n${permission}\n({evaluate, merge})`,
    {process:{platform:process.platform}},
  );
  const defaults = runInNewContext(upstream('defaults.txt').toString());

  await t.test('upstream defaults and last matching rule', () => {
    assert.equal(evaluate('server_tool', '*', defaults).effect, 'allow');
    assert.equal(evaluate('subagent', 'build', defaults).effect, 'allow');
    assert.equal(evaluate('external_directory', '/outside/example', defaults).effect, 'ask');
    const deny = [{action:'*', resource:'*', effect:'deny'}];
    const allow = [{action:'read', resource:'*', effect:'allow'}];
    assert.equal(evaluate('read', 'src/app.js', merge(defaults, deny)).effect, 'deny');
    assert.equal(evaluate('read', 'src/app.js', defaults, deny, allow).effect, 'allow');
    assert.equal(evaluate('read', 'src/app.js', merge(defaults, allow, deny)).effect, 'deny');
  });

  for (const tools of subsets) await t.test(`read-only subset ${tools.join('/')}`, async t => {
    const {permissions} = await renderAgent(t, tools);
    assert.ok(Array.isArray(permissions));
    const policy = merge(defaults, permissions);
    const effect = (action, resource = '*') => evaluate(action, resource, policy).effect;
    for (const [action, resource] of canonical) {
      assert.equal(effect(action, resource), tools.includes(action) ? 'allow' : 'deny', action);
    }
    for (const action of denied) assert.equal(effect(action), 'deny', action);
    assert.equal(effect('external_directory', '/outside/example'), 'deny');
    for (const file of sensitiveFiles) assert.equal(effect('read', file), tools.includes('read') ? 'ask' : 'deny', file);
    for (const file of examples) assert.equal(effect('read', file), tools.includes('read') ? 'allow' : 'deny', file);
  });

  await t.test('case and duplicate tools preserve the selected subset', async t => {
    const {permissions} = await renderAgent(t, ['READ', 'read']);
    assert.equal(permissions.filter(rule => rule.action === 'read' && rule.resource === '*').length, 1);
    const policy = merge(defaults, permissions);
    for (const [action, resource] of canonical) {
      assert.equal(evaluate(action, resource, policy).effect, action === 'read' ? 'allow' : 'deny', action);
    }
  });

  for (const tools of [undefined, [], ['read', 'edit'], ['webfetch']]) {
    await t.test(`ordinary tools ${JSON.stringify(tools)}`, async t => {
      const agent = await renderAgent(t, tools);
      assert.equal(Object.hasOwn(agent, 'permissions'), false);
    });
  }
});
