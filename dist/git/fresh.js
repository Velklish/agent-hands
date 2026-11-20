import { gitRun, gitOutput, gitError, timedOut, GIT_NET_TIMEOUT_MS } from './process.js';
const issue = (run, auth, timeoutMs) => timedOut(run) ? { timeoutMs } : { detail: gitError(run, auth, false) };
export const DEFAULT_BRANCH_FALLBACK = ['master', 'main'];
export function branchOfOriginRef(ref) {
    return ref.replace(/^refs\/remotes\/origin\//, '');
}
export function defaultBranch(repoAbs, run = (...args) => gitRun(['-C', repoAbs, ...args])) {
    const head = gitOutput(run('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'));
    if (head)
        return branchOfOriginRef(head);
    for (const br of DEFAULT_BRANCH_FALLBACK) {
        if (run('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${br}`).status === 0)
            return br;
    }
    return null;
}
function count(run, range) {
    const n = gitOutput(run('rev-list', '--count', range));
    return n !== null && /^\d+$/.test(n) && Number.isSafeInteger(Number(n)) ? Number(n) : null;
}
export function readDefaultBranch(repoAbs) { return defaultBranch(repoAbs); }
export function freshenRepo(repoAbs, { timeoutMs = GIT_NET_TIMEOUT_MS, observeOnly = false, deadline, auth } = {}) {
    const run = (args, credentials) => {
        const remaining = deadline === undefined ? timeoutMs : Math.min(timeoutMs, deadline - Date.now());
        if (remaining <= 0)
            return { status: null, stdout: '', stderr: '', pid: 0, output: ['', '', ''], signal: null,
                error: Object.assign(new Error('overall deadline exceeded'), { code: 'ETIMEDOUT' }) };
        return gitRun(['-C', repoAbs, ...args], { auth: credentials, timeoutMs: remaining });
    };
    const local = (...args) => run(args);
    const res = {
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
    if (observeOnly || !fetchOk || !res.behind)
        return res;
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
