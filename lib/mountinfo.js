'use strict';

// Mount state from /proc/self/mountinfo as data (issue #3). Nothing here calls
// `mountpoint` or lstat()s a mount point: lstat on a dead FUSE mount throws
// ENOTCONN. All I/O comes in through parameters so callers/tests can inject it.

const path = require('path');

const MOUNT_STATES = Object.freeze({
    UNMOUNTED: 'unmounted',
    MOUNTED: 'mounted',
    STALE: 'stale',
    FOREIGN: 'foreign',
    UNKNOWN: 'unknown',
});

const BACKSLASH = 0x5c;

function isOctal(byte) {
    return byte >= 0x30 && byte <= 0x37;
}

// Decode kernel octal escapes (\NNN, exactly three octal digits, value <= 0o377)
// in ONE left-to-right pass, so a decoded backslash is never re-interpreted:
// "\134040" -> "\040" (literal backslash, 0, 4, 0), not a space. Invalid or
// short sequences stay literal. Escapes are decoded as bytes and the result is
// decoded as UTF-8, so escaped multi-byte sequences round-trip.
function unescapeMountinfoField(str) {
    if (typeof str !== 'string' || !str.includes('\\')) return str;
    const input = Buffer.from(str, 'utf8');
    const out = Buffer.allocUnsafe(input.length);
    let o = 0;
    let i = 0;
    while (i < input.length) {
        const b = input[i];
        if (
            b === BACKSLASH &&
            i + 3 < input.length &&
            isOctal(input[i + 1]) &&
            isOctal(input[i + 2]) &&
            isOctal(input[i + 3])
        ) {
            const value = ((input[i + 1] - 0x30) << 6) | ((input[i + 2] - 0x30) << 3) | (input[i + 3] - 0x30);
            if (value <= 0xff) {
                out[o++] = value;
                i += 4;
                continue;
            }
        }
        out[o++] = b;
        i += 1;
    }
    return out.toString('utf8', 0, o);
}

const ID_RE = /^\d+$/;

function parseLine(line) {
    // Kernel-escaped fields never contain raw spaces, so a plain split is safe.
    const f = line.split(' ');
    // id parent major:minor root mountpoint options [optional...] - fstype source superopts
    if (f.length < 10) return null;
    if (!ID_RE.test(f[0]) || !ID_RE.test(f[1])) return null;
    // The optional fields (0..n) end at the first standalone "-" at index >= 6.
    let sep = -1;
    for (let i = 6; i < f.length; i++) {
        if (f[i] === '-') {
            sep = i;
            break;
        }
    }
    if (sep === -1 || f.length - sep - 1 < 2) return null; // need fstype + source
    if (f[3] === '' || f[4] === '' || f[sep + 1] === '') return null;
    return {
        mountId: Number(f[0]),
        parentId: Number(f[1]),
        root: unescapeMountinfoField(f[3]),
        mountPoint: unescapeMountinfoField(f[4]),
        fsType: f[sep + 1],
        source: unescapeMountinfoField(f[sep + 2]),
    };
}

// -> [{ mountId:number, parentId:number, root, mountPoint, fsType, source }] in
// file order (later entries are mounted later, i.e. on top). Malformed lines
// are skipped silently; never throws. mountPoint/root/source are unescaped,
// fsType is not (it never contains escapes).
function parseMountinfo(text) {
    const entries = [];
    if (typeof text !== 'string') return entries;
    for (const line of text.split('\n')) {
        if (line === '') continue;
        const entry = parseLine(line);
        if (entry) entries.push(entry);
    }
    return entries;
}

function describeError(err) {
    if (err && typeof err.message === 'string' && err.message) return err.message;
    return String(err);
}

