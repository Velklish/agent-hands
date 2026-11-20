import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkout, command, commit, fixture, git, posix, routeHost, seed, stubGit } from './fixture.mjs';

const availableParallelism = os.availableParallelism;
os.availableParallelism = () => 2;
syncBuiltinESMExports();
const { aheadUnknown, countZone, defaultUnknown, localStatus, offDefault, scanZone } = await import('../../dist/git/state.js');
os.availableParallelism = availableParallelism;
syncBuiltinESMExports();
const { runRepositoryCommand } = await import('../../dist/git/navigation.js');

const day = 86_400_000;

test('zone scan reports actual state, contact, missing refs and explicit counters without changing clones', async (t) => {
  const base = fixture(t);
  const root = path.join(base, 'workspace');
  const source = seed(path.join(base, 'source'), 'master');
  for (const branch of ['trackless', 'upstream-gone', 'unrelated']) git(source, 'branch', branch);
  const checked = (ns) => checkout(source, path.join(root, ns.startsWith('external/') ? ns : `repos/${ns}`));
  const clean = checked('team/clean');
  const dirty = checked('team/dirty');
  const ahead = checked('team/deep/nested/ahead');
  const detached = checked('external/detached');
  const missing = checked('team/local-only');
  const noUpstream = checked('team/no-upstream');
  const brokenUpstream = checked('team/upstream-gone');
  const unknownAhead = checked('team/default-no-ref');
  const fallback = checked('team/fallback');
  const dirtyTopic = checked('team/dirty-topic');
  const badConfig = checked('team/bad-config');
  const unknownDefault = seed(path.join(root, 'repos/team/unknown-default'), 'topic');
  const broken = path.join(root, 'repos/team/broken');
  mkdirSync(broken);
  writeFileSync(path.join(broken, '.git'), 'gitdir: missing\n');
  mkdirSync(path.join(root, 'repos/team/node_modules/hidden/.git'), { recursive: true });
  mkdirSync(path.join(root, 'repos/.hidden/repo/.git'), { recursive: true });
  writeFileSync(path.join(badConfig, '.git/config'), '[core\n');
  writeFileSync(path.join(dirty, 'first'), 'edited');
  git(dirtyTopic, 'checkout', '-qb', 'off-default');
  writeFileSync(path.join(dirtyTopic, 'untracked'), 'new');
  git(detached, 'checkout', '-q', '--detach');
  git(missing, 'checkout', '-qb', 'local-only');
  git(noUpstream, 'checkout', '-q', '--no-track', '-b', 'trackless', 'origin/trackless');
  git(brokenUpstream, 'checkout', '-q', '--no-track', '-b', 'unrelated', 'origin/unrelated');
  git(brokenUpstream, 'branch', '--set-upstream-to=origin/upstream-gone');
  git(brokenUpstream, 'update-ref', '-d', 'refs/remotes/origin/upstream-gone');
  git(unknownAhead, 'branch', '--unset-upstream');
  git(unknownAhead, 'update-ref', '-d', 'refs/remotes/origin/master');
  for (const dir of [ahead, missing, noUpstream, brokenUpstream, unknownAhead]) commit(dir, 'local change');
  assert.equal(git(brokenUpstream, 'rev-list', '--count', 'origin/unrelated..HEAD'), '1');
  git(fallback, 'fetch', '-q', 'origin');
  git(fallback, 'remote', 'set-head', 'origin', '--delete');
  const worktree = path.join(root, 'repos/team/worktree');
  git(clean, 'worktree', 'add', '-qb', 'linked', worktree);
  assert.ok(statSync(path.join(worktree, '.git')).isFile());
  assert.equal(existsSync(path.join(clean, '.git/FETCH_HEAD')), false);

  const now = Date.now();
  const setAge = (dir, filename, days) => utimesSync(path.join(dir, '.git', filename), (now - day * days) / 1000, (now - day * days) / 1000);
  const originHeadLog = 'logs/refs/remotes/origin/HEAD';
  setAge(fallback, 'FETCH_HEAD', 45);
  setAge(dirty, originHeadLog, 1);
  setAge(detached, originHeadLog, 2);
  setAge(dirtyTopic, originHeadLog, -3);
  setAge(badConfig, originHeadLog, 200);
  const indexPath = path.join(dirty, '.git/index');
  const index = readFileSync(indexPath);
  const indexMtime = statSync(indexPath).mtimeMs;
  const before = git(clean, 'show-ref');
  commit(source, 'new remote commit');

  const rows = await scanZone(root);
  const by = Object.fromEntries(rows.map((entry) => [entry.repo.split('/').at(-1), entry]));
  assert.equal(rows.length, 14);
  assert.deepEqual(rows.map(({ repo }) => repo), rows.map(({ repo }) => repo).sort((a, b) => a.localeCompare(b)));
  assert.ok(!rows.some(({ repo }) => /hidden|node_modules/.test(repo)));
  assert.deepEqual([by.clean.branch, by.clean.default, by.clean.ahead, by.clean.dirty, by.clean.contact.via], ['master', 'master', 0, false, 'clone']);
  assert.deepEqual([by.detached.detached, by.detached.branch, offDefault(by.detached)], [true, null, true]);
  assert.equal(by.dirty.dirty, true);
  assert.deepEqual([by['dirty-topic'].branch, by['dirty-topic'].dirty, offDefault(by['dirty-topic'])], ['off-default', true, true]);
  assert.equal(by.ahead.ahead, 1);
  assert.deepEqual([by['no-upstream'].upstream, by['no-upstream'].ahead], [null, 1]);
  assert.match(by['local-only'].aheadWhy, /^Ref not present locally: origin\/local-only/);
  assert.deepEqual([by['upstream-gone'].upstream, by['upstream-gone'].ahead], ['origin/upstream-gone', null]);
  assert.match(by['upstream-gone'].aheadWhy, /origin\/upstream-gone/);
  assert.deepEqual([offDefault(by['default-no-ref']), defaultUnknown(by['default-no-ref']), aheadUnknown(by['default-no-ref'])], [false, false, true]);
  assert.deepEqual([by.fallback.default, by.fallback.contact.via], ['master', 'fetch']);
  assert.equal(by.broken.readable, false);
  assert.ok(by.broken.why);
  assert.deepEqual(by.broken.contact, { at: null, via: null });
  assert.deepEqual([by['bad-config'].readable, by['bad-config'].contact.via], [false, 'clone']);
  assert.ok(now - by['bad-config'].contact.at > 190 * day);
  assert.deepEqual([by['unknown-default'].default, defaultUnknown(by['unknown-default']), offDefault(by['unknown-default'])], [null, true, false]);
  assert.deepEqual([by.worktree.readable, by.worktree.branch, by.worktree.contact.via], [true, 'linked', 'clone']);
  assert.deepEqual(countZone(rows, now), {
    total: 14, offDefault: 6, defaultUnknown: 1, dirty: 2, ahead: 2, aheadUnknown: 6, stale: 1, contactUnknown: 1, unreadable: 2, clean: 2,
  });
  assert.equal(git(clean, 'show-ref'), before);
  assert.equal(git(dirtyTopic, 'symbolic-ref', '--short', 'HEAD'), 'off-default');
  assert.equal(readFileSync(path.join(dirty, 'first'), 'utf8'), 'edited');
  assert.deepEqual(readFileSync(indexPath), index);
  assert.equal(statSync(indexPath).mtimeMs, indexMtime);
  assert.equal((await localStatus(ahead)).subject, 'local change');
  assert.equal((await localStatus(clean)).subject, null);
  assert.equal((await localStatus(path.join(dirtyTopic, '.git'))).readable, false);
  assert.equal(existsSync(path.join(unknownDefault, '.git/FETCH_HEAD')), false);
});

