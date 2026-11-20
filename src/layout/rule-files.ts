import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fields } from './stdio.js';

export type LayoutRule = string | {path: string; optional?: boolean};

export function selectRuleEntries(entries: readonly unknown[]) {
  return entries.flatMap(entry => {
    const {path: file,optional} = typeof entry === 'string' ? {path:entry,optional:false} : fields(entry,'rule',['path','optional']);
    if (typeof file !== 'string') throw new TypeError('Expected an absolute rule file');
    if (optional !== undefined && typeof optional !== 'boolean') throw new TypeError('Invalid optional rule flag');
    return ruleFiles([file],{optional}).map(file=>({file}));
  });
}

export function ruleFiles(files: readonly string[], { optional = false } = {}) {
  return files.filter(file => {
    if (!path.isAbsolute(file)) throw new TypeError(`Expected an absolute rule file: ${file}`);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat && optional) return false;
    if (!stat?.isFile()) throw new TypeError(`Expected a regular rule file: ${file}`);
    return true;
  });
}

export function readRule(file: string) {
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new TypeError(`Expected a regular rule file: ${file}`);
  return readFileSync(file);
}
