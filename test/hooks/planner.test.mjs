import { isDeepStrictEqual as equal } from 'node:util';
import assert from 'node:assert/strict';
import { planHooks } from '../../dist/hooks/hook-plan.js';
export function hookCases(check) {
    const shell = { matcher: 'start', extra: 12 };
    const callback = { command: 'sample', timeout: 5, type: 'command' };
    const a = { owner: 'one', event: 'Start', shell, callback };
    const b = { ...a, owner: 'two', callback: { ...callback, command: 'second' } };
    const next = { ...a, callback: { ...callback, timeout: 6 } };
    const foreign = { command: 'other', data: [2] };
    const group = (hooks) => ({ ...shell, hooks });
    const doc = (hooks) => ({ keep: 1, hooks: { Start: [null, { hooks: [] }, group(hooks)], Other: 17 } });
    const run = (document, history, intents, target = 'claude') => planHooks({ target, documentJson: document === null ? null : JSON.stringify(document), historyJson: history === null ? null : JSON.stringify(history), intentsJson: JSON.stringify(intents) });
    const h = { kind: 'confirmed', entries: [a] };
    const conflict = (r, why) => !r.ok && r.reason === why;
    for (const target of ['claude', 'codex']) {
        const r = run(doc([foreign, callback, false]), h, [next, b], target);
        const expected = doc([foreign, next.callback, false]);
        expected.hooks.Start.push(group([b.callback]));
        check(`${target}: mixed group keeps foreign siblings, malformed data and order`, r.ok && equal(r.document, expected) && equal(r.next, [next, b]));
        const removed = run(doc([callback]), h, [], target);
        check(`${target}: removal keeps shell and empty groups`, removed.ok && removed.shifted && equal(removed.document, doc([])));
    }
    check('duplicate physical callback is ambiguous', conflict(run(doc([callback, callback]), h, [a]), 'ambiguous'));
    check('one slot cannot serve two owners', conflict(run(doc([callback]), { ...h, entries: [a, { ...a, owner: 'two' }] }, []), 'ambiguous'));
    check('changed timeout, event, shell, missing entry or file conflict', [doc([next.callback]), { hooks: { Other: [group([callback])] } }, { hooks: { Start: [{ hooks: [callback] }] } }, doc([]), null].every(d => conflict(run(d, h, [a]), 'missing')));
    check('new install refuses same command even with changed timeout', conflict(run(doc([next.callback]), null, [a]), 'collision'));
    check('indistinguishable desired entries conflict', conflict(run(null, null, [a, { ...next, owner: 'two' }]), 'collision'));
    check('history is not silently reset', ['legacy', 'unfinished', 'unknown'].every(kind => conflict(run(null, { kind }, [a]), kind === 'unknown' ? 'corrupt-history' : kind)));
    const flat = { ...a, shell: {} };
    const read = { ...flat, callback: { ...callback, matcher: 'Read' } };
    const exec = { ...flat, owner: 'two', callback: { ...callback, matcher: 'Shell' } };
    const fresh = run(null, null, [read, exec], 'cursor');
    check('fresh Cursor document carries version and distinct matchers', fresh.ok && equal(fresh.document, { version: 1, hooks: { Start: [read.callback, exec.callback] } }));
    const existing = { hooks: { Start: [read.callback] } };
    check('Cursor existing matcher discriminates collision independently of timeout', run(existing, null, [exec], 'cursor').ok && conflict(run(existing, null, [{ ...read, callback: { ...read.callback, timeout: 7 } }], 'cursor'), 'collision'));
    const raw = (documentJson, historyJson = null) => planHooks({ target: 'claude', documentJson, historyJson, intentsJson: '[]' });
    const prior = JSON.stringify(h).replace('"timeout":5', '"timeout":9007199254740992');
    const modified = JSON.stringify(doc([callback])).replace('"timeout":5', '"timeout":9007199254740993');
    check('raw rounded callback numbers cannot establish ownership', conflict(raw(modified, prior), 'corrupt-history') && conflict(raw(modified), 'invalid-document'));
    check('foreign numbers cannot lose precision in planned document', ['9007199254740993', '0.10000000000000001', '1e-400'].every(n => conflict(raw(`{"foreign":${n}}`), 'invalid-document')) && raw('{"foreign":0.1}').ok);
    const cursor = run({ version: 1, hooks: { Start: [false, callback, foreign] } }, { ...h, entries: [flat] }, [], 'cursor');
    check('flat removal preserves user fields and siblings', cursor.ok && equal(cursor.document, { version: 1, hooks: { Start: [false, foreign] } }));
    check('malformed touched event refuses addition', conflict(run({ hooks: { Start: false } }, null, [a]), 'invalid-document'));
    check('invalid intent or history entry refused', conflict(run(null, null, [{ ...a, typo: 1 }]), 'invalid-intents') && conflict(run(null, { ...h, entries: [42] }, []), 'corrupt-history'));
}
hookCases((name,ok) => assert.ok(ok,name));
