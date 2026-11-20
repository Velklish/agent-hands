import path from 'node:path';
import { SHARED_DIR } from './skills.js';
export function stageContent(writer, adapter, content) {
    const { skillsDir, agentsDir, ext, renderAgent } = adapter;
    for (const skill of content.skills)
        writer.copyDir(skill.dirAbs, path.join(skillsDir, skill.name), { kind: 'skill', name: skill.name }, skill.source);
    for (const [sourceIndex, item] of content.sharedDirs.entries())
        writer.copyDir(item.srcAbs, path.join(skillsDir, SHARED_DIR), { kind: 'support', sourceIndex }, item.source);
    for (const agent of content.subagents)
        writer.stage(path.join(agentsDir, `${agent.name}.${ext}`), renderAgent(agent), { kind: 'subagent', name: String(agent.name) });
}
