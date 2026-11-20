import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { freshenRepo } from '../../dist/git/fresh.js';
import { createNavigation, ensureWorkspaceDirs, runRepositoryCommand } from '../../dist/git/navigation.js';
import { checkout, command, commit, fixture, git, posix, routeHost, seed, stubGit } from './fixture.mjs';

const tip = (dir, ref = 'HEAD') => git(dir, 'rev-parse', ref);

test('fresh advances a clean default branch and preserves dirty, divergent, ahead-only and detached checkouts', (t) => {
  const root = fixture(t);
  const source = seed(path.join(root, 'source'));
  const work = Object.fromEntries(['clean', 'dirty', 'diverged', 'detached', 'ahead', 'topic'].map((name) => [name, checkout(source, path.join(root, name))]));
  const original = tip(source);
  writeFileSync(path.join(work.dirty, 'untracked'), 'keep');
  const divergent = commit(work.diverged, 'divergent');
  git(work.detached, 'checkout', '--detach', '-q');
  git(work.topic, 'checkout', '-qb', 'topic');
  git(work.topic, 'push', '-q', '-u', 'origin', 'topic');
  const topic = commit(work.topic, 'topic-local');
  writeFileSync(path.join(work.topic, 'untracked'), 'keep');
  const ahead = commit(work.ahead, 'ahead');
  git(work.ahead, 'remote', 'set-url', 'origin', work.ahead);
  git(work.ahead, 'branch', 'reference', original);
  git(work.ahead, 'config', 'remote.origin.fetch', '+refs/heads/reference:refs/remotes/origin/main');
  git(source, 'checkout', '-q', 'topic');
  commit(source, 'topic-remote');
  git(source, 'checkout', '-q', 'main');
  const head = commit(source, 'second');

  const clean = freshenRepo(work.clean);
  assert.equal(clean.updated, true);
  assert.equal(clean.behind, 1);
  assert.deepEqual(clean.warnings, []);
  assert.equal(tip(work.clean), head);
  const current = freshenRepo(work.clean);
  assert.equal(current.behind, 0);
  assert.equal(current.updated, false);
  assert.equal(current.fetchOk, true);
  assert.deepEqual(current.warnings, []);

  const dirty = freshenRepo(work.dirty);
  assert.deepEqual(dirty.warnings, [{ code: 'blocked', branch: 'main', behind: 1, ahead: 0, tree: 'dirty' }]);
  assert.equal(tip(work.dirty), original);
  assert.equal(existsSync(path.join(work.dirty, 'untracked')), true);
  const diverged = freshenRepo(work.diverged);
  assert.deepEqual(diverged.warnings, [{ code: 'blocked', branch: 'main', behind: 1, ahead: 1, tree: 'clean' }]);
  assert.equal(tip(work.diverged), divergent);
  const detached = freshenRepo(work.detached);
  assert.equal(detached.checkout, null);
  assert.equal(detached.updated, true);
  assert.equal(tip(work.detached), original);
  assert.equal(tip(work.detached, 'main'), head);
  const aheadState = freshenRepo(work.ahead);
  assert.equal(aheadState.fetchOk, true);
  assert.deepEqual([aheadState.behind, aheadState.ahead, aheadState.updated], [0, 1, false]);
  assert.equal(tip(work.ahead), ahead);

  git(work.topic, 'fetch', '-q', 'origin');
  const topicState = freshenRepo(work.topic);
  assert.deepEqual([topicState.checkout, topicState.dirty, topicState.headBehindDefault, topicState.checkoutBehind, topicState.checkoutAhead], ['topic', true, 1, 1, 1]);
  assert.equal(topicState.updated, true);
  assert.equal(tip(work.topic, 'main'), head);
  assert.equal(tip(work.topic), topic);
  assert.equal(existsSync(path.join(work.topic, 'untracked')), true);
  const repeat = freshenRepo(work.topic);
  assert.deepEqual([repeat.updated, repeat.behind, repeat.checkout, repeat.dirty, repeat.headBehindDefault], [false, 0, 'topic', true, 1]);
  writeFileSync(path.join(work.clean, 'untracked'), 'keep');
  assert.deepEqual([freshenRepo(work.clean).behind, freshenRepo(work.clean).dirty], [0, true]);
});

