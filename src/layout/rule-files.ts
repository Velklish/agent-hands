import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function ruleFiles(files: readonly string[], { optional = false } = {}) {
  return files.filter(file => {
    if (!path.isAbsolute(file)) throw new TypeError(`Expected an absolute rule file: ${file}`);
    if (optional) return existsSync(file);
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new TypeError(`Expected a regular rule file: ${file}`);
    return true;
  });
}

export function readRules(files: readonly string[]) {
  return ruleFiles(files).map(file => ({ file, content: readFileSync(file, 'utf8') }));
}
