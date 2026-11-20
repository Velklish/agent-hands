import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const toPosix = (file) => file.split(path.sep).join('/');
export const isInnerRelPath = (file) => typeof file === 'string'
    && Boolean(file.trim()) && !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..');
export function writeAtomic(file, bytes, { mode = null, stagingDir } = {}) {
    const dir = path.dirname(file);
    mkdirSync(dir, { recursive: true });
    const temporary = path.join(stagingDir ?? dir, `.layout-${randomUUID()}`);
    try {
        writeFileSync(temporary, bytes, { flag: 'wx', mode: mode ?? undefined });
        if (mode !== null)
            chmodSync(temporary, mode);
        renameSync(temporary, file);
    }
    catch (error) {
        rmSync(temporary, { recursive: true, force: true });
        throw error;
    }
}
export function directoryLink(target, destination) {
    mkdirSync(path.dirname(destination), { recursive: true });
    symlinkSync(path.resolve(target), destination, process.platform === 'win32' ? 'junction' : 'dir');
}
export function removeEntry(file) {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink())
        unlinkSync(file);
    else if (stat)
        rmSync(file, { recursive: true, force: true });
}
export function switchDirectoryBinding(destination, target, { hadOld, immediate = false }) {
    const next = `${destination}.next-${process.pid}`;
    const backup = `${destination}.previous-${process.pid}`;
    if (target)
        directoryLink(target, next);
    if (target && immediate) {
        try {
            renameSync(next, destination);
        }
        finally {
            removeEntry(next);
        }
        return { rollback() { }, finalize() { } };
    }
    try {
        if (hadOld)
            renameSync(destination, backup);
        try {
            if (target)
                renameSync(next, destination);
        }
        catch (error) {
            if (hadOld)
                renameSync(backup, destination);
            throw error;
        }
        return {
            rollback() { removeEntry(destination); if (hadOld)
                renameSync(backup, destination); },
            finalize() { if (hadOld)
                removeEntry(backup); },
        };
    }
    finally {
        removeEntry(next);
    }
}
export function isInside(root, file) {
    const resolved = (p) => existsSync(p) ? realpathSync(p) : path.resolve(p);
    const relative = path.relative(resolved(root), resolved(file));
    return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
export function sealSnapshot(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.isSymbolicLink())
            continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory())
            sealSnapshot(file);
        else if (entry.isFile())
            chmodSync(file, lstatSync(file).mode & 0o111 ? 0o555 : 0o444);
    }
    chmodSync(dir, 0o555);
}
export function removeTemporarySnapshot(dir) {
    if (!existsSync(dir))
        return;
    const writable = (file) => {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink())
            return;
        chmodSync(file, stat.mode | 0o700);
        if (stat.isDirectory())
            for (const entry of readdirSync(file))
                writable(path.join(file, entry));
    };
    writable(dir);
    rmSync(dir, { recursive: true, force: true });
}