test('zone scan can distinguish missing comparison refs, count failures and failed diagnosis', posix, async (t) => {
  const root = fixture(t);
  const source = seed(path.join(root, 'source'));
  git(source, 'branch', 'topic');
  const names = ['missing', 'exists', 'diagnosis', 'silent'];
  for (const name of names) {
    const dir = checkout(source, path.join(root, 'repos/team', name));
    git(dir, 'checkout', '-q', '--no-track', '-b', name === 'exists' ? 'topic' : 'local');
    git(dir, 'remote', 'set-head', 'origin', '--delete');
  }
  const stub = stubGit(t, root, `
    if (cmd === 'rev-list') { console.error('simulated count failure'); process.exit(128); }
    if (cmd === 'rev-parse' && args.at(-1).endsWith('^{commit}')) {
      if (cwd.endsWith('/diagnosis')) { console.error('simulated ref inspection failure'); process.exit(128); }
      if (cwd.endsWith('/silent')) process.exit(128);
    }
  `);
  const rows = await scanZone(root);
  assert.deepEqual(rows.map(({ repo }) => repo), ['team/diagnosis', 'team/exists', 'team/missing', 'team/silent']);
  assert.equal(rows[0].ahead, null);
  assert.match(rows[0].aheadWhy, /simulated count failure.*could not inspect.*simulated ref inspection failure/);
  assert.equal(rows[1].aheadWhy, 'Could not count commits ahead: simulated count failure');
  assert.equal(rows[2].aheadWhy, 'Ref not present locally: origin/local');
  assert.match(rows[3].aheadWhy, /simulated count failure.*could not inspect.*origin\/local/);
  assert.doesNotMatch(rows[3].aheadWhy, /Ref not present locally/);
  for (const name of names) assert.equal(stub.calls().filter(({ cmd, args, cwd }) => cwd.endsWith(`/${name}`) && cmd === 'symbolic-ref'
    && args.includes('refs/remotes/origin/HEAD')).length, 1);
  assert.ok(rows.every(({ default: branch }) => branch === 'main'));
});

