import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function fixture(t) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'workspace-git-')));
  const previous = new Map(Object.entries(process.env).filter(([key]) => key.startsWith('GIT_') || key === 'PATH'));
  for (const key of previous.keys()) if (key !== 'PATH') delete process.env[key];
  Object.assign(process.env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'empty-config'),
    GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0',
  });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
    for (const [key, value] of previous) process.env[key] = value;
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

export function git(dir, ...args) {
  const result = spawnSync('git', ['-C', dir, '-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.test', ...args], {
    encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL',
  });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.error}`);
  return result.stdout.trim();
}

export function commit(dir, name) {
  writeFileSync(path.join(dir, name), `${name}\n`);
  git(dir, 'add', '--', name);
  git(dir, 'commit', '-qm', name);
  return git(dir, 'rev-parse', 'HEAD');
}

export function seed(dir, branch = 'main') {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-qb', branch);
  commit(dir, 'first');
  return dir;
}

export function checkout(source, dir) {
  mkdirSync(path.dirname(dir), { recursive: true });
  git(path.dirname(dir), 'clone', '--quiet', '--', source, dir);
  return dir;
}

export function config(entries) {
  process.env.GIT_CONFIG_COUNT = String(entries.length);
  for (const [i, [key, value]] of entries.entries()) {
    process.env[`GIT_CONFIG_KEY_${i}`] = key;
    process.env[`GIT_CONFIG_VALUE_${i}`] = value;
  }
}

export function stubGit(t, base, body) {
  const dir = path.join(base, 'stub');
  const log = path.join(base, 'git.jsonl');
  mkdirSync(dir);
  const launcher = process.platform === 'win32' || process.env.FIXTURE_NODE_GIT_LAUNCHER === '1';
  const script = path.join(dir, 'git.mjs');
  writeFileSync(script, `
    import { appendFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    const [launcher, ...argv] = process.argv.slice(2);
    const args = [...argv];
    let cwd = '';
    while (['-C', '-c', '--no-optional-locks'].includes(args[0])) {
      const opt = args.shift();
      if (opt === '-C') cwd = args.shift();
      if (opt === '-c') args.shift();
    }
    const cmd = args[0];
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ launcher, argv, args, cmd, cwd }) + '\\n');
    const cwdEndsWith = (name) => cwd.replaceAll('\\\\', '/').endsWith('/' + name);
    const real = () => {
      const result = spawnSync('git', argv, { env: { ...process.env, PATH: ${JSON.stringify(process.env.PATH)} }, stdio: 'inherit' });
      process.exit(result.status ?? 128);
    };
    ${body}
    real();
  `);
  if (launcher) {
    // Windows cannot launch a .cmd shim via execFile without a shell. Redirect only
    // the executable at the test boundary so argv, options and real child exits survive.
    const { spawnSync: sync, execFile: async } = childProcess;
    const redirect = (run) => (exe, args, ...rest) => exe === 'git'
      ? run(process.execPath, [script, 'node', ...args], ...rest) : run(exe, args, ...rest);
    childProcess.spawnSync = redirect(sync);
    childProcess.execFile = redirect(async);
    syncBuiltinESMExports();
    t.after(() => {
      childProcess.spawnSync = sync;
      childProcess.execFile = async;
      syncBuiltinESMExports();
    });
  } else {
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(path.join(dir, 'git'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} path "$@"\n`, { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${previous}`;
    t.after(() => { process.env.PATH = previous; });
  }
  return {
    calls: () => {
      try {
        const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
        if (process.env.FIXTURE_NODE_GIT_LAUNCHER === '1' || process.platform === 'win32') {
          assert.ok(calls.every((call) => call.launcher === 'node'), 'expected the Node Git launcher');
        }
        return calls;
      }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
    reset: () => rmSync(log, { force: true }),
  };
}

export const posix = { skip: process.platform === 'win32' && 'requires POSIX symlink or subprocess fixtures' };
export const routeHost = (host) => {
  if (['github.com', 'code.one.test', 'code.two.test'].includes(host)) return { zone: 'external' };
  if (['git.one.test', 'git.two.test', 'git.one.test:22'].includes(host)) return { zone: 'repos', gitlab: true };
};

export function command(run, options) {
  return async (name, target, flags) => {
    const out = [], err = [];
    const exit = await run(options, name, { ...flags, target }, { out: (text) => out.push(text), err: (text) => err.push(text) });
    return { exit, out, err };
  };
}
