import { grouped } from '../../../hooks/grouped.js';
import { preferences, preferencePath } from './preferences.js';
import { plugin, registrationFiles } from './plugin.js';
export const hooks = { ...grouped, path: '.claude/settings.json', preferences, preferencePath, plugin, registrationFiles };
