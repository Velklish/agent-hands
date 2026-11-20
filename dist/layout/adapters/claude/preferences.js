import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { snapshot } from '../../../hooks/hook-journal.js';
const dict = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = ['enableAllProjectMcpServers', 'extraKnownMarketplaces', 'enabledPlugins', 'skillOverrides'];
function fields(wanted) {
    const next = {};
    if (Object.keys(wanted).some(k => !['enableProjectServers', 'disabledSkills', 'enabledPlugins', 'localMarketplaces'].includes(k)))
        throw new TypeError('Unknown project preference');
    if (wanted.localMarketplaces !== undefined && !dict(wanted.localMarketplaces))
        throw new TypeError('Invalid local marketplaces');
    if (wanted.enabledPlugins !== undefined && !dict(wanted.enabledPlugins))
        throw new TypeError('Invalid plugin selection');
    if (wanted.disabledSkills !== undefined && (!Array.isArray(wanted.disabledSkills) || wanted.disabledSkills.some(s => typeof s !== 'string' || !s)))
        throw new TypeError('Invalid skill selection');
    if (wanted.enableProjectServers !== undefined) {
        if (typeof wanted.enableProjectServers !== 'boolean')
            throw new TypeError('Invalid project server selection');
        next.enableAllProjectMcpServers = wanted.enableProjectServers;
    }
    if (wanted.localMarketplaces)
        next.extraKnownMarketplaces = Object.fromEntries(Object.entries(wanted.localMarketplaces).map(([k, v]) => {
            if (!k || typeof v !== 'string' || !path.isAbsolute(v))
                throw new TypeError('Invalid local marketplace');
            return [k, { source: { source: 'directory', path: v } }];
        }));
    if (wanted.enabledPlugins) {
        if (Object.values(wanted.enabledPlugins).some(v => typeof v !== 'boolean'))
            throw new TypeError('Invalid plugin selection');
        next.enabledPlugins = wanted.enabledPlugins;
    }
    if (wanted.disabledSkills)
        next.skillOverrides = Object.fromEntries(wanted.disabledSkills.map(k => [k, 'off']));
    return next;
}
export function preferencePath(root) { return path.join(root, '.agent-hands/hooks/claude/preferences.json'); }
export function preferences(root, wanted, legacy) {
    const file = preferencePath(root), before = snapshot(file);
    const previous = before === null ? fields(legacy ?? {}) : JSON.parse(before);
    if (!dict(previous) || Object.keys(previous).some(k => !keys.includes(k)))
        throw new Error('Invalid preference ownership');
    const next = fields(wanted), owned = {};
    const projectDocument = (text) => {
        const doc = text === null ? {} : JSON.parse(text), old = structuredClone(doc);
        const apply = (values, prior, desired) => {
            const acquired = Object.create(null);
            for (const [k, v] of Object.entries(prior))
                if (Object.hasOwn(values, k) && isDeepStrictEqual(values[k], v))
                    delete values[k];
            for (const [k, v] of Object.entries(desired))
                if (!Object.hasOwn(values, k)) {
                    Object.defineProperty(values, k, { value: v, enumerable: true, writable: true, configurable: true });
                    acquired[k] = v;
                }
            return acquired;
        };
        const scalar = keys[0];
        Object.assign(owned, apply(doc, Object.hasOwn(previous, scalar) ? { [scalar]: previous[scalar] } : {}, Object.hasOwn(next, scalar) ? { [scalar]: next[scalar] } : {}));
        for (const key of keys.slice(1)) {
            if (!Object.hasOwn(previous, key) && !Object.hasOwn(next, key))
                continue;
            const existing = Object.hasOwn(doc, key) ? doc[key] : {};
            const prior = previous[key] ?? {}, desired = next[key] ?? {};
            if (!dict(existing) || !dict(prior) || !dict(desired))
                throw new Error('Unsupported project preference field');
            const value = { ...existing }, acquired = apply(value, prior, desired);
            if (Object.keys(value).length || Object.hasOwn(doc, key))
                doc[key] = value;
            if (Object.keys(acquired).length)
                owned[key] = acquired;
        }
        return isDeepStrictEqual(old, doc) ? text : JSON.stringify(doc, null, 2) + '\n';
    };
    return { projectDocument, change: () => ({ file, before, after: Object.keys(owned).length ? JSON.stringify(owned) : null }) };
}
