/// <reference types="node" preserve="true" />
export { applyLayout, parseLayout, planLayout, readLayoutState, LayoutConflictError, LayoutMcpError } from './layout/plan.js';
export type { LayoutFile, LayoutInput, LayoutPlan, LayoutResult, LayoutState, LayoutResource, LayoutNotice, LayoutApplyOptions, LayoutChangeSet, LayoutMcpPolicy, LayoutDiagnostic, LayoutRule } from './layout/plan.js';
export { createNavigation, ensureWorkspaceDirs, runRepositoryCommand, NavigationError, OriginError } from './git/navigation.js';
export type { NavigationOptions, RepositoryResolution, CheckoutLocation, NavigationProblem } from './git/navigation.js';
export { isUrl, isDiskPath, urlHost, parseUrl, httpsRepoUrl, RouteError } from './git/address.js';
export type { RouteHost } from './git/address.js';
export { WORKSPACE_DIRS, ZONES, REPOS_ZONE, EXTERNAL_ZONE, SANDBOX_ZONE, zoneRoots, zoneRootAt,
  zoneOfNs, nsUnderZone, repoAbsPath, cloneOf, isCloneDir, listClonedRepos } from './git/layout.js';
export { pickProjects } from './git/fuzzy.js';
export type { Candidate } from './git/fuzzy.js';
export { freshenRepo, readDefaultBranch } from './git/fresh.js';
export type { FreshOptions, FreshResult, FreshWarning } from './git/fresh.js';
export { gitClone, gitCloneSha, repoHead, gitToplevel, gitLsRemoteTags, fetchRepositoryRef } from './git/process.js';
export type { GitAuth, RefFetchResult } from './git/process.js';
export { gitLabClient, GitLabError, projectNamespace } from './git/gitlab.js';
export { localStatus, countZone, offDefault, defaultUnknown, aheadUnknown } from './git/state.js';
export type { Contact, ZoneState, StatusIssue } from './git/state.js';
export { enterEntrypoint, entrypointArgv, parseRuntimeTarget, supportsNode } from './runtime.js';
export type { RuntimeTarget, EntrypointOptions } from './runtime.js';
export { bundledAssets } from './resources.js';
export { applyWorkspaceHooks, applyPreparedWorkspaceHooks, inspectWorkspaceHookOperation, inspectWorkspaceHookOwnership, planWorkspaceHooks, prepareWorkspaceHooks, recoverWorkspaceHooks } from './hooks/workspace.js';
export type { PendingWorkspaceHooks, PreparedWorkspaceHooks } from './hooks/workspace.js';
export type { WorkspacePreferences, WorkspaceRegistration } from './hooks/options.js';
export type { WorkspaceParticipant } from './hooks/hook-operation.js';
export { workspaceHookOutcome, type HookOutcome } from './hooks/outcome.js';
export type { WorkspaceHook, WorkspaceHookBatch, WorkspaceHookBatchScope, WorkspaceHookInput, WorkspaceHookResult, WorkspaceHookScope } from './hooks/workspace.js';
