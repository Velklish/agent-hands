import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fetchTarget, GIT_CLONE_TIMEOUT_MS, GIT_NET_TIMEOUT_MS, gitClone, gitCloneSha, gitError, gitFetch, gitLsRemoteTags,
  repoHead, timedOut } from '../../dist/git/process.js';
import { checkout, commit, config, fixture, git, posix, seed, stubGit } from './fixture.mjs';

test('temporary repositories set a local test identity without global Git configuration', (t) => {
  const root = fixture(t);
  const dir = seed(path.join(root, 'source'));
  assert.equal(git(dir, 'show', '-s', '--format=%an <%ae>'), 'Test Fixture <fixture@example.test>');
});

test('SHA clone pins an older commit using shallow fetch or full-clone fallback', (t) => {
  const root = fixture(t);
  const source = seed(path.join(root, 'source'));
  const pinned = repoHead(source);
  commit(source, 'second');
  const url = 'https://git.one.test/team/source.git';
  const secret = 'sample-private-value';
  const auth = { args: [], env: { GIT_TEST_SECRET: secret }, secret };
  for (const mode of ['normal', 'shallow', 'fallback']) {
    const dest = path.join(root, mode);
    const entries = [[`url.${source}.insteadOf`, url]];
    if (mode === 'fallback') entries.push(['remote.origin.uploadpack', path.join(root, 'missing-upload-pack')]);
    config(entries);
    const result = mode === 'normal' ? gitClone(url, dest, { auth }) : gitCloneSha(url, dest, pinned, { auth });
    assert.deepEqual(result, { ok: true });
    assert.equal(repoHead(dest), mode === 'normal' ? repoHead(source) : pinned);
    assert.equal(readFileSync(path.join(dest, 'first'), 'utf8'), 'first\n');
    assert.equal(existsSync(path.join(dest, 'second')), mode === 'normal');
    assert.equal(existsSync(path.join(dest, '.git/shallow')), mode === 'shallow');
    assert.equal(git(dest, 'config', '--get', 'remote.origin.url'), url);
    assert.equal(readFileSync(path.join(dest, '.git/config'), 'utf8').includes(secret), false);
    if (mode !== 'normal') assert.equal(git(dest, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  }
});

test('invalid and missing SHA refuse without leaving a clone or touching an occupied directory', (t) => {
  const root = fixture(t);
  const source = seed(path.join(root, 'source'));
  const pinned = repoHead(source);
  const dest = path.join(root, 'dest');
  assert.deepEqual(gitCloneSha(source, dest, 'abc123'), { ok: false, reason: 'git', err: 'Expected a full Git SHA' });
  assert.equal(existsSync(dest), false);
  const missing = gitCloneSha(source, dest, '0'.repeat(39) + '1');
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'git');
  assert.ok(missing.err);
  assert.equal(existsSync(dest), false);
  const noSource = gitCloneSha(path.join(root, 'missing-origin'), dest, pinned);
  assert.equal(noSource.ok, false);
  assert.ok(noSource.previous);
  assert.equal(existsSync(dest), false);
  mkdirSync(dest);
  writeFileSync(path.join(dest, 'keep'), 'unrelated content');
  const occupied = gitCloneSha(source, dest, pinned);
  assert.equal(occupied.reason, 'occupied');
  assert.match(occupied.err, /is not empty/);
  assert.equal(readFileSync(path.join(dest, 'keep'), 'utf8'), 'unrelated content');
  assert.equal(existsSync(path.join(dest, '.git')), false);
  const file = path.join(dest, 'keep');
  assert.equal(gitCloneSha(source, file, pinned).reason, 'occupied');
  assert.equal(readFileSync(file, 'utf8'), 'unrelated content');
});

test('fetch uses an explicit origin address, updates FETCH_HEAD and refuses a missing ref', (t) => {
  const root = fixture(t);
  const source = seed(path.join(root, 'source'));
  const work = checkout(source, path.join(root, 'work'));
  const original = repoHead(work);
  assert.equal(fetchTarget(source), 'origin');
  assert.equal(fetchTarget(work), source);
  const next = commit(source, 'second');
  assert.equal(gitFetch(work, fetchTarget(work), ['main']).status, 0);
  assert.equal(git(work, 'rev-parse', 'FETCH_HEAD'), next);
  assert.equal(repoHead(work), original);
  git(work, 'merge', '--ff-only', 'FETCH_HEAD');
  assert.equal(repoHead(work), next);
  assert.equal(readFileSync(path.join(work, 'second'), 'utf8'), 'second\n');
  const missing = gitFetch(work, fetchTarget(work), ['no-such-branch']);
  assert.notEqual(missing.status, 0);
  assert.match(gitError(missing), /couldn't find remote ref no-such-branch/);
  assert.equal(repoHead(work), next);
});

test('ls-remote returns tag refs only and distinguishes an unreachable source', (t) => {
  const root = fixture(t);
  const source = seed(path.join(root, 'source'));
  git(source, 'tag', 'v1.0.0');
  git(source, 'tag', '-am', 'release', 'v2.0.0');
  assert.deepEqual(gitLsRemoteTags(source), ['v1.0.0', 'v2.0.0']);
  assert.equal(gitLsRemoteTags(path.join(root, 'missing')), null);
  assert.deepEqual(gitLsRemoteTags(seed(path.join(root, 'untagged'))), []);
});

test('clone retains the address passed by the caller and redacts authentication errors', (t) => {
  const root = fixture(t);
  const source = seed(path.join(root, 'source'));
  const url = 'https://code.one.test/group/repo.git';
  config([[`url.${source}.insteadOf`, url]]);
  const dir = path.join(root, 'clone');
  assert.deepEqual(gitClone(url, dir), { ok: true });
  assert.equal(git(dir, 'config', '--get', 'remote.origin.url'), url);
  const secret = 'sample-private-value';
  config([[`url.${root}/${secret}.insteadOf`, url]]);
  const refused = gitClone(url, path.join(root, 'failure'), { auth: { args: [], env: {}, secret } });
  assert.equal(refused.ok, false);
  assert.match(refused.err, /\*\*\*/);
  assert.equal(refused.err.includes(secret), false);
  assert.equal(gitError({ status: 128, stderr: 'fatal: ordinary failure\n' }), 'fatal: ordinary failure');
});

test('ordinary and pinned clone have a kill deadline longer by default than a network probe', posix, (t) => {
  const root = fixture(t);
  assert.ok(GIT_CLONE_TIMEOUT_MS > GIT_NET_TIMEOUT_MS);
  const stub = stubGit(t, root, `process.on('SIGTERM', () => {}); await new Promise((resolve) => setTimeout(resolve, 60_000));`);
  const dest = path.join(root, 'clone');
  const start = Date.now();
  for (const result of [gitClone('source', dest, { timeoutMs: 400 }), gitCloneSha('source', dest, '1'.repeat(40), { timeoutMs: 400 })]) {
    assert.deepEqual(result, { ok: false, reason: 'timeout', err: 'Git clone timed out after 0.4 s' });
  }
  assert.deepEqual(stub.calls().map(({ cmd }) => cmd), ['clone', 'init']);
  assert.equal(existsSync(dest), false);
  assert.ok(Date.now() - start < 10_000);
  assert.equal(timedOut({ status: null, error: { code: 'ETIMEDOUT' } }), true);
  assert.equal(timedOut({ status: 128 }), false);
});
