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
  version: string;
  fingerprint: string;
  executable: string;
  accountHome: string;
  legacy?: {fingerprint: string; version: string};
}
