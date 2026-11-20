import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isDiskPath, isUrl, parseUrl, routeUrl, urlAuthority, urlHost, httpsRepoUrl } from '../../dist/git/address.js';
import { checkOrigin, createNavigation, discoverRoot, ensureWorkspaceDirs, probeDisk, runRepositoryCommand } from '../../dist/git/navigation.js';
import { checkout, command, commit, config, fixture, git, posix, routeHost, seed } from './fixture.mjs';

const a = 'https://git.one.test/team/sub/project.git';
const b = 'https://git.two.test/team/sub/project.git';
const publicUrl = 'https://github.com/person/project.git';
const ui = 'ssh://git@git.one.test/team/ui/repository.git';
const options = (root, cwd = root) => ({ root, cwd, routeHost });

test('workspace discovery requires an explicit root or the nearest marker', (t) => {
  const base = fixture(t);
  const root = path.join(base, 'workspace');
  const group = path.join(root, 'repos/team/sub');
  ensureWorkspaceDirs(root);
  mkdirSync(group, { recursive: true });
  assert.equal(discoverRoot({ root }), root);
  assert.equal(discoverRoot({ cwd: seed(path.join(base, 'source')) }), null);
  assert.throws(() => discoverRoot({ root: path.join(base, 'missing') }), /not a directory/);
  mkdirSync(path.join(root, '.agent-hands'));
  assert.equal(discoverRoot({ cwd: group }), root);
  mkdirSync(path.join(group, '.agent-hands'));
  assert.equal(discoverRoot({ cwd: group }), group);
  assert.ok(existsSync(path.join(root, 'sandbox')));
});

test('URLs preserve repository namespaces, distinguish groups and route by authority', async (t) => {
  const root = fixture(t);
  const nav = createNavigation(options(root));
  for (const suffix of ['', '/', '.git', '.git/', '.git///', '/-/tree/main', '/-/merge_requests/1']) {
    assert.deepEqual(parseUrl(`https://git.one.test/team/sub/project${suffix}`), { nsPath: 'team/sub/project', group: false });
  }
  for (const url of [a, 'HTTPS://Git.One.Test/team/sub/project.git/', 'git@git.one.test:team/sub/project.git',
    'ssh://git@git.one.test:22/team/sub/project.git']) {
    assert.ok(isUrl(url));
    const result = await nav.resolve(url);
    assert.equal(result.source, 'url');
    assert.equal(result.abs, path.join(root, 'repos/team/sub/project'));
  }
  assert.equal(urlAuthority('ssh://git@GIT.one.test:22/team/sub/project'), 'git.one.test:22');
  assert.equal(urlHost('ssh://git@GIT.one.test:22/team/sub/project'), 'git.one.test');
  for (const group of ['team', 'team/sub']) {
    const url = `https://git.one.test/groups/${group}/-/shared`;
    assert.deepEqual(parseUrl(url), { nsPath: group, group: true });
    assert.equal(routeUrl(root, url, routeHost).group, true);
    await assert.rejects(nav.repoPath(url), /repository, not a group/);
    await assert.rejects(nav.clone(url), /repository, not a group/);
  }
  for (const url of ['https://git.one.test', 'https://git.one.test/groups/']) {
    assert.equal(parseUrl(url).nsPath, '');
    await assert.rejects(nav.resolve(url), { code: 'empty' });
  }
  for (const url of ['HTTPS://GitHub.com/person/project', 'ssh://git@code.one.test/team/project.git', publicUrl]) {
    const resolved = await nav.resolve(url);
    assert.equal(resolved.nsPath, 'external/project');
    assert.equal(resolved.url, url);
  }
  for (const url of ['HTTPS://github.com/person', 'https://github.com/person']) await assert.rejects(nav.clone(url), { code: 'owner' });
  for (const url of ['https://other.test/github.com/project', 'https://gitXone.test/team/project', 'ssh://git@git.one.test:23/team/project']) {
    await assert.rejects(nav.clone(url), { code: 'host' });
  }
  assert.equal(httpsRepoUrl('git.one.test', 'team/project'), 'https://git.one.test/team/project.git');
  assert.equal(httpsRepoUrl('git.one.test', 'team/project.git'), 'https://git.one.test/team/project.git');
  await assert.rejects(nav.resolve(''), /Specify a repository/);
});

