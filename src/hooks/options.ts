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
