import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isMap, LineCounter, parseDocument } from 'yaml';

export const SHARED_DIR = '_shared';
export interface SkillSource { dirAbs: string; source: string; ownerLabel: string; coords: string; relBase: string;
  include?: string[] | null; exclude?: string[]; overrides?: string[] }
export interface Skill { name: string; description: string; source: string; ownerLabel: string; coords: string; dirAbs: string; mdRel: string; override: boolean }
export interface SkillConflict { name: string; kept: Skill; skipped: Skill }
type Problem = 'delimiters' | 'mapping' | 'missing' | 'empty' | 'name';
type FormatProblem = (kind: Problem, first?: string, second?: string) => string;
const describe: FormatProblem = (kind, a, b) => ({
  delimiters: 'expected YAML frontmatter between --- lines', mapping: 'expected a YAML mapping with name and description',
  missing: `missing ${a}: expected a non-empty string`, empty: `${a}: expected a non-empty string`,
  name: `name "${a}" does not match directory "${b}"`,
}[kind]);

export function parseFrontmatter(text: string, { source = 'skill', file = 'SKILL.md', dirName, format = describe }:
  { source?: string; file?: string; dirName?: string; format?: FormatProblem } = {}) {
  const m = text.match(/^---\r?\n([\s\S]*?\r?\n)---(?:\r?\n|$)/);
  const lines = new LineCounter();
  const reject = (reason: string, offset = 0): never => {
    const { line, col } = m ? lines.linePos(offset) : { line: 0, col: 1 };
    throw new Error(`${source}: ${file}:${line + 1}:${col}: frontmatter: ${reason}`);
  };
  if (!m) return reject(format('delimiters'));
  const doc = parseDocument(m[1], { lineCounter: lines, prettyErrors: false, strict: true, uniqueKeys: true });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) reject(problem.message, problem.pos[0]);
  if (!isMap(doc.contents)) reject(format('mapping'));
  let raw: unknown;
  try { raw = doc.toJS(); } catch (e) { reject((e as Error).message); }
  const fm = raw as Record<string, unknown>;
  for (const key of ['name', 'description']) {
    const node = doc.get(key, true) as { range?: number[] } | undefined;
    if (!doc.has(key)) reject(format('missing', key));
    if (typeof fm[key] !== 'string' || !fm[key].trim()) reject(format('empty', key), node?.range?.[0] ?? 0);
  }
  if (dirName !== undefined && fm.name !== dirName) {
    reject(format('name', fm.name as string, dirName), (doc.get('name', true) as { range?: number[] }).range?.[0] ?? 0);
  }
  return fm as Record<string, unknown> & { name: string; description: string };
}

export function collectSkills(sources: SkillSource[], { parse = parseFrontmatter }: { parse?: typeof parseFrontmatter } = {}) {
  const skills: Skill[] = [];
  const missingDeclared: { source: string; names: string[] }[] = [];
  const errors: string[] = [];
  for (const { dirAbs, source, ownerLabel, coords, relBase, include, exclude = [], overrides = [] } of sources) {
    if (!existsSync(dirAbs)) continue;
    const taken = new Set<string>();
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      if (!entry.isDirectory() || (include && !include.includes(entry.name)) || exclude.includes(entry.name)) continue;
      const skillDir = path.join(dirAbs, entry.name);
      const file = path.join(skillDir, 'SKILL.md');
      if (!existsSync(file)) continue;
      try {
        const { name, description } = parse(readFileSync(file, 'utf8'), { source, file, dirName: entry.name });
        taken.add(name);
        skills.push({ name, description, source, ownerLabel, coords, dirAbs: skillDir,
          mdRel: `${relBase}/${entry.name}/SKILL.md`, override: overrides.includes(name) });
      } catch (error) { errors.push((error as Error).message); }
    }
    const missing = [...new Set([...(include ?? []), ...overrides])].filter(name => !taken.has(name));
    if (missing.length) missingDeclared.push({ source, names: missing });
  }
  const kept = new Map<string, Skill>();
  const conflicts: SkillConflict[] = [];
  for (const skill of skills.sort((a, b) => Number(b.override) - Number(a.override))) {
    const previous = kept.get(skill.name);
    if (!previous) kept.set(skill.name, skill);
    else if (previous.dirAbs !== skill.dirAbs) conflicts.push({ name: skill.name, kept: previous, skipped: skill });
  }
  return { skills: [...kept.values()], conflicts, missingDeclared, errors };
}

export function collectSharedDirs(sources: Pick<SkillSource, 'dirAbs' | 'source'>[]) {
  return sources.flatMap(({ dirAbs, source }) => {
    const srcAbs = path.join(dirAbs, SHARED_DIR);
    return existsSync(srcAbs) ? [{ srcAbs, source }] : [];
  });
}

export function validateSkill(file: string, name: string, source?: string) {
  if (!lstatSync(file).isFile()) throw new Error(`${file}: expected a regular skill file`);
  parseFrontmatter(readFileSync(file, 'utf8'), { file, dirName: name, source });
}

export function renderSkillsIndex(skills: readonly Skill[]) {
  const cell = (value: string) => value.replace(/\s*\n\s*/g, ' ').trim().replaceAll('|', '\\|');
  return ['# Skills', '', '| Skill | Source | Path | Description |', '|---|---|---|---|',
    ...[...skills].sort((a, b) => a.name.localeCompare(b.name)).map(s =>
      `| ${cell(s.name)} | ${cell(s.source)} | \`${cell(s.mdRel)}\` | ${cell(s.description)} |`), ''].join('\n');
}
