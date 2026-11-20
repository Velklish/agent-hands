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
    find: "real.normalize('NFC') === dest.normalize('NFC')", replace: 'relativeInside(base, real) !== null' },
];

function verify(probe, expected) {
  const args = ['--test', '--test-reporter=tap', `--test-name-pattern=${probe.target}`, `test/git/${probe.file}.test.mjs`];
  const result = spawnSync(process.execPath, args, { cwd: sandbox, encoding: 'utf8', timeout: 90_000, killSignal: 'SIGKILL' });
  assert.equal(result.status, expected, `${probe.name}: ${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  assert.match(result.stdout, /^# tests 1$/m);
  assert.match(result.stdout, /^# skipped 0$/m);
  const verdict = expected === 0 ? 'ok' : 'not ok';
  assert.match(result.stdout, new RegExp(`^${verdict} 1 - ${probe.target}`, 'm'));
  assert.match(result.stdout, new RegExp(`^# fail ${expected}$`, 'm'));
  if (expected !== 0) assert.match(result.stdout, /ERR_ASSERTION/);
  console.log(`${probe.name}: exit ${result.status}, ${verdict} — ${probe.target}`);
}

try {
  cpSync(path.join(root, 'dist'), path.join(sandbox, 'dist'), { recursive: true });
  cpSync(path.join(root, 'test/git'), path.join(sandbox, 'test/git'), { recursive: true });
  writeFileSync(path.join(sandbox, 'package.json'), '{"type":"module"}\n');
  for (const probe of probes) {
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
