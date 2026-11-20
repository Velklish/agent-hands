import { type LayoutInput } from './engine.js';
export { applyLayout, readLayoutState } from './engine.js';
export type { LayoutFile, LayoutInput, LayoutPlan, LayoutResult, LayoutState, LayoutResource, LayoutNotice } from './engine.js';
export declare function parseLayout(value: unknown): import("./engine.js").LayoutPlan;
export declare function planLayout(input: LayoutInput): import("./engine.js").LayoutPlan;
