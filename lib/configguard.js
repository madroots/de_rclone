'use strict';

// Guards every rclone.conf write (issue #5):
//   * refuses to touch an encrypted config (our INI writer would corrupt it),
//   * validates the new content with rclone itself before replacing the file,
//   * replaces the file atomically (same-directory temp file + rename).
//
// All I/O comes in through parameters (`fsImpl`, `runRclone`) so it can be tested
// with fakes.

const crypto = require('crypto');
const path = require('path');
const { AppError } = require('./errors');

const ENCRYPTED_HEADER = 'RCLONE_ENCRYPT_V0:';
const ENCRYPTED_PREFIX = 'RCLONE_ENCRYPT_V';
const ENCRYPTED_MESSAGE = 'Your rclone config is encrypted; de_rclone cannot edit it yet. Use `rclone config` meanwhile.';
const STDERR_LIMIT = 500;
// A config with many remotes can dump more than execFile's 1 MiB default buffer.
const RCLONE_OPTIONS = { timeout: 30000, maxBuffer: 32 * 1024 * 1024 };
// fchmod failures that only mean "this filesystem has no permission bits" (vfat, some FUSE).
const FCHMOD_IGNORED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL', 'ENOSYS']);

/**
 * Mirrors rclone fs/config/crypt.go `Decrypt`: lines are trimmed, blank lines and lines
 * starting with `;` or `#` are skipped, and the first remaining line decides. rclone
 * itself only decrypts `RCLONE_ENCRYPT_V0:` and aborts with "unsupported configuration
 * encryption" for any other `RCLONE_ENCRYPT_V*` header; neither can be edited by us, so both
 * are reported as 'encrypted'. (JS trim() also strips U+FEFF, Go's TrimSpace does not;
 * a BOM-prefixed header is therefore refused here, which is the safe direction.)
 * @param {string} content
 * @returns {'plain'|'encrypted'}
 */
function detectConfigFormat(content) {
    if (typeof content !== 'string') throw new TypeError('config content must be a string');
    let start = 0;
    while (start <= content.length) {
        let end = content.indexOf('\n', start);
        if (end === -1) end = content.length;
        const line = content.slice(start, end).trim();
        start = end + 1;
        if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
        return line.startsWith(ENCRYPTED_PREFIX) ? 'encrypted' : 'plain';
    }
    return 'plain';
}

/** @param {string} content @throws {AppError} CONFIG_ENCRYPTED */
function assertPlainConfig(content) {
    if (detectConfigFormat(content) === 'encrypted') {
        throw new AppError('CONFIG_ENCRYPTED', ENCRYPTED_MESSAGE);
    }
}

function errnoOf(e) {
    return e && e.code;
}

function writeFailed(what, e) {
    return new AppError('CONFIG_WRITE_FAILED', `${what}: ${(e && e.message) || e}`);
}

// Resolves the file that must be replaced. A symlinked config keeps its link; the
// symlink target is replaced.
function resolveTarget(configPath, fsImpl) {
    let st;
    try {
        st = fsImpl.lstatSync(configPath);
    } catch (e) {
        if (errnoOf(e) === 'ENOENT') return configPath;
        throw writeFailed(`cannot inspect ${configPath}`, e);
    }
    if (!st.isSymbolicLink()) return configPath;
    try {
        return fsImpl.realpathSync(configPath);
    } catch (e) {
        throw writeFailed(`cannot resolve symlink ${configPath}`, e);
    }
}

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function describeRcloneFailure(failure, shown, hidden) {
    if (failure && failure.error && failure.error.code === 'ENOENT') {
        return new AppError('RCLONE_MISSING', 'rclone was not found; install rclone (needed to validate configuration changes)');
    }
    let text = String((failure && failure.stderr) || '').trim();
    if (!text) text = String((failure && failure.error && failure.error.message) || failure || 'unknown error').trim();
    // The temp path means nothing to the user; show the config path rclone was really asked about.
    text = text.split(hidden).join(shown);
    // rclone echoes the offending line, which may hold a credential.
    text = text.replace(/(could not parse line:).*/g, '$1 <line hidden>');
    if (text.length > STDERR_LIMIT) text = `${text.slice(0, STDERR_LIMIT)}...`;
    return text;
}

