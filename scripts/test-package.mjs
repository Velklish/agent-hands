import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const source = process.cwd(), temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'agent-hands-install-')));
const env = { ...process.env, npm_config_registry:'https://registry.npmjs.org', npm_config_cache:path.join(temp,'cache'), NODE_PATH:'', GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:os.devNull };
function run(cmd,args,cwd=source) { return execFileSync(cmd,args,{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(); }
const read = file => fs.readFileSync(file,'utf8');
const write = (file, text) => fs.writeFileSync(file,text);
const version = JSON.parse(read('package.json')).version;
const sha = run('git',['rev-parse','HEAD']);
const packed = process.env.PACK_DESTINATION || temp;
function smoke(spec,label) {
  const project = path.join(temp,label);
  fs.mkdirSync(project); write(path.join(project,'package.json'),'{"private":true,"type":"module"}');
  run('npm',['install','--omit=dev','--ignore-scripts','--no-audit','--no-fund',spec],project);
  const pkg = path.join(project,'node_modules','agent-hands');
  assert.equal(fs.lstatSync(pkg).isSymbolicLink(),false);
  assert.ok(!fs.existsSync(path.join(project,'node_modules/backslop')));
  if(label==='git') assert.ok(JSON.parse(read(path.join(project,'package-lock.json'))).packages['node_modules/agent-hands'].resolved.endsWith('#'+sha));
  const node=(...args)=>run(process.execPath,args,project);
  const cli=(...args)=>run(path.join(project,'node_modules/.bin/agent-hands'),args,project);
  const block=(file)=>read(path.join(pkg,file)).match(/```js\n([\s\S]+?)\n```/)[1];
  write(path.join(project,'example.mjs'),block('README.md')); node('example.mjs');
  for(const command of read(path.join(pkg,'README.md')).matchAll(/^npx --no-install agent-hands (.+)$/gm)) cli(...command[1].split(' '));
  const config=['--config','layout.json','--state','cursor-state.json'];
  assert.equal(JSON.parse(cli('apply',...config)).updated.length,0);
  const rule = path.join(project,'example-work/.agents/rules/cursor/0001.md');
  write(rule,'manual edit'); assert.throws(()=>cli('apply',...config)); assert.equal(read(rule),'manual edit');
  const root = path.join(project,'workspace'); fs.mkdirSync(root); write(path.join(project,'asset-example.mjs'),block('assets/README.md'));
  assert.equal(JSON.parse(node('asset-example.mjs',root)).target,'cursor');
  const repo = path.join(root,'repos/group/example'); run('git',['init','-q',repo]);write(path.join(project,'repos.json'),JSON.stringify({root}));
  assert.equal(cli('path','--config','repos.json','example'),repo);
  assert.equal(node('--input-type=module','-e',`import {createNavigation} from 'agent-hands';console.log((await createNavigation({root:${JSON.stringify(root)},routeHost:()=>undefined}).repoPath('example')).abs)`),repo);
  node('--input-type=module','-e',`import assert from 'node:assert/strict';for(const suffix of ['dist/index.js','dist/layout/adapters/cursor/index.js','src/index.ts','package.json']) await assert.rejects(import('agent-hands/'+suffix),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});`);
  run('python3',['-B',path.join(pkg,'profiles/my-voice/skills/my-voice-calibrate/scripts/collect.py'),'--help'],project);
  write(path.join(project,'consumer.mts'),`import {planLayout,applyLayout,type LayoutInput,type LayoutResult} from 'agent-hands';
const input: LayoutInput = {root:'/work',target:'cursor',rules:[],servers:[],subagents:[],skills:[]};
for(const target of ['cursor','codex'] as const){const result:Promise<LayoutResult>=applyLayout(planLayout({...input,target}));void result;}
// @ts-expect-error Unknown target must be rejected.
planLayout({...input,target:'unknown'});`);
  // Use an external compiler, resolving declarations only from the installed project.
  run(process.execPath,[path.join(source,'node_modules/typescript/bin/tsc'),'--ignoreConfig','--strict','--noEmit','--module','NodeNext','consumer.mts'],project);
  console.log(`${label}: CLI, root import, ownership refusal, declarations and installed examples passed`);
}
try {
  const [pack]=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',packed]));
  const files=pack.files.map(f=>f.path).sort();
  const expected=run('git',['ls-files','dist','bin','assets','profiles/my-voice/skills','profiles/my-voice/README.md','README.md','LICENSE','package.json','docs/reference/*.md']).split('\n').sort();
  assert.deepEqual(files,expected);
  const archive=path.join(packed,pack.filename); smoke(archive,'tarball');
  const mirror=path.join(temp,'mirror.git');run('git',['init','--bare','-q',mirror]);
  run('git',['--git-dir',mirror,'fetch','--no-tags',source,sha]);
  run('git',['--git-dir',mirror,'update-ref','refs/heads/main',sha]);
  run('git',['--git-dir',mirror,'symbolic-ref','HEAD','refs/heads/main']);
  const tag='v'+version;run('git',['--git-dir',mirror,'update-ref','refs/tags/'+tag,sha]);
  assert.equal(run('git',['--git-dir',mirror,'rev-parse','refs/tags/'+tag]),sha);
  smoke('git+'+pathToFileURL(mirror).href+'#'+tag,'git');
  console.log(`Local mirror only: ${tag} = ${sha}; ${pack.integrity}`);
  if(packed!==temp) console.log(archive);
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
