import type { Target } from './adapter.js';
export interface LayoutMcpPolicy {
    mode?: 'merge' | 'replace';
    placeholders?: 'native' | 'literal';
    compatibility?: 'strict' | 'report';
    unowned?: 'refuse' | 'preserve' | 'adopt-identical';
    removeEmpty?: 'created' | 'owned-keys' | 'keep';
    emitEmpty?: boolean;
    resetInheritedAgents?: boolean;
    comments?: readonly string[];
    transportReference?: string;
}
export type LayoutDiagnostic = {
    code: 'unsupported-fields' | 'unsupported-transport' | 'unresolved-placeholder' | 'invalid-timeout' | 'foreign-server' | 'transport-conflict';
    target: Target;
    path: string;
    server: string;
    field?: string;
    keys?: readonly string[];
    reason?: string;
};
export declare class LayoutMcpError extends TypeError {
    readonly diagnostic: LayoutDiagnostic;
    constructor(message: string, diagnostic: LayoutDiagnostic);
}
export declare function readMcpPolicy(value: unknown): LayoutMcpPolicy;