test('a failed fetch cannot fast-forward from a stale tracking ref', (t) => {
  const root = fixture(t);
  const source = seed(path.join(root, 'source'));
  const work = checkout(source, path.join(root, 'work'));
  const original = tip(work);
  const remote = commit(source, 'second');
  git(work, 'fetch', '-q', 'origin');
  assert.equal(tip(work, 'origin/main'), remote);
  git(work, 'remote', 'set-url', 'origin', path.join(root, 'missing'));
  const res = freshenRepo(work);
  assert.equal(res.behind, 1);
  assert.equal(res.fetchOk, false);
  assert.equal(res.updated, false);
  assert.equal(tip(work), original);
  assert.equal(res.warnings[0].code, 'fetch');
  git(work, 'update-ref', 'refs/remotes/origin/main', original);
  const zero = freshenRepo(work);
  assert.equal(zero.behind, 0);
  assert.equal(zero.fetchOk, false);
  git(work, 'checkout', '-qb', 'topic');
  const topic = freshenRepo(work);
  assert.deepEqual([topic.behind, topic.headBehindDefault, topic.checkout, topic.fetchOk], [0, 0, 'topic', false]);
});

test('freshness distinguishes missing Git, origin and default branch', (t) => {
  const root = fixture(t);
  const dir = seed(path.join(root, 'local'), 'trunk');
  assert.deepEqual(freshenRepo(root).warnings, [{ code: 'not-repo', repoAbs: root }]);
  assert.deepEqual(freshenRepo(dir).warnings, [{ code: 'no-origin' }]);
  const empty = path.join(root, 'empty.git');
  git(root, 'init', '--bare', '-q', empty);
  git(dir, 'remote', 'add', 'origin', empty);
  const unknown = freshenRepo(dir);
  assert.equal(unknown.fetchOk, true);
  assert.equal(unknown.branch, null);
  assert.equal(unknown.behind, null);
  assert.deepEqual(unknown.warnings, [{ code: 'unknown-default' }]);
});

test('fresh resolves names before mutation and does not update the workspace from inside a zone', async (t) => {
  const base = fixture(t);
  const source = seed(path.join(base, 'source'));
  const root = checkout(source, path.join(base, 'workspace'));
  const outerHead = tip(root);
  writeFileSync(path.join(root, '.git/info/exclude'), '/repos/\n/external/\n/sandbox/\n');
  ensureWorkspaceDirs(root);
  for (const sub of ['repos/team/subgroup', 'sandbox/scratch', 'project', 'duplicate', 'unresolved']) mkdirSync(path.join(root, sub), { recursive: true });
  const clone = checkout(source, path.join(root, 'repos/team/project'));
  const child = checkout(source, path.join(root, 'sandbox/child'));
  const outside = checkout(source, path.join(base, 'outside/clone'));
  const inClone = path.join(clone, 'src');
  mkdirSync(inClone);
  const dup = ['repos/a/duplicate', 'external/duplicate'].map((sub) => checkout(source, path.join(root, sub)));
  const next = commit(source, 'second');
  const nav = createNavigation({ root, cwd: root, routeHost });
  assert.equal((await nav.fresh('project')).abs, clone);
  assert.equal(tip(clone), next);
  const decoy = path.join(base, 'decoy');
  mkdirSync(path.join(decoy, 'project'), { recursive: true });
  await assert.rejects(createNavigation({ root, cwd: decoy, routeHost }).fresh('./project'), /Not inside a Git clone/);
  const run = command(runRepositoryCommand, { root, cwd: root, routeHost });
  const named = await run('fresh', 'project');
  assert.deepEqual([named.exit, named.err], [0, []]);
  assert.equal(JSON.parse(named.out[0]).abs, clone);
  const ambiguous = await run('fresh', 'duplicate');
  assert.deepEqual([ambiguous.exit, ambiguous.out, ambiguous.err.length], [1, [], 3]);
  for (const dir of dup) assert.equal(tip(dir), outerHead);
  await assert.rejects(nav.fresh('unresolved'), /No local match/);
  await assert.rejects(nav.fresh('team/subgroup'), /Not a clone root/);
  for (const sub of ['repos/team/subgroup', 'sandbox/scratch', 'repos', 'external', 'sandbox']) {
    await assert.rejects(nav.fresh(`./${sub}`), /Not inside a Git clone/);
    await assert.rejects(createNavigation({ root, cwd: path.join(root, sub), routeHost }).fresh(), /Not inside a Git clone/);
  }
  await assert.rejects(nav.fresh('sandbox/scratch'), /Not inside a Git clone/);
  assert.equal(tip(root), outerHead);
  assert.equal((await nav.fresh('sandbox/child')).state.updated, true);
  assert.equal(tip(child), next);
  assert.equal((await nav.fresh(child)).abs, child);
  assert.equal((await nav.fresh(inClone)).abs, clone);
  assert.equal((await createNavigation({ root, cwd: clone, routeHost }).fresh('./src')).abs, clone);
  assert.equal((await createNavigation({ root, cwd: base, routeHost }).fresh('outside/clone')).state.updated, true);
  assert.equal((await nav.fresh(outside)).abs, outside);
  assert.equal(tip(outside), next);
});

