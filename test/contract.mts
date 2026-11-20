import { applyLayout, parseLayout, planLayout, readLayoutState, type LayoutChangeSet, type LayoutInput, type LayoutPlan, type LayoutResult } from 'agent-hands';
import { planWorkspaceHooks, applyWorkspaceHooks, recoverWorkspaceHooks, type WorkspaceHookDiagnostic, type WorkspaceHookInput, type WorkspaceHookResult } from 'agent-hands';
const hookInput: WorkspaceHookInput = { root:'/example',target:'claude',enabled:true,hooks:[{ owner:'example',event:'SessionStart',command:'example',timeout:4 }] };
const hookResult: WorkspaceHookResult = planWorkspaceHooks(hookInput);
const hookDiagnostics: readonly WorkspaceHookDiagnostic[] | undefined = hookResult.diagnostics;
void hookDiagnostics;
applyWorkspaceHooks({root:hookInput.root,selections:[hookInput]});
recoverWorkspaceHooks({root:hookInput.root,targets:['cursor','codex']});
// @ts-expect-error Ownership paths are internal.
applyWorkspaceHooks({...hookInput,state:'/override'});

const input: LayoutInput = { root: '/project', target: 'cursor', skills: [], servers: [], subagents: [], rules: [] };
const plan: LayoutPlan = planLayout(input);
const raw: unknown = JSON.parse('{}');
const applied: Promise<LayoutResult> = applyLayout(plan, readLayoutState(raw));
void applied;
void applyLayout(parseLayout(raw));

// @ts-expect-error Invalid tool identifiers are not accepted by typed callers.
planLayout({ ...input, target: 'crusor' });
// @ts-expect-error Required content is not optional.
planLayout({ root: input.root, target: input.target, skills: [], servers: [], subagents: [] });
// @ts-expect-error Display data is not an applicable plan.
void applyLayout({ root: '/project', files: [] });

for (const target of ['cursor', 'codex'] as const) {
  const selected: LayoutInput = { ...input, target };
  const result: Promise<LayoutResult> = applyLayout(planLayout(selected));
  void result;
}

const staged = (changes: LayoutChangeSet) => {
  changes.assertCurrent();
  const ownership = readLayoutState(JSON.parse(JSON.stringify(changes.state)));
  for (const write of changes.writes) void (write.secure && write.path);
  void ownership;
};
void applyLayout(planLayout({...input,scope:'mcp',mcp:{compatibility:'report',unowned:'adopt-identical'},
  rules:[{path:'/project/rules.md',optional:true}],servers:[{name:'example',placeholders:'literal',definition:{command:'node'}}]}),undefined,{stage:staged});
// @ts-expect-error A caller cannot name an output path in the MCP policy.
planLayout({...input,mcp:{path:'.custom'}});
