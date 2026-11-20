import { parseFrontmatter } from '../dist/layout/skills.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyLayout, planLayout } from 'agent-hands';
import { input, put, scratch } from './fixtures.mjs';
const check = (label, condition, detail) => test(label, () => assert.ok(condition, detail));
const md = (yaml) => `---\n${yaml}\n---\n# Skill\n`;
const invalid = [
    ['colon-space', 'name: sample\ndescription: task: details', /Nested mappings/],
    ['unmatched-quote', 'name: sample\ndescription: "unfinished', /Missing closing.*quote/],
    ['duplicate-key', 'name: sample\ndescription: first\ndescription: second', /unique/],
    ['numeric-name', 'name: 42\ndescription: details', /name.*string/],
    ['boolean-description', 'name: sample\ndescription: true', /description.*string/],
    ['sequence-description', 'name: sample\ndescription: [details]', /description.*string/],
    ['mapping-description', 'name: sample\ndescription: {task: details}', /description.*string/],
    ['missing-name', 'description: details', /missing name/],
    ['missing-description', 'name: sample', /missing description/],
    ['blank-name', 'name: " "\ndescription: details', /name.*non-empty/],
    ['blank-description', 'name: sample\ndescription: >', /description.*non-empty/],
    ['dirname-mismatch', 'name: different\ndescription: details', /different.*sample/],
    ['unknown-tag', 'name: sample\ndescription: !custom details', /Unresolved tag/],
    ['non-map', '[sample, details]', /mapping/],
];
const valid = [
    ['quoted', 'name: sample\ndescription: "task: details"', 'task: details'],
    ['single-quoted', "name: sample\ndescription: 'writer''s task'", "writer's task"],
    ['folded', 'name: sample\ndescription: >-\n  first line\n  second line', 'first line second line'],
    ['literal', 'name: sample\ndescription: |\n  first line\n  second line', 'first line\nsecond line\n'],
    ['multiline', 'name: sample\ndescription: first line\n  second line', 'first line second line'],
    ['quoted-multiline', 'name: sample\ndescription: "first line\n  second line"', 'first line second line'],
    ['crlf', 'name: sample\r\ndescription: >-\r\n  first line\r\n  second line', 'first line second line'],
    ['extra-fields', 'name: sample\ndescription: details\nmetadata:\n  version: 2\nallowed-tools: [Read, Bash]', 'details'],
];
{
    for (const [name, yaml, reason] of invalid) {
        let error;
        try {
            parseFrontmatter(md(yaml), { source: 'fixture source', file: '/fixture/sample/SKILL.md', dirName: 'sample' });
        }
        catch (e) {
            error = e;
        }
        check(`frontmatter: rejects ${name} with source, file, location and reason`, !!error && /fixture source/.test(error.message) && /\/fixture\/sample\/SKILL.md:\d+:\d+/.test(error.message)
            && reason.test(error.message), error?.message ?? 'accepted invalid frontmatter');
    }
    for (const [name, yaml, description] of valid) {
        const parsed = parseFrontmatter(md(yaml), { dirName: 'sample' });
        check(`frontmatter: preserves ${name} semantics`, parsed.name === 'sample' && parsed.description === description, JSON.stringify(parsed));
        if (name === 'extra-fields')
            check('frontmatter: preserves additional fields', parsed.metadata?.version === 2 && parsed['allowed-tools']?.join() === 'Read,Bash', JSON.stringify(parsed));
    }
    for (const text of ['# no frontmatter\n', '---\nname: sample\ndescription: details\n', '---\nname: sample\ndescription: details\n---oops\n']) {
        let error;
        try {
            parseFrontmatter(text, { dirName: 'sample' });
        }
        catch (e) {
            error = e;
        }
        check('frontmatter: rejects absent or unterminated frontmatter', !!error, 'accepted invalid delimiters');
    }
}

test('all four targets preserve selected skill bytes and reject invalid updates before writing', async t => {
    const dir = scratch(t), root = path.join(dir, 'workspace'); fs.mkdirSync(root);
    const sources = ['first','second','third'].map((source,i) => {
        const name = `skill-${i}`;
        const dirAbs = path.join(dir, source, name);
        const bytes = md(`name: ${name}\ndescription: >-\n  task: first line\n  second line\nmetadata:\n  version: 2`);
        return { name, source, dirAbs, bytes, file: put(dirAbs,'SKILL.md',bytes) };
    });
    const files = [];
    for (const target of ['claude','cursor','codex','opencode']) {
        const options = input(root,target,{skills:sources.map(({bytes,file,...entry})=>entry)});
        const initial = await applyLayout(planLayout(options));
        assert.equal(initial.written.length,3);
        const repeated = await applyLayout(planLayout(options),initial.state);
        assert.deepEqual(repeated.state,initial.state);
        assert.deepEqual(repeated.updated,[]);
        for (const item of sources) {
            const destination = path.join(root,`.${target}/skills/${item.name}/SKILL.md`);
            assert.equal(fs.readFileSync(destination,'utf8'),item.bytes);
            files.push([destination,item.bytes]);
            for (const [label,yaml,reason] of invalid) {
                fs.writeFileSync(item.file,md(yaml.replaceAll('sample',item.name)));
                assert.throws(()=>planLayout(options),error=>error.message.startsWith(`${item.source}: ${item.file}:`) && /SKILL.md:\d+:\d+/.test(error.message) && (label==='dirname-mismatch'?/different/.test(error.message):reason.test(error.message)));
                for (const [file,bytes] of files) assert.equal(fs.readFileSync(file,'utf8'),bytes);
            }
            fs.writeFileSync(item.file,item.bytes);
        }
    }
});
