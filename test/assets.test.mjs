import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {brokenLinks,relativeLinks} from '../dist/layout/markdown.js';
import {parseFrontmatter} from '../dist/layout/skills.js';
import {scratch,put} from './fixtures.mjs';
const files = dir=>fs.readdirSync(dir,{recursive:true}).map(f=>path.join(dir,f)).filter(f=>fs.statSync(f).isFile());
function inspect(root){const shipped=new Set(files(root));for(const f of shipped){const bytes=fs.readFileSync(f,'utf8');assert.doesNotMatch(bytes,/\p{Script=Cyrillic}/u);assert.deepEqual(brokenLinks(f,shipped),[],f);if(path.basename(f)==='SKILL.md') parseFrontmatter(bytes,{dirName:path.basename(path.dirname(f))})}}
test('portable English instructions: all links remain in the copied distribution',t=>{const dir=scratch(t),root=path.join(dir,'assets');fs.cpSync('assets',root,{recursive:true});inspect(root);put(dir,'outside.md','Exists');put(root,'rules/escape.md','[outside](../../outside.md)');assert.throws(()=>inspect(root),/escape.md/);fs.unlinkSync(path.join(root,'rules/escape.md'));put(root,'bad.md','\u0422\u0435\u0441\u0442');assert.throws(()=>inspect(root),/Cyrillic/)});
test('links: nested paths, titles, references, anchors, lists, fences, inline code',t=>{
 const dir=scratch(t),f=put(dir,'nested/doc.md', [
 '[plain](../ok.md) [title](missing.md "title") [angle](<../has space.md>) [bad](<not here.md> "title")',
 '[external](https://example.test) [anchor](#title) [mail](mailto:a@example.test)', '',
 '  ````js','[x](ignored)','```','[x](still-ignored)','  ````','[after](resumed)',
 '    ```','[four](visible)','', '`[code](ignored)` [live](adjacent) `unmatched [live](unmatched)',
 'paragraph','[not]: ignored','','[yes]: ../ok.md','[no]: missing.md',
 ].join('\n'));const ok=put(dir,'ok.md','ok'),space=put(dir,'has space.md','ok');assert.deepEqual(relativeLinks(f),['../ok.md','missing.md','../has space.md','not here.md','resumed','visible','adjacent','unmatched','../ok.md','missing.md']);assert.deepEqual(brokenLinks(f,new Set([ok,space,f])),['missing.md','not here.md','resumed','visible','adjacent','unmatched','missing.md']);
});
test('archive contains working README example, ordered rules and discoverable skill metadata',t=>{
 const dir=scratch(t);const [{filename}]=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',dir],{encoding:'utf8'}));execFileSync('tar',['-xzf',path.join(dir,filename),'-C',dir]);const pkg=path.join(dir,'package');assert.ok(fs.existsSync(path.join(pkg,'README.md')));inspect(path.join(pkg,'assets'));
 fs.symlinkSync(path.resolve('node_modules'),path.join(pkg,'node_modules'),'dir');const read=f=>fs.readFileSync(f,'utf8');const example=read(path.join(pkg,'assets/README.md')).match(/```js\n([\s\S]*?)\n```/)[1];put(pkg,'example.mjs',example);const root=path.join(dir,'work');fs.mkdirSync(root);const state=JSON.parse(execFileSync(process.execPath,['example.mjs',root],{cwd:pkg}));assert.equal(state.target,'cursor');for(const [i,name] of ['AGENTS.md','workspace.md'].entries())assert.equal(read(path.join(root,`.agents/rules/000${i+1}.md`)),read(path.join(pkg,'assets/rules',name)));assert.equal(parseFrontmatter(read(path.join(root,'.cursor/skills/asking-questions/SKILL.md'))).name,'asking-questions');
});
