import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const list = directory => readdirSync(directory, { withFileTypes:true, recursive:true })
  .filter(entry => !entry.isDirectory())
  .map(entry => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
  .sort();
const tracked = execFileSync('git', ['ls-files', '-z', 'dist/'], {encoding:'utf8'})
  .split('\0').filter(Boolean).map(file => file.slice('dist/'.length)).sort();
const output = mkdtempSync(path.join(tmpdir(), 'agent-hands-dist-'));
try {
  for (const file of ['src', 'package.json', 'tsconfig.json'])
    cpSync(file, path.join(output, file), {recursive:true});
  symlinkSync(path.resolve('node_modules'), path.join(output, 'node_modules'), 'junction');
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {cwd:output, stdio:'inherit'});
  const generated = path.join(output, 'dist');
  assert.deepEqual(list(generated), tracked, 'Generated and tracked dist file sets differ');
  assert.deepEqual(list('dist'), tracked, 'Working and tracked dist file sets differ');
  for (const file of tracked) {
    assert.ok(readFileSync(path.join(generated, file)).equals(readFileSync(path.join('dist', file))), `dist/${file} differs from the build`);
  }
  console.log(`Verified ${tracked.length} tracked distribution files against an isolated build`);
} finally {
  rmSync(output, {recursive:true, force:true});
}
