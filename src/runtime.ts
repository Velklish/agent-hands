import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { constants } from 'node:os';
import path from 'node:path';
import process from 'node:process';

export interface RuntimeTarget {
  readonly node: string;
  readonly entrypoint: string;
}

export interface EntrypointOptions {
  readonly replaceProcess?: boolean;
}

function isFullyQualified(value: string): boolean {
  if (process.platform !== 'win32') return path.posix.isAbsolute(value);
  // A single separator is absolute to win32.isAbsolute, but still inherits the current drive.
  return path.win32.isAbsolute(value) && path.win32.parse(value).root.length > 1;
}

function absolutePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isFullyQualified(value) || value.includes('\0')) {
    throw new TypeError(`Expected an absolute path: ${field}`);
  }
  return value;
}

export function parseRuntimeTarget(value: unknown): RuntimeTarget {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('Expected a runtime target object');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'node' && key !== 'entrypoint') throw new TypeError(`Unknown runtime target field: ${String(key)}`);
  }
  function read(field: keyof RuntimeTarget) {
    const property = Object.getOwnPropertyDescriptor(value, field);
    return absolutePath(property && 'value' in property ? property.value : undefined, field);
  }
  return Object.freeze({ node: read('node'), entrypoint: read('entrypoint') });
}

export function entrypointArgv(target: RuntimeTarget, args: readonly string[]): [entrypoint: string, ...args: string[]] {
  const { entrypoint } = parseRuntimeTarget(target);
  if (!Array.isArray(args)) throw new TypeError('Expected an argument array');
  const argv: [string, ...string[]] = [entrypoint];
  for (let index = 0; index < args.length; index++) {
    const arg: unknown = Object.getOwnPropertyDescriptor(args, index)?.value;
    if (typeof arg !== 'string' || arg.includes('\0')) throw new TypeError(`Invalid entrypoint argument at index ${index}`);
    argv.push(arg);
  }
  return argv;
}

export function supportsNode(version: string, minimumMajor: number): boolean {
  if (typeof version !== 'string' || !Number.isSafeInteger(minimumMajor) || minimumMajor < 1) {
    throw new TypeError('Expected a Node version and a positive minimum major version');
  }
  return Number(/^(\d+)\./.exec(version)?.[1]) >= minimumMajor;
}

// True means the caller can load its main module in the current process.
export async function enterEntrypoint(target: RuntimeTarget, args: readonly string[], options: EntrypointOptions = {}): Promise<boolean> {
  const selected = parseRuntimeTarget(target);
  const nodeArgs = [...process.execArgv, ...entrypointArgv(selected, args)];
  const descriptor = options && Object.getOwnPropertyDescriptor(options, 'replaceProcess');
  const replaceProcess: unknown = descriptor?.value;
  if (!options || typeof options !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(options)) ||
    (descriptor && !('value' in descriptor)) ||
    Reflect.ownKeys(options).some(key => key !== 'replaceProcess') ||
    (replaceProcess !== undefined && typeof replaceProcess !== 'boolean')) {
    throw new TypeError('Expected entrypoint options with an optional replaceProcess boolean');
  }
  if (realpathSync(selected.node) === realpathSync(process.execPath)) return true;
  if (replaceProcess && process.execve) process.execve(selected.node, [selected.node, ...nodeArgs], process.env);

  const child = spawn(selected.node, nodeArgs, { stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    process.exitCode = await new Promise<number>(resolve => {
      child.once('error', error => { console.error(error.message); resolve(1); });
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
  return false;
}