test('zone aliases cannot refresh the enclosing workspace', posix, async (t) => {
  const root = fixture(t);
  seed(root);
  ensureWorkspaceDirs(root);
  symlinkSync(root, path.join(root, 'repos/enclosing'), 'dir');
  const nav = createNavigation({ root, cwd: root, routeHost });
  await assert.rejects(nav.fresh('./repos/enclosing'), /Not inside a Git clone/);
});

test('fresh stops after the first failed top-level query for both sandbox path spellings', async (t) => {
  const base = fixture(t);
  const source = seed(path.join(base, 'source'));
  const root = checkout(source, path.join(base, 'workspace'));
  const original = tip(root);
  commit(source, 'second');
  ensureWorkspaceDirs(root);
  mkdirSync(path.join(root, 'sandbox/scratch'));
  const nav = createNavigation({ root, cwd: root, routeHost });
  const witness = path.join(base, 'top-level-attempt');
  const stub = stubGit(t, base, `
    if (args.includes('--show-toplevel')) {
      const { existsSync, writeFileSync } = await import('node:fs');
      if (!existsSync(${JSON.stringify(witness)})) {
        writeFileSync(${JSON.stringify(witness)}, 'attempted'); process.exit(128);
      }
    }
  `);
  for (const target of ['./sandbox/scratch', 'sandbox/scratch']) {
    stub.reset();
    await assert.rejects(nav.fresh(target), /Not inside a Git clone/);
    assert.deepEqual(stub.calls().map(({ cmd }) => cmd), ['rev-parse']);
    assert.equal(existsSync(witness), true);
    unlinkSync(witness);
  }
  assert.equal(tip(root), original);
  assert.equal(tip(root, 'origin/main'), original);
});

test('failed status or ref reads do not trigger a merge; missing-local reports the fetch result', (t) => {
  const root = fixture(t);
  const dir = seed(path.join(root, 'work'));
  const stub = stubGit(t, root, `
    const mode = process.env.GIT_TEST_MODE;
    const say = (text) => { console.log(text); process.exit(0); };
    if (cmd === 'remote') say('file:///fixture');
    if (cmd === 'fetch') process.exit(mode === 'fetch' ? 1 : 0);
    if (cmd === 'symbolic-ref') say(args.includes('--short') ? 'main' : 'refs/remotes/origin/main');
    if (cmd === 'rev-parse') {
      if (args.includes('--verify') && ['fetch', 'missing'].includes(mode)) process.exit(1);
      say('.git');
    }
    if (cmd === 'status') process.exit(mode === 'status' ? 1 : 0);
    if (cmd === 'rev-list') {
      if (mode === 'count') process.exit(1);
      say(mode === 'malformed' ? 'unknown' : args.at(-1) === 'main..origin/main' ? '1' : '0');
    }
    if (cmd === 'merge') process.exit(mode === 'merge' ? 1 : 0);
  `);
  const run = (mode) => { stub.reset(); process.env.GIT_TEST_MODE = mode; return freshenRepo(dir); };
  for (const mode of ['count', 'malformed']) {
    const res = run(mode);
    assert.equal(res.behind, null);
    assert.deepEqual(res.warnings, [{ code: 'unknown-divergence', branch: 'main' }]);
    assert.equal(stub.calls().some(({ cmd }) => cmd === 'merge'), false);
  }
  const status = run('status');
  assert.equal(status.dirty, null);
  assert.deepEqual(status.warnings, [{ code: 'blocked', branch: 'main', behind: 1, ahead: 0, tree: 'unknown' }]);
  assert.equal(stub.calls().some(({ cmd }) => cmd === 'merge'), false);
  assert.deepEqual(run('missing').warnings, [{ code: 'missing-local', branch: 'main', fetchOk: true }]);
  assert.deepEqual(run('fetch').warnings.map(({ code }) => code), ['fetch', 'missing-local']);
  assert.equal(run('fetch').warnings[1].fetchOk, false);
  assert.equal(run('merge').warnings[0].code, 'update');
  const ok = run('');
  assert.equal(ok.updated, true);
  assert.deepEqual(ok.warnings, []);
  assert.equal(stub.calls().filter(({ cmd }) => cmd === 'merge').length, 1);
});

