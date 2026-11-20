import { fileURLToPath } from 'node:url';
const locate = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
export const bundledAssets = Object.freeze({
  workspaceRules: Object.freeze(['AGENTS.md', 'workspace.md'].map(name => locate(`../assets/rules/${name}`))),
  workspaceTemplate: locate('../assets/templates/workspace/AGENTS.md'),
  askingQuestions: locate('../assets/skills/asking-questions'),
  voiceCalibration: locate('../profiles/my-voice/skills/my-voice-calibrate'),
});
