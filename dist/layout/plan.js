import { createRequire } from 'node:module';
import { isTarget } from './adapter.js';
import { prepare } from './engine.js';
export { applyLayout, readLayoutState, LayoutConflictError } from './engine.js';
const load = createRequire(import.meta.url);
const adapters = {
    claude: () => load('./adapters/claude/index.js').adapter,
    cursor: () => load('./adapters/cursor/index.js').adapter,
    codex: () => load('./adapters/codex/index.js').adapter,
    opencode: () => load('./adapters/opencode/index.js').adapter,
};
export function parseLayout(value) {
    return prepare(value, target => {
        if (!isTarget(target))
            throw new TypeError('Unsupported layout target');
        return adapters[target]();
    });
}
export function planLayout(input) { return parseLayout(input); }
