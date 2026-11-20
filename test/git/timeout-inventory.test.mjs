import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const sourceDir = fileURLToPath(new URL('../../src/git/', import.meta.url));
const direct = new Set(['spawnSync', 'spawn', 'execFile', 'execFileSync', 'exec', 'execSync']);

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(file);
    return entry.name.endsWith('.ts') ? [file] : [];
  }).sort();
}

function effectiveOptions(node, result = new Map()) {
  if (!node || !ts.isObjectLiteralExpression(node)) return result;
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) {
      if (ts.isObjectLiteralExpression(prop.expression)) effectiveOptions(prop.expression, result);
      else result.clear();
      continue;
    }
    const name = prop.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
      if (ts.isPropertyAssignment(prop)) result.set(name.text, prop.initializer);
      else if (ts.isShorthandPropertyAssignment(prop)) result.set(name.text, prop.name);
      else result.delete(name.text);
    } else if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
      if (ts.isPropertyAssignment(prop)) result.set(name.expression.text, prop.initializer);
      else result.delete(name.expression.text);
    } else result.clear();
  }
  return result;
}

function launches(file, text = readFileSync(file, 'utf8')) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  function visit(node, owner) {
    if (ts.isFunctionDeclaration(node)) owner = node.name?.text;
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === 'git') {
      found.push({ file: path.basename(file), fn: node.expression.getText(source), owner,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        options: effectiveOptions(node.arguments[2]) });
    }
    ts.forEachChild(node, (child) => visit(child, owner));
  }
  visit(source);
  return found;
}

function violations({ fn, options }) {
  if (!direct.has(fn)) return ['unclassified launch'];
  const timeout = options.get('timeout');
  const kill = options.get('killSignal');
  const buffer = options.get('maxBuffer');
  const reference = (value) => value && ts.isIdentifier(value) && value.text !== 'undefined';
  return [
    !reference(timeout) && 'no named timeout',
    !(kill && ts.isStringLiteralLike(kill) && kill.text === 'SIGKILL') && 'no SIGKILL',
    !reference(buffer) && 'no named output limit',
  ].filter(Boolean);
}

test('the Git launch inventory is nonempty and every launch owns its timeout, kill signal and output limit', () => {
  const found = files(sourceDir).flatMap((file) => launches(file));
  assert.deepEqual(found.map(({ file, fn, owner }) => `${file}:${owner}:${fn}`), ['process.ts:gitRun:spawnSync', 'state.ts:git:execFile']);
  for (const run of found) assert.deepEqual(violations(run), [], `${run.file}:${run.line}`);
  const processSource = readFileSync(path.join(sourceDir, 'process.ts'), 'utf8');
  assert.match(processSource, /function gitRun\(args[^\n]+timeoutMs = GIT_NET_TIMEOUT_MS/);
  assert.equal(found[0].options.get('timeout').getText(), 'timeoutMs');
  assert.equal(found[1].options.get('timeout').getText(), 'GIT_LOCAL_TIMEOUT_MS');
  assert.ok(found.every(({ options }) => options.get('maxBuffer').getText() === 'GIT_MAX_OUTPUT'));
  assert.match(processSource, /function gitToplevel[\s\S]*?gitRun\(\['-C', dir, 'rev-parse', '--show-toplevel'\]\)/);
});

test('the launch inventory detects unsafe spread overrides, omitted guards and unknown call forms', () => {
  const base = "timeout: ceiling, killSignal: 'SIGKILL', maxBuffer: limit";
  const scan = (options) => violations(launches('fixture.ts', `spawnSync('git', [], {${options}})`)[0]);
  assert.deepEqual(scan(`${base}, ...{timeout: 0, killSignal: 'SIGTERM'}`), ['no named timeout', 'no SIGKILL']);
  assert.deepEqual(scan(`...unknown, ${base}`), []);
  assert.deepEqual(scan(`${base}, ...unknown`), ['no named timeout', 'no SIGKILL', 'no named output limit']);
  assert.deepEqual(scan(`${base}, ...{windowsHide: true}`), []);
  assert.deepEqual(scan(`${base}, timeout: undefined`), ['no named timeout']);
  assert.deepEqual(scan(`${base}, ...{timeout: undefined}`), ['no named timeout']);
  assert.deepEqual(scan(`...{timeout: undefined}, ${base}`), []);
  assert.deepEqual(scan(`${base}, maxBuffer: undefined`), ['no named output limit']);
  assert.deepEqual(scan("timeout: 5_000, killSignal: 'SIGTERM'"), ['no named timeout', 'no SIGKILL', 'no named output limit']);
  assert.deepEqual(violations(launches('fixture.ts', `unknownLauncher(\`git\`, [], {${base}})`)[0]), ['unclassified launch']);
});
