import path from 'node:path';
import type { AgentDefinition } from './subagents.js';
import type { LayoutAdapter } from './adapter.js';
import { SHARED_DIR } from './skills.js';

export type SelectedContent = {
  skills: readonly { name: string; dirAbs: string; source?: string }[];
  sharedDirs: readonly { srcAbs: string; source?: string }[];
  subagents: readonly AgentDefinition[];
};
export type ResourceOwner = { kind: 'skill'; name: string } | { kind: 'support'; sourceIndex: number } | { kind: 'subagent'; name: string };
type Stage = {
  copyDir(source: string, path: string, resource: ResourceOwner, origin?: string): void;
  stage(path: string, content: string, resource: ResourceOwner): void;
};
export function stageContent(writer: Stage, adapter: LayoutAdapter, content: SelectedContent) {
  const {skillsDir, agentsDir, ext, renderAgent} = adapter;
  for (const skill of content.skills) writer.copyDir(skill.dirAbs, path.join(skillsDir, skill.name), { kind: 'skill', name: skill.name }, skill.source);
  for (const [sourceIndex, item] of content.sharedDirs.entries()) writer.copyDir(item.srcAbs, path.join(skillsDir, SHARED_DIR), { kind: 'support', sourceIndex }, item.source);
  for (const agent of content.subagents) writer.stage(path.join(agentsDir, `${agent.name}.${ext}`), renderAgent(agent), { kind: 'subagent', name: String(agent.name) });
}
