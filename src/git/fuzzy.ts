import { readFileSync } from 'node:fs';
import path from 'node:path';
import { listClonedRepos } from './layout.js';
import { GIT_LOCAL_TIMEOUT_MS, gitOutput, gitRun } from './process.js';
import { isRecord, projectNamespace } from './gitlab.js';

const REMOTE_URL = /\[remote "origin"\][^[]*?\n\s*url\s*=\s*(\S+)/;

export function normalize(name: unknown) {
  return String(name).trim().toLowerCase().replace(/[.\-_\s]+/g, '-').replace(/^-+|-+$/g, '');
}

export function tokens(name: unknown) {
  const n = normalize(name);
  return n ? n.split('-') : [];
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function score(hint: unknown, repoName: unknown, slug = '') {
  const h = tokens(hint);
  const name = tokens(repoName);
  if (!h.length || !name.length) return { value: 0, kind: '' };
  if (same(h, name)) return { value: 100, kind: 'exact' };
  if (slug && same(h, tokens(slug))) return { value: 95, kind: 'remote' };
  if (name.length > h.length && same(name.slice(-h.length), h)) return { value: 80, kind: 'suffix' };
  if (name.length > h.length && same(name.slice(0, h.length), h)) return { value: 70, kind: 'prefix' };
  if (h.length > name.length && same(h.slice(0, name.length), name)) return { value: 60, kind: 'parent' };
  if (h.length >= 2) {
    for (let i = 0; i <= name.length - h.length; i += 1) {
      if (same(name.slice(i, i + h.length), h)) return { value: 50, kind: 'part' };
    }
  }
  return { value: 0, kind: '' };
}

export function gitRemote(repoAbs: string) {
  try {
    const m = REMOTE_URL.exec(readFileSync(path.join(repoAbs, '.git', 'config'), 'utf8'));
    if (m) return m[1].trim();
  } catch { /* A worktree may store its config elsewhere. */ }
  return gitOutput(gitRun(['-C', repoAbs, 'remote', 'get-url', 'origin'], { timeoutMs: GIT_LOCAL_TIMEOUT_MS })) ?? '';
}

export function remoteSlug(remote: string) {
  if (!remote) return '';
  const tail = remote.replace(/\/+$/, '').split('/').at(-1) ?? '';
  return normalize(tail.replace(/\.git$/, ''));
}

export function topScored<T extends { value: number, nsPath: string }>(scored: T[]) {
  scored.sort((a, b) => b.value - a.value || a.nsPath.localeCompare(b.nsPath));
  const best = scored[0]?.value;
  return scored.filter((s) => s.value === best);
}

export function findRepo(root: string, hint: unknown, { personal = (_ns: string): boolean => false, onCollision = (_abs: string) => {} } = {}) {
  const scored = [];
  for (const repo of listClonedRepos(root, onCollision)) {
    const { value, kind } = score(hint, path.basename(repo.nsPath), remoteSlug(gitRemote(repo.abs)));
    if (value) scored.push({ value, kind, nsPath: repo.nsPath, personal: personal(repo.nsPath) });
  }
  const top = topScored(scored);
  if (!top.length) return { status: 'NOTFOUND' } as const;
  if (top.length === 1) return { status: 'RESOLVED', nsPath: top[0].nsPath, kind: top[0].kind } as const;
  return { status: 'AMBIGUOUS', candidates: top.map((s) => ({ nsPath: s.nsPath, kind: s.kind, personal: s.personal })) } as const;
}

export interface Candidate { nsPath: string; kind: string; personal?: boolean }

export function pickProjects(name: unknown, found: unknown[]): Candidate[] {
  const scored: Array<Candidate & { value: number }> = [];
  const seen = new Set<string>();
  for (const p of found) {
    if (!isRecord(p) || p.archived || typeof p.path !== 'string') continue;
    const nsPath = projectNamespace(p);
    if (!nsPath || seen.has(nsPath)) continue;
    const { value, kind } = score(name, p.path);
    if (!value) continue;
    seen.add(nsPath);
    scored.push({ value, kind, nsPath, personal: !isRecord(p.namespace) || p.namespace.kind !== 'group' });
  }
  const top = topScored(scored);
  const groupOwned = top.filter((s) => !s.personal);
  return (groupOwned.length ? groupOwned : top).map((s) => ({ nsPath: s.nsPath, kind: s.kind, personal: s.personal }));
}
