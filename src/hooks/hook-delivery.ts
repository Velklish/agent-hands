import { planHooks, type HookEntry, type HookPlan, type HookTarget } from './hook-plan.js';
import { snapshot, type TargetChange } from './hook-journal.js';
import { commitHookOperation, type OperationScope } from './hook-operation.js';
import { sha256 } from '../layout/fs.js';
import { format } from './format.js';

export interface ManagedHooks {
  readonly target: HookTarget;
  readonly document: string;
  readonly state: string;
  readonly intents: readonly HookEntry[];
  readonly release?: readonly string[];
  readonly restore?: readonly string[];
  readonly expectedState?: string | null;
  readonly reconcile?: boolean;
  readonly legacy?: { readonly document: string; readonly entries: readonly HookEntry[] };
  readonly projectDocument?: (text: string | null, original: string | null) => string | null;
}
interface Receipt {
  version: 2;
  target: HookTarget;
  createdDocument: boolean;
  released: string[];
  entries: HookEntry[];
  structure: Structure;
}
interface Structure { digest: string | null; hookKey: boolean; events: string[]; groups: [string,number][] }
const emptyStructure = (): Structure => ({ digest:null,hookKey:false,events:[],groups:[] });
const object = (value: unknown): value is Record<string,unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function validStructure(s: unknown): s is Structure {
  return object(s) && Object.keys(s).length === 4 && (s.digest === null || (typeof s.digest === 'string' && /^[a-f0-9]{64}$/.test(s.digest))) && typeof s.hookKey === 'boolean'
    && Array.isArray(s.events) && s.events.every(key => typeof key === 'string') && new Set(s.events).size === s.events.length
    && Array.isArray(s.groups) && s.groups.every(g => Array.isArray(g) && g.length === 2 && typeof g[0] === 'string' && Number.isSafeInteger(g[1]) && g[1] >= 0);
}
function receipt(spec: ManagedHooks, raw: string | null, document: string | null): Receipt {
  if (raw === null) return { version:2,target:spec.target,createdDocument:false,released:[],entries:[],structure:emptyStructure() };
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new Error('Corrupt hook ownership'); }
  if (!object(v) || Object.keys(v).length !== 6 || v.version !== 2 || v.target !== spec.target || typeof v.createdDocument !== 'boolean' || !Array.isArray(v.released) || !v.released.every(x => typeof x === 'string') || new Set(v.released).size !== v.released.length || !Array.isArray(v.entries) || !validStructure(v.structure)) throw new Error('Corrupt hook ownership');
  const validate = planHooks({ target:spec.target,documentJson:null,historyJson:null,intentsJson:JSON.stringify(v.entries) });
  if (!validate.ok || validate.next.some(e => v.released instanceof Array && v.released.includes(e.owner))) throw new Error('Corrupt hook ownership');
  return { version:2,target:spec.target,createdDocument:v.createdDocument,released:v.released,entries:validate.next,structure:v.structure };
}

