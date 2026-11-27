import { isDeepStrictEqual } from 'node:util';

type Fields = Record<string, unknown>;
export interface RegistrationRequest {
  readonly platform: string;
  readonly marketplace: string;
  readonly directory: string;
  readonly plugin: string;
  readonly step: 'add' | 'install' | 'update';
}

const record = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value: Fields, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const name = (s: string) => /^[a-z0-9][a-z0-9-]*$/.test(s) && !Object.hasOwn(Object.prototype, s);
const id = (s: string) => s.split('@').length === 2 && s.split('@').every(name);
const dictionary = (value: unknown, accepts: (key: string, entry: unknown) => boolean) => record(value) && Object.entries(value).every(([k,v]) => accepts(k,v));
const source = (v: unknown) => record(v) && keys(v,['source']) && record(v.source) && keys(v.source,['source','path']) && v.source.source === 'directory' && typeof v.source.path === 'string' && v.source.path.startsWith('/');
const callback = (v: unknown, timeouts: readonly number[]) => record(v) && keys(v,['type','command','timeout']) && v.type === 'command' && typeof v.command === 'string' && v.command.length > 0 && (!Object.hasOwn(v,'timeout') || (typeof v.timeout === 'number' && timeouts.includes(v.timeout)));
const question = 'AskUserQuestion|AskQuestion|request_user_input';
const identifier = '[a-z][a-z0-9]*(?:_[a-z0-9]+)*';
const pairedTools = new RegExp(`^mcp__${identifier}__\\(${identifier}\\|${identifier}\\)$`);
const macMatchers: Record<string,readonly string[]> = {
  SessionStart:['startup|resume'], Stop:[], PreToolUse:[question,'Write'],
  PostToolUse:[question], PostToolUseFailure:[question],
};
const linuxKeys = ['hooks','env','enabledPlugins','extraKnownMarketplaces'];
const macKeys = Object.keys({ hooks:true,enableAllProjectMcpServers:true,skillOverrides:true,enabledPlugins:true,extraKnownMarketplaces:true });

function group(value: unknown, event: string, mac: boolean) {
  if (!record(value) || !keys(value,['matcher','hooks']) || !Array.isArray(value.hooks) || !value.hooks.every(row => callback(row,mac ? [4,30] : [4]))) return false;
  if (!mac) return event === 'PreToolUse' && value.matcher === 'Write';
  return Object.hasOwn(macMatchers,event) && (!Object.hasOwn(value,'matcher') || (typeof value.matcher === 'string' && (macMatchers[event].includes(value.matcher) ||
    (event === 'PostToolUse' && pairedTools.test(value.matcher)))));
}

function readSettings(text: string, {platform,step}: RegistrationRequest): Fields {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { throw new Error('Unsupported project settings'); }
  // Reject duplicate members and lossy numeric conversions before trusting parsed values.
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[^\s]/gs)?.join('');
  const registrationOnly = platform === 'darwin' && record(doc) && keys(doc,['enabledPlugins','extraKnownMarketplaces']);
  const projected = (platform === 'darwin' && !registrationOnly) || (platform === 'linux' && step === 'update' && record(doc) && Object.hasOwn(doc,'enableAllProjectMcpServers'));
  if (JSON.stringify(doc) !== tokens || !record(doc) || !keys(doc,registrationOnly ? ['enabledPlugins','extraKnownMarketplaces'] : projected ? macKeys : linuxKeys)
    || (projected && (!macKeys.every(k => Object.hasOwn(doc,k)) || doc.enableAllProjectMcpServers !== true || !dictionary(doc.skillOverrides,(k,v) => name(k) && v === 'off')))
    || ('hooks' in doc && !dictionary(doc.hooks,(k,v) => (projected ? Object.hasOwn(macMatchers,k) : k === 'PreToolUse') && Array.isArray(v) && v.every(row => group(row,k,projected))))
    || ('env' in doc && !dictionary(doc.env,(k,v) => /^[A-Z_][A-Z0-9_]*$/.test(k) && typeof v === 'string'))
    || ('enabledPlugins' in doc && !dictionary(doc.enabledPlugins,(k,v) => id(k) && typeof v === 'boolean'))
    || ('extraKnownMarketplaces' in doc && !dictionary(doc.extraKnownMarketplaces,(k,v) => name(k) && source(v)))) throw new Error('Unsupported project settings');
  return doc;
}

export function registrationPostcondition(request: RegistrationRequest, before: string): (after: string | null) => boolean {
  if (!name(request.marketplace) || !name(request.plugin) || !request.directory.startsWith('/') || !['add','install','update'].includes(request.step)) throw new Error('Unsupported registration request');
  const expected = readSettings(before,request);
  const known = expected.extraKnownMarketplaces as Fields | undefined;
  const desired = { source: { source: 'directory', path: request.directory } };
  if (known && Object.hasOwn(known,request.marketplace) && !isDeepStrictEqual(known[request.marketplace],desired)) throw new Error('Conflicting marketplace source');
  const enabled = expected.enabledPlugins as Fields | undefined;
  const subject = `${request.plugin}@${request.marketplace}`;
  if (enabled?.[subject] === false) throw new Error('Plugin disabled by project');
  if (request.step === 'add') expected.extraKnownMarketplaces = { ...known, [request.marketplace]: desired };
  if (request.step === 'install') expected.enabledPlugins = { ...enabled, [subject]: true };
  return after => {
    try {
      if (after === null) return false;
      const actual = readSettings(after,request);
      if (request.step === 'add' && !Object.hasOwn(expected,'enabledPlugins') && isDeepStrictEqual(actual.enabledPlugins,{})) delete actual.enabledPlugins;
      return isDeepStrictEqual(actual, expected);
    }
    catch { return false; }
  };
}

