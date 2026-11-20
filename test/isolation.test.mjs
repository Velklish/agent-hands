import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {parse} from 'acorn';
import {scratch,put,input} from './fixtures.mjs';
import {applyLayout,planLayout} from 'agent-hands';

const targets = ['claude','cursor','codex','opencode'];
const nativeOutput = {
  claude: { agent: '.md', mcp: '.mcp.json', perKey: true },
  cursor: { agent: '.md', mcp: '.cursor/mcp.json', perKey: true },
  codex: { agent: '.toml', mcp: '.codex/config.toml', perKey: false },
  opencode: { agent: '.md', mcp: 'opencode.json', perKey: true },
};
function graph(root, entry, target) {
  const seen = new Set();
  const adapters = path.join(root,'layout/adapters') + path.sep;
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const tree = parse(fs.readFileSync(file,'utf8'), {ecmaVersion:'latest',sourceType:'module'});
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      const edge = ['ImportExpression','ImportDeclaration','ExportAllDeclaration','ExportNamedDeclaration'].includes(node.type) ? node.source
        : node.type === 'CallExpression' && ['load','require'].includes(node.callee?.name) ? node.arguments[0] : null;
      if (edge) {
        const spec = edge.value;
        assert.equal(typeof spec,'string','computed import');
        if (spec.startsWith('node:') || spec === 'yaml' || spec === 'smol-toml') return;
        const dep = path.resolve(path.dirname(file),spec);
        assert.ok(spec.startsWith('.') && dep.startsWith(root + path.sep),'outside runtime');
        if (target && dep.startsWith(adapters)) assert.ok(dep.startsWith(path.join(adapters,target) + path.sep),'sibling import');
        visit(dep);
      }
      Object.values(node).forEach(walk);
    }
    walk(tree);
  }
  visit(path.join(root,entry));
}

test('emitted facade graph stays within runtime', () => {
  const root = path.resolve('dist');
  graph(root,'index.js');
  graph(root,'layout/artifacts.js');
  graph(root,'layout/adapters/codex/transports.js','codex');
});

test('emitted import guard rejects computed imports, side-effect imports and re-exports', t => {
  const root = scratch(t);
  for (const [source,reason] of [
    ['import(name);', /computed import/],
    ["import '../outside.js';", /outside runtime/],
    ["export * from '../outside.js';", /outside runtime/],
  ]) {
    put(root,'index.js',source);
    assert.throws(() => graph(root,'index.js'),reason);
  }
});

function snapshot(root) {
  return Object.fromEntries(fs.readdirSync(root,{recursive:true}).sort().map(rel => {
    const file = path.join(root,rel);
    const stat = fs.lstatSync(file);
    return [rel, {mode:stat.mode, bytes:stat.isDirectory() ? null : stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file).toString('base64')}];
  }));
}

