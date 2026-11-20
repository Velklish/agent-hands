const API_TIMEOUT_MS = 20_000;
export const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
export function projectNamespace(value) {
    if (!isRecord(value) || typeof value.path_with_namespace !== 'string')
        return null;
    const parts = value.path_with_namespace.split('/');
    return parts.length >= 2 && parts.every((part) => /^[\p{L}\p{N}_.-]+$/u.test(part) && part !== '.' && part !== '..')
        && !/\.git$/i.test(value.path_with_namespace)
        ? value.path_with_namespace : null;
}
export class GitLabError extends Error {
    problem;
    constructor(message, problem) {
        super(message);
        this.problem = problem;
    }
    get status() { return this.problem.code === 'http' ? this.problem.status : undefined; }
}
export function gitLabClient(host, { token, timeoutMs = API_TIMEOUT_MS, request = fetch } = {}) {
    const origin = URL.parse(`https://${host}`);
    if (!origin || origin.host !== host.toLowerCase().replace(/:443$/, '') || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
        throw new GitLabError('Expected a GitLab host, without a scheme or path', { code: 'host' });
    }
    const base = `${origin.origin}/api/v4/`;
    async function api(pathname, { soft = false } = {}) {
        const url = URL.parse(pathname, base);
        if (!url?.href.startsWith(base))
            throw new GitLabError('GitLab API path leaves /api/v4/', { code: 'path' });
        const headers = token ? { 'PRIVATE-TOKEN': token } : {};
        let response;
        try {
            response = await request(url.href, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
        }
        catch (e) {
            if (soft)
                return null;
            const timeout = e instanceof Error && e.name === 'TimeoutError';
            const causeCode = e instanceof Error && isRecord(e.cause) ? e.cause.code : undefined;
            const detail = typeof causeCode === 'string' ? causeCode : e instanceof Error ? e.message : String(e);
            throw new GitLabError(`Could not reach ${host}: ${timeout ? `timed out after ${timeoutMs / 1000} s` : detail}`, { code: 'network', timeout, detail });
        }
        if (!response.ok) {
            if (soft)
                return null;
            throw new GitLabError(`GitLab API ${response.status}: ${url.href}`, { code: 'http', status: response.status });
        }
        try {
            const json = await response.json();
            return { json, headers: response.headers };
        }
        catch {
            if (soft)
                return null;
            throw new GitLabError(`Invalid JSON from GitLab: ${url.href}`, { code: 'json' });
        }
    }
    async function apiPaged(pathname, { soft = false } = {}) {
        const all = [];
        let page = 1;
        for (;;) {
            const response = await api(`${pathname}${pathname.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { soft });
            if (!response)
                return null;
            if (!Array.isArray(response.json)) {
                if (soft)
                    return null;
                throw new GitLabError('Expected an array from a paginated GitLab endpoint', { code: 'page-items' });
            }
            for (const item of response.json)
                all.push(item);
            const next = response.headers.get('x-next-page');
            if (!next)
                return all;
            if (!/^\d+$/.test(next) || !Number.isSafeInteger(Number(next)) || Number(next) <= page) {
                if (soft)
                    return null;
                throw new GitLabError(`Invalid GitLab next page: ${next}`, { code: 'next-page' });
            }
            page = Number(next);
        }
    }
    return { api, apiPaged };
}
