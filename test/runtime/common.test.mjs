import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { enterEntrypoint, entrypointArgv, parseRuntimeTarget, supportsNode } from '../../dist/runtime.js';
const target = { node: process.execPath, entrypoint: process.execPath };
test('validates own data fields and preserves argument boundaries', async () => {
    assert.deepEqual(entrypointArgv(target, ['', 'two words']), [target.entrypoint, '', 'two words']);
    for (const bad of [null, {}, { ...target, extra: true }, { ...target, entrypoint: 'relative' }, Object.create(target), { ...target, get node() { throw Error('getter invoked'); } }])
        assert.throws(() => parseRuntimeTarget(bad), TypeError);
    assert.throws(() => entrypointArgv(target, ['\0']), TypeError);
    assert.equal(await enterEntrypoint(target, []), true);
    assert.equal(supportsNode('20.0.1', 21), false);
    assert.equal(supportsNode('21.0.0', 21), true);
});
test('win32 path grammar requires a drive root or a server and share in both fields', () => {
    const probe = `import assert from 'node:assert/strict';
    import {parseRuntimeTarget} from ${JSON.stringify(new URL('../../dist/runtime.js', import.meta.url).href)};
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const [valid, invalid] = JSON.parse(process.argv[1]);
    for (const field of ['node', 'entrypoint']) {
      const target = {node: valid[0], entrypoint: valid[0]};
      for (const value of valid) assert.equal(parseRuntimeTarget({...target, [field]: value})[field], value);
      for (const value of invalid) assert.throws(() => parseRuntimeTarget({...target, [field]: value}), TypeError, value);
    }`;
    const valid = [String.raw `D:\tools\node.exe`, 'D:/tools/node.exe', String.raw `\\server\share\bin\main.js`];
    const invalid = [String.raw `\tools\node.exe`, '/tools/node.exe', String.raw `D:tools\main.js`, 'D:', String.raw `\\server`];
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, JSON.stringify([valid, invalid])], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
});
test('standalone runtime executes the supplied entrypoint and propagates exit code', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'entrypoint-'));
    try {
        const node = path.join(root, path.basename(process.execPath));
        if (process.platform === 'win32')
            copyFileSync(process.execPath, node);
        else
            writeFileSync(node, `#!/bin/sh\nexec "$TEST_NODE" "$@"\n`, { mode: 0o755 });
        copyFileSync(new URL('../../dist/runtime.js', import.meta.url), path.join(root, 'runtime.mjs'));
        const entrypoint = path.join(root, 'selected main.mjs');
        writeFileSync(entrypoint, 'console.log(JSON.stringify(process.argv.slice(2)));process.exitCode=37;');
        writeFileSync(path.join(root, 'launch.mjs'), `import {enterEntrypoint} from './runtime.mjs';await enterEntrypoint(${JSON.stringify({ node, entrypoint })}, ['two words', '']);`);
        const result = spawnSync(process.execPath, ['launch.mjs'], { cwd: root, env: { TEST_NODE: process.execPath, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot }, encoding: 'utf8' });
        assert.equal(result.status, 37, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), ['two words', '']);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
