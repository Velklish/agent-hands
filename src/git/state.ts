import { readdirSync, statSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { GIT_LOCAL_TIMEOUT_MS, GIT_MAX_OUTPUT } from './process.js';
import { listClonedRepos, repoAbsPath } from './layout.js';
import { DEFAULT_BRANCH_FALLBACK, branchOfOriginRef } from './fresh.js';

const english = {
  timeout: (seconds: number) => `Git timed out after ${seconds} s`,
  notRoot: (dir: string) => `Not a Git repository root: ${dir}`,
  count: (why: string | null) => `Could not count commits ahead: ${why}`,
  missing: (ref: string) => `Ref not present locally: ${ref}`,
  unknown: (why: string | null, ref: string, other: string | null) => `Could not count commits ahead: ${why}; could not inspect ${ref}: ${other}`,
};

type GitResult = { ok: true; out: string } | { ok: false; code: number | null; stderr: string; why: string };
interface Status { readable: boolean; why: string | null; branch: string | null; detached: boolean; upstream: string | null; ahead: number | null; aheadWhy: string | null; dirty: boolean }
export interface Contact { at: number | null; via: string | null }
export interface ZoneState extends Status { repo: string; default: string | null; contact: Contact }


const CONCURRENCY = os.availableParallelism();

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function parseCount(value: string) {
  const count = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(count) ? count : null;
}

function git(repoAbs: string, labels: typeof english, ...args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', ['-C', repoAbs, ...args], {
      encoding: 'utf8',
      maxBuffer: GIT_MAX_OUTPUT,
      timeout: GIT_LOCAL_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    }, (err, stdout, stderr) => {
      const text = (stderr ?? '').trim();
      if (!err) return resolve({ ok: true, out: stdout.trim() });
      const why = err.killed
        ? labels.timeout(Math.round(GIT_LOCAL_TIMEOUT_MS / 1000))
        : (text.split('\n').filter(Boolean).pop() || err.message);
      const code = !err.killed && typeof err.code === 'number' ? err.code : null;
      resolve({ ok: false, code, stderr: text, why });
    });
  });
}

function mtimeMs(file: string) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function newestMtime(dir: string): number {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let best = 0;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    best = Math.max(best, e.isDirectory() ? newestMtime(p) : mtimeMs(p));
  }
  return best;
}

function lastContact(gitDir: string): Contact {
  const fetched = mtimeMs(path.join(gitDir, 'FETCH_HEAD'));
  if (fetched) return { at: fetched, via: 'fetch' };
  const cloned = newestMtime(path.join(gitDir, 'logs', 'refs', 'remotes'));
  return cloned ? { at: cloned, via: 'clone' } : { at: null, via: null };
}

function parseStatus(status: { ok: true; out: string } | { ok: false; why: string | null }): Status {
  const res: Status = {
    readable: status.ok,
    why: status.ok ? null : status.why,
    branch: null,
    detached: false,
    upstream: null,
    ahead: null,
    aheadWhy: null,
    dirty: false,
  };
  if (!status.ok) return res;
  for (const line of status.out.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      res.detached = head === '(detached)';
      res.branch = res.detached ? null : head;
    } else if (line.startsWith('# branch.upstream ')) {
      res.upstream = line.slice('# branch.upstream '.length).trim() || null;
    } else if (line.startsWith('# branch.ab ')) {
      const ahead = /^# branch\.ab \+(\d+) /.exec(line)?.[1];
      res.ahead = ahead === undefined ? null : parseCount(ahead);
    } else if (line && !line.startsWith('#')) {
      res.dirty = true;
    }
  }
  return res;
}

function samePath(a: string, b: string) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export async function localStatus(dirAbs: string, labels = english) {
  const top = await git(dirAbs, labels, 'rev-parse', '--path-format=absolute', '--show-toplevel');
  if (!top.ok || !samePath(top.out, dirAbs)) {
    return { ...parseStatus({ ok: false, why: labels.notRoot(dirAbs) }), subject: null };
  }
  const s = parseStatus(await git(dirAbs, labels, '--no-optional-locks', 'status', '--porcelain=v2', '--branch'));
  if (!s.readable || !s.ahead) return { ...s, subject: null };
  const head = await git(dirAbs, labels, 'log', '-1', '--format=%s');
  return { ...s, subject: head.ok ? head.out : null };
}

