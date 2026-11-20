import { createRequire } from 'node:module';
import type { LayoutAdapter, Target } from './adapter.js';
import { prepare, type LayoutInput } from './engine.js';
export { applyLayout, readLayoutState } from './engine.js';
export type { LayoutFile, LayoutInput, LayoutPlan, LayoutResult, LayoutState } from './engine.js';
const load = createRequire(import.meta.url);
const adapters = {
  claude: () => (load('./adapters/claude/index.js') as typeof import('./adapters/claude/index.js')).adapter,
  cursor: () => (load('./adapters/cursor/index.js') as typeof import('./adapters/cursor/index.js')).adapter,
  codex: () => (load('./adapters/codex/index.js') as typeof import('./adapters/codex/index.js')).adapter,
  opencode: () => (load('./adapters/opencode/index.js') as typeof import('./adapters/opencode/index.js')).adapter,
} satisfies Record<Target, () => LayoutAdapter>;
export function parseLayout(value: unknown) {
  return prepare(value, target => {
    if (typeof target !== 'string' || !Object.hasOwn(adapters, target)) throw new TypeError('Unsupported layout target');
    return adapters[target as Target]();
  });
}
export function planLayout(input: LayoutInput) { return parseLayout(input); }