test('lookup and clone verify the original origin before reusing a destination', async (t) => {
  const base = fixture(t);
  const root = path.join(base, 'workspace');
  const source = seed(path.join(base, 'seed'));
  ensureWorkspaceDirs(root);
  config([publicUrl, a, b, ui].map((url) => [`url.${source}.insteadOf`, url]));
  const nav = createNavigation(options(root));
  const run = command(runRepositoryCommand, options(root));
  const external = path.join(root, 'external/project');
  const internal = path.join(root, 'repos/team/sub/project');
  assert.deepEqual(await run('clone', publicUrl), { exit: 0, out: [external], err: [] });
  assert.equal(git(external, 'config', '--get', 'remote.origin.url'), publicUrl);
  assert.equal(git(external, 'remote', 'get-url', 'origin'), source);
  assert.equal((await nav.repoPath(publicUrl)).abs, external);
  assert.deepEqual(await run('path', 'project'), { exit: 0, out: [external], err: [] });
  assert.deepEqual(await nav.clone(a), { abs: internal, cloned: true });
  assert.deepEqual(await nav.clone(`${a}/`), { abs: internal, cloned: false });
  assert.deepEqual(await nav.clone('./repos/team/sub/project'), { abs: internal, cloned: false });
  assert.deepEqual(await nav.clone('external/project'), { abs: external, cloned: false });
  await assert.rejects(nav.clone(b), { reason: 'mismatch' });
  await assert.rejects(nav.repoPath(b), { reason: 'mismatch' });
  assert.equal(git(internal, 'config', '--get', 'remote.origin.url'), a);
  const uiDest = path.join(root, 'repos/team/ui/repository');
  assert.deepEqual(await run('clone', 'ssh://git@git.one.test/team/ui/repository/-/tree/main'), { exit: 0, out: [uiDest], err: [] });
  assert.equal(git(uiDest, 'config', '--get', 'remote.origin.url'), ui);
  const ambiguous = await run('path', 'project');
  assert.deepEqual(ambiguous, { exit: 1, out: [], err: [
    'Repository name is ambiguous on disk: project', '  external/project (exact)', '  team/sub/project (exact)',
  ] });
  assert.deepEqual((await nav.scan()).map((entry) => entry.repo), ['external/project', 'team/sub/project', 'team/ui/repository']);
});

test('unreadable, missing, competing and multiple origin values do not prove identity', async (t) => {
  const root = fixture(t);
  const one = 'https://code.one.test/team/project.git';
  const two = 'https://code.two.test/team/project.git';
  const dir = seed(path.join(root, 'external/project'));
  const nav = createNavigation(options(root));
  await assert.rejects(nav.repoPath(one), { reason: 'missing' });
  assert.doesNotThrow(() => checkOrigin(dir, one, routeHost, { allowMissing: true }));
  git(dir, 'remote', 'add', 'origin', one);
  await assert.rejects(nav.clone(two), { reason: 'mismatch' });
  git(dir, 'config', '--add', 'remote.origin.url', two);
  assert.equal(git(dir, 'remote', 'get-url', 'origin'), one);
  await assert.rejects(nav.repoPath(two), { reason: 'ambiguous' });
  await assert.rejects(nav.clone(one), { reason: 'ambiguous' });
  appendFileSync(path.join(dir, '.git/config'), '\n[broken\n');
  await assert.rejects(nav.repoPath(one), { reason: 'unreadable' });
  assert.throws(() => checkOrigin(dir, one, routeHost, { allowMissing: true }), { reason: 'unreadable' });
});