function commonGitDir(repoAbs: string, labels: typeof english) {
  const dotGit = path.join(repoAbs, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return Promise.resolve({ ok: true, out: dotGit });
  } catch { /* Worktrees store a pointer here, not a directory. */ }
  return git(repoAbs, labels, 'rev-parse', '--path-format=absolute', '--git-common-dir');
}

async function whyNotCounted(repoAbs: string, ref: string, why: string | null, labels: typeof english) {
  const exists = await git(repoAbs, labels, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  if (exists.ok) return labels.count(why);
  if (exists.code === 1 && !exists.stderr) return labels.missing(ref);
  return labels.unknown(why, ref, exists.why);
}

async function defaultOf(repoAbs: string, originHead: GitResult, labels: typeof english) {
  if (originHead.ok) return branchOfOriginRef(originHead.out);
  const asked = await Promise.all(DEFAULT_BRANCH_FALLBACK.map(
    (br) => git(repoAbs, labels, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${br}`),
  ));
  const i = asked.findIndex((r) => r.ok);
  return i === -1 ? null : DEFAULT_BRANCH_FALLBACK[i];
}

async function inspect(root: string, repo: string, labels: typeof english): Promise<ZoneState> {
  const abs = repoAbsPath(root, repo);
  const [originHead, status, gitDir] = await Promise.all([
    git(abs, labels, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'),
    git(abs, labels, '--no-optional-locks', 'status', '--porcelain=v2', '--branch'),
    commonGitDir(abs, labels),
  ]);
  const def = await defaultOf(abs, originHead, labels);
  const st = parseStatus(status);
  if (st.ahead === null && st.branch !== null) {
    const ref = st.upstream ?? `origin/${st.branch}`;
    const counted = await git(abs, labels, 'rev-list', '--count', `${ref}..${st.branch}`);
    if (counted.ok) {
      st.ahead = parseCount(counted.out);
      if (st.ahead === null) st.aheadWhy = labels.count('Git returned an invalid commit count');
    }
    else st.aheadWhy = await whyNotCounted(abs, ref, counted.why, labels);
  }
  return {
    repo,
    default: def,
    ...st,
    contact: lastContact(gitDir.ok ? gitDir.out : path.join(abs, '.git')),
  };
}

export async function scanZone(root: string, repos: string[] = listClonedRepos(root).map((r) => r.nsPath), labels = english) {
  const states: ZoneState[] = new Array(repos.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= repos.length) return;
      states[i] = await inspect(root, repos[i], labels);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, repos.length) }, worker));
  return states.sort((a, b) => a.repo.localeCompare(b.repo));
}

export function offDefault(s: ZoneState) {
  return s.readable && (s.detached || (s.default !== null && s.branch !== s.default));
}

export function defaultUnknown(s: ZoneState) {
  return s.readable && !s.detached && s.default === null;
}

export function aheadUnknown(s: ZoneState) {
  return s.readable && s.branch !== null && s.ahead === null;
}

export function countZone(states: ZoneState[], now = Date.now()) {
  const c = {
    total: states.length,
    offDefault: 0,
    defaultUnknown: 0,
    dirty: 0,
    ahead: 0,
    aheadUnknown: 0,
    stale: 0,
    contactUnknown: 0,
    unreadable: 0,
    clean: 0,
  };
  for (const s of states) {
    if (!s.readable) { c.unreadable += 1; continue; }
    if (offDefault(s)) c.offDefault += 1;
    if (defaultUnknown(s)) c.defaultUnknown += 1;
    if (s.dirty) c.dirty += 1;
    if (s.ahead) c.ahead += 1;
    if (aheadUnknown(s)) c.aheadUnknown += 1;
    if (s.contact.at === null) c.contactUnknown += 1;
    else if (now - s.contact.at > MONTH_MS) c.stale += 1;
    if (!offDefault(s) && !defaultUnknown(s) && !s.dirty && s.ahead === 0) c.clean += 1;
  }
  return c;
}
