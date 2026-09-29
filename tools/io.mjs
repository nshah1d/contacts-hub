import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { decodeBytes, invariant, LIMITS } from '../public/js/core/primitives.js';
/**
 * Reads a regular file without following a link, and fails if the file changes size or
 * modification time during the read.
 * @param {string} filename
 * @param {number} [max] Byte limit.
 * @returns {Promise<{bytes: Buffer, name: string}>}
 */
export async function readInput(filename, max = LIMITS.sourceBytes) {
    const stat = await fs.lstat(filename);
    invariant(stat.isFile() && !stat.isSymbolicLink(), 'Choose a regular input file, not a symbolic link.');
    invariant(stat.size <= max, 'The input exceeds its byte limit.');
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
        const before = await handle.stat(), bytes = await handle.readFile(), after = await handle.stat();
        invariant(bytes.length <= max && before.size === after.size && before.mtimeMs === after.mtimeMs, 'The source changed while it was read.');
        return { bytes, name: path.basename(filename) };
    }
    finally {
        await handle.close();
    }
}
export async function readSource(filename) {
    const { bytes, name } = await readInput(filename);
    return { text: decodeBytes(bytes), name };
}
/** Creates an owner-only output file that must not already exist, and syncs it to storage; a failed write removes it. */
export async function writeNew(filename, content) {
    const handle = await fs.open(filename, 'wx', 0o600);
    try {
        await handle.writeFile(content);
        await handle.sync();
    }
    catch (e) {
        await handle.close();
        await fs.unlink(filename).catch(() => {
        });
        throw e;
    }
    await handle.close();
}
