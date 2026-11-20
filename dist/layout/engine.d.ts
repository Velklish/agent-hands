import { type ServerEntry } from './stdio.js';
import { type ResourceOwner } from './content.js';
import { type LayoutAdapter, type Target } from './adapter.js';
import { type LayoutMcpPolicy, type LayoutDiagnostic } from './mcp-policy.js';
export interface LayoutFile {
    path: string;
    content: string | Uint8Array;
    executable?: boolean;
}
export type LayoutResource = {
    path: string;
    relativePath: string;
    owner: ResourceOwner;
};
export type LayoutNotice = {
    code: 'skipped-supporting-file';
    resource: LayoutResource;
    symbolic: boolean;
};
export declare class LayoutConflictError extends Error {
    readonly output: string;
    readonly first: string | undefined;
    readonly second: string;
    constructor(output: string, first: string | undefined, second: string);
}
export interface LayoutInput {
    root: string;
    target: Target;
    skills: readonly {
        name: string;
        dirAbs: string;
        source?: string;
    }[];
    sharedDirs?: readonly {
        srcAbs: string;
        source?: string;
    }[];
    subagents: readonly {
        name: string;
        description: string;
        prompt: string;
        model?: string;
        tools?: readonly string[];
        source?: string;
        file?: string;
    }[];
    servers: readonly ServerEntry[];
    rules: readonly string[];
    env?: Readonly<Record<string, string>>;
    scope?: 'all' | 'resources' | 'mcp';
    mcp?: LayoutMcpPolicy;
    supportingFiles?: 'strict' | 'skip-nonregular';
    writeTools?: Readonly<Record<string, {
        source: string;
        write: readonly string[];
    }>>;
}
declare const planBrand: unique symbol;
export interface LayoutPlan {
    readonly [planBrand]: true;
    root: string;
    files: readonly LayoutFile[];
    rules?: readonly string[];
    resources: readonly LayoutResource[];
    notices: readonly LayoutNotice[];
    diagnostics: readonly LayoutDiagnostic[];
    mcpFingerprints?: {
        path: string;
        current: Readonly<Record<string, string>>;
        legacy?: Readonly<Record<string, string>>;
    };
    requiredVars?: readonly string[];
    writeTools?: readonly {
        server: string;
        tool: string;
    }[];
}
export interface LayoutState {
    target?: Target;
    files: Record<string, string>;
    serverKeys?: Record<string, Record<string, string>>;
    createdMcp?: string[];
    agentResets?: string[];
}
export interface LayoutResult {
    state: LayoutState;
    written: string[];
    updated: string[];
    removed: string[];
    diagnostics: readonly LayoutDiagnostic[];
}
export interface LayoutChangeSet {
    readonly writes: readonly (LayoutFile & {
        secure: boolean;
    })[];
    readonly removes: readonly string[];
    readonly state: LayoutState;
    readonly diagnostics: readonly LayoutDiagnostic[];
    assertCurrent(): void;
}
export interface LayoutApplyOptions {
    stage?: (changes: LayoutChangeSet) => void | Promise<void>;
}
export declare function prepare(value: unknown, select: (target: unknown) => LayoutAdapter): LayoutPlan;
export declare function readLayoutState(value: unknown): LayoutState;
export declare function applyLayout(plan: LayoutPlan, previous?: LayoutState, options?: LayoutApplyOptions): Promise<LayoutResult>;
export {};
