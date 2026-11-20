import { readdirSync, statSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { GIT_LOCAL_TIMEOUT_MS, GIT_MAX_OUTPUT } from './process.js';
import { listClonedRepos, repoAbsPath } from './layout.js';
import { DEFAULT_BRANCH_FALLBACK, branchOfOriginRef } from './fresh.js';
const english = {
    timeout: (seconds) => `Git timed out after ${seconds} s`,
    notRoot: (dir) => `Not a Git repository root: ${dir}`,
    count: (why) => `Could not count commits ahead: ${why}`,
    missing: (ref) => `Ref not present locally: ${ref}`,
    unknown: (why, ref, other) => `Could not count commits ahead: ${why}; could not inspect ${ref}: ${other}`,
};
function describe(issue) {
    switch (issue.code) {
        case 'timeout': return english.timeout(issue.seconds);
        case 'git': return issue.detail;
        case 'not-root': return english.notRoot(issue.dir);
        case 'count': return english.count(describe(issue.cause));
        case 'missing-ref': return english.missing(issue.ref);
        case 'unknown-ref': return english.unknown(describe(issue.count), issue.ref, describe(issue.lookup));
    }
}
const CONCURRENCY = os.availableParallelism();
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
function parseCount(value) {
    const count = Number(value);
    return /^\d+$/.test(value) && Number.isSafeInteger(count) ? count : null;
}
function git(repoAbs, ...args) {
    return new Promise((resolve) => {
        execFile('git', ['-C', repoAbs, ...args], {
            encoding: 'utf8',
            maxBuffer: GIT_MAX_OUTPUT,
            timeout: GIT_LOCAL_TIMEOUT_MS,
            killSignal: 'SIGKILL',
        }, (err, stdout, stderr) => {
            const text = (stderr ?? '').trim();
            if (!err)
                return resolve({ ok: true, out: stdout.trim() });
            const issue = err.killed
                ? { code: 'timeout', seconds: Math.round(GIT_LOCAL_TIMEOUT_MS / 1000) }
                : { code: 'git', detail: text.split('\n').filter(Boolean).pop() || err.message };
            const code = !err.killed && typeof err.code === 'number' ? err.code : null;
            resolve({ ok: false, code, stderr: text, issue });
        });
    });
}
function mtimeMs(file) {
    try {
        return statSync(file).mtimeMs;
    }
    catch {
        return 0;
    }
}
function newestMtime(dir) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return 0;
    }
    let best = 0;
    for (const e of entries) {
        const p = path.join(dir, e.name);
        best = Math.max(best, e.isDirectory() ? newestMtime(p) : mtimeMs(p));
    }
    return best;
}
function lastContact(gitDir) {
    const fetched = mtimeMs(path.join(gitDir, 'FETCH_HEAD'));
    if (fetched)
        return { at: fetched, via: 'fetch' };
    const cloned = newestMtime(path.join(gitDir, 'logs', 'refs', 'remotes'));
    return cloned ? { at: cloned, via: 'clone' } : { at: null, via: null };
}
function parseStatus(status) {
    const res = {
        readable: status.ok,
        why: status.ok ? null : describe(status.issue),
        issue: status.ok ? null : status.issue,
        branch: null,
        detached: false,
        upstream: null,
        ahead: null,
        aheadWhy: null,
        aheadIssue: null,
        dirty: false,
    };
    if (!status.ok)
        return res;
    for (const line of status.out.split('\n')) {
        if (line.startsWith('# branch.head ')) {
            const head = line.slice('# branch.head '.length).trim();
            res.detached = head === '(detached)';
            res.branch = res.detached ? null : head;
        }
        else if (line.startsWith('# branch.upstream ')) {
            res.upstream = line.slice('# branch.upstream '.length).trim() || null;
        }
        else if (line.startsWith('# branch.ab ')) {
            const ahead = /^# branch\.ab \+(\d+) /.exec(line)?.[1];
            res.ahead = ahead === undefined ? null : parseCount(ahead);
        }
        else if (line && !line.startsWith('#')) {
            res.dirty = true;
        }
    }
    return res;
}
function samePath(a, b) {
    try {
        return realpathSync(a) === realpathSync(b);
    }
    catch {
        return false;
    }
}
export async function localStatus(dirAbs) {
    const top = await git(dirAbs, 'rev-parse', '--path-format=absolute', '--show-toplevel');
    if (!top.ok || !samePath(top.out, dirAbs)) {
        return { ...parseStatus({ ok: false, issue: { code: 'not-root', dir: dirAbs } }), subject: null };
    }
    const s = parseStatus(await git(dirAbs, '--no-optional-locks', 'status', '--porcelain=v2', '--branch'));
    if (!s.readable || !s.ahead)
        return { ...s, subject: null };
    const head = await git(dirAbs, 'log', '-1', '--format=%s');
    return { ...s, subject: head.ok ? head.out : null };
}
function commonGitDir(repoAbs) {
    const dotGit = path.join(repoAbs, '.git');
    try {
        if (statSync(dotGit).isDirectory())
            return Promise.resolve({ ok: true, out: dotGit });
    }
    catch { /* Worktrees store a pointer here, not a directory. */ }
    return git(repoAbs, 'rev-parse', '--path-format=absolute', '--git-common-dir');
}
async function whyNotCounted(repoAbs, ref, count) {
    const exists = await git(repoAbs, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    if (exists.ok)
        return { code: 'count', cause: count };
    if (exists.code === 1 && !exists.stderr)
        return { code: 'missing-ref', ref };
    return { code: 'unknown-ref', ref, count, lookup: exists.issue };
}
async function defaultOf(repoAbs, originHead) {
    if (originHead.ok)
        return branchOfOriginRef(originHead.out);
    const asked = await Promise.all(DEFAULT_BRANCH_FALLBACK.map((br) => git(repoAbs, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${br}`)));
    const i = asked.findIndex((r) => r.ok);
    return i === -1 ? null : DEFAULT_BRANCH_FALLBACK[i];
}
async function inspect(root, repo) {
    const abs = repoAbsPath(root, repo);
    const [originHead, status, gitDir] = await Promise.all([
        git(abs, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'),
        git(abs, '--no-optional-locks', 'status', '--porcelain=v2', '--branch'),
        commonGitDir(abs),
    ]);
    const def = await defaultOf(abs, originHead);
    const st = parseStatus(status);
    if (st.ahead === null && st.branch !== null) {
        const ref = st.upstream ?? `origin/${st.branch}`;
        const counted = await git(abs, 'rev-list', '--count', `${ref}..${st.branch}`);
        if (counted.ok) {
            st.ahead = parseCount(counted.out);
            if (st.ahead === null)
                st.aheadIssue = { code: 'count', cause: { code: 'git', detail: 'Git returned an invalid commit count' } };
        }
        else
            st.aheadIssue = await whyNotCounted(abs, ref, counted.issue);
        if (st.aheadIssue)
            st.aheadWhy = describe(st.aheadIssue);
    }
    return {
        repo,
        default: def,
        ...st,
        contact: lastContact(gitDir.ok ? gitDir.out : path.join(abs, '.git')),
    };
}
export async function scanZone(root, repos = listClonedRepos(root).map((r) => r.nsPath)) {
    const states = new Array(repos.length);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const i = next;
            next += 1;
            if (i >= repos.length)
                return;
            states[i] = await inspect(root, repos[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, repos.length) }, worker));
    return states.sort((a, b) => a.repo.localeCompare(b.repo));
}
export function offDefault(s) {
    return s.readable && (s.detached || (s.default !== null && s.branch !== s.default));
}
export function defaultUnknown(s) {
    return s.readable && !s.detached && s.default === null;
}
export function aheadUnknown(s) {
    return s.readable && s.branch !== null && s.ahead === null;
}
export function countZone(states, now = Date.now()) {
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
        if (!s.readable) {
            c.unreadable += 1;
            continue;
        }
        if (offDefault(s))
            c.offDefault += 1;
        if (defaultUnknown(s))
            c.defaultUnknown += 1;
        if (s.dirty)
            c.dirty += 1;
        if (s.ahead)
            c.ahead += 1;
        if (aheadUnknown(s))
            c.aheadUnknown += 1;
        if (s.contact.at === null)
            c.contactUnknown += 1;
        else if (now - s.contact.at > MONTH_MS)
            c.stale += 1;
        if (!offDefault(s) && !defaultUnknown(s) && !s.dirty && s.ahead === 0)
            c.clean += 1;
    }
    return c;
}
