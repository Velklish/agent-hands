import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  const {packages} = JSON.parse(read(path.join(project,'package-lock.json')));
  for (const name of Object.keys(JSON.parse(read(path.join(pkg,'package.json'))).devDependencies))
    assert.ok(!packages['node_modules/' + name], `Unexpected development dependency: ${name}`);
  if(label==='git') assert.ok(packages['node_modules/agent-hands'].resolved.endsWith('#'+sha));
  const node=(...args)=>run(process.execPath,args,project);
  const cli=(...args)=>run(path.join(project,'node_modules/.bin/agent-hands'),args,project);
  const block=(file)=>read(path.join(pkg,file)).match(/```js\n([\s\S]+?)\n```/)[1];
  write(path.join(project,'example.mjs'),block('README.md')); node('example.mjs');
  for(const command of read(path.join(pkg,'README.md')).matchAll(/^(node node_modules\/agent-hands\/.+|npx --no-install agent-hands .+)$/gm)) {
    const args = command[1].split(' ');
    if (args[0] === 'node') node(...args.slice(1));
    else cli(...args.slice(3));
  }
  const config=['--config','layout.json','--state','cursor-state.json'];
  assert.equal(JSON.parse(cli('apply',...config)).updated.length,0);
  const rule = path.join(project,'example-work/.agents/rules/cursor/0001.md');
  write(rule,'manual edit'); assert.throws(()=>cli('apply',...config)); assert.equal(read(rule),'manual edit');
  const root = path.join(project,'workspace'); fs.mkdirSync(root); write(path.join(project,'asset-example.mjs'),block('assets/README.md'));
  assert.equal(JSON.parse(node('asset-example.mjs',root)).target,'cursor');
  const repo = path.join(root,'repos/group/example'); run('git',['init','-q',repo]);write(path.join(project,'repos.json'),JSON.stringify({root}));
  assert.equal(cli('path','--config','repos.json','example'),repo);
  assert.equal(node('--input-type=module','-e',`import {createNavigation} from 'agent-hands';console.log((await createNavigation({root:${JSON.stringify(root)},routeHost:()=>undefined}).repoPath('example')).abs)`),repo);
  const hookConfig = path.join(project,'hooks.json');
  const batch = JSON.parse(read(hookConfig));
  const hook = (cmd, file = 'hooks.json') => JSON.parse(cli('hooks-' + cmd,'--config',file));
  assert.deepEqual(hook('plan'),{changed:false,shifted:false});
  assert.deepEqual(hook('inspect'),{pending:false,registration:false,ownership:['codex','cursor'].map(target=>({target,ownership:{owners:1,released:0}}))});
  node('--input-type=module','-e',`import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {artifactGroup, collectSkills, createOutputWriter, inspectWorkspaceHookOwnership, planWorkspaceHooks} from 'agent-hands';
const data=JSON.parse(readFileSync('hooks.json','utf8')); assert.deepEqual(planWorkspaceHooks(data),{changed:false,shifted:false});
for(const {target} of data.selections) assert.deepEqual(inspectWorkspaceHookOwnership({root:data.root,target}),{owners:['node-version'],released:[]});
const writer=createOutputWriter(data.root,{files:{}});writer.stage('sample','rendered');writer.preflight();writer.apply();
assert.equal(readFileSync(data.root+'/sample','utf8'),'rendered');assert.ok(writer.files.sample);
assert.equal(artifactGroup(['sample'],'sample/one'),'sample');assert.deepEqual(collectSkills([]).skills,[]);
for(const suffix of ['dist/index.js','dist/layout/adapters/cursor/index.js','dist/hooks/workspace.js','src/index.ts','package.json'])
  await assert.rejects(import('agent-hands/'+suffix),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});`);
  const previous = read(path.join(batch.root,'.codex/hooks.json'));
  batch.selections[0].hooks[0].command = 'echo example-private-value';
  write(hookConfig,JSON.stringify(batch));
  write(path.join(project,'single.json'),JSON.stringify({root:batch.root,...batch.selections[0]}));
  write(path.join(project,'interrupt.mjs'),`import fs from 'node:fs';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
const rename=fs.renameSync;fs.renameSync=(from,to)=>{rename(from,to);if(to===path.resolve('hooks-workspace/.codex/hooks.json'))process.exit(73);};syncBuiltinESMExports();`);
  assert.throws(()=>node('--import','./interrupt.mjs','node_modules/agent-hands/bin/agent-hands.js','hooks-apply','--config','hooks.json'),{status:73});
  assert.match(read(path.join(batch.root,'.codex/hooks.json')),/example-private-value/);
  assert.deepEqual(hook('inspect'),{pending:true,registration:false,targets:['codex','cursor']});
  assert.throws(()=>hook('recover','single.json'),error=>error.status===1 && /original hook targets/.test(error.stderr));
  assert.deepEqual(hook('recover'),{recovered:true});
  assert.equal(read(path.join(batch.root,'.codex/hooks.json')),previous);
  assert.deepEqual(hook('recover'),{recovered:false});
  assert.deepEqual(hook('apply','single.json'),{changed:true,shifted:false});
  assert.deepEqual(hook('inspect','single.json'),{pending:false,registration:false,ownership:[{target:'codex',ownership:{owners:1,released:0}}]});
  const invalid = path.join(project,'malformed-config-value.json');
  write(invalid,'{"example-private-value": unsupported}');
  assert.throws(()=>hook('plan',invalid),error=>error.status===1 &&
    error.stderr.trim()==='Cannot read hook configuration as JSON' && !error.stdout);
  write(invalid,JSON.stringify({root:batch.root,target:'opencode',enabled:true,hooks:[]}));
  assert.throws(()=>hook('plan',invalid),error=>error.status===1 && /OpenCode uses plugins/.test(error.stderr));
  write(path.join(batch.root,'.codex/hooks.json'),'invalid-private-setting');
  assert.throws(()=>hook('apply','single.json'),error=>error.status===1 && !error.stdout &&
    !/invalid-private-setting|example-private-value|hooks-workspace/.test(error.stderr));
  run('python3',['-B',path.join(pkg,'profiles/my-voice/skills/my-voice-calibrate/scripts/collect.py'),'--help'],project);
  write(path.join(project,'consumer.mts'),`import {planLayout,applyLayout,createNavigation,createOutputWriter,artifactLayout,collectSubagents,prepareWorkspaceHooks,planWorkspaceHooks,type OutputMutations,type LayoutInput,type LayoutResult,type RepositoryResolution,type WorkspaceHookBatch,type WorkspaceHookResult} from 'agent-hands';
const input: LayoutInput = {root:'/work',target:'cursor',rules:[],servers:[],subagents:[],skills:[]};
for(const target of ['cursor','codex'] as const){const result:Promise<LayoutResult>=applyLayout(planLayout({...input,target}));void result;}
const nav=createNavigation({root:input.root,routeHost:()=>({zone:'repos',gitlab:true})});
const repository:Promise<RepositoryResolution>=nav.resolve('example',{allowGroup:true});void repository;
const hooks:WorkspaceHookBatch={root:input.root,accountHome:'/home',selections:[{target:'codex',enabled:true,hooks:[]},{target:'cursor',enabled:true,hooks:[]}]};
const preview:WorkspaceHookResult=planWorkspaceHooks(hooks);void preview;
const registrations = prepareWorkspaceHooks(hooks).registrations.map(row => row.action);void registrations;
const artifacts=artifactLayout(['output'],{root:'/store',artifacts:'/store/bundles',renderer:1});
const writer=createOutputWriter(input.root,{files:{}},{artifacts});
const mutations:OutputMutations={write(){},remove(){},bind(){}};
writer.apply(undefined,undefined,mutations);collectSubagents([]);
// @ts-expect-error Commands are strings.
planWorkspaceHooks({root:input.root,target:'codex',enabled:true,hooks:[{owner:'test',event:'SessionStart',command:1}]});
// @ts-expect-error A targeted scan accepts namespace strings only.
nav.scan([4]);
// @ts-expect-error Unknown target must be rejected.
planLayout({...input,target:'unknown'});`);
  // Use an external compiler, resolving declarations only from the installed project.
  run(process.execPath,[path.join(source,'node_modules/typescript/bin/tsc'),'--ignoreConfig','--strict','--noEmit','--module','NodeNext','consumer.mts'],project);
  console.log(`${label}: CLI, root JavaScript, strict TypeScript, ownership, interrupted batch recovery and installed examples passed`);
}
try {
  const [pack]=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',packed]));
  const files=pack.files.map(f=>f.path).sort();
  const expected=run('git',['ls-files','dist','bin','assets','profiles/my-voice/skills','profiles/my-voice/README.md','README.md','LICENSE','package.json','docs/reference/*.md','examples/hooks.mjs']).split('\n').sort();
  assert.deepEqual(files,expected);
  const archive=path.join(packed,pack.filename); smoke(archive,'tarball');
  const mirror=path.join(temp,'mirror.git');run('git',['init','--bare','-q',mirror]);
  run('git',['--git-dir',mirror,'fetch','--no-tags',source,sha]);
  run('git',['--git-dir',mirror,'update-ref','refs/heads/main',sha]);
  run('git',['--git-dir',mirror,'symbolic-ref','HEAD','refs/heads/main']);
  const tag='v'+version;run('git',['--git-dir',mirror,'update-ref','refs/tags/'+tag,sha]);
  assert.equal(run('git',['--git-dir',mirror,'rev-parse','refs/tags/'+tag]),sha);
  smoke('git+'+pathToFileURL(mirror).href+'#'+tag,'git');
  console.log(`Local mirror only: refs/tags/${tag} = ${sha}`);
  console.log(`Archive: ${files.length} files, SHA256 ${createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}, npm integrity ${pack.integrity}`);
  if(packed!==temp) console.log(archive);
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
