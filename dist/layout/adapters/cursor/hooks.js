import { isDeepStrictEqual } from 'node:util';
export const hooks = {
    grouped: false, groupIndices: () => [],
    path: '.cursor/hooks.json', empty: () => ({ version: 1 }), accepts: shell => !Object.keys(shell).length,
    slots: (event, eventIndex, list) => list.map((value, callbackIndex) => ({ event, shell: {}, value, list, location: { eventIndex, groupIndex: null, callbackIndex } })),
    matches: (a, b) => a.command === b.command && isDeepStrictEqual(a.matcher, b.matcher),
    append: (list, e) => { list.push(e.callback); },
    entry: (owner, event, command, matcher) => ({ owner, event, shell: {}, callback: matcher === undefined ? { command } : { command, matcher } }),
};