// Runs `rclone --config <file> --ask-password=false config dump` and returns the parsed object.
async function dumpConfig(runRclone, file, { shown, failurePrefix }) {
    const args = ['--config', file, '--ask-password=false', 'config', 'dump'];
    let result;
    try {
        result = await runRclone(args, RCLONE_OPTIONS);
    } catch (failure) {
        const described = describeRcloneFailure(failure, shown, file);
        if (described instanceof AppError) throw described;
        throw new AppError('CONFIG_INVALID', `${failurePrefix}: ${described}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(String(result && result.stdout));
    } catch (e) {
        throw new AppError('CONFIG_INVALID', `${failurePrefix}: rclone did not print a JSON configuration`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new AppError('CONFIG_INVALID', `${failurePrefix}: rclone did not print a configuration object`);
    }
    return parsed;
}

function checkDiskUnchanged(target, original, fsImpl) {
    const changed = () => new AppError('CONFIG_CHANGED', 'config changed while it was being edited; no changes were made, retry');
    if (original === null) {
        try {
            fsImpl.lstatSync(target);
        } catch (e) {
            if (errnoOf(e) === 'ENOENT') return;
            throw writeFailed(`cannot inspect ${target}`, e);
        }
        throw changed();
    }
    let current;
    try {
        current = fsImpl.readFileSync(target);
    } catch (e) {
        if (errnoOf(e) === 'ENOENT') throw changed();
        throw writeFailed(`cannot read ${target}`, e);
    }
    if (Buffer.compare(current, Buffer.from(original, 'utf8')) !== 0) throw changed();
}

function checkDumps({ oldDump, newDump, changedNames, expect }) {
    const changed = new Set(changedNames);
    const unintended = [];
    for (const name of new Set([...Object.keys(oldDump), ...Object.keys(newDump)])) {
        if (changed.has(name)) continue;
        const inOld = Object.hasOwn(oldDump, name);
        const inNew = Object.hasOwn(newDump, name);
        if (inOld !== inNew || (inOld && canonical(oldDump[name]) !== canonical(newDump[name]))) {
            unintended.push(name);
        }
    }
    if (unintended.length > 0) {
        throw new AppError('CONFIG_INVALID', `the new config would unintentionally change remotes: ${unintended.sort().join(', ')}`);
    }
    if (expect) {
        const missing = (expect.present || []).filter((n) => !Object.hasOwn(newDump, n));
        const unexpected = (expect.absent || []).filter((n) => Object.hasOwn(newDump, n));
        if (missing.length > 0) {
            throw new AppError('CONFIG_INVALID', `rclone does not see the expected remotes in the new config: ${missing.join(', ')}`);
        }
        if (unexpected.length > 0) {
            throw new AppError('CONFIG_INVALID', `rclone still sees remotes that should be gone in the new config: ${unexpected.join(', ')}`);
        }
    }
}

function syncDirectory(dir, fsImpl) {
    let fd;
    try {
        fd = fsImpl.openSync(dir, 'r');
        fsImpl.fsyncSync(fd);
    } catch (e) {
        // Best effort: not every platform/filesystem can fsync a directory.
    } finally {
        if (fd !== undefined) {
            try { fsImpl.closeSync(fd); } catch (e) { /* ignore */ }
        }
    }
}

/**
 * Validates `content` with rclone and atomically replaces the config file with it.
 * Any failure aborts with the config unchanged and the temp file removed.
 *
 * @param {object} p
 * @param {string} p.configPath
 * @param {string|null} p.original exact string read earlier (utf8), null when the file did not exist
 * @param {string} p.content new full file content
 * @param {string[]} p.changedNames remotes the caller intentionally changed
 * @param {{present?: string[], absent?: string[]}} [p.expect] checked against rclone's view of the new file
 * @param {(args: string[], options: object) => Promise<{stdout: string, stderr: string}>} p.runRclone
 * @param {object} [p.fsImpl]
 * @returns {Promise<{configPath: string}>} the resolved file that was replaced
 */
async function writeConfigAtomic({ configPath, original, content, changedNames, expect, runRclone, fsImpl = require('fs') }) {
    if (typeof configPath !== 'string' || configPath === '') throw new TypeError('configPath must be a non-empty string');
    if (original !== null && typeof original !== 'string') throw new TypeError('original must be a string or null');
    if (typeof content !== 'string') throw new TypeError('content must be a string');
    if (!Array.isArray(changedNames)) throw new TypeError('changedNames must be an array');

    assertPlainConfig(original ?? '');
    assertPlainConfig(content);

    const target = resolveTarget(configPath, fsImpl);
    const dir = path.dirname(target);
    const tmp = path.join(dir, `.${path.basename(target)}.de_rclone-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);

    let fd;
    try {
        try {
            fd = fsImpl.openSync(tmp, 'wx', 0o600);
            fsImpl.writeFileSync(fd, content, 'utf8');
            fsImpl.fsyncSync(fd);
            try {
                fsImpl.fchmodSync(fd, 0o600);
            } catch (e) {
                if (!FCHMOD_IGNORED.has(errnoOf(e))) throw e;
            }
            const toClose = fd;
            fd = undefined;
            fsImpl.closeSync(toClose);
        } catch (e) {
            throw writeFailed(`cannot write temporary config next to ${target}`, e);
        }

        const newDump = await dumpConfig(runRclone, tmp, {
            shown: target,
            failurePrefix: 'rclone rejected the new configuration',
        });

        let oldDump = {};
        if (original !== null) {
            // Reported as CONFIG_CHANGED rather than as a bogus diff when the file vanished or changed.
            checkDiskUnchanged(target, original, fsImpl);
            try {
                oldDump = await dumpConfig(runRclone, target, {
                    shown: target,
                    failurePrefix: 'existing config cannot be parsed by rclone; refusing to modify it',
                });
            } catch (e) {
                if (e.code === 'CONFIG_INVALID') {
                    throw new AppError('CONFIG_INVALID', 'existing config cannot be parsed by rclone; refusing to modify it');
                }
                throw e;
            }
        }

        checkDumps({ oldDump, newDump, changedNames, expect });
        checkDiskUnchanged(target, original, fsImpl);

        try {
            fsImpl.renameSync(tmp, target);
        } catch (e) {
            throw writeFailed(`cannot replace ${target}`, e);
        }
        syncDirectory(dir, fsImpl);
        return { configPath: target };
    } finally {
        if (fd !== undefined) {
            try { fsImpl.closeSync(fd); } catch (e) { /* ignore */ }
        }
        try {
            fsImpl.unlinkSync(tmp);
        } catch (e) {
            // ENOENT after a successful rename; anything else must not mask the real result.
        }
    }
}

module.exports = { detectConfigFormat, assertPlainConfig, writeConfigAtomic };
