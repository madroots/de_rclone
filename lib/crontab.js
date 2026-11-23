'use strict';

// ---------------------------------------------------------------------------
// Read classification.
//
// Recorded upstream behavior (all `crontab -l`, exit status ERROR_EXIT == 1):
//  - cronie, missing spool file:
//      "no crontab for <user>\n", exit 1
//      https://github.com/cronie-crond/cronie/blob/master/src/crontab.c (list_cmd)
//      ERROR_EXIT is 1: https://github.com/cronie-crond/cronie/blob/master/src/cron.h
//  - cronie, cron.allow/cron.deny:
//      "You (<user>) are not allowed to use this program (crontab)\n"
//      "See crontab(1) for more information\n", exit 1  (same file, main())
//  - cronie, PAM refusal:
//      "You (<user>) are not allowed to access to (crontab) because of pam configuration.\n", exit 1
//  - cronie, spool file unreadable: perror(path) -> "<path>: Permission denied", exit 1
//  - Debian cron (vixie-cron derivative): same "no crontab for <user>" and
//      "You (<user>) are not allowed to use this program (crontab)" texts, exit 1
//      https://salsa.debian.org/debian/cron/-/blob/master/crontab.c
//  - BusyBox (UNVERIFIED on a real binary; derived from source): `crontab -l` is
//      bb_cat() of the user's file, so a missing crontab yields
//      "crontab: <user>: No such file or directory" with exit 1
//      https://github.com/mirror/busybox/blob/master/miscutils/crontab.c and libbb/bb_cat.c.
//      Indistinguishable from other open failures by text, so it is deliberately
//      classified as 'error' (conservative: never a basis for writing).
//  - Node child_process.execFile: missing binary -> error.code 'ENOENT';
//      timeout -> error.killed === true, error.signal 'SIGTERM', error.code null;
//      non-zero exit -> error.code is the numeric exit status.
//      https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback
// ---------------------------------------------------------------------------

// Anchored to the whole (trimmed) stderr: extra diagnostics mean something else is wrong.
const NO_CRONTAB_RE = /^(?:crontab:\s*)?no crontab for [^\r\n]+$/i;
const NOT_ALLOWED_RE = /not allowed to use this program|not allowed to access to .* because of pam configuration|permission denied/i;

// execFile kills the child with SIGTERM on timeout (killed === true); any other
// signal means the tool died abnormally. Neither has a numeric exit status.
function wasSignaled(error) {
    return error.killed === true || (typeof error.signal === 'string' && error.signal !== '');
}

function firstLine(text) {
    return String(text || '').trim().split(/\r?\n/)[0];
}

// Describes why a crontab process failed; shared by reads and writes.
function describeFailure(error, stderr) {
    if (error.killed === true) return 'crontab timed out';
    if (wasSignaled(error)) return `crontab was terminated by ${error.signal}`;
    return String(stderr || '').trim() || error.message || String(error);
}

function classifyCrontabRead({ error, stdout, stderr } = {}) {
    if (!error) {
        const content = typeof stdout === 'string' ? stdout : String(stdout ?? '');
        return { status: content.trim() === '' ? 'empty' : 'ok', content, reason: null, message: null };
    }
    const err = typeof error === 'object' ? error : { message: String(error) };
    const text = String(stderr || '');
    if (err.code === 'ENOENT') {
        return {
            status: 'unavailable', content: null, reason: 'not-installed',
            message: 'crontab is not installed'
        };
    }
    if (typeof err.code === 'number' && err.code !== 0) {
        if (err.code === 1 && NO_CRONTAB_RE.test(text.trim())) {
            return { status: 'empty', content: '', reason: null, message: null };
        }
        if (NOT_ALLOWED_RE.test(text)) {
            return {
                status: 'unavailable', content: null, reason: 'denied',
                message: `your user is not allowed to use crontab (cron.allow/cron.deny): ${firstLine(text)}`
            };
        }
    }
    return {
        status: 'error', content: null, reason: null,
        message: `Could not read crontab: ${describeFailure(err, text)}`
    };
}

// ---------------------------------------------------------------------------
// Client.
// ---------------------------------------------------------------------------

// A crontab file must end in a newline (cron rejects/ignores an unterminated
// last line). Existing trailing newlines are never stripped, so bytes outside
// the edit are preserved exactly; only a missing final newline is added. The
// empty string stays empty, which installs an empty crontab.
function normalizeCrontabContent(content) {
    if (content === '' || content.endsWith('\n')) return content;
    return `${content}\n`;
}

function createCrontabClient({ execFile, timeoutMs = 10000 } = {}) {
    if (typeof execFile !== 'function') throw new TypeError('createCrontabClient requires an execFile function');

    function run(args, input) {
        return new Promise(resolve => {
            const options = { env: { ...process.env, LC_ALL: 'C' }, timeout: timeoutMs };
            let child;
            try {
                child = execFile('crontab', args, options, (error, stdout, stderr) => {
                    resolve({ error, stdout, stderr });
                });
            } catch (error) {
                resolve({ error, stdout: '', stderr: '' });
                return;
            }
            if (input !== undefined && child && child.stdin) {
                // The tool may exit before reading stdin (e.g. access denied);
                // the exit status then arrives through the callback.
                child.stdin.on('error', () => { });
                child.stdin.end(input);
            }
        });
    }

    async function read() {
        return classifyCrontabRead(await run(['-l']));
    }

    async function write(content) {
        const { error, stderr } = await run(['-'], normalizeCrontabContent(String(content)));
        if (error) return { ok: false, message: `Could not write crontab: ${describeFailure(error, stderr)}` };
        return { ok: true };
    }

    async function edit(compute, { maxAttempts = 3 } = {}) {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const before = await read();
            if (before.status === 'unavailable' || before.status === 'error') {
                return { outcome: before.status, before, after: null, message: before.message };
            }
            const next = compute(before.content);
            if (next === null) return { outcome: 'unchanged', before, after: null, message: null };
            if (typeof next !== 'string') throw new TypeError('crontab edit callback must return a string or null');

            // Snapshot compare: the decision above is only valid for `before`.
            const recheck = await read();
            if (recheck.status === 'unavailable' || recheck.status === 'error') {
                return { outcome: recheck.status, before, after: null, message: recheck.message };
            }
            if (recheck.status !== before.status || recheck.content !== before.content) continue;

            const written = await write(next);
            if (!written.ok) return { outcome: 'write-failed', before, after: null, message: written.message };
            const after = await read();
            return { outcome: 'written', before, after, message: null };
        }
        return {
            outcome: 'conflict', before: null, after: null,
            message: `crontab changed while editing; gave up after ${maxAttempts} attempts`
        };
    }

    return { read, write, edit };
}

module.exports = { classifyCrontabRead, createCrontabClient, normalizeCrontabContent };
