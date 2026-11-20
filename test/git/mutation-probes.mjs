import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'git-mutation-probes-'));
const probes = [
  { name: 'origin check', module: 'navigation', file: 'navigation', target: 'lookup and clone verify the original origin',
    find: 'if (!origin || !sameRepositoryUrl(origin, url, routeHost))', replace: 'if (false)' },
  { name: 'failed fetch guard', module: 'fresh', file: 'fresh', target: 'a failed fetch cannot fast-forward',
    find: 'observeOnly || !fetchOk || !res.behind', replace: 'observeOnly || !res.behind' },
  { name: 'real destination identity', module: 'layout', file: 'navigation', target: 'a symlink destination is not the directory',
    find: "real.normalize('NFC') === dest.normalize('NFC')", replace: 'true' },
  { name: 'lexical zone boundary', module: 'navigation', file: 'fresh', target: 'zone aliases cannot refresh the enclosing workspace',
    find: 'workZone(path.resolve(root), path.resolve(abs), true) ?? ', replace: '' },
  { name: 'invalid paginated response', module: 'gitlab', file: 'gitlab', target: 'GitLab rejects malformed JSON',
    find: 'if (!Array.isArray(response.json)) {', replace: 'if (soft && !Array.isArray(response.json)) return []; if (!Array.isArray(response.json)) {' },
  { name: 'sandbox boundary', module: 'navigation', file: 'fresh', target: 'fresh resolves names before mutation',
    find: 'return WORKSPACE_DIRS.find', replace: "return WORKSPACE_DIRS.filter((zone) => zone !== 'sandbox').find" },
  { name: 'origin read failure', module: 'navigation', file: 'navigation', target: 'unreadable, missing, competing and multiple origin',
    find: 'result.status === 1 && !result.error && !result.signal && !result.stderr && !result.stdout', replace: 'result.status !== 0' },
  { name: 'project page transport', module: 'address', file: 'navigation', target: 'lookup and clone verify the original origin',
    find: /isProjectPage \? clean\.replace\([^\n]+ : clean/, replace: 'clean' },
  { name: 'unknown command', module: 'navigation', file: 'navigation', target: 'unknown command refuses before discovery',
    find: "command !== 'zone' && command !== 'fresh' && command !== 'clone' && command !== 'path'", replace: 'false' },
  { name: 'unverified Git root', module: 'navigation', file: 'fresh', target: 'fresh stops after the first failed top-level query',
    find: 'const top = gitToplevel(abs);\n        if (!top || isEnclosingRepo', replace: 'const top = gitToplevel(abs) ?? abs;\n        if (!top || isEnclosingRepo' },
  { name: 'ambiguous origin', module: 'navigation', file: 'navigation', target: 'unreadable, missing, competing and multiple origin',
    find: "throw new OriginError('ambiguous', abs);", replace: 'origins.splice(0, origins.length - 1);' },
  { name: 'disk fallback', module: 'navigation', file: 'navigation', target: 'a valid disk path from a nested cwd',
    find: 'if (disk.exists && disk.nsPath)\n                return diskResult();', replace: 'if (nsPath && disk.exists && disk.nsPath)\n                return diskResult();' },
  { name: 'index writes in zone scan', module: 'state', file: 'state', target: 'zone scan leaves stale index stat data untouched',
    find: "git(abs, labels, '--no-optional-locks', 'status'", replace: "git(abs, labels, 'status'" },
  { name: 'excluded build directories', module: 'layout', file: 'layout', target: 'discovery finds deep and flat clones',
    find: "'packages', 'dist', 'build'", replace: "'packages', 'build'" },
];

function verify(probe, expected) {
  const args = ['--test', '--test-reporter=tap', `--test-name-pattern=${probe.target}`, `test/git/${probe.file}.test.mjs`];
  const result = spawnSync(process.execPath, args, { cwd: sandbox, encoding: 'utf8', timeout: 90_000, killSignal: 'SIGKILL' });
  assert.equal(result.status, expected, `${probe.name}: ${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  assert.match(result.stdout, /^# tests 1$/m);
  assert.match(result.stdout, /^# skipped 0$/m);
  const verdict = expected === 0 ? 'ok' : 'not ok';
  const witnessed = result.stdout.match(new RegExp(`^${verdict} 1 - (${probe.target}[^\r\n]*)$`, 'm'));
  assert.ok(witnessed, result.stdout);
  assert.match(result.stdout, new RegExp(`^# fail ${expected}$`, 'm'));
  if (expected !== 0) assert.match(result.stdout, /ERR_ASSERTION/);
  console.log(`${probe.name}: exit ${result.status}, ${verdict} — ${witnessed[1]}`);
}

try {
  cpSync(path.join(root, 'dist'), path.join(sandbox, 'dist'), { recursive: true });
  cpSync(path.join(root, 'test/git'), path.join(sandbox, 'test/git'), { recursive: true });
  writeFileSync(path.join(sandbox, 'package.json'), '{"type":"module"}\n');
  for (const probe of probes) {
    if (process.platform === 'win32' && ['real destination identity', 'lexical zone boundary'].includes(probe.name)) {
      console.log(`${probe.name}: skipped (requires a symlink fixture)`);
      continue;
    }
    const file = path.join(sandbox, 'dist/git', `${probe.module}.js`);
    const original = readFileSync(file, 'utf8');
    assert.equal(original.split(probe.find).length, 2, `${probe.name}: expected one mutation site`);
    writeFileSync(file, original.replace(probe.find, probe.replace));
    verify(probe, 1);
    writeFileSync(file, original);
    verify(probe, 0);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
