import { applyLayout, parseLayout, planLayout, readLayoutState, type LayoutInput, type LayoutPlan, type LayoutResult } from 'agent-hands';

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
