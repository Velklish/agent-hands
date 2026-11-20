export interface RegistrationRequest {
    readonly binarySha256: string;
    readonly version: string;
    readonly platform: string;
    readonly arch: string;
    readonly marketplace: string;
    readonly directory: string;
    readonly plugin: string;
    readonly step: 'add' | 'install' | 'update';
}
export declare function registrationPostcondition(request: RegistrationRequest, before: string): (after: string | null) => boolean;
export interface RegistrationSnapshot {
    readonly settings: string | null;
    readonly marketplaces: string | null;
    readonly installations: string | null;
}
export declare function registrationUnchanged(request: RegistrationRequest, before: RegistrationSnapshot, after: RegistrationSnapshot): boolean;
export declare function registrationPreflight(request: RegistrationRequest, project: string, before: RegistrationSnapshot): {
    marketplace: boolean;
    installed: boolean;
    version: unknown;
    installPath: unknown;
};
export declare function inspectRegistration(request: Pick<RegistrationRequest, 'marketplace' | 'plugin' | 'directory'>, project: string, before: RegistrationSnapshot): {
    marketplace: boolean;
    installed: boolean;
    version: unknown;
    installPath: unknown;
};
export declare function registrationEvidence(request: RegistrationRequest, project: string, version: string, before: RegistrationSnapshot, after: RegistrationSnapshot, exit: number | null, expectedPath?: string): boolean;