// A mount at our managed path is ours iff it is an rclone FUSE mount. Its source
// cannot identify the remote: rclone records the backend's own fs string, so an
// `alias`/`union`/`crypt` remote shows its underlying path rather than "name:"
// (verified against a real kernel mount table). Any other filesystem type is foreign.
async function classifyMount({ entries, mountPoint, probe }) {
    const matches = (entries || []).filter((e) => e.mountPoint === mountPoint);
    if (matches.length === 0) {
        return { state: MOUNT_STATES.UNMOUNTED, message: 'not mounted', entry: undefined };
    }
    const entry = matches[matches.length - 1];
    const foreign = matches.find((e) => e.fsType !== 'fuse.rclone');
    if (foreign) {
        return {
            state: MOUNT_STATES.FOREIGN,
            message: `${mountPoint} is in use by another mount (${foreign.fsType} ${foreign.source})`,
            entry,
        };
    }
    try {
        await probe(mountPoint);
        return { state: MOUNT_STATES.MOUNTED, message: 'mounted', entry };
    } catch (err) {
        const code = err && err.code;
        if (code === 'ENOTCONN' || code === 'EIO') {
            return {
                state: MOUNT_STATES.STALE,
                message: `mount is stale (${code}): ${describeError(err)}`,
                entry,
            };
        }
        if (code === 'PROBE_TIMEOUT') {
            return { state: MOUNT_STATES.UNKNOWN, message: `mount is not responding: ${describeError(err)}`, entry };
        }
        return { state: MOUNT_STATES.UNKNOWN, message: describeError(err), entry };
    }
}

// stat() raced against a timer. On timeout rejects Error{code:'PROBE_TIMEOUT'}.
// The timer is always cleared. A hung stat() cannot be cancelled and may stay
// pending after the probe has rejected (its eventual result/rejection is
// swallowed); the underlying request occupies a libuv threadpool slot until the
// kernel returns.
function createMountProbe({ fsPromises, timeoutMs = 3000 }) {
    return async function probe(mountPoint) {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const err = new Error(`stat ${mountPoint} did not complete within ${timeoutMs}ms`);
                err.code = 'PROBE_TIMEOUT';
                reject(err);
            }, timeoutMs);
        });
        const statPromise = Promise.resolve().then(() => fsPromises.stat(mountPoint));
        statPromise.catch(() => {}); // avoid unhandled rejection if it fails after the timeout
        try {
            await Promise.race([statPromise, timeout]);
        } finally {
            clearTimeout(timer);
        }
    };
}

function readMountinfo(fsPromises, file = '/proc/self/mountinfo') {
    return fsPromises.readFile(file, 'utf8');
}

// Errors meaning "this ancestor cannot be resolved, try its parent": missing
// path components, or an ancestor that is itself a dead mount. Anything else
// (e.g. EACCES) is rethrown rather than silently guessed.
const CLIMB_CODES = new Set(['ENOENT', 'ENOTDIR', 'ENOTCONN', 'EIO']);

// Resolve symlinks in the PARENT chain only; the final component is never
// passed to realpathSync (it may be a dead mount). If the parent is missing,
// the deepest resolvable ancestor is realpath'd and the rest re-appended.
function canonicalizeMountPoint(mountPoint, fsSync) {
    const abs = path.resolve(mountPoint);
    const leaf = path.basename(abs);
    if (abs === path.parse(abs).root) return abs;
    const rest = [leaf];
    let dir = path.dirname(abs);
    for (;;) {
        try {
            return path.join(fsSync.realpathSync(dir), ...rest);
        } catch (err) {
            const parent = path.dirname(dir);
            if (!err || !CLIMB_CODES.has(err.code) || parent === dir) throw err;
            rest.unshift(path.basename(dir));
            dir = parent;
        }
    }
}

function mountsDirectlyUnder(entries, dir) {
    return (entries || []).filter((e) => path.dirname(e.mountPoint) === dir);
}

module.exports = {
    MOUNT_STATES,
    unescapeMountinfoField,
    parseMountinfo,
    classifyMount,
    createMountProbe,
    readMountinfo,
    canonicalizeMountPoint,
    mountsDirectlyUnder,
};
