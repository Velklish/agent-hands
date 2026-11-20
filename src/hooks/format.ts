import { createRequire } from 'node:module';
import type { HookEntry, HookTarget, Slot } from './hook-plan.js';
import type { WorkspacePreferences, WorkspaceRegistration } from './options.js';
import type { TargetChange } from './hook-journal.js';
import type { ExternalHookChange } from './hook-operation.js';

export type Fields = Record<string, unknown>;
export interface HookFormat {
  preferences?(root:string,wanted:WorkspacePreferences,legacy?:WorkspacePreferences):{projectDocument:(text:string|null)=>string|null;change:()=>TargetChange};
  preferencePath?(root:string):string;
  plugin?(root:string,settings:TargetChange,input:WorkspaceRegistration):{changes:TargetChange[];steps:ExternalHookChange[];checkSource:()=>void};
  registrationFiles?(root:string,home:string):string[];
  path: string;
  empty(): Fields;
  accepts(shell: Fields): boolean;
  groupIndices(list: unknown[], owned: ReadonlySet<number>): number[];
  grouped: boolean;
  slots(event: string, index: number, groups: unknown[]): Slot[];
  matches(a: Fields, b: Fields): boolean;
  append(list: unknown[], entry: HookEntry): void;
  entry(owner: string, event: string, command: string, matcher?: string): HookEntry;
}
const load = createRequire(import.meta.url);
const formats = {
  claude: () => (load('../layout/adapters/claude/hooks.js') as typeof import('../layout/adapters/claude/hooks.js')).hooks,
  codex: () => (load('../layout/adapters/codex/hooks.js') as typeof import('../layout/adapters/codex/hooks.js')).hooks,
  cursor: () => (load('../layout/adapters/cursor/hooks.js') as typeof import('../layout/adapters/cursor/hooks.js')).hooks,
} satisfies Record<HookTarget,() => HookFormat>;
export function format(target: HookTarget): HookFormat {
  return formats[target]();
}
