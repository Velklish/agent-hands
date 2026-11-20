import { isDeepStrictEqual as equal } from 'node:util';
import { format } from './format.js';
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
function parse(text) {
    if (typeof text !== 'string')
        throw new Error('Expected JSON text');
    return JSON.parse(text, (_key, value, context) => {
        if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)) || String(value) !== context?.source))
            throw new Error('Unsupported number');
        return value;
    });
}
function entries(x, native) {
    return Array.isArray(x) && x.every(e => object(e) && exact(e, ['owner', 'event', 'shell', 'callback']) && typeof e.owner === 'string' && e.owner.length && typeof e.event === 'string' && e.event.length && object(e.shell) && native.accepts(e.shell) && object(e.callback) && typeof e.callback.command === 'string' && e.callback.command.length);
}
function sameScope(a, b) {
    return a.event === b.event && equal(a.shell, b.shell);
}
export function planHooks(input) {
    return planHooksFromUnknown(input);
}
export function planHooksFromUnknown(input) {
    if (!object(input) || !exact(input, ['target', 'documentJson', 'historyJson', 'intentsJson']) || !Object.values(Object.getOwnPropertyDescriptors(input)).every(d => 'value' in d) || (input.target !== 'claude' && input.target !== 'cursor' && input.target !== 'codex'))
        return { ok: false, reason: 'invalid-input' };
    const native = format(input.target);
    let reason = 'corrupt-history';
    try {
        let previous = [];
        if (input.historyJson !== null) {
            const h = parse(input.historyJson);
            if (object(h) && exact(h, ['kind']) && (h.kind === 'unfinished' || h.kind === 'legacy'))
                return { ok: false, reason: h.kind };
            if (!object(h) || h.kind !== 'confirmed' || !exact(h, ['kind', 'entries']) || !entries(h.entries, native))
                return { ok: false, reason };
            previous = h.entries;
        }
        if (new Set(previous.map(e => e.owner)).size !== previous.length)
            return { ok: false, reason };
        reason = 'invalid-intents';
        const wanted = parse(input.intentsJson);
        if (!entries(wanted, native))
            return { ok: false, reason };
        reason = 'invalid-document';
        const doc = input.documentJson === null ? native.empty() : parse(input.documentJson);
        if (!object(doc) || (Object.hasOwn(doc, 'hooks') && !object(doc.hooks)))
            return { ok: false, reason };
        const hooks = object(doc.hooks) ? doc.hooks : {};
        const all = Object.entries(hooks).flatMap(([event, list], index) => Array.isArray(list) ? native.slots(event, index, list) : []);
        const owned = new Map();
        const actions = [];
        for (const [index, e] of previous.entries()) {
            const matches = all.filter(s => sameScope(s, e) && equal(s.value, e.callback));
            if (matches.length === 0)
                return { ok: false, reason: 'missing', index };
            if (matches.length !== 1 || owned.has(matches[0]))
                return { ok: false, reason: 'ambiguous', index };
            owned.set(matches[0], e.owner);
        }
        for (const [index, e] of wanted.entries()) {
            if (Object.hasOwn(hooks, e.event) && !Array.isArray(hooks[e.event]))
                return { ok: false, reason, index };
            const collides = (scope, value) => sameScope(e, scope) && object(value) && native.matches(value, e.callback);
            if (wanted.slice(0, index).some(p => p.owner === e.owner || collides(p, p.callback)) || all.some(s => owned.get(s) !== e.owner && collides(s, s.value)))
                return { ok: false, reason: 'collision', index };
        }
        const retained = new Set();
        const removals = [];
        for (const [slot, owner] of owned) {
            const index = wanted.findIndex(e => e.owner === owner);
            const desired = wanted[index];
            if (desired && sameScope(slot, desired)) {
                retained.add(owner);
                actions.push({ kind: equal(slot.value, desired.callback) ? 'keep' : 'replace', index, location: slot.location });
                slot.list[slot.location.callbackIndex] = desired.callback;
            }
            else {
                removals.push(slot);
                actions.push({ kind: 'remove', index: previous.findIndex(e => e.owner === owner), location: slot.location });
            }
        }
        for (const s of removals.sort((a, b) => b.location.callbackIndex - a.location.callbackIndex))
            s.list.splice(s.location.callbackIndex, 1);
        for (const [index, e] of wanted.entries()) {
            if (retained.has(e.owner))
                continue;
            if (!Object.hasOwn(hooks, e.event))
                Object.defineProperty(hooks, e.event, { value: [], enumerable: true, configurable: true, writable: true });
            native.append(hooks[e.event], e);
            actions.push({ kind: 'add', index });
        }
        if (wanted.length)
            doc.hooks = hooks;
        return { ok: true, document: input.documentJson === null && !wanted.length ? null : doc, next: wanted, actions, shifted: removals.length > 0 };
    }
    catch {
        return { ok: false, reason };
    }
}
