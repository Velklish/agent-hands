import type { AgentDefinition } from './subagents.js';
import type { LayoutAdapter } from './adapter.js';
export type SelectedContent = {
    skills: readonly {
        name: string;
        dirAbs: string;
        source?: string;
    }[];
    sharedDirs: readonly {
        srcAbs: string;
        source?: string;
    }[];
    subagents: readonly AgentDefinition[];
};
export type ResourceOwner = {
    kind: 'skill';
    name: string;
} | {
    kind: 'support';
    sourceIndex: number;
} | {
    kind: 'subagent';
    name: string;
};
type Stage = {
    copyDir(source: string, path: string, resource: ResourceOwner, origin?: string): void;
    stage(path: string, content: string, resource: ResourceOwner): void;
};
export declare function stageContent(writer: Stage, adapter: LayoutAdapter, content: SelectedContent): void;
export {};
