import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gitLabClient, GitLabError } from '../../dist/git/gitlab.js';

test('GitLab request uses the explicit authority, a timeout and only a supplied header token', async () => {
  const calls = [];
  const request = async (input, options) => { calls.push([String(input), options]); return Response.json({ username: 'example' }); };
  const token = 'example-api-token';
  assert.deepEqual((await gitLabClient('GIT.one.test:8443', { token, request }).api('user')).json, { username: 'example' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://git.one.test:8443/api/v4/user');
  assert.deepEqual(calls[0][1].headers, { 'PRIVATE-TOKEN': token });
  assert.equal(calls[0][1].redirect, 'error');
  assert.ok(calls[0][1].signal instanceof AbortSignal);
  await gitLabClient('git.one.test', { request }).api('user');
  assert.deepEqual(calls[1][1].headers, {});
});

test('GitLab rejects invalid hosts and cross-origin or out-of-prefix requests before transport', async () => {
  const request = () => assert.fail('transport must not be called');
  for (const host of ['https://git.one.test', 'git.one.test/api/v4', 'u@git.one.test', 'git.one.test?query=1', '']) {
    assert.throws(() => gitLabClient(host, { request }), { problem: { code: 'host' } });
  }
  const client = gitLabClient('git.one.test', { request });
  for (const endpoint of ['https://git.two.test/api/v4/projects', '//git.two.test/api/v4/projects', '../projects', 'https://[']) {
    await assert.rejects(client.api(endpoint), { problem: { code: 'path' } });
  }
});

test('GitLab distinguishes hard HTTP, network and timeout errors; soft calls return null', async () => {
  for (const status of [401, 403, 404]) {
    const client = gitLabClient('git.one.test', { request: async () => new Response(null, { status }) });
    await assert.rejects(client.api('projects/x'), (error) => error instanceof GitLabError && error.status === status
      && error.problem.code === 'http' && error.message.includes(`GitLab API ${status}`));
    assert.equal(await client.api('projects/x', { soft: true }), null);
  }
  const offline = gitLabClient('git.one.test', { request: async () => {
    throw new Error('fetch failed', { cause: { code: 'ENOTFOUND' } });
  } });
  await assert.rejects(offline.api('projects/x'), {
    problem: { code: 'network', timeout: false, detail: 'ENOTFOUND' }, message: /git\.one\.test.*ENOTFOUND/,
  });
  assert.equal(await offline.api('projects/x', { soft: true }), null);
  const timeout = gitLabClient('git.one.test', { timeoutMs: 5, request: async (_url, { signal }) => {
    await new Promise((_, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('timeout signal never fired')), 250);
      signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
    });
  } });
  await assert.rejects(timeout.api('projects/x'), (error) => error.problem.code === 'network' && error.problem.timeout
    && /timed out after 0\.005 s/.test(error.message));
  assert.equal(await timeout.api('projects/x', { soft: true }), null);
});

test('GitLab pagination keeps each explicit host and collects every page in order', async () => {
  const asked = [];
  for (const host of ['git.one.test', 'git.two.test']) {
    const client = gitLabClient(host, { request: async (input) => {
      const url = new URL(input); asked.push(url.href);
      const page = url.searchParams.get('page');
      return Response.json([{ host: url.host, page }], { headers: page === '1' ? { 'x-next-page': '2' } : {} });
    } });
    const endpoint = host === 'git.one.test' ? 'groups/team/projects' : 'projects?search=project';
    assert.deepEqual(await client.apiPaged(endpoint), [{ host, page: '1' }, { host, page: '2' }]);
  }
  assert.deepEqual(asked, [
    'https://git.one.test/api/v4/groups/team/projects?per_page=100&page=1',
    'https://git.one.test/api/v4/groups/team/projects?per_page=100&page=2',
    'https://git.two.test/api/v4/projects?search=project&per_page=100&page=1',
    'https://git.two.test/api/v4/projects?search=project&per_page=100&page=2',
  ]);
});

test('GitLab rejects malformed JSON, non-array pages and non-forward page numbers', async () => {
  for (const [code, reply] of [
    ['json', () => new Response('{')], ['page-items', () => Response.json({ project: 'not a list' })],
    ...['1', '0', 'not-a-number', '9007199254740992', '-2'].map((next) => ['next-page', () => Response.json([], { headers: { 'x-next-page': next } })]),
  ]) {
    let requests = 0;
    const client = gitLabClient('git.one.test', { request: async () => { requests += 1; return reply(); } });
    await assert.rejects(client.apiPaged('projects'), { problem: { code } });
    assert.equal(await client.apiPaged('projects', { soft: true }), null);
    assert.equal(requests, 2);
  }
});

test('GitLab discards partial results when a later page fails', async () => {
  const pages = [];
  const client = gitLabClient('git.one.test', { request: async (input) => {
    const page = new URL(input).searchParams.get('page');
    pages.push(page);
    return page === '1' ? Response.json([{ id: 1 }], { headers: { 'x-next-page': '2' } }) : new Response(null, { status: 403 });
  } });
  assert.equal(await client.apiPaged('groups/team/projects', { soft: true }), null);
  await assert.rejects(client.apiPaged('groups/team/projects'), { problem: { code: 'http', status: 403 } });
  assert.deepEqual(pages, ['1', '2', '1', '2']);
  assert.deepEqual(await gitLabClient('git.one.test', { request: async () => Response.json([]) }).apiPaged('projects'), []);
});
