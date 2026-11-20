import type { SpawnSyncReturns } from 'node:child_process';
import { gitRun, gitOutput, gitError, timedOut, GIT_NET_TIMEOUT_MS, type GitAuth } from './process.js';

type Issue = { timeoutMs: number } | { detail: string };
export type FreshWarning = { code: 'not-repo'; repoAbs: string }
  | { code: 'no-origin' | 'unknown-default' }
  | { code: 'fetch'; issue: Issue }
  | { code: 'missing-local'; branch: string; fetchOk: boolean }
  | { code: 'unknown-divergence'; branch: string }
  | { code: 'blocked'; branch: string; behind: number; ahead: number; tree: 'clean' | 'dirty' | 'unknown' }
  | { code: 'update'; branch: string; behind: number; issue: Issue };

const issue = (run: SpawnSyncReturns<string>, auth: GitAuth | undefined, timeoutMs: number): Issue =>
  timedOut(run) ? { timeoutMs } : { detail: gitError(run, auth, false) };

export interface FreshResult<W = FreshWarning> {
  branch: string | null; checkout: string | null; behind: number | null; ahead: number | null;
  headBehindDefault: number | null; checkoutBehind: number | null; checkoutAhead: number | null;
  dirty: boolean | null; updated: boolean; fetchOk: boolean; warnings: W[];
}

export const DEFAULT_BRANCH_FALLBACK = ['master', 'main'];

export function branchOfOriginRef(ref: string) {
  return ref.replace(/^refs\/remotes\/origin\//, '');
}

export function defaultBranch(repoAbs: string, run = (...args: string[]) => gitRun(['-C', repoAbs, ...args])) {
  const head = gitOutput(run('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'));
  if (head) return branchOfOriginRef(head);
  for (const br of DEFAULT_BRANCH_FALLBACK) {
    if (run('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${br}`).status === 0) return br;
  }
  return null;
}

function count(run: (...args: string[]) => SpawnSyncReturns<string>, range: string) {
  const n = gitOutput(run('rev-list', '--count', range));
  return n !== null && /^\d+$/.test(n) && Number.isSafeInteger(Number(n)) ? Number(n) : null;
}

export function readDefaultBranch(repoAbs: string) { return defaultBranch(repoAbs); }

export interface FreshOptions {
  timeoutMs?: number; observeOnly?: boolean; deadline?: number; auth?: GitAuth | (() => GitAuth);
}

export function freshenRepo(repoAbs: string, { timeoutMs = GIT_NET_TIMEOUT_MS, observeOnly = false, deadline, auth }: FreshOptions = {}) {
  const run = (args: string[], credentials?: GitAuth) => {
    const remaining = deadline === undefined ? timeoutMs : Math.min(timeoutMs, deadline - Date.now());
    if (remaining <= 0) return { status: null, stdout: '', stderr: '', pid: 0, output: ['', '', ''], signal: null,
      error: Object.assign(new Error('overall deadline exceeded'), { code: 'ETIMEDOUT' }) } satisfies SpawnSyncReturns<string>;
    return gitRun(['-C', repoAbs, ...args], { auth: credentials, timeoutMs: remaining });
  };
  const local = (...args: string[]) => run(args);
  const res: FreshResult = {
    branch: null, checkout: null, behind: null, ahead: null,
    headBehindDefault: null, checkoutBehind: null, checkoutAhead: null,
    dirty: null, updated: false, fetchOk: false, warnings: [],
  };

  if (local('rev-parse', '--git-dir').status !== 0) {
    res.warnings.push({ code: 'not-repo', repoAbs });
    return res;
  }
  if (local('remote', 'get-url', 'origin').status !== 0) {
    res.warnings.push({ code: 'no-origin' });
    return res;
  }

  const credentials = typeof auth === 'function' ? auth() : auth;
  const fetched = run(observeOnly ? ['fetch', '--quiet', '--no-tags', '--no-prune', '--no-write-fetch-head',
    '--recurse-submodules=no', '--refmap=', 'origin', '+refs/heads/*:refs/remotes/origin/*']
    : ['fetch', '--quiet', 'origin'], credentials);
  const fetchOk = fetched.status === 0;
  res.fetchOk = fetchOk;
  if (!fetchOk) {
    res.warnings.push({ code: 'fetch', issue: issue(fetched, credentials, timeoutMs) });
  }

  res.branch = defaultBranch(repoAbs, local);
  const current = gitOutput(local('symbolic-ref', '--quiet', '--short', 'HEAD'));
  res.checkout = current;
  const status = gitOutput(local('--no-optional-locks', 'status', '--porcelain'));
  res.dirty = status === null ? null : status !== '';

  if (!res.branch) {
    res.warnings.push({ code: 'unknown-default' });
    return res;
  }
  const br = res.branch;
  if (current !== br) {
    res.headBehindDefault = count(local, `HEAD..origin/${br}`);
    if (current && local('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${current}`).status === 0) {
      res.checkoutBehind = count(local, `HEAD..origin/${current}`);
      res.checkoutAhead = count(local, `origin/${current}..HEAD`);
    }
  }
  if (local('rev-parse', '--verify', '--quiet', `refs/heads/${br}`).status !== 0) {
    res.warnings.push({ code: 'missing-local', branch: br, fetchOk });
    return res;
  }

  res.behind = count(local, `${br}..origin/${br}`);
  res.ahead = count(local, `origin/${br}..${br}`);
  if (res.behind === null || res.ahead === null) {
    res.warnings.push({ code: 'unknown-divergence', branch: br });
    return res;
  }
  if (observeOnly || !fetchOk || !res.behind) return res;

  const tree = current !== br || status === '' ? 'clean' : status === null ? 'unknown' : 'dirty';
  if (res.ahead || tree !== 'clean') {
    res.warnings.push({ code: 'blocked', branch: br, behind: res.behind, ahead: res.ahead, tree });
    return res;
  }

  const upd = current === br
    ? local('merge', '--ff-only', `origin/${br}`)
    : run(['fetch', '--quiet', 'origin', `${br}:${br}`], credentials);
  if (upd.status !== 0) {
    res.warnings.push({ code: 'update', branch: br, behind: res.behind, issue: issue(upd, credentials, timeoutMs) });
    return res;
  }
  res.updated = true;
  return res;
}
