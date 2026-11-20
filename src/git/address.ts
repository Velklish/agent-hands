import path from 'node:path';
import { EXTERNAL_ZONE, REPOS_ZONE, collidesWithZoneName, normalizeNs } from './layout.js';

const URL_PREFIX = /^(?:(?:https?|ssh):\/\/([^/]+)\/?|git@([^:]+):)/i;
export const isUrl = (target: unknown) => /^(https?:\/\/|ssh:\/\/|git@)/i.test(String(target));
export const isDiskPath = (target: unknown) => /^\.{1,2}([\\/]|$)/.test(String(target)) || path.isAbsolute(String(target));

export function urlAuthority(url: unknown) {
  const match = URL_PREFIX.exec(String(url));
  return (match?.[1] ?? match?.[2])?.replace(/^.*@/, '').toLowerCase() || null;
}
export const urlHost = (url: unknown) => urlAuthority(url)?.replace(/:\d+$/, '') ?? null;
export const barePath = (url: unknown) => String(url).replace(/\/+$/, '').replace(URL_PREFIX, '');

export function parseUrl(url: unknown) {
  const nsPath = barePath(url).replace(/\/-\/.*$/, '').replace(/\.git$/, '');
  const group = /^groups(?:\/(.*))?$/.exec(nsPath);
  return group ? { nsPath: group[1] ?? '', group: true } : { nsPath, group: false };
}
export const httpsRepoUrl = (host: string, namespace: unknown) => `https://${host}/${String(namespace).replace(/\.git$/, '')}.git`;

export type HostRoute = { zone: typeof REPOS_ZONE | typeof EXTERNAL_ZONE; gitlab?: boolean };
export type RouteHost = (authority: string) => HostRoute | undefined;

export class RouteError extends Error {
  constructor(readonly code: 'host' | 'empty' | 'owner' | 'unsafe' | 'reserved', readonly detail?: string) {
    super({ host: 'No route for repository host', empty: 'Repository URL has no path', owner: 'Specify a repository, not an owner or organization',
      unsafe: 'Repository URL does not map to a safe destination', reserved: 'Namespace conflicts with the external zone' }[code] + (detail ? `: ${detail}` : ''));
  }
}

export function routeUrl(root: string, url: string, routeHost: RouteHost) {
  const authority = urlAuthority(url);
  const route = authority && routeHost(authority);
  if (!route || (route.zone !== REPOS_ZONE && route.zone !== EXTERNAL_ZONE)) throw new RouteError('host', authority ?? undefined);
  const clean = url.replace(/\/+$/, '');
  const raw = barePath(clean);
  const parsed = route.gitlab ? parseUrl(clean) : { nsPath: raw.replace(/\.git$/, ''), group: false };
  if (!parsed.nsPath && route.zone !== EXTERNAL_ZONE) throw new RouteError('empty');
  const parts = parsed.nsPath.split('/').filter(Boolean);
  if (route.zone === EXTERNAL_ZONE && (parts.length < 2 || parsed.group)) throw new RouteError('owner');
  if (route.zone === REPOS_ZONE && collidesWithZoneName(parts)) throw new RouteError('reserved', parsed.nsPath);
  const nsPath = route.zone === EXTERNAL_ZONE ? `${EXTERNAL_ZONE}/${parts.at(-1)}` : parsed.nsPath;
  if (parts.some((part) => /^(?:\.|%2e){1,2}$/i.test(part) || /%(?:2f|5c|00)/i.test(part))
    || !normalizeNs(root, nsPath)) throw new RouteError('unsafe', parts.at(-1));
  const isProjectPage = route.gitlab && !parsed.group && raw.includes('/-/');
  const transport = isProjectPage ? clean.replace(/\/-\/.*$/, '').replace(/\.git$/, '') + '.git' : clean;
  return { nsPath, group: parsed.group, url: transport, authority };
}

export function sameRepositoryUrl(a: string, b: string, routeHost: RouteHost) {
  const host = urlAuthority(a);
  if (!host || host !== urlAuthority(b)) return false;
  const ns = (url: string) => routeHost(host)?.gitlab ? parseUrl(url).nsPath : barePath(url).replace(/\.git$/, '');
  return ns(a) === ns(b);
}
