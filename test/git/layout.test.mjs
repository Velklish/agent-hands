import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cloneOf, isCloneDir, listClonedRepos, normalizeNs, nsUnderZone, repoAbsPath, ZONES, zoneOfNs, zoneRoots } from '../../dist/git/layout.js';
import { findRepo, gitRemote, normalize, pickProjects, remoteSlug, score, tokens, topScored } from '../../dist/git/fuzzy.js';
import { createNavigation } from '../../dist/git/navigation.js';
import { gitToplevel, repoHead } from '../../dist/git/process.js';
import { fixture, git, posix, routeHost, seed } from './fixture.mjs';

test('fuzzy matching has a stable token-based ranking', () => {
  for (const name of [' App.Search ', 'app-search', 'APP Search', 'app_search']) assert.equal(normalize(name), 'app-search');
  assert.deepEqual(tokens('store.priority-view api'), ['store', 'priority', 'view', 'api']);
  assert.deepEqual(tokens('  '), []);
  assert.equal(remoteSlug('https://git.one.test/team/data.store.git/'), 'data-store');
  assert.equal(remoteSlug('git@git.one.test:team/store-api.git'), 'store-api');
  assert.equal(remoteSlug(''), '');
  for (const [hint, name, slug, value, kind] of [
    ['app-search', 'app.search', '', 100, 'exact'], ['data-store', 'local-store', 'data.store', 95, 'remote'],
    ['priority-view-api', 'store-priority-view-api', '', 80, 'suffix'],
    ['store-priority', 'store-priority-view-api', '', 70, 'prefix'],
    ['tool.extensions', 'tool', '', 60, 'parent'], ['priority-view', 'store-priority-view-api', '', 50, 'part'],
    ['view', 'store-priority-view-api', '', 0, ''], ['api', 'store-priority-view-api', '', 80, 'suffix'],
    ['view', 'viewfinder', '', 0, ''], ['', 'view', '', 0, ''],
  ]) assert.deepEqual(score(hint, name, slug), { value, kind });
  assert.deepEqual(topScored([]), []);
  const candidates = ['weak', 'z', 'medium', 'a'].map((nsPath, i) => ({ nsPath, value: [50, 100, 70, 100][i] }));
  assert.deepEqual(topScored(candidates).map(({ nsPath }) => nsPath), ['a', 'z']);
  assert.deepEqual(topScored(candidates.slice(1, 3)).map(({ nsPath }) => nsPath), ['z']);
});

test('discovery finds deep and flat clones but stops at hidden, excluded and nested clone trees', (t) => {
  const root = fixture(t);
  const real = ['repos/tool', 'repos/team/app.search', 'repos/team/apps/repo', 'repos/a/b/c/d/deep',
    'repos/a/b/c/metrics', 'external/widget', 'external/forks/team/other', 'sandbox/experiment'];
  for (const name of real) seed(path.join(root, name));
  const worktree = path.join(root, 'repos/team/worktree');
  git(path.join(root, 'repos/tool'), 'worktree', 'add', '-qb', 'linked', worktree);
  for (const name of ['.hidden', 'node_modules', 'bin', 'obj', 'packages', 'dist', 'build', 'target', 'vendor']) {
    mkdirSync(path.join(root, 'repos/team', name, 'shadow/.git'), { recursive: true });
  }
  mkdirSync(path.join(root, 'repos/tool/inside/hidden-clone/.git'), { recursive: true });
  mkdirSync(path.join(root, 'repos/group/subgroup'), { recursive: true });
  const found = listClonedRepos(root);
  assert.deepEqual(found.map(({ nsPath }) => nsPath).sort(), [
    'a/b/c/d/deep', 'a/b/c/metrics', 'external/forks/team/other', 'external/widget', 'team/app.search', 'team/apps/repo', 'team/worktree', 'tool',
  ]);
  for (const { nsPath, abs } of found) assert.equal(abs, repoAbsPath(root, nsPath));
  assert.equal(gitRemote(worktree), '');
  const fetchUrl = 'https://git.one.test/team/tool.git';
  git(path.join(root, 'repos/tool'), 'remote', 'add', 'origin', fetchUrl);
  assert.equal(gitRemote(worktree), fetchUrl);
  assert.equal(cloneOf(root, path.join(root, 'repos/group/subgroup')), null);
  assert.equal(cloneOf(root, path.join(root, 'sandbox/experiment')), null);
  assert.equal(cloneOf(root, path.join(root, 'repos/tool')), null, 'repos namespace needs a pair for containment');
  assert.equal(cloneOf(root, path.join(root, 'repos/a/b/c/d/deep/not-yet'))?.nsPath, 'a/b/c/d/deep');
  assert.equal(cloneOf(root, path.join(root, 'external/forks/team/other'))?.nsPath, 'external/forks/team/other');
  assert.equal(cloneOf(root, path.join(root, 'external/widget'))?.nsPath, 'external/widget');
  assert.ok(isCloneDir(worktree));
  assert.equal(repoHead(worktree), git(worktree, 'rev-parse', 'HEAD'));
});

