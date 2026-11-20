import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { sha256 } from '../../fs.js';
import { snapshot, type TargetChange } from '../../../hooks/hook-journal.js';
import type { WorkspaceHookDiagnostic, WorkspacePreferences } from '../../../hooks/options.js';
type Dict = Record<string,unknown>;
const dict = (v:unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);
const preferenceFields = {
  enableAllProjectMcpServers:'enableProjectServers',
  extraKnownMarketplaces:'localMarketplaces',
  enabledPlugins:'enabledPlugins',
  skillOverrides:'disabledSkills',
} as const;
const keys = Object.keys(preferenceFields) as (keyof typeof preferenceFields)[];
function fields(wanted:WorkspacePreferences) {
  const next: Dict = {};
  if (Object.keys(wanted).some(k => !['enableProjectServers','disabledSkills','enabledPlugins','localMarketplaces'].includes(k))) throw new TypeError('Unknown project preference');
  if (wanted.localMarketplaces !== undefined && !dict(wanted.localMarketplaces)) throw new TypeError('Invalid local marketplaces');
  if (wanted.enabledPlugins !== undefined && !dict(wanted.enabledPlugins)) throw new TypeError('Invalid plugin selection');
  if (wanted.disabledSkills !== undefined && (!Array.isArray(wanted.disabledSkills) || wanted.disabledSkills.some(s => typeof s !== 'string' || !s))) throw new TypeError('Invalid skill selection');
  if (wanted.enableProjectServers !== undefined) {
    if (typeof wanted.enableProjectServers !== 'boolean') throw new TypeError('Invalid project server selection');
    next.enableAllProjectMcpServers = wanted.enableProjectServers;
  }
  if (wanted.localMarketplaces) next.extraKnownMarketplaces = Object.fromEntries(Object.entries(wanted.localMarketplaces).map(([k,v]) => {
    if (!k || typeof v !== 'string' || !path.isAbsolute(v)) throw new TypeError('Invalid local marketplace');
    return [k,{source:{source:'directory',path:v}}];
  }));
  if (wanted.enabledPlugins) {
    if (Object.values(wanted.enabledPlugins).some(v => typeof v !== 'boolean')) throw new TypeError('Invalid plugin selection');
    next.enabledPlugins = wanted.enabledPlugins;
  }
  if (wanted.disabledSkills) next.skillOverrides = Object.fromEntries(wanted.disabledSkills.map(k => [k,'off']));
  return next;
}
export function preferencePath(root:string) { return path.join(root,'.agent-hands/hooks/claude/preferences.json'); }
export function preferences(root:string,wanted:WorkspacePreferences,legacy?:WorkspacePreferences) {
  const file = preferencePath(root), before = snapshot(file);
  let saved:unknown;
  if (before === null) saved = fields(legacy ?? {});
  else {
    try { saved = JSON.parse(before); }
    catch { throw new Error('Invalid preference ownership'); }
  }
  const receipt = dict(saved) && Object.hasOwn(saved,'version') ? saved : null;
  if (receipt && (receipt.version !== 2 || Object.keys(receipt).length !== 4 || typeof receipt.digest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.digest) || !Array.isArray(receipt.containers) || receipt.containers.some(k => !keys.slice(1).includes(k)) || new Set(receipt.containers).size !== receipt.containers.length)) throw new Error('Invalid preference structure ownership');
  const previous: unknown = receipt ? receipt.fields : saved;
  if (!dict(previous) || Object.keys(previous).some(k => !Object.hasOwn(preferenceFields,k))) throw new Error('Invalid preference ownership');
  const next = fields(wanted), owned:Dict = {};
  const containers:string[] = [];
  const diagnostics: WorkspaceHookDiagnostic[] = [];
  let digest: string|null = null;
  const projectDocument = (text: string|null, original:string|null) => {
    const generated = new Set<string>(receipt && original !== null && sha256(original) === receipt.digest ? receipt.containers as string[] : []);
    const doc = text === null ? {} : JSON.parse(text), old = structuredClone(doc);
    const apply = (key: keyof typeof preferenceFields,values:Dict,prior:Dict,desired:Dict) => {
      const acquired: Dict = Object.create(null);
      let conflict = false;
      for (const [k,v] of Object.entries(prior)) if (Object.hasOwn(values,k) && isDeepStrictEqual(values[k],v)) delete values[k];
      for (const [k,v] of Object.entries(desired)) {
        if (Object.hasOwn(values,k)) {
          if (!isDeepStrictEqual(values[k],v)) conflict = true;
          continue;
        }
        Object.defineProperty(values,k,{value:v,enumerable:true,writable:true,configurable:true}); acquired[k]=v;
      }
      if (conflict) diagnostics.push({code:'preference-conflict',target:'claude',field:preferenceFields[key]});
      return acquired;
    };
    const scalar = keys[0];
    Object.assign(owned,apply(scalar,doc,Object.hasOwn(previous,scalar)?{[scalar]:previous[scalar]}:{},Object.hasOwn(next,scalar)?{[scalar]:next[scalar]}:{}));
    for (const key of keys.slice(1)) {
      if (!Object.hasOwn(previous,key) && !Object.hasOwn(next,key)) continue;
      const present = Object.hasOwn(doc,key);
      const existing = present ? doc[key] : {};
      const prior = previous[key] ?? {}, desired = next[key] ?? {};
      if (!dict(existing) || !dict(prior) || !dict(desired)) throw new Error('Unsupported project preference field');
      const value = {...existing}, acquired = apply(key,value,prior,desired);
      if (Object.keys(value).length) {
        doc[key] = value;
        if (Object.keys(acquired).length && (!present || generated.has(key))) containers.push(key);
      } else if (generated.has(key)) delete doc[key];
      else if (present) doc[key] = value;
      if (Object.keys(acquired).length) owned[key]=acquired;
    }
    const projected = isDeepStrictEqual(old,doc) ? text : JSON.stringify(doc,null,2)+'\n';
    digest = projected === null ? null : sha256(projected);
    return projected;
  };
  return {projectDocument,diagnostics,change:():TargetChange => ({file,before,after:Object.keys(owned).length ? JSON.stringify({version:2,fields:owned,containers,digest}) : null})};
}
