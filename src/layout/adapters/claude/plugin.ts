import path from 'node:path';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sha256 } from '../../fs.js';
import { snapshot, type TargetChange } from '../../../hooks/hook-journal.js';
import type { ExternalHookChange } from '../../../hooks/hook-operation.js';
import type { WorkspaceRegistration, WorkspaceRegistrationPlan, WorkspaceRegistrationInspection, WorkspaceRegistrationStatus } from '../../../hooks/options.js';
import { inspectRegistration, pinnedRegistrationVersion, registrationEvidence, registrationPreflight, registrationUnchanged, type RegistrationRequest } from './registration.js';

const validName = (name: unknown): name is string => typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name) && !Object.hasOwn(Object.prototype,name);
const validVersion = (version: unknown): version is string => typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version);
const validFingerprint = (fingerprint: unknown): fingerprint is string => typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint);
const destination = (home:string,marketplace:string,plugin:string,version:string) => path.join(home,'.claude/plugins/cache',marketplace,plugin,version);
function inProject(root:string,directory:string) {
  const relative = path.relative(root,directory);
  return !!relative && !relative.startsWith('..'+path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function readReceipt(raw:string, marketplace:string, plugin:string, directory?:string) {
  let prior;
  try { prior = JSON.parse(raw); } catch { throw new Error('Invalid registration receipt'); }
  if (!prior || JSON.stringify(prior) !== raw || Object.keys(prior).length !== 5 ||
      prior.marketplace !== marketplace || prior.plugin !== plugin || typeof prior.directory !== 'string' ||
      !path.isAbsolute(prior.directory) || path.normalize(prior.directory) !== prior.directory ||
      (directory !== undefined && prior.directory !== directory) || !validVersion(prior.version) || !validFingerprint(prior.fingerprint))
    throw new Error('Invalid registration receipt or source mismatch');
  return prior as {directory:string;version:string;fingerprint:string};
}
export function registrationPath(root:string) {
  return path.join(root,'.agent-hands/hooks/claude/registration.json');
}
export function registrationFiles(root:string,home:string) {
  const profile = path.join(realpathSync(home),'.claude');
  return [path.join(profile,'plugins/known_marketplaces.json'),path.join(profile,'plugins/installed_plugins.json'),path.join(root,'.claude/settings.local.json'),path.join(profile,'settings.json'),registrationPath(root)];
}
export function inspectProjectRegistration(input:WorkspaceRegistrationInspection):WorkspaceRegistrationStatus {
  const {root,accountHome,marketplace,plugin,expectedVersion,expectedFingerprint} = input;
  if (!validName(marketplace) || !validName(plugin) || (expectedVersion !== undefined && !validVersion(expectedVersion)) ||
      (expectedFingerprint !== undefined && !validFingerprint(expectedFingerprint))) throw new TypeError('Invalid plugin identity');
  const [markets,installs,,,file] = registrationFiles(root,accountHome);
  const raw = snapshot(file);
  try {
    const receipt = raw === null ? undefined : readReceipt(raw,marketplace,plugin);
    const actual = inspectRegistration({marketplace,plugin,directory:receipt?.directory},root,{
      settings:null,marketplaces:snapshot(markets),installations:snapshot(installs),
    });
    if (!actual.installed) return {status:receipt ? 'stale' : 'missing'};
    const {version,directory} = actual;
    if (!validVersion(version) || typeof directory !== 'string' || path.normalize(directory) !== directory ||
        !inProject(root,directory) || actual.installPath !== destination(accountHome,marketplace,plugin,version)) return {status:'stale'};
    const observed = {scope:'project',version} as const;
    if (!receipt) return {status:'retained',...observed};
    if (receipt.version !== version) return {status:'stale',...observed};
    return {status:(expectedVersion !== undefined && expectedVersion !== version) ||
        (expectedFingerprint !== undefined && expectedFingerprint !== receipt.fingerprint) ? 'stale' : 'current',
      ...observed,fingerprint:receipt.fingerprint};
  } catch { return {status:'stale'}; }
}
export function plugin(root:string,settings:TargetChange,input:WorkspaceRegistration) {
  const {plugin,marketplace,version,fingerprint} = input;
  if (!validName(plugin) || !validName(marketplace) || !validVersion(version) || !validFingerprint(fingerprint)) throw new TypeError('Invalid plugin identity');
  if (![input.accountHome,input.directory,input.executable].every(v => path.isAbsolute(v) && path.normalize(v) === v)) throw new TypeError('Expected absolute plugin paths');
  const directory = input.directory, home = realpathSync(input.accountHome);
  if (!inProject(root,directory)) throw new TypeError('Expected a workspace-local plugin source');
  const physical = input.expectedPhysicalDirectory;
  if (physical !== undefined) {
    if (typeof physical !== 'string' || !path.isAbsolute(physical) || path.normalize(physical) !== physical || !physical.startsWith(home + path.sep)) throw new TypeError('Expected a pinned physical source under the selected account home');
  }
  const checkSource = () => {
    if (physical !== undefined && (realpathSync(path.dirname(directory)) !== path.dirname(directory) || !lstatSync(directory).isSymbolicLink() || !lstatSync(physical).isDirectory() || realpathSync(physical) !== physical)) throw new Error('Unconfirmed plugin source alias');
    if (realpathSync(directory) !== (physical ?? directory)) throw new Error('Plugin source changed');
  };
  const files = registrationFiles(root,home);
  const changes = files.map(file => { const before = snapshot(file); return {file,before,after:before}; });
  const read = ([settings,marketplaces,installations]:readonly (string|null)[]) => ({settings,marketplaces,installations});
  const before = read([settings.before,...changes.slice(0,2).map(c => c.before)]);
  const current = inspectRegistration({marketplace,plugin,directory},root,before);
  const receipt = changes.at(-1)!;
  const prior = receipt.before === null ? input.legacy : readReceipt(receipt.before,marketplace,plugin,directory);
  if (prior && (!validVersion(prior.version) || !validFingerprint(prior.fingerprint))) throw new Error('Invalid plugin registration receipt');
  const expectedDestination = (v:string) => destination(home,marketplace,plugin,v);
  if (current.installed !== !!prior || (prior && (prior.version !== current.version || current.installPath !== expectedDestination(prior.version))) || (current.marketplace && !current.installed)) throw new Error('Unconfirmed project plugin registration');
  receipt.after = JSON.stringify({plugin,marketplace,directory,fingerprint,version});
  const steps: ExternalHookChange[] = [];
  const registration: WorkspaceRegistrationPlan = {action:current.installed ? 'update' : 'install',version,
    ...(typeof current.version === 'string' && {previousVersion:current.version})};
  if (prior && current.version === version) {
    if (prior.fingerprint !== fingerprint) throw new Error('Changed plugin source requires a new version');
    return {changes,steps,checkSource,registration:{...registration,action:'current' as const}};
  }
  let binary: string, binarySha256: string;
  try {
    binary = realpathSync(input.executable);
    if (!lstatSync(binary).isFile()) throw new Error();
    binarySha256 = sha256(readFileSync(binary));
  } catch { throw new Error('Unsupported registration binary'); }
  const identity = {binarySha256,platform:process.platform,arch:process.arch};
  const request: RegistrationRequest = {...identity,version:pinnedRegistrationVersion(identity),marketplace,plugin,directory,step:current.installed?'update':'install'};
  registrationPreflight(request,root,before);
  let versionConfirmed = false;
  const launch = (args: string[], readVersion = false) => spawnSync(binary,args,{
    cwd:root, timeout:readVersion ? 10_000 : 120_000, killSignal:'SIGKILL', maxBuffer:4096,
    encoding:'utf8', stdio:['ignore',readVersion ? 'pipe' : 'ignore','ignore'],
    env:{HOME:home,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),PATH:process.env.PATH,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1'},
  });
  for (const step of [...(current.marketplace ? [] : ['add'] as const),current.installed ? 'update' as const : 'install' as const]) {
    const config = {...request,step}, protectedFiles = [settings.file,...files.slice(0,2)];
    steps.push({files:protectedFiles,retain:files.slice(0,2),run:() => {
      checkSource();
      if (!versionConfirmed) {
        if (sha256(readFileSync(binary)) !== binarySha256) throw new Error('Plugin binary changed');
        const version = launch(['--version'],true);
        if (version.error || version.status !== 0 || version.stdout?.trim() !== config.version) throw new Error('Unconfirmed registration binary version');
        versionConfirmed = true;
      }
      if (sha256(readFileSync(binary)) !== binarySha256) throw new Error('Plugin binary changed');
      const args = step === 'add' ? ['marketplace','add',directory] : [step,`${plugin}@${marketplace}`];
      return launch(['plugin',...args,'--scope','project']).status;
    },verify:(a,b,exit) => {checkSource();return registrationEvidence(config,root,version,read(a),read(b),exit,expectedDestination(version));},verifyFailure:(a,b) => registrationUnchanged(config,read(a),read(b))});
  }
  return {changes,steps,checkSource,registration};
}
