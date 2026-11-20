import path from 'node:path';
import type { AgentDefinition } from './subagents.js';
import type { LayoutAdapter } from './adapter.js';
import { SHARED_DIR } from './skills.js';

export type SelectedContent = {
  skills: readonly { name: string; dirAbs: string; source?: string }[];
  sharedDirs: readonly { srcAbs: string; source?: string }[];
  subagents: readonly AgentDefinition[];
};
type Stage = {
  copyDir(source: string, path: string, options?: { origin?: string | null }): void;
  stage(path: string, content: string, options?: { origin?: string | null }): void;
};
export function stageContent(writer: Stage, adapter: LayoutAdapter, content: SelectedContent) {
  const {skillsDir, agentsDir, ext, renderAgent} = adapter;
  for (const skill of content.skills) writer.copyDir(skill.dirAbs, path.join(skillsDir, skill.name), { origin: skill.source });
  for (const item of content.sharedDirs) writer.copyDir(item.srcAbs, path.join(skillsDir, SHARED_DIR), { origin: item.source });
  for (const agent of content.subagents) writer.stage(path.join(agentsDir, `${agent.name}.${ext}`), renderAgent(agent));
}