test('namespace resolution wins over a sibling directory and does not hide rejected disk readings', async (t) => {
  const root = fixture(t);
  const nav = createNavigation(options(root));
  const actual = seed(path.join(root, 'repos/team/project'));
  const external = seed(path.join(root, 'external/tool'));
  for (const name of ['team/project', 'project', 'outside/missing', 'repos/team/subgroup', 'external/partial']) {
    mkdirSync(path.join(root, name), { recursive: true });
  }
  assert.equal((await nav.resolve('team/project')).source, 'namespace');
  assert.equal((await nav.resolve('team/project/')).abs, actual);
  assert.equal((await nav.resolve('project')).source, 'disk');
  for (const input of [actual, './repos/team/project', 'repos/team/project', 'repos/team/../team/project']) {
    const result = await nav.resolve(input);
    assert.equal(result.source, 'disk');
    assert.equal(result.abs, actual);
  }
  assert.equal((await nav.resolve('repos/../team/project')).source, 'namespace');
  assert.equal((await nav.resolve('./external/tool')).source, 'disk');
  assert.equal((await nav.resolve('external/tool')).source, 'namespace');
  assert.equal((await nav.repoPath('tool')).abs, external);
  assert.equal((await nav.resolve('team/not-cloned')).source, 'namespace');
  const ignored = await nav.resolve('outside/missing');
  assert.equal(ignored.nsPath, 'outside/missing');
  assert.match(ignored.note, /outside the repository zones/);
  assert.equal(probeDisk(root, 'outside/missing', root).exists, true);
  assert.equal(probeDisk(root, 'team/not-cloned', root).exists, false);
  assert.equal((await nav.resolve('repos/team/subgroup')).nsPath, 'team/subgroup');
  const run = command(runRepositoryCommand, options(root));
  for (const input of ['repos/team/subgroup', 'team/subgroup', 'external/partial']) {
    const result = await run('path', input, { clone: true });
    assert.equal(result.exit, 1);
    assert.deepEqual(result.out, []);
    assert.match(result.err.join(), /Not a clone root/);
  }
  assert.match((await run('path', 'outside/missing')).err.join(), /Ignored directory.+[\s\S]+Repository is not cloned/);
  assert.match((await run('path', 'team/not-cloned')).err.join(), /Repository is not cloned/);
  await assert.rejects(nav.clone('external/missing'), /No clone URL is configured/);
  for (const target of ['../outside', 'team/../../outside', 'external/../repos/team/project', 'team/../../external/tool']) {
    await assert.rejects(nav.clone(target), /outside the repository zones|Unsafe or reserved/);
  }
  for (const input of ['.', '..', './x', '../x', actual]) assert.equal(isDiskPath(input), true);
  for (const input of ['project', 'team/project', 'repos/team/project']) assert.equal(isDiskPath(input), false);
});

test('a nested cwd preserves namespace priority, valid disk fallback and zone boundaries', async (t) => {
  const root = fixture(t);
  const first = seed(path.join(root, 'repos/team/first'));
  const second = seed(path.join(root, 'repos/team/second'));
  const tool = seed(path.join(root, 'external/tool'));
  const fallback = seed(path.join(first, 'repos/decoy'));
  const reserved = seed(path.join(root, 'repos/external/tool'));
  const staleDecoy = path.join(first, 'external/tool');
  mkdirSync(path.join(first, 'nested'));
  const settings = options(root, first);
  const run = command(runRepositoryCommand, settings);
  const nav = createNavigation(settings);
  const cases = [
    ['external/tool', tool, 'namespace'],
    ['nested/../../second', second, 'disk'],
    ['external/../repos/decoy', null, null],
    [path.relative(first, reserved), null, null],
  ];
  assert.equal(existsSync(staleDecoy), false);
  assert.ok(existsSync(fallback));
  for (const [target, abs, source] of cases) {
    const result = await run('path', target);
    if (abs) {
      assert.deepEqual(result, { exit: 0, out: [abs], err: [] }, target);
      assert.equal((await nav.resolve(target)).source, source, target);
    } else {
      assert.deepEqual([result.exit, result.out], [1, []], target);
      assert.match(result.err[0], /reserved/);
    }
  }
  seed(staleDecoy);
  assert.deepEqual(await run('path', 'external/tool'), { exit: 0, out: [tool], err: [] });
  assert.match((await run('path', 'external/missing')).err[0], /Repository is not cloned/);
});

