'use strict';

// Faithful fake of the ONLY rclone invocation configguard uses:
//   rclone --config <file> [--ask-password=false] config dump
//
// Behaviors below were recorded against rclone v1.75.1 with temp files (HOME and
// --config pointing into a temp dir) unless marked [source] (read from rclone source,
// not executed) or [unverified].
//
//  * missing file : stderr `<date> NOTICE: Config file "<path>" not found - using defaults`,
//                   stdout `{}` (no trailing newline), exit 0.
//  * empty file   : stdout `{}`, exit 0.
//  * unparsable line (no `=`/`:`, empty key, `[a] trailing`, unclosed `[a`):
//                   stderr `<date> CRITICAL: Failed to load config file "<path>": could not parse line: <line>`, exit 1.
//  * directory    : `... CRITICAL: Failed to load config file "<path>": read <path>: is a directory`, exit 1.
//  * encrypted header (`RCLONE_ENCRYPT_V0:` as first non-blank, non-`#`/`;` line, trimmed;
//    https://github.com/rclone/rclone/blob/master/fs/config/crypt.go `Decrypt`):
//      - data is base64 (newlines ignored). Invalid char before the last partial
//        quantum: `failed to load base64 encoded data: illegal base64 data at input byte N`
//        (N counts filtered, newline-less data: verified for N = 0 and 8);
//        bad/partial final quantum: `failed to load base64 encoded data: unexpected EOF`;
//      - decoded < 40 bytes (24 nonce + 16 secretbox overhead): `configuration data too short`;
//      - otherwise, with --ask-password=false and no password: `unable to decrypt configuration
//        and not allowed to ask for password - set RCLONE_CONFIG_PASS to your configuration password`.
//      - other `RCLONE_ENCRYPT_V*`: `unsupported configuration encryption - update rclone for support`.
//    All of these exit 1 via `CRITICAL: Failed to load config file "<path>": <reason>`.
//  * INI dialect (goconfig as used by rclone): lines trimmed; blank and `#`/`;` lines skipped;
//    `[name]` (name trimmed); `key = value` or `key: value` split at the EARLIEST `=` or `:`,
//    key and value trimmed, no inline comments, no quoting; keys case-sensitive; last duplicate
//    key wins; duplicate sections merge; keys before any section go to `DEFAULT`; a leading
//    UTF-8 BOM is ignored; CRLF tolerated. Output: JSON, 4-space indent, sorted keys.
//  * exit failure shape: execFile rejects with an Error whose `.code` is the exit code (1),
//    plus `.stderr`/`.stdout`; the app's execFilePromise wraps this as `{ error, stderr, stdout }`.
//
// The INI parser and header detection here are deliberately independent from lib/configguard.js.

class FakeRcloneRejection extends Error {}

function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function critical(file, reason) {
    const stderr = `${stamp()} CRITICAL: Failed to load config file "${file}": ${reason}\n`;
    const error = new FakeRcloneRejection(`Command failed: rclone config dump\n${stderr}`);
    error.code = 1;
    return { error, stderr, stdout: '' };
}

function firstSignificantLineAndRest(text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim();
        if (l === '' || l.startsWith(';') || l.startsWith('#')) continue;
        return { line: l, rest: lines.slice(i + 1).join('\n') };
    }
    return null;
}

function encryptedFailure(file, rest) {
    const data = rest.replace(/[\r\n]/g, '');
    const quantumEnd = Math.floor(data.length / 4) * 4;
    for (let i = 0; i < data.length; i++) {
        const c = data[i];
        const ok = /[A-Za-z0-9+/]/.test(c) || (c === '=' && i >= data.length - 2 && i >= quantumEnd - 2);
        if (ok) continue;
        return critical(file, i < quantumEnd
            ? `failed to load base64 encoded data: illegal base64 data at input byte ${i}`
            : 'failed to load base64 encoded data: unexpected EOF');
    }
    if (data.length % 4 !== 0) return critical(file, 'failed to load base64 encoded data: unexpected EOF');
    if (Buffer.from(data, 'base64').length < 24 + 16) return critical(file, 'configuration data too short');
    return critical(file, 'unable to decrypt configuration and not allowed to ask for password - set RCLONE_CONFIG_PASS to your configuration password');
}

function parseIni(text, file) {
    const out = {};
    let section = 'DEFAULT';
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
        if (line.startsWith('[')) {
            if (!line.endsWith(']')) return { failure: critical(file, `could not parse line: ${line}`) };
            section = line.slice(1, -1).trim() || 'DEFAULT';
            out[section] = out[section] || {};
            continue;
        }
        const sep = line.search(/[=:]/);
        const key = sep === -1 ? '' : line.slice(0, sep).trim();
        if (key === '') return { failure: critical(file, `could not parse line: ${line}`) };
        out[section] = out[section] || {};
        out[section][key] = line.slice(sep + 1).trim();
    }
    return { out };
}

function sortedJson(obj) {
    const sorted = {};
    for (const name of Object.keys(obj).sort()) {
        sorted[name] = {};
        for (const key of Object.keys(obj[name]).sort()) sorted[name][key] = obj[name][key];
    }
    return JSON.stringify(sorted, null, 4);
}

/**
 * @param {{fsImpl?: object}} [opts]
 * @returns {((args: string[], options?: object) => Promise<{stdout: string, stderr: string}>) & {calls: string[][]}}
 */
function createFakeRclone({ fsImpl = require('fs') } = {}) {
    const calls = [];
    function runRclone(args, options) {
        calls.push([...args]);
        let i = 0;
        if (args[i++] !== '--config' || typeof args[i++] !== 'string') {
            throw new Error(`fake rclone: expected "--config <file>" first, got ${JSON.stringify(args)}`);
        }
        const file = args[1];
        if (args[i] === '--ask-password=false') i++;
        if (args[i] !== 'config' || args[i + 1] !== 'dump' || args.length !== i + 2) {
            throw new Error(`fake rclone: unsupported invocation ${JSON.stringify(args)}`);
        }

        let text;
        try {
            text = fsImpl.readFileSync(file, 'utf8');
        } catch (e) {
            if (e.code === 'ENOENT') {
                return Promise.resolve({
                    stdout: '{}',
                    stderr: `${stamp()} NOTICE: Config file "${file}" not found - using defaults\n`,
                });
            }
            if (e.code === 'EISDIR') return Promise.reject(critical(file, `read ${file}: is a directory`));
            throw e; // [unverified] other read errors: a test bug, not an emulated behavior
        }

        const first = firstSignificantLineAndRest(text);
        if (first && first.line === 'RCLONE_ENCRYPT_V0:') return Promise.reject(encryptedFailure(file, first.rest));
        if (first && first.line.startsWith('RCLONE_ENCRYPT_V')) {
            return Promise.reject(critical(file, 'unsupported configuration encryption - update rclone for support'));
        }
        const parsed = parseIni(text, file);
        if (parsed.failure) return Promise.reject(parsed.failure);
        return Promise.resolve({ stdout: sortedJson(parsed.out), stderr: '' });
    }
    runRclone.calls = calls;
    return runRclone;
}

/** runRclone for a machine without rclone: rejects like execFile does (error.code === 'ENOENT'). */
function createMissingRclone() {
    const calls = [];
    function runRclone(args) {
        calls.push([...args]);
        const error = new Error('spawn rclone ENOENT');
        error.code = 'ENOENT';
        error.syscall = 'spawn rclone';
        error.errno = -2;
        return Promise.reject({ error, stderr: '', stdout: '' });
    }
    runRclone.calls = calls;
    return runRclone;
}

module.exports = { createFakeRclone, createMissingRclone };
