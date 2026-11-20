type CommandIssue = {
    code: 'timeout';
    seconds: number;
} | {
    code: 'git';
    detail: string;
};
export type StatusIssue = CommandIssue | {
    code: 'not-root';
    dir: string;
} | {
    code: 'count';
    cause: CommandIssue;
} | {
    code: 'missing-ref';
    ref: string;
} | {
    code: 'unknown-ref';
    ref: string;
    count: CommandIssue;
    lookup: CommandIssue;
};
interface Status {
    readable: boolean;
    why: string | null;
    issue: StatusIssue | null;
    branch: string | null;
    detached: boolean;
    upstream: string | null;
    ahead: number | null;
    aheadWhy: string | null;
    aheadIssue: StatusIssue | null;
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
export declare function localStatus(dirAbs: string): Promise<{
    subject: string | null;
    readable: boolean;
    why: string | null;
    issue: StatusIssue | null;
    branch: string | null;
    detached: boolean;
    upstream: string | null;
    ahead: number | null;
    aheadWhy: string | null;
    aheadIssue: StatusIssue | null;
    dirty: boolean;
}>;
export declare function scanZone(root: string, repos?: readonly string[]): Promise<ZoneState[]>;
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
