export type WorkspaceHookStateLocation = 'default' | 'agents';
export interface WorkspaceHookStateScope {
  root: string;
  stateLocation?: WorkspaceHookStateLocation;
}
export interface WorkspaceHookDiagnostic {
  readonly code: 'preference-conflict';
  readonly target: 'claude';
  readonly field: 'enableProjectServers' | 'localMarketplaces' | 'enabledPlugins' | 'disabledSkills';
}
export interface WorkspacePreferences {
  enableProjectServers?: boolean;
  disabledSkills?: readonly string[];
  enabledPlugins?: Readonly<Record<string,boolean>>;
  localMarketplaces?: Readonly<Record<string,string>>;
}
export interface WorkspaceRegistration {
  marketplace: string;
  plugin: string;
  directory: string;
  expectedPhysicalDirectory?: string;
  version: string;
  fingerprint: string;
  executable: string;
  accountHome: string;
  legacy?: {fingerprint: string; version: string};
}
export interface WorkspaceRegistrationPlan {
  action: 'install' | 'update' | 'current';
  version: string;
  previousVersion?: string;
}
export interface WorkspaceRegistrationOutcome extends Omit<WorkspaceRegistrationPlan, 'action'> {
  status: 'installed' | 'updated' | 'current';
}
export interface WorkspaceRegistrationInspection extends WorkspaceHookStateScope {
  accountHome: string;
  marketplace: string;
  plugin: string;
  expectedVersion?: string;
  expectedFingerprint?: string;
}
export type WorkspaceRegistrationStatus =
  | { status:'missing' }
  | { status:'retained'; scope:'project'; version:string }
  | { status:'current'; scope:'project'; version:string; fingerprint:string }
  | { status:'stale'; scope?:'project'; version?:string; fingerprint?:string };
