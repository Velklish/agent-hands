interface Status {
    readable: boolean;
    why: string | null;
    branch: string | null;
    detached: boolean;
    upstream: string | null;
    ahead: number | null;
    aheadWhy: string | null;
    dirty: boolean;
}
export interface Contact {
    at: number | null;
    via: string | null;
}
export interface ZoneState extends Status {
    repo: string;
    default: string | null;
    contact: Contact;
}
export declare function localStatus(dirAbs: string, labels?: {
    timeout: (seconds: number) => string;
    notRoot: (dir: string) => string;
    count: (why: string | null) => string;
    missing: (ref: string) => string;
    unknown: (why: string | null, ref: string, other: string | null) => string;
}): Promise<{
    subject: string | null;
    readable: boolean;
    why: string | null;
    branch: string | null;
    detached: boolean;
    upstream: string | null;
    ahead: number | null;
    aheadWhy: string | null;
    dirty: boolean;
}>;
export declare function scanZone(root: string, repos?: string[], labels?: {
    timeout: (seconds: number) => string;
    notRoot: (dir: string) => string;
    count: (why: string | null) => string;
    missing: (ref: string) => string;
    unknown: (why: string | null, ref: string, other: string | null) => string;
}): Promise<ZoneState[]>;
export declare function offDefault(s: ZoneState): boolean;
export declare function defaultUnknown(s: ZoneState): boolean;
export declare function aheadUnknown(s: ZoneState): boolean;
export declare function countZone(states: ZoneState[], now?: number): {
    total: number;
    offDefault: number;
    defaultUnknown: number;
    dirty: number;
    ahead: number;
    aheadUnknown: number;
    stale: number;
    contactUnknown: number;
    unreadable: number;
    clean: number;
};
export {};
