import assert from 'node:assert/strict';
import path from 'node:path';
import { symlinkSync } from 'node:fs';
import test from 'node:test';
import { LayoutConflictError, planLayout } from 'agent-hands';
import { input, put, scratch } from './fixtures.mjs';

const skillText = '---\nname: example\ndescription: Example skill\n---\nExample.\n';
for (const target of ['claude', 'cursor', 'codex', 'opencode']) {
  test(`${target}: selected resources retain their logical owners and relative paths`, t => {
    const root = scratch(t);
    const skill = path.dirname(put(root, 'input/example/SKILL.md', skillText));
    put(root, 'input/example/docs/SKILL.md', 'not the main declaration');
    const support = path.dirname(put(root, 'input/support/example.md', 'shared'));
    const support2 = path.dirname(put(root, 'input/support2/other.md', 'also shared'));
    put(root, 'input/support2/example.md', 'shared');
    const plan = planLayout(input(root, target, { skills: [{ name: 'example', dirAbs: skill }],
      sharedDirs: [{ srcAbs: support }, { srcAbs: support2 }],
      subagents: [{ name: 'reader', description: 'Reads a fixture', prompt: 'Read the fixture.' }],
      servers: [{ name: 'server', definition: { command: 'node' } }], rules: [put(root, 'input/rule.md', '# Rule')] }));
    const prefix = `.${target}`;
    const extension = target === 'codex' ? 'toml' : 'md';
    const byPath = new Map(plan.resources.map(({ path: rel, ...resource }) => [rel, resource]));
    assert.deepEqual(byPath.get(`${prefix}/skills/example/SKILL.md`), { owner: { kind: 'skill', name: 'example' }, relativePath: 'SKILL.md' });
    assert.deepEqual(byPath.get(`${prefix}/skills/example/docs/SKILL.md`), { owner: { kind: 'skill', name: 'example' }, relativePath: 'docs/SKILL.md' });
    assert.deepEqual(byPath.get(`${prefix}/skills/_shared/example.md`), { owner: { kind: 'support', sourceIndex: 0 }, relativePath: 'example.md' });
    assert.deepEqual(byPath.get(`${prefix}/skills/_shared/other.md`), { owner: { kind: 'support', sourceIndex: 1 }, relativePath: 'other.md' });
    assert.deepEqual(byPath.get(`${prefix}/agents/reader.${extension}`), { owner: { kind: 'subagent', name: 'reader' }, relativePath: `reader.${extension}` });
    assert.equal(plan.resources.length, 5);
    assert.equal(plan.files.length, plan.resources.length + 2);
    assert.ok(plan.resources.every(({ path }) => plan.files.some(file => file.path === path)));
    assert.deepEqual(plan.notices, []);
  });
}

test('optional reporting skips a supporting link without following it', { skip: process.platform === 'win32' }, t => {
  const root = scratch(t);
  const skill = path.dirname(put(root, 'input/example/SKILL.md', skillText));
  const outside = put(root, 'outside.md', 'not a selected file');
  symlinkSync(outside, path.join(skill, 'link.md'));
  const args = input(root, 'cursor', { skills: [{ name: 'example', dirAbs: skill }] });
  assert.throws(() => planLayout(args), /expected a regular supporting file/);
  const plan = planLayout({ ...args, supportingFiles: 'skip-nonregular' });
  assert.deepEqual(plan.files.map(file => file.path), ['.cursor/skills/example/SKILL.md']);
  assert.deepEqual(plan.notices, [{ code: 'skipped-supporting-file', symbolic: true,
    resource: { path: '.cursor/skills/example/link.md', relativePath: 'link.md', owner: { kind: 'skill', name: 'example' } } }]);
});

test('conflicting supporting bytes identify both source labels without parsing error copy', t => {
  const root = scratch(t);
  const one = path.dirname(put(root, 'inputs/one/readme.md', 'one'));
  const two = path.dirname(put(root, 'inputs/two/readme.md', 'two'));
  assert.throws(() => planLayout(input(root, 'cursor', { sharedDirs: [{ srcAbs: one, source: 'first' }, { srcAbs: two, source: 'second' }] })),
    error => error instanceof LayoutConflictError && error.output === '.cursor/skills/_shared/readme.md'
      && error.first === 'first' && error.second === 'second');
});
