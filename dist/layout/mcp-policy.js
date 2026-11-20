import { fields, stringList } from './stdio.js';
export class LayoutMcpError extends TypeError {
    diagnostic;
    constructor(message, diagnostic) {
        super(message);
        this.diagnostic = diagnostic;
    }
}
export function readMcpPolicy(value) {
    if (value === undefined)
        return {};
    const raw = fields(value, 'MCP policy', ['mode', 'placeholders', 'compatibility', 'unowned', 'removeEmpty', 'emitEmpty', 'resetInheritedAgents', 'comments', 'transportReference']);
    const choice = (field, choices) => {
        const value = raw[field];
        if (value === undefined)
            return undefined;
        const selected = choices.find(candidate => candidate === value);
        if (!selected)
            throw new TypeError(`Invalid MCP policy: ${field}`);
        return selected;
    };
    const flag = (field) => {
        const value = raw[field];
        if (value !== undefined && typeof value !== 'boolean')
            throw new TypeError(`Invalid MCP policy: ${field}`);
        return value;
    };
    const comments = raw.comments === undefined ? undefined : stringList(raw.comments, 'Expected an array of MCP comment lines');
    if (comments?.some(line => /[\x00-\x1f\x7f]/.test(line)))
        throw new TypeError('Expected single-line MCP comments');
    if (raw.transportReference !== undefined && typeof raw.transportReference !== 'string')
        throw new TypeError('Invalid MCP policy: transportReference');
    return {
        mode: choice('mode', ['merge', 'replace']), placeholders: choice('placeholders', ['native', 'literal']),
        compatibility: choice('compatibility', ['strict', 'report']), unowned: choice('unowned', ['refuse', 'preserve', 'adopt-identical']),
        removeEmpty: choice('removeEmpty', ['created', 'owned-keys', 'keep']), emitEmpty: flag('emitEmpty'), resetInheritedAgents: flag('resetInheritedAgents'),
        comments, transportReference: raw.transportReference,
    };
}
