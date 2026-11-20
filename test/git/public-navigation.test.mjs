import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createNavigation, fetchRepositoryRef, gitClone, gitToplevel, localStatus,
  NavigationError, OriginError, projectNamespace, repoHead, runRepositoryCommand } from 'agent-hands';
import { fixture, git, seed } from './fixture.mjs';

const routeHost = authority => authority === 'code.test' ? { zone: 'repos', gitlab: true } : { zone: 'external' };

test('the root API exposes group routes, search failures and missing origins as data', async t => {
  const root = fixture(t);
  const nav = createNavigation({ root, routeHost, search: async () => null });
  const url = 'https://code.test/team/project.git';
  const group = await nav.resolve('https://code.test/groups/team/-/activity', { allowGroup: true });
  assert.equal(group.group, true);
  assert.equal(group.nsPath, 'team');
  await assert.rejects(nav.resolve('unavailable'), e => e instanceof NavigationError && e.problem.code === 'search-unavailable');
  const checkout = seed(path.join(root, 'repos/team/project'));
  assert.throws(() => nav.verifyOrigin(checkout, url), e => e instanceof OriginError && e.reason === 'missing');
  assert.doesNotThrow(() => nav.verifyOrigin(checkout, url, { allowMissing: true }));
  git(checkout, 'remote', 'add', 'origin', 'https://code.test/other/project.git');
  assert.throws(() => nav.verifyOrigin(checkout, url, { allowMissing: true }), { reason: 'mismatch' });
  for (const invalid of ['team/%2e%2e', 'team/x?dir=y', 'team/x#fragment', 'team/tree.git', 'team/../x']) {
    assert.equal(projectNamespace({ path_with_namespace: invalid }), null, invalid);
  }
  assert.equal(projectNamespace({ path_with_namespace: 'team/tools/real-project' }), 'team/tools/real-project');
});

test('the root API locates checkouts without updating them and scans only selected namespaces', async t => {
  const root = fixture(t);
  seed(root);
  const project = seed(path.join(root, 'repos/team/project'));
  seed(path.join(root, 'repos/team/second'));
  const bare = path.join(root, 'sandbox/not-a-checkout');
  mkdirSync(bare, { recursive: true });
  const nav = createNavigation({ root, routeHost });
  assert.equal(gitToplevel(project), project);
  assert.deepEqual(nav.locateCheckout(project), { abs: project });
  assert.throws(() => nav.locateCheckout(bare), e => e instanceof NavigationError && e.problem.code === 'enclosing-repo' && e.problem.zone === 'sandbox');
  assert.deepEqual((await localStatus(bare)).issue, { code: 'not-root', dir: bare });
  const selected = await nav.scan(['team/project']);
  assert.deepEqual(selected.map(row => row.repo), ['team/project']);
  assert.equal(selected[0].aheadIssue?.code, 'missing-ref');
  assert.equal(repoHead(project), git(project, 'rev-parse', 'HEAD'));
});

test('targeted scan cannot report the enclosing checkout as a named subgroup', async t => {
  const root = fixture(t);
  seed(root);
  const subgroup = path.join(root, 'repos/team/subgroup');
  mkdirSync(path.join(subgroup, '.git'), { recursive: true });
  const abs = seed(path.join(root, 'repos/team/project'));
  assert.equal(gitToplevel(subgroup), root);
  const nav = createNavigation({ root, routeHost });
  assert.throws(() => nav.verifyCheckoutRoot(subgroup), { problem: { code: 'not-checkout', abs: subgroup, exists: true } });
  assert.deepEqual(nav.verifyCheckoutRoot(abs), { abs });
  const [good, rejected] = await nav.scan(['team/subgroup', 'team/project']);
  assert.equal(good.readable, true);
  assert.equal(rejected.readable, false);
  assert.equal(rejected.branch, null);
  assert.deepEqual(rejected.issue, { code: 'not-root', dir: subgroup });
  assert.deepEqual(rejected.contact, { at: null, via: null });
});

test('untyped search results fail before ambiguity or command output', async t => {
  const root = fixture(t);
  const conclusive = { nsPath: 'team/project', url: 'https://code.test/team/project.git', kind: 'exact' };
  for (const result of [undefined, {}, [null, conclusive], [conclusive, ,], [{ ...conclusive, kind: 2 }], [{ ...conclusive, personal: 'yes' }]]) {
    const output = [], errors = [];
    const options = { root, routeHost, search: async () => result };
    assert.equal(await runRepositoryCommand(options, 'path', { target: 'project' }, { out: line => output.push(line), err: line => errors.push(line) }), 1);
    assert.deepEqual(output, []);
    assert.deepEqual(errors, ['Remote search returned an invalid candidate list']);
  }
  const options = { root, routeHost, search: async () => [conclusive] };
  assert.equal((await createNavigation(options).resolve('project')).source, 'remote');
});

test('an explicit URL clone and ref fetch do not need a workspace or a host route', t => {
  const root = fixture(t);
  const upstream = seed(path.join(root, 'upstream'));
  const copy = path.join(root, 'copy');
  assert.deepEqual(gitClone(upstream, copy), { ok: true });
  git(upstream, 'tag', 'test-tag');
  assert.deepEqual(fetchRepositoryRef(copy, 'refs/tags/test-tag', { depth: 0 }), { ok: true });
  assert.equal(git(copy, 'rev-parse', 'FETCH_HEAD'), repoHead(upstream));
  const missing = fetchRepositoryRef(copy, 'refs/tags/unknown', { depth: 0 });
  assert.equal(missing.ok, false);
  assert.equal(missing.timedOut, false);
  assert.match(missing.detail, /unknown/);
});