for (const target of targets) test(`${target}: package root applies with all sibling modules absent and preserves all three neighbors`, async t => {
  const dir = scratch(t), root = path.join(dir,'workspace'), distribution = path.join(dir,'node_modules','agent-hands');
  const lib = path.join(distribution,'dist'), sourceDist = path.resolve('dist');
  fs.mkdirSync(root);
  fs.mkdirSync(distribution,{recursive:true});
  fs.copyFileSync('package.json',path.join(distribution,'package.json'));
  fs.cpSync(sourceDist,lib,{recursive:true,filter:file => {
    const [layout, adapters, name] = path.relative(sourceDist,file).split(path.sep);
    return layout !== 'layout' || adapters !== 'adapters' || !name || name === target;
  }});
  for (const dependency of ['yaml','smol-toml']) fs.symlinkSync(path.resolve('node_modules',dependency),path.join(dir,'node_modules',dependency),process.platform === 'win32' ? 'junction' : 'dir');
  const siblings = targets.filter(other => other !== target);
  for (const other of siblings) assert.equal(fs.existsSync(path.join(lib,'layout','adapters',other)),false);
  graph(lib,`layout/adapters/${target}/index.js`,target);

  const selection = harness => {
    const name = `verify-${harness}`, source = path.join(dir,'inputs',name);
    put(source,'SKILL.md',`---\nname: ${name}\ndescription: Check the layout\n---\nCheck it.\n`);
    put(source,'refs/guide.md',`Supporting bytes for ${harness}\n`);
    const rule = put(dir,`inputs/${name}.md`,`Rule for ${harness}\n`);
    return input(root,harness,{skills:[{name,dirAbs:source}],rules:[rule],
      subagents:[{name,description:'Checks changes',prompt:'Read the diff.',tools:['read']}],
      servers:[{name:'tool',definition:{command:'node',args:['serve.mjs']}}]});
  };
  const foreign = [];
  for (const other of siblings) {
    const {state} = await applyLayout(planLayout(selection(other)));
    const file = put(dir,`ownership/${other}.json`,JSON.stringify(state));
    foreign.push({state,file,before:fs.readFileSync(file,'utf8')});
  }
  const ownership = path.join(dir,'ownership');
  const foreignOwnership = snapshot(ownership);
  const before = snapshot(root);
  const plan = selection(target);
  const {agent,mcp,perKey} = nativeOutput[target];
  const name = `verify-${target}`;
  const resources = [`.${target}/skills/${name}/SKILL.md`, `.${target}/skills/${name}/refs/guide.md`,
    `.${target}/agents/${name}${agent}`, `.agents/rules/${target}/0001.md`];
  const expectedOwnFiles = [...resources,mcp].sort();
  const ownPaths = new Set(expectedOwnFiles.map(file => path.normalize(file)));
  for (const own of [...ownPaths]) {
    for (let parent = path.dirname(own); parent !== '.'; parent = path.dirname(parent)) {
      if (!Object.hasOwn(before,parent)) ownPaths.add(parent);
    }
  }
  const witness = path.join(dir,'selected-state.json');
  const script = put(dir,'apply.mjs',`
    import {planLayout, applyLayout, readLayoutState} from 'agent-hands';
    import assert from 'node:assert/strict';
    import {readFileSync,writeFileSync} from 'node:fs';
    const prune = process.argv[2] === 'prune';
    const plan = planLayout(prune ? ${JSON.stringify(input(root,target))} : ${JSON.stringify(plan)});
    assert.deepEqual(plan.files.map(file => file.path).sort(), prune ? [] : ${JSON.stringify(expectedOwnFiles)}, 'unexpected planned paths');
    const previous = prune ? readLayoutState(JSON.parse(readFileSync(${JSON.stringify(witness)},'utf8'))) : undefined;
    const result = await applyLayout(plan,previous);
    writeFileSync(${JSON.stringify(witness)},JSON.stringify(result.state));
  `);
  const checkForeign = () => {
    const after = snapshot(root);
    assert.deepEqual(Object.fromEntries(Object.entries(after).filter(([rel]) => !ownPaths.has(rel))),before,'foreign output changed');
    assert.deepEqual(snapshot(ownership),foreignOwnership,'foreign ownership changed');
  };
  execFileSync(process.execPath,[script,'apply'],{cwd:dir});
  checkForeign();
  for (const file of expectedOwnFiles) assert.ok(fs.lstatSync(path.join(root,file)).isFile(),file);
  const state = JSON.parse(fs.readFileSync(witness,'utf8'));
  assert.equal(state.target,target);
  assert.deepEqual(Object.keys(state.files).sort(), (perKey ? resources : expectedOwnFiles).slice().sort());
  assert.deepEqual(Object.keys(state.serverKeys), perKey ? [mcp] : []);
  if (perKey) assert.deepEqual(Object.keys(state.serverKeys[mcp]), ['tool']);
  assert.deepEqual(state.createdMcp, perKey ? [mcp] : []);

  execFileSync(process.execPath,[script,'prune'],{cwd:dir});
  checkForeign();
  for (const file of expectedOwnFiles) assert.equal(fs.existsSync(path.join(root,file)),false,file);
  assert.deepEqual(JSON.parse(fs.readFileSync(witness,'utf8')),{target,files:{},serverKeys:{},createdMcp:[]});

  for (const {state,file,before: bytes} of foreign) {
    await assert.rejects(applyLayout(planLayout(input(root,target)),state),/Ownership belongs/);
    for (const [rel,hash] of Object.entries(state.files)) await assert.rejects(applyLayout(planLayout(input(root,target)),{files:{[rel]:hash}}),/Invalid ownership path/);
    assert.equal(fs.readFileSync(file,'utf8'),bytes);
  }
  checkForeign();

  const engine = path.join(lib,'layout','engine.js');
  const original = fs.readFileSync(engine,'utf8');
  const extraPath = `.agents/rules/${siblings[0]}/unexpected-planned.md`;
  const stageAnchor = 'stageContent({ stage:';
  assert.ok(original.includes(stageAnchor));
  fs.writeFileSync(engine,original.replace(stageAnchor,`stage(${JSON.stringify(extraPath)}, 'foreign planned output');\n    ${stageAnchor}`));
  try {
    const wrongPlan = spawnSync(process.execPath,[script,'apply'],{cwd:dir,encoding:'utf8'});
    assert.equal(wrongPlan.status,1);
    assert.match(wrongPlan.stderr,/unexpected planned paths/);
    assert.ok(wrongPlan.stderr.includes(extraPath),wrongPlan.stderr);
    checkForeign();
    t.diagnostic(`Planned foreign path ${extraPath} rejected before apply (child exit ${wrongPlan.status})`);
  } finally {
    fs.writeFileSync(engine,original);
  }

  const adapter = path.join(lib,'layout','adapters',target,'index.js');
  fs.appendFileSync(adapter,`\nimport '../${siblings[0]}/index.js';\n`);
  assert.throws(() => graph(lib,`layout/adapters/${target}/index.js`,target),/sibling import/);
  fs.appendFileSync(path.join(lib,'index.js'),`\nimport './layout/adapters/${siblings[1]}/index.js';\n`);
  const refused = spawnSync(process.execPath,[script,'apply'],{cwd:dir,encoding:'utf8'});
  assert.equal(refused.status,1);
  assert.match(refused.stderr,/ERR_MODULE_NOT_FOUND/);
  assert.ok(refused.stderr.includes(siblings[1]), refused.stderr);

  for (const other of siblings) {
    put(root,`.agents/rules/${other}/unexpected.md`,'foreign mutation');
    assert.throws(checkForeign,/foreign output changed/);
    fs.unlinkSync(path.join(root,`.agents/rules/${other}/unexpected.md`));
  }
  fs.writeFileSync(foreign[0].file,'changed');
  assert.throws(checkForeign,/foreign ownership changed/);
});
