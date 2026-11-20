import { type LayoutInput } from './engine.js';
export { applyLayout, readLayoutState, LayoutConflictError } from './engine.js';
export type { LayoutFile, LayoutInput, LayoutPlan, LayoutResult, LayoutState, LayoutResource, LayoutNotice, LayoutApplyOptions, LayoutChangeSet } from './engine.js';
export { LayoutMcpError } from './mcp-policy.js';
export type { LayoutMcpPolicy, LayoutDiagnostic } from './mcp-policy.js';
export type { LayoutRule } from './rule-files.js';
export declare function parseLayout(value: unknown): import("./engine.js").LayoutPlan;
export declare function planLayout(input: LayoutInput): import("./engine.js").LayoutPlan;