test('lookup is read-only by default; an explicit update changes tracking refs', async (t) => {
  const root = fixture(t);
  const source = seed(path.join(root, 'source'));
  const dir = checkout(source, path.join(root, 'repos/team/project'));
  writeFileSync(path.join(dir, 'untracked'), 'local contents');
  git(dir, 'branch', 'topic');
  git(dir, 'checkout', '-q', 'topic');
  const head = commit(source, 'second');
  const snapshot = () => ({ refs: git(dir, 'show-ref'), status: git(dir, '--no-optional-locks', 'status', '--porcelain=v2'),
    head: git(dir, 'rev-parse', 'HEAD'), index: readFileSync(path.join(dir, '.git/index')) });
  const before = snapshot();
  const nav = createNavigation(options(root));
  const run = command(runRepositoryCommand, options(root));
  assert.deepEqual(await nav.repoPath('project'), { abs: dir, state: null });
  assert.deepEqual(await run('path', 'project'), { exit: 0, out: [dir], err: [] });
  assert.deepEqual(await run('path', 'project', { fresh: false }), { exit: 0, out: [dir], err: [] });
  assert.deepEqual(snapshot(), before);
  const explicit = await run('path', 'project', { fresh: true });
  assert.deepEqual(explicit.out, [dir]);
  assert.equal(explicit.exit, 0);
  assert.equal(explicit.err.length, 1);
  const state = JSON.parse(explicit.err[0]);
  assert.equal(state.checkout, 'topic');
  assert.equal(state.headBehindDefault, 1);
  assert.equal(state.dirty, true);
  assert.equal(state.updated, true);
  assert.equal(git(dir, 'rev-parse', 'origin/main'), head);
});

test('offline, empty, ambiguous and inconsistent search outcomes are distinct', async (t) => {
  const root = fixture(t);
  const local = seed(path.join(root, 'repos/team/local'));
  const hits = [null, [], [{ nsPath: 'team/sub/project', url: a, kind: 'exact' }, { nsPath: 'team/other/project', url: b, kind: 'exact' }],
    [{ nsPath: 'external/project', url: a, kind: 'exact' }]];
  const noSearch = command(runRepositoryCommand, options(root));
  assert.deepEqual(await noSearch('path', 'missing'), { exit: 1, out: [], err: [
    'No local match for missing; remote search is not configured. Specify a repository URL.',
  ] });
  let calls = 0;
  const nav = createNavigation({ ...options(root), search: async () => hits[calls++] });
  assert.equal((await nav.repoPath('local')).abs, local);
  assert.equal((await nav.resolve(a)).source, 'url');
  assert.equal(calls, 0);
  await assert.rejects(nav.resolve('offline'), /Remote search is unavailable/);
  await assert.rejects(nav.resolve('empty'), /No local or remote match/);
  await assert.rejects(nav.resolve('duplicate'), { candidates: hits[2] });
  await assert.rejects(nav.clone('inconsistent'), /does not match/);
  assert.equal(calls, 4);
  assert.equal(existsSync(path.join(root, 'external/project')), false);
});