test('fresh fetch alone gets explicit authentication and redacts failed diagnostics', (t) => {
  const root = fixture(t);
  const origin = seed(path.join(root, 'source'));
  const dir = checkout(origin, path.join(root, 'work'));
  const stub = stubGit(t, root, `if (cmd === 'fetch' && process.env.GIT_TEST_SECRET) {
    console.error('remote failure: ' + process.env.GIT_TEST_SECRET); process.exit(77);
  }`);
  const secret = 'sample-private-value';
  const result = freshenRepo(dir, { auth: () => ({ args: ['-c', 'example.probe=yes'], env: { GIT_TEST_SECRET: secret }, secret }) });
  assert.equal(result.fetchOk, false);
  assert.deepEqual(result.warnings, [{ code: 'fetch', issue: { detail: 'remote failure: ***' } }]);
  const calls = stub.calls();
  assert.equal(calls.filter(({ cmd }) => cmd === 'fetch').length, 1);
  assert.ok(calls.every(({ cmd, argv }) => argv.includes('example.probe=yes') === (cmd === 'fetch') && !argv.includes(secret)));
  stub.reset();
  assert.equal(freshenRepo(dir).fetchOk, true);
  assert.ok(stub.calls().some(({ cmd }) => cmd === 'fetch'));
  assert.ok(stub.calls().every(({ argv }) => !argv.includes('example.probe=yes')));
});

test('observe-only fetch changes tracking refs but not local refs, files, tags, index or FETCH_HEAD', (t) => {
  const root = fixture(t);
  const source = seed(path.join(root, 'source'));
  const dir = checkout(source, path.join(root, 'work'));
  const original = tip(dir);
  const head = commit(source, 'second');
  git(source, 'tag', 'remote-only');
  git(dir, 'tag', 'local-only');
  for (const ref of ['+refs/heads/*:refs/heads/imported/*', '+refs/tags/*:refs/tags/*']) git(dir, 'config', '--add', 'remote.origin.fetch', ref);
  for (const [key, value] of [['remote.origin.tagOpt', '--tags'], ['fetch.pruneTags', 'true'],
    ['remote.origin.pruneTags', 'true'], ['fetch.prune', 'true'], ['remote.origin.mirror', 'true']]) git(dir, 'config', key, value);
  const snapshot = () => [git(dir, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags'),
    git(dir, '--no-optional-locks', 'status', '--porcelain'), git(dir, 'rev-parse', 'HEAD'), readFileSync(path.join(dir, '.git/index'))];
  const before = snapshot();
  const result = freshenRepo(dir, { observeOnly: true });
  assert.equal(result.fetchOk, true);
  assert.equal(result.updated, false);
  assert.equal(result.behind, 1);
  assert.deepEqual(snapshot(), before);
  assert.equal(tip(dir, 'origin/main'), head);
  assert.equal(tip(dir), original);
  assert.equal(existsSync(path.join(dir, '.git/FETCH_HEAD')), false);
  assert.equal(existsSync(path.join(dir, 'second')), false);
});

test('a hanging fetch is killed at its timeout and one deadline bounds later Git calls', posix, (t) => {
  const root = fixture(t);
  const origin = seed(path.join(root, 'source'));
  const dir = checkout(origin, path.join(root, 'work'));
  const stub = stubGit(t, root, `if (cmd === 'fetch') {
    process.on('SIGTERM', () => {});
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    process.exit(78);
  }`);
  const start = Date.now();
  const result = freshenRepo(dir, { timeoutMs: 400 });
  assert.equal(result.fetchOk, false);
  assert.deepEqual(result.warnings[0], { code: 'fetch', issue: { timeoutMs: 400 } });
  assert.ok(Date.now() - start < 10_000);
  stub.reset();
  const clock = Date.now;
  let now = 0;
  Date.now = () => { now += 1000; return now; };
  try {
    const expired = freshenRepo(dir, { timeoutMs: 3000, deadline: 3900 });
    assert.equal(expired.fetchOk, false);
    assert.equal(expired.branch, null);
    assert.deepEqual(stub.calls().map(({ cmd }) => cmd), ['rev-parse', 'remote', 'fetch']);
  } finally { Date.now = clock; }
});
