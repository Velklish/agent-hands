import assert from 'node:assert/strict';
import { registrationPostcondition, registrationEvidence } from '../../../dist/layout/adapters/claude/registration.js';

const request = { platform: 'linux', plugin: 'subject', marketplace: 'market', directory: '/fixture/market', step: 'install' };
const hooks = { PreToolUse: [{ matcher: 'Write', hooks: ['one','two'].map(command => ({ type: 'command', command })) }] };
const project = { hooks, env: { FIXTURE: 'keep' } };
const before = JSON.stringify(project);
const accepts = registrationPostcondition(request, before);
const after = { ...project, enabledPlugins: { 'subject@market': true } };
assert.ok(accepts(JSON.stringify(after, null, 2)));
assert.ok(!accepts(null));
assert.ok(!accepts(before));
assert.ok(!accepts(JSON.stringify({ ...after, env: {} })));
const reordered = structuredClone(after);
reordered.hooks.PreToolUse[0].hooks.reverse();
assert.ok(!accepts(JSON.stringify(reordered)));
for (const json of ['{"env":{},"env":{}}', '{"unknown":true}', before.replace('"matcher"','"note":1,"matcher"'), before.replace('"type"','"timeout":4.0000000000000000001,"type"'), '{"enabledPlugins":{"subject@market":false}}']) assert.throws(() => registrationPostcondition(request,json));
console.log('Registration settings checks passed');
const marketplaces = JSON.stringify({ market:{ source:{ source:'directory',path:'/fixture/market' }, installLocation:'/fixture/market' } });
const start = { settings:before, marketplaces, installations:null };
const row = { scope:'project',projectPath:'/fixture/project',version:'1.0.0',installPath:'/fixture/cache' };
const installations = (...rows) => JSON.stringify({ version:2,plugins:{ 'subject@market':rows } });
const success = { settings:JSON.stringify(after),marketplaces,installations:installations(row) };
const verified = (end,exit = 0) => registrationEvidence(request,'/fixture/project','1.0.0',start,end,exit);
assert.ok(verified(success));
assert.ok(!verified(success,9),'native failure cannot confirm registration');
assert.ok(!verified({...success,settings:JSON.stringify({...after,env:{}})}),'neighbor mutation cannot confirm registration');
assert.ok(!verified({...success,installations:null}),'marketplace alone is not an installation');
assert.ok(!registrationEvidence(request,'/fixture/project','1.0.0',{...start,marketplaces:null},{...success,marketplaces:null},0),'installation alone is not a marketplace');
for (const invalid of [{installations:null},{installations:installations(row,row)},{installations:installations({...row,scope:'local'})},{installations:installations({...row,projectPath:'/other'})},{installations:installations({...row,version:'0'})},{marketplaces:null},{settings:before}]) assert.ok(!verified({ ...success,...invalid }));
assert.ok(!verified(success,7));
console.log('Registration evidence checks passed');

const mac = { ...request,platform:'darwin' };
assert.ok(registrationPostcondition(mac,'{}')(JSON.stringify({enabledPlugins:{'subject@market':true}})));
for (const shape of [{extra:true},{hooks:{}},{enabledPlugins:{'subject@market':0}},{extraKnownMarketplaces:{market:{source:{source:'remote',path:'/market'}}}}]) assert.throws(()=>registrationPostcondition(mac,JSON.stringify(shape)),/project settings/);
const group = (matcher,timeout) => ({ ...(matcher ? { matcher } : {}),hooks:[{ type:'command',command:'first',...(timeout ? { timeout } : {}) },{ type:'command',command:'second' }] });
const question = 'AskUserQuestion|AskQuestion|request_user_input';
const macSettings = { enableAllProjectMcpServers:true,skillOverrides:{ fixture:'off' }, enabledPlugins:{ 'neighbor@market':true,'other@market':false },extraKnownMarketplaces:{}, hooks:{
  SessionStart:[group('startup|resume',4)],Stop:[group(null)],PreToolUse:[group('Write',4),group(question,30)],PostToolUse:[group('mcp__sample_tools__(read_one|write_two)'),group(question,30)],PostToolUseFailure:[group(question,30)],
} };
const macAccepts = registrationPostcondition(mac,JSON.stringify(macSettings));
for (const step of ['add','install']) assert.throws(()=>registrationPostcondition({...request,step},JSON.stringify(macSettings)),/project settings/);
assert.ok(registrationPostcondition({...request,step:'update'},JSON.stringify(macSettings))(JSON.stringify(macSettings)));
assert.throws(()=>registrationPostcondition({...request,step:'update'},JSON.stringify({...macSettings,env:{FIXTURE:'keep'}})),/project settings/);
assert.ok(macAccepts(JSON.stringify({ ...macSettings,enabledPlugins:{ ...macSettings.enabledPlugins,'subject@market':true } })));
for (const mod of [
  doc => { doc.hooks.Stop[0].externalFixtureField = 'opaque'; },
  doc => { doc.hooks.Stop[0].hooks[0].timeout = 60; },
  doc => { doc.hooks.PreToolUse[0].matcher = 'unknown'; },
  doc => { doc.hooks.PreToolUse[0].matcher = 'mcp__sample_tools__(read_one|write_two)'; },
  doc => { doc.hooks.PostToolUse[0].matcher = 'mcp__sample_tools__(read_.*|write_two)'; },
  doc => { doc.hooks.PostToolUse[0].matcher = 'mcp__sample_tools__(one|two|three)'; },
  doc => { doc.enableAllProjectMcpServers = false; },
  doc => { doc.skillOverrides.fixture = 'on'; },
  doc => { delete doc.extraKnownMarketplaces; },
]) {
  const unsupported = structuredClone(macSettings);
  mod(unsupported);
  assert.throws(() => registrationPostcondition(mac,JSON.stringify(unsupported)),/project settings/);
}
console.log('Registration macOS shape allowlist and negative controls passed');

const updating = {...request,step:'update'};
const updated = {...success,installations:installations({...row,version:'1.0.1',installPath:'/fixture/cache/1.0.1'})};
assert.ok(registrationEvidence(updating,'/fixture/project','1.0.1',success,updated,0,'/fixture/cache/1.0.1'));
assert.ok(!registrationEvidence(updating,'/fixture/project','1.0.0',success,success,0,row.installPath));
assert.ok(!registrationEvidence(updating,'/fixture/project','1.0.2',success,updated,0,'/fixture/cache/1.0.2'));
