import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

export const GIT_NET_TIMEOUT_MS = 30_000;
export const GIT_LOCAL_TIMEOUT_MS = 5_000;
export const GIT_CLONE_TIMEOUT_MS = 300_000;
export const GIT_MAX_OUTPUT = 32 * 1024 * 1024;

export interface GitAuth { args: string[]; env: NodeJS.ProcessEnv; secret?: string | null }
export type ProcessResult = { error?: NodeJS.ErrnoException; signal?: NodeJS.Signals | null; status?: number | null; stderr?: string | Buffer | null };
type GitResult = { ok: true } | { ok: false; err: string; reason: 'timeout' | 'occupied' | 'git'; previous?: string };
interface Options { auth?: GitAuth; timeoutMs?: number }

export function gitRun(args: string[], { auth, timeoutMs = GIT_NET_TIMEOUT_MS, inherit = false }: Options & { inherit?: boolean } = {}) {
  return spawnSync('git', [...(auth?.args ?? []), ...args], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: GIT_MAX_OUTPUT, killSignal: 'SIGKILL',
    stdio: ['ignore', inherit ? 'inherit' : 'pipe', 'pipe'],
    env: { ...process.env, ...auth?.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

export const gitOutput = (r: { status: number | null; stdout?: string | null }) => r.status === 0 ? (r.stdout ?? '').trim() : null;
export const timedOut = (r: ProcessResult | null | undefined) => r?.error?.code === 'ETIMEDOUT' || (!!r?.signal && r.status === null);

export function gitError(r: ProcessResult, auth?: GitAuth, full = true) {
  const stderr = String(r.stderr ?? '').trim();
  const text = (full ? stderr : stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1))
    || r.error?.message || `git exited ${r.status}`;
  return auth?.secret ? text.replaceAll(auth.secret, '***') : text;
}

export function gitToplevel(dir: string) {
  const top = gitOutput(gitRun(['-C', dir, 'rev-parse', '--show-toplevel']));
  return top ? path.resolve(top) : null;
}

export function repoHead(dir: string) {
  const top = gitToplevel(dir);
  if (!top || realpathSync(top) !== realpathSync(dir)) return null;
  return gitOutput(gitRun(['-C', dir, 'rev-parse', 'HEAD'])) || null;
}

export function fetchTarget(dir: string) {
  return gitOutput(gitRun(['-C', dir, 'remote', 'get-url', 'origin'])) || 'origin';
}

export function gitLsRemoteTags(url: string, options: Options = {}) {
  const out = gitOutput(gitRun(['ls-remote', '--tags', '--refs', '--', url], { timeoutMs: 20_000, ...options }));
  return out === null ? null : out.split('\n').map((line) => /^\S+\trefs\/tags\/(.+)$/.exec(line)?.[1]).filter((tag) => tag !== undefined);
}

function cloneError(r: ProcessResult, auth: GitAuth | undefined, timeoutMs: number): Exclude<GitResult, { ok: true }> {
  return timedOut(r)
    ? { ok: false, reason: 'timeout', err: `Git clone timed out after ${timeoutMs / 1000} s` }
    : { ok: false, reason: 'git', err: gitError(r, auth) };
}

export function gitClone(url: string, dest: string, { auth, branch, depth, timeoutMs = GIT_CLONE_TIMEOUT_MS }: Options & { branch?: string; depth?: number } = {}): GitResult {
  const args = ['clone', '--quiet'];
  if (depth) args.push('--depth', String(depth));
  if (branch) args.push('--branch', branch);
  const r = gitRun([...args, '--', url, dest], { auth, timeoutMs, inherit: true });
  return r.status === 0 ? { ok: true } : cloneError(r, auth, timeoutMs);
}

export function gitCloneSha(url: string, dest: string, sha: string, { auth, timeoutMs = GIT_CLONE_TIMEOUT_MS }: Options = {}): GitResult {
  if (!/^[a-f0-9]{40}$/i.test(sha)) return { ok: false, reason: 'git', err: 'Expected a full Git SHA' };
  const destination = lstatSync(dest, { throwIfNoEntry: false });
  if (destination && (!destination.isDirectory() || readdirSync(dest).length)) {
    return { ok: false, reason: 'occupied', err: `${dest} is not empty or is not a directory` };
  }
  mkdirSync(dest, { recursive: true });
  const run = (...args: string[]) => gitRun(['-C', dest, ...args], { auth, timeoutMs, inherit: true });
  const abort = (error: Exclude<GitResult, { ok: true }>) => {
    rmSync(dest, { recursive: true, force: true });
    return error;
  };
  for (const args of [['init', '--quiet'], ['remote', 'add', '--', 'origin', url]]) {
    const r = run(...args);
    if (r.status !== 0) return abort(cloneError(r, auth, timeoutMs));
  }
  const fetched = run('fetch', '--quiet', '--depth', '1', 'origin', sha);
  if (fetched.status !== 0) {
    rmSync(dest, { recursive: true, force: true });
    const full = gitClone(url, dest, { auth, timeoutMs });
    if (!full.ok) return abort({ ...full, previous: cloneError(fetched, auth, timeoutMs).err });
  }
  const co = run('checkout', '--detach', '--quiet', fetched.status === 0 ? 'FETCH_HEAD' : sha);
  return co.status === 0 ? { ok: true } : abort(cloneError(co, auth, timeoutMs));
}

export function gitFetch(dir: string, target: string, refs: string[], options: Options & { flags?: string[] } = {}) {
  return gitRun(['-C', dir, 'fetch', '--quiet', ...(options.flags ?? []), '--', target, ...refs], options);
}