export interface RegistrationSnapshot {
  readonly settings: string | null;
  readonly marketplaces: string | null;
  readonly installations: string | null;
}

export function registrationUnchanged(request: RegistrationRequest, before: RegistrationSnapshot, after: RegistrationSnapshot) {
  if (before.marketplaces !== after.marketplaces || before.installations !== after.installations) return false;
  if (before.settings === after.settings) return true;
  if (before.settings === null || after.settings === null) return false;
  try {
    const expected = readSettings(before.settings,request);
    const current = readSettings(after.settings,request);
    if (!Object.hasOwn(expected,'enabledPlugins') && isDeepStrictEqual(current.enabledPlugins,{})) delete current.enabledPlugins;
    return isDeepStrictEqual(expected,current);
  }
  catch { return false; }
}

export function registrationPreflight(request: RegistrationRequest, project: string, before: RegistrationSnapshot) {
  registrationPostcondition(request,before.settings ?? '{}');
  return inspectRegistration(request,project,before);
}

export function inspectRegistration(request: Pick<RegistrationRequest,'marketplace'|'plugin'> & {directory?:string}, project: string, before: RegistrationSnapshot) {
  const markets = registry(before.marketplaces);
  const installs = registry(before.installations);
  if (before.installations !== null && (!keys(installs,['version','plugins']) || installs.version !== 2 || !record(installs.plugins))) throw new Error('Unsupported installation registry');
  const rows = (installs.plugins as Fields | undefined)?.[`${request.plugin}@${request.marketplace}`] ?? [];
  if (!Array.isArray(rows) || !rows.every(record)) throw new Error('Unsupported plugin rows');
  const matching = rows.filter(row => row.scope === 'project' && row.projectPath === project);
  if (matching.length > 1) throw new Error('Ambiguous project installation');
  const source = markets[request.marketplace];
  const directory = record(source) ? source.installLocation : undefined;
  if (source !== undefined && (!record(source) || typeof directory !== 'string' || !directory.startsWith('/') ||
      (request.directory !== undefined && directory !== request.directory) ||
      !isDeepStrictEqual(source.source,{source:'directory',path:directory}))) throw new Error('Conflicting registered marketplace');
  if (matching.length && source === undefined) throw new Error('Incomplete project registration');
  return { marketplace:source !== undefined, directory, installed:matching.length === 1, version:matching[0]?.version, installPath:matching[0]?.installPath };
}

function registry(raw: string | null): Fields {
  if (raw === null) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Unsupported plugin registry'); }
  if (!record(value) || JSON.stringify(value) !== raw.match(/"(?:\\.|[^"\\])*"|[^\s]/gs)?.join('')) throw new Error('Unsupported plugin registry');
  return value;
}

export function registrationEvidence(request: RegistrationRequest, project: string, version: string, before: RegistrationSnapshot, after: RegistrationSnapshot, exit: number | null, expectedPath?: string): boolean {
  if (exit !== 0 || !project.startsWith('/') || !version) return false;
  try {
    if (!registrationPostcondition(request,before.settings ?? '{}')(after.settings)) return false;
    const previousMarkets = registry(before.marketplaces);
    const markets = registry(after.marketplaces);
    const entry = markets[request.marketplace];
    if (!record(entry) || entry.installLocation !== request.directory || !isDeepStrictEqual(entry.source,{ source:'directory',path:request.directory })) return false;
    if (request.step === 'add') {
      if (Object.hasOwn(previousMarkets,request.marketplace)) return false;
      delete markets[request.marketplace];
      return isDeepStrictEqual(previousMarkets,markets) && before.installations === after.installations;
    }
    if (before.marketplaces !== after.marketplaces) return false;
    const readInstallations = (raw: string | null) => {
      if (raw === null) return {};
      const doc = registry(raw);
      if (!keys(doc,['version','plugins']) || doc.version !== 2 || !record(doc.plugins)) throw new Error('Unknown installation registry');
      return doc.plugins;
    };
    const previous = readInstallations(before.installations);
    const installed = readInstallations(after.installations);
    const subject = `${request.plugin}@${request.marketplace}`;
    const rows = installed[subject];
    const ours = (r: unknown) => record(r) && r.scope === 'project' && r.projectPath === project;
    if (!Array.isArray(rows)) return false;
    const selected = rows.filter(ours);
    if (selected.length !== 1 || selected[0].version !== version || typeof selected[0].installPath !== 'string' || !selected[0].installPath.startsWith('/') || (expectedPath !== undefined && selected[0].installPath !== expectedPath)) return false;
    const prior = Object.hasOwn(previous,subject) ? previous[subject] : [];
    if (!Array.isArray(prior)) return false;
    const previousProject = prior.filter(ours);
    if (request.step === 'update') {
      if (previousProject.length !== 1 || !record(previousProject[0]) || typeof previousProject[0].version !== 'string' || previousProject[0].version === version) return false;
    } else if (previousProject.length) return false;
    previous[subject] = prior.filter(r => !ours(r));
    installed[subject] = rows.filter(r => !ours(r));
    return isDeepStrictEqual(previous,installed);
  } catch { return false; }
}