function reconcileStructure(spec: ManagedHooks, previous: Structure, before: Record<string,unknown> | null, plan: Extract<HookPlan,{ok:true}>) {
  const document = plan.document;
  const original = before && object(before.hooks) ? before.hooks : {};
  const hooks = document && object(document.hooks) ? document.hooks : null;
  if (!hooks) return emptyStructure();
  const events = new Set(previous.events);
  const groups = new Map(previous.groups.map(([event,index]) => [JSON.stringify([event,index]),[event,index] as [string,number]]));
  const count = new Map<string,number>();
  for (const action of plan.actions) if (action.kind === 'add') {
    const { event } = plan.next[action.index];
    if (!Object.hasOwn(original,event)) events.add(event);
    if (format(spec.target).grouped) {
      const old = original[event];
      const index = (Array.isArray(old) ? old.length : 0) + (count.get(event) ?? 0);
      count.set(event,(count.get(event) ?? 0) + 1);
      groups.set(JSON.stringify([event,index]),[event,index]);
    }
  }
  const next: Structure = { digest:null,hookKey:previous.hookKey || !Object.hasOwn(before ?? {},'hooks'),events:[],groups:[] };
  for (const [event,list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    const owned = new Set([...groups.values()].filter(([name]) => name === event).map(([,i]) => i));
    for (const index of format(spec.target).groupIndices(list,owned)) next.groups.push([event,index]);
    if (events.has(event)) {
      if (!list.length) delete hooks[event];
      else next.events.push(event);
    }
  }
  if (document && next.hookKey && !Object.keys(hooks).length) { delete document.hooks; next.hookKey = false; }
  return next;
}

export function confirmedHookIntents(spec: Pick<ManagedHooks,'target'|'document'|'state'>) {
  return receipt({ ...spec,intents:[] },snapshot(spec.state),snapshot(spec.document)).entries;
}
export function inspectHookOwnership(spec: Pick<ManagedHooks,'target'|'document'|'state'>) {
  const before = snapshot(spec.state);
  if (before === null) return null;
  const evidence = receipt({ ...spec,intents:[] },before,snapshot(spec.document));
  const checked = prepareHookDocument({ ...spec,intents:evidence.entries,expectedState:before });
  return {owners:evidence.entries.map(entry => entry.owner),released:checked.released};
}

export function prepareHookDocument(spec: ManagedHooks): { changes: TargetChange[]; shifted: boolean; released: readonly string[] } {
  const document = snapshot(spec.document);
  const state = snapshot(spec.state);
  if (spec.expectedState !== undefined && state !== spec.expectedState) throw new Error('Hook ownership changed during preflight');
  let input: Record<string,unknown> | null = null;
  if (document !== null) {
    let canonical: string | undefined;
    try {
      const value: unknown = JSON.parse(document);
      if (!object(value)) throw new Error();
      input = value;
      canonical = JSON.stringify(value);
    } catch { throw new Error('Invalid hook document'); }
    if (canonical !== document.match(/"(?:\\.|[^"\\])*"|[^\s]/gs)?.join('')) throw new Error('Unsupported hook document encoding');
  }
  const previous = receipt(spec,state,document);
  if (state === null && spec.legacy) {
    if (document !== spec.legacy.document) throw new Error('Legacy hook snapshot changed');
    previous.entries = [...spec.legacy.entries];
  }
  const released = new Set(previous.released);
  const disconnected = new Set<string>();
  for (const owner of spec.restore ?? []) {
    const entry = previous.entries.find(e => e.owner === owner);
    if ((!entry && !released.has(owner) && state !== null && !spec.reconcile) || !spec.intents.some(e => e.owner === owner) || spec.release?.includes(owner)) throw new Error('Invalid restoration selection');
    if (entry) {
      const located = planHooks({ target:spec.target,documentJson:document,historyJson:JSON.stringify({ kind:'confirmed',entries:[entry] }),intentsJson:'[]' });
      if (!located.ok && located.reason !== 'missing') throw new Error(`Hook restoration refused: ${located.reason}`);
      if (!located.ok) disconnected.add(owner);
    } else if (released.has(owner)) {
      const desired = spec.intents.find(e => e.owner === owner)!;
      const located = planHooks({target:spec.target,documentJson:document,historyJson:JSON.stringify({kind:'confirmed',entries:[desired]}),intentsJson:'[]'});
      if (!located.ok && located.reason !== 'missing') throw new Error(`Hook restoration refused: ${located.reason}`);
      if (located.ok) previous.entries.push(desired);
    }
    released.delete(owner);
  }
  for (const owner of spec.release ?? []) {
    if (!previous.entries.some(e => e.owner === owner) && !released.has(owner) && !((state === null || spec.reconcile) && spec.intents.some(e => e.owner === owner))) throw new Error('Unknown hook owner');
    released.add(owner);
  }
  const keep = (e: HookEntry) => !released.has(e.owner);
  const plan = planHooks({ target:spec.target,documentJson:document,historyJson:JSON.stringify({ kind:'confirmed',entries:previous.entries.filter(e => keep(e) && !disconnected.has(e.owner)) }),intentsJson:JSON.stringify(spec.intents.filter(keep)) });
  if (!plan.ok) throw new Error(`Hook plan refused: ${plan.reason}`);
  const trusted = document !== null && previous.structure.digest === sha256(document);
  const structure = reconcileStructure(spec,trusted ? previous.structure : emptyStructure(),input,plan);
  const planned = plan.actions.every(a => a.kind === 'keep') ? document : JSON.stringify(plan.document,null,2) + '\n';
  let after = spec.projectDocument ? spec.projectDocument(planned,document) : planned;
  let createdDocument = after !== null && (document === null || (trusted && previous.createdDocument));
  const empty = ['{}',JSON.stringify(format(spec.target).empty())];
  if (createdDocument && !plan.next.length && !released.size && empty.includes(JSON.stringify(JSON.parse(after!)))) {
    after = null;
    createdDocument = false;
  }
  structure.digest = after === null ? null : sha256(after);
  const next: Receipt = { ...previous,createdDocument,structure,released:[...released],entries:plan.next };
  return { changes:[{ file:spec.document,before:document,after },{ file:spec.state,before:state,after:state === null && !next.entries.length && !next.released.length && !createdDocument ? null : JSON.stringify(next) }], shifted:plan.shifted,released:next.released };
}

export function deliverHooks(scope: Omit<OperationScope,'targets'>, documents: readonly ManagedHooks[], warnShift: () => void) {
  const plans = documents.map(prepareHookDocument);
  const changes = plans.flatMap(p => p.changes);
  if (plans.some(p => p.shifted)) warnShift();
  commitHookOperation({ ...scope,targets:changes.map(c => c.file) },changes);
}
