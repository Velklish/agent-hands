/// <reference types="node" preserve="true" />
export { applyLayout, parseLayout, planLayout, readLayoutState } from './layout/plan.js';
export type { LayoutFile, LayoutInput, LayoutPlan, LayoutResult, LayoutState } from './layout/plan.js';
export { createNavigation, ensureWorkspaceDirs, runRepositoryCommand, NavigationError } from './git/navigation.js';
export type { NavigationOptions } from './git/navigation.js';
export { gitLabClient, GitLabError } from './git/gitlab.js';
export { enterEntrypoint, entrypointArgv, parseRuntimeTarget, supportsNode } from './runtime.js';
export type { RuntimeTarget, EntrypointOptions } from './runtime.js';
export { bundledAssets } from './resources.js';
export { applyWorkspaceHooks, applyPreparedWorkspaceHooks, inspectWorkspaceHookOperation, planWorkspaceHooks, prepareWorkspaceHooks, recoverWorkspaceHooks } from './hooks/workspace.js';
export type { PendingWorkspaceHooks, PreparedWorkspaceHooks } from './hooks/workspace.js';
export type { WorkspacePreferences, WorkspaceRegistration } from './hooks/options.js';
export type { WorkspaceParticipant } from './hooks/hook-operation.js';
export { workspaceHookOutcome, type HookOutcome } from './hooks/outcome.js';
export type { WorkspaceHook, WorkspaceHookBatch, WorkspaceHookBatchScope, WorkspaceHookInput, WorkspaceHookResult, WorkspaceHookScope } from './hooks/workspace.js';