test('clone-missing resolves identity once and refuses a conflicting namespace URL or nonempty destination', async (t) => {
  const root = fixture(t);
  const source = seed(path.join(root, 'source'));
  config([[`url.${source}.insteadOf`, a], [`url.${source}.insteadOf`, 'https://git.one.test/team/by-namespace.git']]);
  const hit = { nsPath: 'team/sub/project', url: a, kind: 'exact' };
  let searched = 0;
  const nav = createNavigation({ ...options(root), search: async () => (++searched === 1 ? [hit] : []),
    namespaceUrl: (ns) => httpsRepoUrl('git.one.test', ns) });
  const dest = path.join(root, 'repos/team/sub/project');
  assert.deepEqual(await nav.repoPath('project', { clone: true }), { abs: dest, state: null });
  assert.equal(searched, 1);
  assert.equal(git(dest, 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'HEAD'));
  const byNamespace = await nav.clone('team/by-namespace');
  assert.deepEqual(byNamespace, { abs: path.join(root, 'repos/team/by-namespace'), cloned: true });
  assert.equal(git(byNamespace.abs, 'config', '--get', 'remote.origin.url'), 'https://git.one.test/team/by-namespace.git');
  assert.equal(searched, 1);
  const occupied = path.join(root, 'repos/team/occupied');
  mkdirSync(occupied);
  writeFileSync(path.join(occupied, 'keep'), 'mine');
  await assert.rejects(nav.clone('team/occupied'), /not an empty directory/);
  assert.equal(readFileSync(path.join(occupied, 'keep'), 'utf8'), 'mine');
  assert.equal(existsSync(path.join(occupied, '.git')), false);
  const other = createNavigation({ ...options(root), namespaceUrl: () => a });
  await assert.rejects(other.clone('team/wrong'), /another destination/);
  assert.equal(existsSync(path.join(root, 'repos/team/wrong')), false);
});

test('unknown command refuses before discovery, routing or a search', async (t) => {
  const root = fixture(t);
  const trap = () => assert.fail('unexpected repository resolution');
  const run = command(runRepositoryCommand, { root: path.join(root, 'missing'), routeHost: trap, search: trap });
  const result = await run('pth', publicUrl);
  assert.equal(result.exit, 1);
  assert.deepEqual(result.out, []);
  assert.match(result.err.join(), /^Unknown repository command: pth.*Usage:/);
});

test('clone rejects traversal and reserved namespaces before transport', async (t) => {
  const root = fixture(t);
  const nav = createNavigation(options(root));
  for (const slug of ['../project', '%2e%2e/project', 'bad%2fproject', 'bad%5cproject', 'bad%00project']) {
    await assert.rejects(nav.clone(`https://git.one.test/team/${slug}.git`), { code: 'unsafe' });
  }
  await assert.rejects(nav.clone('https://github.com/team/..'), { code: 'unsafe' });
  for (const url of ['https://git.one.test/groups/external', 'https://git.one.test/external/project']) {
    await assert.rejects(nav.clone(url), { code: 'reserved' });
  }
  assert.equal((await nav.resolve(publicUrl)).nsPath, 'external/project');
  assert.equal(existsSync(path.join(root, 'repos')), false);
  const backslashes = 'https://github.com/team/x\\..\\..\\outside';
  if (process.platform === 'win32') await assert.rejects(nav.resolve(backslashes), { code: 'unsafe' });
  else assert.equal((await nav.resolve(backslashes)).nsPath, 'external/x\\..\\..\\outside');
});

test('a symlink destination is not the directory requested by its namespace', posix, async (t) => {
  const base = fixture(t);
  const root = path.join(base, 'workspace');
  const source = seed(path.join(base, 'source'));
  ensureWorkspaceDirs(root);
  config([[`url.${source}.insteadOf`, 'https://git.one.test/escape/new.git'],
    [`url.${source}.insteadOf`, 'https://git.one.test/alias/new.git']]);
  const nav = createNavigation(options(root));
  symlinkSync(base, path.join(root, 'repos/escape'), 'dir');
  await assert.rejects(nav.clone('https://git.one.test/escape/new.git'), { code: 'unsafe' });
  assert.equal(existsSync(path.join(base, 'new')), false);
  mkdirSync(path.join(root, 'repos/target'));
  symlinkSync(path.join(root, 'repos/target'), path.join(root, 'repos/alias'), 'dir');
  await assert.rejects(nav.clone('https://git.one.test/alias/new.git'), { code: 'unsafe' });
  assert.equal(existsSync(path.join(root, 'repos/target/new')), false);
});