test('broken Git metadata is discoverable but does not supply a usable HEAD or clone root', async (t) => {
  const root = fixture(t);
  seed(root);
  const fake = path.join(root, 'repos/team/fake');
  const broken = path.join(root, 'external/broken');
  mkdirSync(path.join(fake, '.git'), { recursive: true });
  mkdirSync(broken, { recursive: true });
  writeFileSync(path.join(broken, '.git'), 'gitdir: missing\n');
  const nav = createNavigation({ root, cwd: root, routeHost });
  for (const [dir, name] of [[fake, 'fake'], [broken, 'broken']]) {
    assert.ok(isCloneDir(dir));
    assert.equal(cloneOf(root, dir)?.abs, dir);
    assert.equal(repoHead(dir), null);
    await assert.rejects(nav.repoPath(name), /Not a clone root/);
  }
  const sub = path.join(root, 'sub');
  mkdirSync(sub);
  assert.equal(gitToplevel(sub), root);
  assert.equal(repoHead(sub), null);
  assert.equal(repoHead(path.join(root, 'missing')), null);
  assert.equal(repoHead(root), git(root, 'rev-parse', 'HEAD'));
});

test('workspace zones round trip and reserve the external namespace under repos', async (t) => {
  const root = fixture(t);
  const ext = seed(path.join(root, 'external/tool'));
  const collision = seed(path.join(root, 'repos/external/tool'));
  const one = seed(path.join(root, 'repos/team/sub/one'));
  assert.deepEqual(ZONES, ['repos', 'external']);
  assert.deepEqual(zoneRoots(root), ['repos', 'external'].map((name) => path.join(root, name)));
  assert.equal(zoneOfNs('external/tool'), 'external');
  assert.equal(zoneOfNs('team/tool'), 'repos');
  assert.equal(zoneOfNs('tool'), 'repos');
  assert.equal(repoAbsPath(root, 'external/tool'), ext);
  assert.equal(repoAbsPath(root, 'team/sub/one'), one);
  assert.equal(nsUnderZone(root, ext), 'external/tool');
  assert.equal(nsUnderZone(root, one), 'team/sub/one');
  assert.equal(nsUnderZone(root, root), null);
  assert.equal(normalizeNs(root, 'repos/../team/sub/one'), 'team/sub/one');
  for (const candidate of ['external/../../outside', 'external', 'external/../repos/team/sub/one', 'team/../../external/tool']) {
    assert.equal(normalizeNs(root, candidate), null);
  }
  const collisions = [];
  assert.deepEqual(listClonedRepos(root, (dir) => collisions.push(dir)).map(({ nsPath }) => nsPath).sort(), ['external/tool', 'team/sub/one']);
  assert.deepEqual(collisions, [path.dirname(collision)]);
  assert.equal(cloneOf(root, collision), null);
  const nav = createNavigation({ root, cwd: root, routeHost });
  assert.equal((await nav.repoPath('external/tool')).abs, ext);
  for (const candidate of [collision, './repos/external/tool', 'repos/external/tool']) await assert.rejects(nav.repoPath(candidate), /reserved/);
});

