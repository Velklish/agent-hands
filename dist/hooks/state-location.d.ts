import type { WorkspaceHookStateScope } from './options.js';
export declare function physicalDirectory(root: string, directory: string): boolean;
export declare function hookStatePaths({ root, stateLocation }: WorkspaceHookStateScope): {
    base: string;
    local: string;
    alternate: string;
    checkLocation: () => void;
};
export declare function hookStateScope(local: string): {
    directory: string;
    pointers: string[];
};
