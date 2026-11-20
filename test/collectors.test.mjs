import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {scratch,put} from './fixtures.mjs';
import {collectSkills, collectSharedDirs,renderSkillsIndex} from '../dist/layout/skills.js';
import {collectServers,sameServerConfig} from '../dist/layout/mcp.js';
import {collectSubagents,yamlValue} from '../dist/layout/subagents.js';
import {parse} from 'yaml';
const entry = (root,name) => ({dirAbs:path.join(root,name),source:name,ownerLabel:name,coords:name,relBase:name});
const skill = (root,source,name,description) => put(root,`${source}/${name}/SKILL.md`,`---\nname: ${name}\ndescription: ${description}\n---\nBody\n`);
test('collector preserves folded, chomped, literal and plain descriptions and reports empty blocks', t => {
  const root=scratch(t), source=entry(root,'catalog');
  for (const [name,block] of Object.entries({folded:'>\n  First line\n  next line',chomped:'>-\n  First line\n  next line',literal:'|\n  First line\n  next line',plain:'One line',empty:'>'})) skill(root,'catalog',name,block);
  const {skills,errors}=collectSkills([source]);
  assert.deepEqual(Object.fromEntries(skills.map(s=>[s.name,s.description])), {folded:'First line next line\n',chomped:'First line next line',literal:'First line\nnext line\n',plain:'One line'});
  assert.equal(errors.length,1);assert.match(errors[0],/empty\/SKILL.md.*description.*non-empty/);
  const rows=renderSkillsIndex(skills).split('\n').filter(line=>line.startsWith('| ')&&!line.startsWith('| Skill |'));
  assert.equal(rows.length,4); assert.ok(rows.includes('| literal | catalog | `catalog/literal/SKILL.md` | First line next line |'));
  const onlyBroken=collectSkills([{...source,include:['empty']}]);
  assert.deepEqual(onlyBroken.skills,[]);
  assert.match(onlyBroken.errors[0],/^catalog: .*empty\/SKILL.md.*description.*non-empty/);
});
test('YAML agent scalars preserve punctuation, implicit strings, and line endings', () => {
  for (const value of ['A "quote"', '"leading', '', 'space ', 'null', '0x1', 'true', 'first\nsecond ', 'first\nsecond\n', 'first\r\nsecond']) {
    assert.equal(parse(`value: ${yamlValue(value)}\n`).value,value);
  }
  assert.equal(yamlValue('A "quote"'),'A "quote"');
});
test('ordered sources, overrides, selection before parsing, missing declarations and shared materials',t=>{
  const root=scratch(t);const [first,next]=['first','next'].map(name=>entry(root,name));
  for(const source of [first,next]) skill(root,source.source,'sample','Description');
  skill(root,'first','broken','>');put(root,'first/_shared/ref.md','ref');
  assert.deepEqual(collectSharedDirs([first,next]),[{srcAbs:path.join(first.dirAbs,'_shared'),source:'first'}]);
  for(const selection of [{include:['sample','missing']},{exclude:['broken']}]) {
    const result=collectSkills([{...first,...selection},next]);assert.deepEqual(result.errors,[]);assert.deepEqual(result.skills.map(s=>s.source),['first']);assert.equal(result.conflicts[0].skipped.source,'next');
    if(selection.include)assert.deepEqual(result.missingDeclared,[{source:'first',names:['missing']}]);
  }
  assert.equal(collectSkills([first,first]).conflicts.length,0);
  assert.equal(collectSkills([first,{...next,overrides:['sample']}]).skills[0].source,'next');
});
test('server map comparison, soft failures and source attribution',t=>{
  const root=scratch(t);const docs=['{"one":{"command":"node","env":{"B":"2","A":"1"}}}', '{','{"one":{"env":{"A":"1","B":"2"},"command":"node"},"two":{"command":"other"}}','{"one":{"command":"changed"}}','[]'];
  const errors=[];const result=collectServers(docs.map((s,i)=>({file:put(root,`${i}.json`,s),label:`source ${i}`,provenance:`${i}`})),{reject:m=>errors.push(m)});
  assert.equal(errors.length,3);assert.match(errors[0],/1.json/);assert.match(errors[1],/source 2.*source 3/);assert.match(errors[2],/4.json/);assert.equal(result.servers.one.command,'node');assert.equal(result.servers.two.command,'other');assert.equal(result.serverOwner.one,'2');
  assert.equal(sameServerConfig({a:['a','b']},{a:['b','a']}),false);assert.equal(sameServerConfig({a:1},{}),false);
});
test('canonical agent collection requires fields, rejects invalid lines and duplicate sources',t=>{
  const root=scratch(t),sources=['one','two'].map(s=>entry(root,s));const yaml='name: sample\ndescription: |\n  first\n  next\ntools: [read, grep]\nprompt: Try it\n';
  put(root,'one/sample.yaml',yaml);assert.equal(collectSubagents(sources)[0].description,'first\nnext\n');
  for(const [body,error] of [[yaml,/one.*two/],['name: broken',/description/],['invalid line',/invalid/i]]){put(root,'two/example.yml',body);assert.throws(()=>collectSubagents(sources),error)}
});
