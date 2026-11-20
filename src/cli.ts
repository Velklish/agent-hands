import { closeSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseLayout, readLayoutState, applyLayout, runRepositoryCommand, type LayoutPlan, type NavigationOptions,
  planWorkspaceHooks, applyWorkspaceHooks, inspectWorkspaceHookOperation, inspectWorkspaceHookOwnership, recoverWorkspaceHooks,
  type WorkspaceHookBatch, type WorkspaceHookInput, type WorkspaceHookScope } from 'agent-hands';

const usage = `agent-hands <plan|apply|path|clone|fresh|zone> --config FILE [--state FILE] [TARGET]
agent-hands <hooks-plan|hooks-apply|hooks-inspect|hooks-recover> --config FILE
plan previews paths; apply requires a trusted state file outside the workspace.
Hook commands use the same single-target or batch configuration.
path and zone are local reads; clone and fresh explicitly contact remotes.`;
const json = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function navigation(value: unknown): NavigationOptions {
  if (!record(value) || typeof value.root !== 'string' || !path.isAbsolute(value.root) ||
      Object.keys(value).some(k => !['root','hosts'].includes(k))) throw Error('Expected an absolute root and optional hosts');
  const hosts = new Map<string, 'repos'|'external'>();
  if ('hosts' in value) {
    if (!record(value.hosts)) throw Error('Expected a host map');
    for (const [host, zone] of Object.entries(value.hosts)) {
      if (zone !== 'repos' && zone !== 'external') throw Error(`Unknown zone for ${host}`);
      hosts.set(host.toLowerCase(), zone);
    }
  }
  return { root: value.root, routeHost: authority => {
    const zone = hosts.get(authority.toLowerCase());
    return zone && { zone, gitlab: zone === 'repos' };
  } };
}
async function apply(plan: LayoutPlan, file: string, config: string) {
  const root = realpathSync(plan.root);
  const state = path.join(realpathSync(path.dirname(path.resolve(file))), path.basename(file));
  const relative = path.relative(root, state);
  if ((!relative.startsWith('..'+path.sep) && relative !== '..' && !path.isAbsolute(relative)) || state === realpathSync(config))
    throw Error('Select a separate trusted ownership file outside the workspace');
  const lock = state + '.lock';
  const fd = openSync(lock, 'wx', 0o600);
  let committed = false;
  try {
    const stat = lstatSync(state, { throwIfNoEntry: false });
    let previous;
    if (stat) {
      if (!stat.isFile() || stat.nlink !== 1) throw Error('Expected a regular ownership file');
      const saved = json(state);
      if (!record(saved) || saved.root !== root || !record(saved.state)) throw Error('Invalid ownership file for this workspace');
      previous = readLayoutState(saved.state);
    }
    const result = await applyLayout(plan, previous);
    writeFileSync(fd, JSON.stringify({root,state:result.state})+'\n');
    renameSync(lock,state);
    committed = true;
    return {written:result.written,updated:result.updated,removed:result.removed};
  } finally {
    closeSync(fd);
    // After rename the lock name is free for the next invocation.
    if (!committed) unlinkSync(lock);
  }
}
type HookCommand = 'hooks-plan' | 'hooks-apply' | 'hooks-inspect' | 'hooks-recover';
type HookTarget = Exclude<WorkspaceHookScope['target'], 'opencode'>;
class HookCliError extends Error {}

