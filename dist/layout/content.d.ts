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
type Stage = {
    copyDir(source: string, path: string, options?: {
        origin?: string | null;
    }): void;
    stage(path: string, content: string, options?: {
        origin?: string | null;
    }): void;
};
export declare function stageContent(writer: Stage, adapter: LayoutAdapter, content: SelectedContent): void;
export {};
