import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isMap, LineCounter, parseDocument } from 'yaml';
export const SHARED_DIR = '_shared';
const describe = (kind, a, b) => ({
    delimiters: 'expected YAML frontmatter between --- lines', mapping: 'expected a YAML mapping with name and description',
    missing: `missing ${a}: expected a non-empty string`, empty: `${a}: expected a non-empty string`,
    name: `name "${a}" does not match directory "${b}"`,
}[kind]);
export function parseFrontmatter(text, { source = 'skill', file = 'SKILL.md', dirName, format = describe } = {}) {
    const m = text.match(/^---\r?\n([\s\S]*?\r?\n)---(?:\r?\n|$)/);
    const lines = new LineCounter();
    const reject = (reason, offset = 0) => {
        const { line, col } = m ? lines.linePos(offset) : { line: 0, col: 1 };
        throw new Error(`${source}: ${file}:${line + 1}:${col}: frontmatter: ${reason}`);
    };
    if (!m)
        return reject(format('delimiters'));
    const doc = parseDocument(m[1], { lineCounter: lines, prettyErrors: false, strict: true, uniqueKeys: true });
    const problem = doc.errors[0] ?? doc.warnings[0];
    if (problem)
        reject(problem.message, problem.pos[0]);
    if (!isMap(doc.contents))
        reject(format('mapping'));
    let raw;
    try {
        raw = doc.toJS();
    }
    catch (e) {
        reject(e.message);
    }
    const fm = raw;
    for (const key of ['name', 'description']) {
        const node = doc.get(key, true);
        if (!doc.has(key))
            reject(format('missing', key));
        if (typeof fm[key] !== 'string' || !fm[key].trim())
            reject(format('empty', key), node?.range?.[0] ?? 0);
    }
    if (dirName !== undefined && fm.name !== dirName) {
        reject(format('name', fm.name, dirName), doc.get('name', true).range?.[0] ?? 0);
    }
    return fm;
}
export function collectSkills(sources, { parse = parseFrontmatter } = {}) {
    const skills = [];
    const missingDeclared = [];
    const errors = [];
    for (const { dirAbs, source, ownerLabel, coords, relBase, include, exclude = [], overrides = [] } of sources) {
        if (!existsSync(dirAbs))
            continue;
        const taken = new Set();
        for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
            if (!entry.isDirectory() || (include && !include.includes(entry.name)) || exclude.includes(entry.name))
                continue;
            const skillDir = path.join(dirAbs, entry.name);
            const file = path.join(skillDir, 'SKILL.md');
            if (!existsSync(file))
                continue;
            try {
                const { name, description } = parse(readFileSync(file, 'utf8'), { source, file, dirName: entry.name });
                taken.add(name);
                skills.push({ name, description, source, ownerLabel, coords, dirAbs: skillDir,
                    mdRel: `${relBase}/${entry.name}/SKILL.md`, override: overrides.includes(name) });
            }
            catch (error) {
                errors.push(error.message);
            }
        }
        const missing = [...new Set([...(include ?? []), ...overrides])].filter(name => !taken.has(name));
        if (missing.length)
            missingDeclared.push({ source, names: missing });
    }
    const kept = new Map();
    const conflicts = [];
    for (const skill of skills.sort((a, b) => Number(b.override) - Number(a.override))) {
        const previous = kept.get(skill.name);
        if (!previous)
            kept.set(skill.name, skill);
        else if (previous.dirAbs !== skill.dirAbs)
            conflicts.push({ name: skill.name, kept: previous, skipped: skill });
    }
    return { skills: [...kept.values()], conflicts, missingDeclared, errors };
}
export function collectSharedDirs(sources) {
    return sources.flatMap(({ dirAbs, source }) => {
        const srcAbs = path.join(dirAbs, SHARED_DIR);
        return existsSync(srcAbs) ? [{ srcAbs, source }] : [];
    });
}
export function validateSkill(file, name, source) {
    if (!lstatSync(file).isFile())
        throw new Error(`${file}: expected a regular skill file`);
    parseFrontmatter(readFileSync(file, 'utf8'), { file, dirName: name, source });
}
export function renderSkillsIndex(skills) {
    const cell = (value) => value.replace(/\s*\n\s*/g, ' ').trim().replaceAll('|', '\\|');
    return ['# Skills', '', '| Skill | Source | Path | Description |', '|---|---|---|---|',
        ...[...skills].sort((a, b) => a.name.localeCompare(b.name)).map(s => `| ${cell(s.name)} | ${cell(s.source)} | \`${cell(s.mdRel)}\` | ${cell(s.description)} |`), ''].join('\n');
}