function hookConfig(file: string) {
  let input: unknown;
  try { input = json(file); } catch { throw new HookCliError('Cannot read hook configuration as JSON'); }
  if (!record(input) || typeof input.root !== 'string' || !path.isAbsolute(input.root))
    throw new HookCliError('Hook configuration requires an absolute workspace root');
  const selections = 'selections' in input ? input.selections : [input];
  if (!Array.isArray(selections) || !selections.length)
    throw new HookCliError('Expected at least one hook selection');
  const batchAccount = 'selections' in input ? input.accountHome : undefined;
  if (batchAccount !== undefined && (typeof batchAccount !== 'string' || !path.isAbsolute(batchAccount)))
    throw new HookCliError('Hook configuration requires an absolute account home');
  let registrationAccount: string | undefined;
  const targets: HookTarget[] = selections.map(selection => {
    if (!record(selection)) throw new HookCliError('Expected a hook selection object');
    const {target, registration} = selection;
    if (target === 'opencode') throw new HookCliError('OpenCode uses plugins and does not support command hooks');
    if (target !== 'claude' && target !== 'codex' && target !== 'cursor')
      throw new HookCliError('Select Claude Code, Codex or Cursor for command hooks');
    if (registration !== undefined) {
      if (target !== 'claude' || !record(registration) ||
          typeof registration.accountHome !== 'string' || !path.isAbsolute(registration.accountHome))
        throw new HookCliError('Claude Code plugin registration requires an absolute account home');
      registrationAccount = registration.accountHome;
    }
    return target;
  });
  if (new Set(targets).size !== targets.length) throw new HookCliError('Expected distinct hook targets');
  // The public operations validate the desired hook definitions before planning or writing.
  if (batchAccount && registrationAccount && realpathSync(batchAccount) !== realpathSync(registrationAccount))
    throw new HookCliError('Claude Code registration account must match the batch account');
  return {input: input as unknown as WorkspaceHookInput | WorkspaceHookBatch,
    targets, accountHome: batchAccount ?? registrationAccount, registration: registrationAccount !== undefined};
}

function runHookCommand(command: HookCommand, args: string[]) {
  const options = {config:{type:'string'}} as const;
  const {values} = (() => {
    try { return parseArgs({args, options}); }
    catch { throw new HookCliError(usage); }
  })();
  if (!values.config) throw new HookCliError(usage);
  const {input, targets, accountHome, registration} = hookConfig(values.config);
  if (command === 'hooks-plan') return planWorkspaceHooks(input);
  if (command === 'hooks-apply') return applyWorkspaceHooks(input);

  const {root} = input;
  const pending = inspectWorkspaceHookOperation({root, accountHome});
  if (command === 'hooks-inspect') {
    if (pending.pending) return pending;
    const ownership = targets.map(target => {
      const receipt = inspectWorkspaceHookOwnership({root, target});
      return {target, ownership: receipt && {owners: receipt.owners.length, released: receipt.released.length}};
    });
    return {...pending, ownership};
  }

  if (!pending.pending) return {recovered:false};
  if (pending.registration !== registration || Boolean(pending.registration || pending.accountScoped) !== Boolean(accountHome) ||
      pending.targets.length !== targets.length || !pending.targets.every(target => targets.some(selected => selected === target)))
    throw new HookCliError('Recovery requires the original hook targets and registration account. See hooks-inspect.');
  recoverWorkspaceHooks({root, targets, accountHome});
  return {recovered:true};
}

async function main() {
  const [command,...args] = process.argv.slice(2);
  if (command === '--help' || command === 'help') { console.log(usage); return 0; }
  if (command === 'hooks-plan' || command === 'hooks-apply' || command === 'hooks-inspect' || command === 'hooks-recover') {
    try {
      console.log(JSON.stringify(runHookCommand(command,args)));
      return 0;
    } catch (error) {
      // Adapter and I/O errors can contain user-supplied commands, settings, or paths.
      console.error(error instanceof HookCliError ? error.message :
        `${command} failed. Check the configuration and workspace state. Use hooks-inspect to check for a pending operation.`);
      return 1;
    }
  }
  const {values,positionals} = parseArgs({args,allowPositionals:true,options:{config:{type:'string'},state:{type:'string'}}});
  if (!values.config || !command) throw Error(usage);
  const cfg = json(values.config);
  if (command === 'plan' || command === 'apply') {
    if (positionals.length || (command === 'apply') !== Boolean(values.state)) throw Error(usage);
    const plan = parseLayout(cfg);
    console.log(JSON.stringify(command === 'plan' ? {files:plan.files.map(f=>f.path), requiredVars:plan.requiredVars} : await apply(plan,values.state!,values.config)));
    return 0;
  }
  if (values.state || positionals.length > 1 || (command === 'zone' && positionals.length) ||
    (command !== 'path' && command !== 'zone' && command !== 'fresh' && command !== 'clone')) throw Error(usage);
  return runRepositoryCommand(navigation(cfg),command,{target:positionals[0]});
}
try { process.exitCode = await main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
}