test('zone scan bounds parallel repositories and isolates a hung status and default discovery', posix, async (t) => {
  const root = fixture(t);
  const source = seed(path.join(root, 'source'));
  const names = ['hang-status', 'hang-default', 'neighbor', 'later'];
  for (const name of names) checkout(source, path.join(root, 'repos/team', name));
  writeFileSync(path.join(root, 'repos/team/neighbor/new'), 'dirty');
  commit(path.join(root, 'repos/team/later'), 'local');
  const stub = stubGit(t, root, `
    if (cmd === 'status' && cwd.endsWith('/hang-status') || cwd.endsWith('/hang-default')) {
      process.on('SIGTERM', () => {});
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  `);
  const start = Date.now();
  const rows = await scanZone(root, names.map((name) => `team/${name}`));
  assert.ok(Date.now() - start < 25_000);
  const by = Object.fromEntries(rows.map((row) => [row.repo, row]));
  for (const name of ['hang-status', 'hang-default']) {
    assert.equal(by[`team/${name}`].readable, false);
    assert.match(by[`team/${name}`].why, /Git timed out after 5 s/);
  }
  assert.equal(by['team/hang-default'].default, null);
  assert.equal(by['team/neighbor'].dirty, true);
  assert.equal(by['team/later'].ahead, 1);
  const starts = stub.calls().filter(({ cmd }) => cmd === 'symbolic-ref').map(({ cwd }) => path.basename(cwd));
  assert.deepEqual(starts.slice(0, 2).sort(), ['hang-default', 'hang-status']);
  assert.deepEqual(starts.slice(2).sort(), ['later', 'neighbor']);
});

test('an empty workspace returns an empty structured zone report', async (t) => {
  const root = fixture(t);
  assert.deepEqual(await scanZone(root), []);
  assert.deepEqual(await command(runRepositoryCommand, { root, routeHost })('zone'), { exit: 0, out: ['[]'], err: [] });
});
