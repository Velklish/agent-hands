import {strict as assert} from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {parse} from 'acorn';
import {scratch,put,input} from './fixtures.mjs';
import {applyLayout,planLayout} from '../dist/layout/plan.js';
const targets=['claude','cursor','codex','opencode'];
function graph(root,target){const seen=new Set();function visit(file){if(seen.has(file))return;seen.add(file);const tree=parse(fs.readFileSync(file,'utf8'),{ecmaVersion:'latest',sourceType:'module'});function walk(n){if(!n||typeof n!=='object')return;const edge=n.source&&['ImportExpression','ImportDeclaration','ExportAllDeclaration','ExportNamedDeclaration'].includes(n.type)?n.source:n.type==='CallExpression'&&['load','require'].includes(n.callee?.name)?n.arguments[0]:null;if(edge){const spec=edge.value;assert.equal(typeof spec,'string','computed import');if(spec.startsWith('node:')||spec==='yaml')return;const dep=path.resolve(path.dirname(file),spec);assert.ok(spec.startsWith('.')&&dep.startsWith(root+path.sep),'outside runtime');if(target&&dep.startsWith(path.join(root,'adapters')+path.sep)) assert.ok(dep.startsWith(path.join(root,'adapters',target)+path.sep),'sibling import');visit(dep)}Object.values(n).forEach(walk)}walk(tree)}visit(path.join(root,target?`adapters/${target}/index.js`:'plan.js'));if(!target)visit(path.join(root,'artifacts.js'));}
test('emitted facade graph stays within runtime',()=>graph(path.resolve('dist/layout')));
for(const [i,target] of targets.entries())test(`${target}: facade applies with all sibling modules absent; foreign state cannot authorize writes`,async t=>{
 const dir=scratch(t),lib=path.join(dir,'layout'),root=path.join(dir,'workspace'),other=targets[(i+1)%targets.length];fs.mkdirSync(root);fs.cpSync('dist/layout',lib,{recursive:true,filter:f=>!targets.some(s=>s!==target&&f.endsWith(`/adapters/${s}`))});fs.symlinkSync(path.resolve('node_modules'),path.join(dir,'node_modules'),'dir');put(dir,'package.json','{"type":"module"}');graph(lib,target);
 const foreign=await applyLayout(planLayout(input(root,other,{subagents:[{name:'other',description:'Foreign',prompt:'keep'}]})));const [file]=Object.keys(foreign.state.files);const snapshot=()=>fs.readFileSync(path.join(root,file),'utf8');const before=snapshot();const verify=()=>assert.equal(snapshot(),before,'foreign output changed');
 const plan=input(root,target,{subagents:[{name:'own',description:'Own',prompt:'own'}]});put(dir,'apply.mjs',`import {planLayout,applyLayout} from './layout/plan.js';await applyLayout(planLayout(${JSON.stringify(plan)}));`);execFileSync(process.execPath,['apply.mjs'],{cwd:dir});verify();await assert.rejects(applyLayout(planLayout(input(root,target)),foreign.state),/Ownership belongs/);await assert.rejects(applyLayout(planLayout(input(root,target)),{files:foreign.state.files}),/Invalid ownership path/);verify();
 const entry=path.join(lib,'adapters',target,'index.js');fs.appendFileSync(entry,`\nimport '../${other}/index.js';`);assert.throws(()=>graph(lib,target),/sibling import/);
 fs.writeFileSync(path.join(root,file),'changed');assert.throws(verify,/foreign output changed/);
});