test('a symlinked zone is neither walked nor used as a clone destination', posix, (t) => {
  const root = fixture(t);
  const outside = seed(path.join(root, 'elsewhere/group/project'));
  symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'repos'), 'dir');
  assert.deepEqual(listClonedRepos(root), []);
  assert.equal(normalizeNs(root, 'group/project'), null);
  assert.equal(cloneOf(root, outside), null);
  assert.ok(existsSync(outside));
});

test('local and remote fuzzy ranking preserve candidate kinds and deterministic ties', (t) => {
  const root = fixture(t);
  const remoteRepo = seed(path.join(root, 'repos/data/local-store'));
  const fetchUrl = 'https://git.one.test/data/data.store.git';
  git(remoteRepo, 'config', 'remote.origin.pushurl', 'https://code.one.test/team/push-only.git');
  git(remoteRepo, 'config', 'remote.origin.url', fetchUrl);
  assert.match(readFileSync(path.join(remoteRepo, '.git/config'), 'utf8'), /pushurl[\s\S]*\n\s*url\s*=/);
  assert.equal(git(remoteRepo, 'remote', 'get-url', 'origin'), fetchUrl);
  assert.equal(gitRemote(remoteRepo), fetchUrl);
  assert.equal(remoteSlug(gitRemote(remoteRepo)), 'data-store');
  assert.deepEqual(findRepo(root, 'data.store'), { status: 'RESOLVED', nsPath: 'data/local-store', kind: 'remote' });
  assert.deepEqual(findRepo(root, 'push-only'), { status: 'NOTFOUND' });
  for (const ns of ['a/ui/sub/app.search', 'b/app-search', 'team/app-search-api', 'team/store-priority-view-api', 'tool']) {
    seed(path.join(root, 'repos', ns));
  }
  const local = findRepo(root, 'app-search');
  const expected = ['a/ui/sub/app.search', 'b/app-search'].map((nsPath) => ({ nsPath, kind: 'exact', personal: false }));
  assert.deepEqual(local, { status: 'AMBIGUOUS', candidates: expected });
  const project = (ns, extra = {}) => ({ path: path.basename(ns), path_with_namespace: ns, namespace: { kind: 'group' }, ...extra });
  assert.deepEqual(pickProjects('APP_SEARCH', ['b/app-search', 'team/app-search-api', 'a/ui/sub/app.search'].map((ns) => project(ns))), expected);
  assert.deepEqual(pickProjects('app-search', [project('user/app-search', { namespace: { kind: 'user' } }), project('b/app-search')]), [expected[1]]);
  assert.deepEqual(pickProjects('app-search', [project('a/app-search', { archived: true }), null, [], project('bad/../app-search')]), []);
  assert.deepEqual(pickProjects('view-api', [project('team/store-priority-view-api')]), [{ nsPath: 'team/store-priority-view-api', kind: 'suffix', personal: false }]);
  assert.deepEqual(findRepo(root, 'priority-view-api'), { status: 'RESOLVED', nsPath: 'team/store-priority-view-api', kind: 'suffix' });
  assert.deepEqual(findRepo(root, 'tool.extensions'), { status: 'RESOLVED', nsPath: 'tool', kind: 'parent' });
  assert.deepEqual(findRepo(root, 'nothing'), { status: 'NOTFOUND' });
  assert.deepEqual(findRepo(root, 'app.search', { personal: (ns) => ns.startsWith('b/') }).candidates.map(({ personal }) => personal), [false, true]);
  assert.deepEqual(findRepo(root, 'metrics'), { status: 'NOTFOUND' });
  seed(path.join(root, 'repos/core/ops/sub/metrics'));
  seed(path.join(root, 'repos/team/metrics-collector'));
  assert.deepEqual(findRepo(root, 'metrics'), { status: 'RESOLVED', nsPath: 'core/ops/sub/metrics', kind: 'exact' });
});
