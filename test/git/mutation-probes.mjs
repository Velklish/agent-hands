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
    find: 'const top = gitToplevel(abs);\n        if (!top)', replace: 'const top = gitToplevel(abs) ?? abs;\n        if (!top)' },
  { name: 'ambiguous origin', module: 'navigation', file: 'navigation', target: 'unreadable, missing, competing and multiple origin',
    find: "throw new OriginError('ambiguous', abs);", replace: 'origins.splice(0, origins.length - 1);' },
  { name: 'disk fallback', module: 'navigation', file: 'navigation', target: 'a nested cwd preserves namespace priority',
    find: 'if (disk.exists && disk.nsPath)\n                return diskResult();', replace: 'if (nsPath && disk.exists && disk.nsPath)\n                return diskResult();' },
  { name: 'namespace priority', module: 'navigation', file: 'navigation', target: 'a nested cwd preserves namespace priority',
    find: /(if \(nsPath && isCloneDir\(repoAbsPath\(root, nsPath\)\)\)\s+return fromNs\(nsPath, 'namespace'\);)\s+(if \(crossesExternal\)\s+throw new NavigationError\([^\n]+;)/,
    replace: '$2\n            $1' },
  { name: 'cross-zone fallback', module: 'navigation', file: 'navigation', target: 'a nested cwd preserves namespace priority',
    find: /if \(crossesExternal\)\s+throw new NavigationError\([^\n]+;/, replace: '' },
  { name: 'launcher environment isolation', fixture: 'fixture', file: 'process', target: 'the requested Git launcher is witnessed',
    env: { FIXTURE_NODE_GIT_LAUNCHER: '1', GIT_FIXTURE_NODE_LAUNCHER: '1' },
    find: "process.platform === 'win32' || process.env.FIXTURE_NODE_GIT_LAUNCHER === '1';", replace: "process.platform === 'win32' || process.env.GIT_FIXTURE_NODE_LAUNCHER === '1';" },
  { name: 'index writes in zone scan', module: 'state', file: 'state', target: 'zone scan leaves stale index stat data untouched',
    find: "git(abs, '--no-optional-locks', 'status'", replace: "git(abs, 'status'" },
  { name: 'excluded build directories', module: 'layout', file: 'layout', target: 'discovery finds deep and flat clones',
    find: "'packages', 'dist', 'build'", replace: "'packages', 'build'" },
  { name: 'missing origin category', module: 'navigation', file: 'public-navigation', target: 'the root API exposes group routes',
    find: "throw new OriginError('missing', abs);", replace: "throw new OriginError('mismatch', abs);" },
  { name: 'selected namespace scan', module: 'navigation', file: 'public-navigation', target: 'the root API locates checkouts',
    find: 'scanZone(root, namespaces)', replace: 'scanZone(root)' },
  { name: 'explicit reference', module: 'process', file: 'public-navigation', target: 'an explicit URL clone and ref fetch',
    find: 'gitFetch(dir, fetchTarget(dir), [ref]', replace: 'gitFetch(dir, fetchTarget(dir), []' },
  { name: 'scan root identity', module: 'state', file: 'public-navigation', target: 'targeted scan cannot report the enclosing checkout',
    find: 'if (!samePath(top.out, abs))', replace: 'if (false)' },
  { name: 'search result validation', module: 'navigation', file: 'public-navigation', target: 'untyped search results fail',
    find: 'remoteCandidates(await search(target))', replace: 'await search(target)' },
];

function verify(probe, expected) {
  const args = ['--test', '--test-reporter=tap', `--test-name-pattern=${probe.target}`, `test/git/${probe.file}.test.mjs`];
  const result = spawnSync(process.execPath, args, { cwd: sandbox, env: { ...process.env, ...probe.env }, encoding: 'utf8', timeout: 90_000, killSignal: 'SIGKILL' });
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
  const { name, type, exports } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name, type, exports }));
  cpSync(path.join(root, 'node_modules/yaml'), path.join(sandbox, 'node_modules/yaml'), { recursive: true });
  for (const probe of probes) {
    if (process.platform === 'win32' && ['real destination identity', 'lexical zone boundary'].includes(probe.name)) {
      console.log(`${probe.name}: skipped (requires a symlink fixture)`);
      continue;
    }
    if (process.platform === 'win32' && probe.fixture) {
      console.log(`${probe.name}: skipped (Windows always uses the Node launcher)`);
      continue;
    }
    const file = probe.fixture ? path.join(sandbox, 'test/git', `${probe.fixture}.mjs`) : path.join(sandbox, 'dist/git', `${probe.module}.js`);
    const original = readFileSync(file, 'utf8');
    const matches = typeof probe.find === 'string'
      ? original.split(probe.find).length - 1 : [...original.matchAll(new RegExp(probe.find.source, `${probe.find.flags}g`))].length;
    assert.equal(matches, 1, `${probe.name}: expected one mutation site`);
    writeFileSync(file, original.replace(probe.find, probe.replace));
    verify(probe, 1);
    writeFileSync(file, original);
    verify(probe, 0);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
