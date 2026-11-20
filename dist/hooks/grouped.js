export const grouped = {
    grouped: true,
    groupIndices(list, owned) {
        const remaining = [];
        for (let index = 0, current = 0; index < list.length; current++) {
            if (owned.has(current)) {
                const group = list[index];
                if (group && typeof group === 'object' && 'hooks' in group && Array.isArray(group.hooks) && !group.hooks.length) {
                    list.splice(index, 1);
                    continue;
                }
                remaining.push(index);
            }
            index++;
        }
        return remaining;
    },
    empty: () => ({}), accepts: shell => !Object.hasOwn(shell, 'hooks'),
    slots(event, eventIndex, groups) {
        return groups.flatMap((group, groupIndex) => {
            if (!group || typeof group !== 'object' || Array.isArray(group))
                return [];
            const { hooks: list, ...shell } = group;
            return Array.isArray(list) ? list.map((value, callbackIndex) => ({ event, shell, value, list, location: { eventIndex, groupIndex, callbackIndex } })) : [];
        });
    },
    matches: (a, b) => a.command === b.command,
    append: (list, e) => { list.push({ ...e.shell, hooks: [e.callback] }); },
    entry: (owner, event, command, matcher) => ({ owner, event, shell: matcher === undefined ? {} : { matcher }, callback: { type: 'command', command } }),
};
