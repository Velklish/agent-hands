export declare const SHARED_DIR = "_shared";
export interface SkillSource {
    dirAbs: string;
    source: string;
    ownerLabel: string;
    coords: string;
    relBase: string;
    include?: string[] | null;
    exclude?: string[];
    overrides?: string[];
}
export interface Skill {
    name: string;
    description: string;
    source: string;
    ownerLabel: string;
    coords: string;
    dirAbs: string;
    mdRel: string;
    override: boolean;
}
export interface SkillConflict {
    name: string;
    kept: Skill;
    skipped: Skill;
}
type Problem = 'delimiters' | 'mapping' | 'missing' | 'empty' | 'name';
type FormatProblem = (kind: Problem, first?: string, second?: string) => string;
export declare function parseFrontmatter(text: string, { source, file, dirName, format }?: {
    source?: string;
    file?: string;
    dirName?: string;
    format?: FormatProblem;
}): Record<string, unknown> & {
    name: string;
    description: string;
};
export declare function collectSkills(sources: SkillSource[], { parse }?: {
    parse?: typeof parseFrontmatter;
}): {
    skills: Skill[];
    conflicts: SkillConflict[];
    missingDeclared: {
        source: string;
        names: string[];
    }[];
    errors: string[];
};
export declare function collectSharedDirs(sources: Pick<SkillSource, 'dirAbs' | 'source'>[]): {
    srcAbs: string;
    source: string;
}[];
export declare function validateSkill(file: string, name: string, source?: string): void;
export declare function renderSkillsIndex(skills: readonly Skill[]): string;
export {};
