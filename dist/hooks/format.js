import { createRequire } from 'node:module';
const load = createRequire(import.meta.url);
const formats = {
    claude: () => load('../layout/adapters/claude/hooks.js').hooks,
    codex: () => load('../layout/adapters/codex/hooks.js').hooks,
    cursor: () => load('../layout/adapters/cursor/hooks.js').hooks,
};
export function format(target) {
    return formats[target]();
}
