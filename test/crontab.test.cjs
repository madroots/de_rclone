'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { execFile: realExecFile } = require('node:child_process');

const {
    isCronLineFor, isCronEntryFor, classifyCrontabRead, createCrontabClient, normalizeCrontabContent
} = require('../lib/crontab');

// ---------------------------------------------------------------------------
// Matcher (moved verbatim from main.js; #7 will change it)
// ---------------------------------------------------------------------------

const fooCron = "@reboot rclone mount 'foo:' '/managed/foo' --daemon # Added by de_rclone: foo\n";
const unrelatedCron = '# keep this comment about rclone mount foo:\n' +
    '@reboot rclone mount prefixfoo: /managed/prefixfoo --daemon\n' +
    '@reboot rclone mount foo:subdir /managed/subdir --daemon\n' +
    '0 1 * * * echo backup # rclone mount foo:\n' +
    '0 2 * * * echo rclone mount foo:\n';

test('matcher detects the generated line and quoting/path variants for the exact remote', () => {
    const accepted = [
        fooCron.trim(),
        '@reboot /usr/bin/rclone mount "foo:" /managed/foo --daemon',
        '0 3 * * * rclone mount foo: /x',
        '   @reboot rclone mount foo: /x',
        '@reboot echo hi; rclone mount foo: /x',
        '@reboot true && rclone mount foo: /x &',
        '@reboot exec rclone mount foo: /x',
        '@reboot rclone mount foo: /x\r',
        '@reboot rclone mount foo\\: /x',
    ];
    for (const line of accepted) assert.equal(isCronLineFor(line, 'foo'), true, line);
    assert.equal(isCronLineFor("@reboot rclone mount 'my remote:' /x", 'my remote'), true);
});

test('matcher rejects comments, prefixes, other remotes, echo and unterminated quotes', () => {
    // 'must still be rejected' list from #7 that the current matcher already honours.
    for (const line of unrelatedCron.split('\n').filter(Boolean)) {
        assert.equal(isCronLineFor(line, 'foo'), false, line);
    }
    const rejected = [
        '# @reboot rclone mount foo: /x',
        '@reboot rclone mount foo2: /x',
        '@reboot rclone mount other: foo:subdir',
        '@reboot echo rclone mount foo:',
        "@reboot rclone mount 'foo: /x",
        '@reboot rclone mount foo',
        '',
    ];
    for (const line of rejected) assert.equal(isCronLineFor(line, 'foo'), false, line);
    assert.equal(isCronLineFor(fooCron.trim(), 'fo'), false);
});

test('isCronEntryFor scans every line of the table and tolerates empty input', () => {
    assert.equal(isCronEntryFor(unrelatedCron, 'foo'), false);
    assert.equal(isCronEntryFor(unrelatedCron + fooCron, 'foo'), true);
    assert.equal(isCronEntryFor(unrelatedCron + fooCron, 'bar'), false);
    assert.equal(isCronEntryFor(unrelatedCron + fooCron.replace(/\n$/, ''), 'foo'), true);
    assert.equal(isCronEntryFor('', 'foo'), false);
    assert.equal(isCronEntryFor(null, 'foo'), false);
    assert.equal(isCronEntryFor(undefined, 'foo'), false);
});

// ---------------------------------------------------------------------------
// classifyCrontabRead
//
// Recorded upstream behavior (see lib/crontab.js for the full citation list):
//  cronie crontab.c: list_cmd "no crontab for %s\n"; main() "You (%s) are not allowed to use
//    this program (%s)\n" + "See crontab(1) for more information\n"; PAM text "You (%s) are not
//    allowed to access to (%s) because of pam configuration.\n"; ERROR_EXIT == 1.
//    https://github.com/cronie-crond/cronie/blob/master/src/crontab.c
//    https://github.com/cronie-crond/cronie/blob/master/src/cron.h
//  Debian cron crontab.c: same "no crontab for %s" and "not allowed to use this program" texts.
//    https://salsa.debian.org/debian/cron/-/blob/master/crontab.c
//  BusyBox: text derived from source only (never run on a real binary):
//    https://github.com/mirror/busybox/blob/master/miscutils/crontab.c  (`-l` is bb_cat of the file)
// ---------------------------------------------------------------------------

function exitError(code, stderr) {
    return Object.assign(new Error(`Command failed: crontab -l\n${stderr}`), { code, killed: false, signal: null });
}

const NOT_ALLOWED = 'You (alice) are not allowed to use this program (crontab)\nSee crontab(1) for more information\n';

test('classification table for crontab -l outcomes', () => {
    const timeout = Object.assign(new Error('Command failed: crontab -l'), { code: null, killed: true, signal: 'SIGTERM' });
    const segv = Object.assign(new Error('Command failed: crontab -l'), { code: null, killed: false, signal: 'SIGSEGV' });
    const cases = [
        // [name, input, expected subset]
        ['plain table', { stdout: '@reboot x\n', stderr: '' }, { status: 'ok', content: '@reboot x\n' }],
        ['empty stdout', { stdout: '', stderr: '' }, { status: 'empty', content: '' }],
        ['whitespace-only stdout keeps its bytes', { stdout: ' \n\n', stderr: '' }, { status: 'empty', content: ' \n\n' }],
        ['stdout of a table with only comments is ok', { stdout: '# c\n', stderr: '' }, { status: 'ok', content: '# c\n' }],
        ['binary missing', { error: Object.assign(new Error('spawn crontab ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '' },
            { status: 'unavailable', reason: 'not-installed', content: null }],
        ['cronie: no crontab', { error: exitError(1, 'no crontab for alice\n'), stdout: '', stderr: 'no crontab for alice\n' },
            { status: 'empty', content: '' }],
        ['prefixed with program name', { error: exitError(1, 'x'), stdout: '', stderr: 'crontab: no crontab for alice\n' },
            { status: 'empty', content: '' }],
        ['case-insensitive', { error: exitError(1, 'x'), stdout: '', stderr: 'No Crontab For alice' },
            { status: 'empty', content: '' }],
        ['cronie: cron.allow/cron.deny', { error: exitError(1, NOT_ALLOWED), stdout: '', stderr: NOT_ALLOWED },
            { status: 'unavailable', reason: 'denied', content: null }],
        ['not-allowed text with another non-zero status', { error: exitError(2, NOT_ALLOWED), stdout: '', stderr: NOT_ALLOWED },
            { status: 'unavailable', reason: 'denied' }],
        ['cronie: PAM refusal', {
            error: exitError(1, 'x'), stdout: '',
            stderr: 'You (alice) are not allowed to access to (crontab) because of pam configuration.\n'
        }, { status: 'unavailable', reason: 'denied' }],
        ['spool file unreadable (perror)', {
            error: exitError(1, 'x'), stdout: '', stderr: '/var/spool/cron/alice: Permission denied\n'
        }, { status: 'unavailable', reason: 'denied' }],
        ['timeout', { error: timeout, stdout: '', stderr: '' }, { status: 'error', content: null }],
        ['killed by another signal', { error: segv, stdout: '', stderr: '' }, { status: 'error' }],
        ['BusyBox missing crontab (unverified text) is conservatively an error', {
            error: exitError(1, 'x'), stdout: '', stderr: 'crontab: alice: No such file or directory\n'
        }, { status: 'error' }],
        ['exit 1 with no text', { error: exitError(1, ''), stdout: '', stderr: '' }, { status: 'error' }],
        ['no-crontab text with a different exit status is not "empty"', {
            error: exitError(2, 'x'), stdout: '', stderr: 'no crontab for alice\n'
        }, { status: 'error' }],
        ['no-crontab text mixed with other diagnostics is not "empty"', {
            error: exitError(1, 'x'), stdout: '', stderr: 'crontab: spool corrupt\nno crontab for alice\n'
        }, { status: 'error' }],
        ['stdout is ignored when the process failed', {
            error: exitError(1, 'x'), stdout: '@reboot x\n', stderr: 'boom\n'
        }, { status: 'error', content: null }],
        ['string error code (maxBuffer)', {
            error: Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
            stdout: '', stderr: ''
        }, { status: 'error' }],
    ];
    for (const [name, input, expected] of cases) {
        const result = classifyCrontabRead(input);
        for (const [key, value] of Object.entries(expected)) assert.deepEqual(result[key], value, `${name}: ${key}`);
        // Content is only ever offered for a table that is safe to edit.
        if (result.status === 'unavailable' || result.status === 'error') assert.equal(result.content, null, name);
        else assert.equal(result.message, null, name);
    }
});

test('classification messages are actionable', () => {
    const msg = input => classifyCrontabRead(input).message;
    assert.match(msg({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }), /not installed/);
    assert.match(msg({ error: exitError(1, NOT_ALLOWED), stderr: NOT_ALLOWED }), /not allowed to use crontab.*cron\.allow\/cron\.deny/);
    assert.match(msg({ error: Object.assign(new Error('x'), { code: null, killed: true, signal: 'SIGTERM' }) }), /timed out/);
    assert.match(msg({ error: exitError(1, ''), stderr: '  disk on fire \n' }), /disk on fire/);
    assert.match(msg({ error: Object.assign(new Error('weird failure'), { code: 'EACCES' }), stderr: '' }), /weird failure/);
    assert.match(msg({ error: Object.assign(new Error('x'), { code: null, killed: false, signal: 'SIGSEGV' }) }), /SIGSEGV/);
});

// The classifier relies on Node's real error shapes. Produce them with real child processes
// (the current node binary and a nonexistent program), never with crontab itself.
function realRun(file, args, options) {
    return new Promise(resolve => realExecFile(file, args, options, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
}

test('classifier understands the error shapes produced by the real execFile', async () => {
    const missing = await realRun('de-rclone-no-such-binary-xyz', ['-l'], {});
    assert.deepEqual(
        { status: classifyCrontabRead(missing).status, reason: classifyCrontabRead(missing).reason },
        { status: 'unavailable', reason: 'not-installed' });

    const noTable = await realRun(process.execPath, ['-e', "process.stderr.write('no crontab for alice\\n'); process.exit(1)"], {});
    assert.equal(classifyCrontabRead(noTable).status, 'empty');

    const denied = await realRun(process.execPath, ['-e', "process.stderr.write('You (alice) are not allowed to use this program (crontab)\\n'); process.exit(1)"], {});
    assert.equal(classifyCrontabRead(denied).reason, 'denied');

    const hung = await realRun(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeout: 100 });
    const hungResult = classifyCrontabRead(hung);
    assert.equal(hungResult.status, 'error');
    assert.match(hungResult.message, /timed out/);

    const ok = await realRun(process.execPath, ['-e', "process.stdout.write('@reboot x\\n')"], {});
    assert.deepEqual(classifyCrontabRead(ok), { status: 'ok', content: '@reboot x\n', reason: null, message: null });
});

// ---------------------------------------------------------------------------
// Fake crontab binary
//
// Models `crontab -l` and `crontab -` (stdin) the way the recorded sources above behave:
//  - missing table: stderr "no crontab for <user>\n", exit 1 (cronie/Debian list_cmd)
//  - denied: the two-line "You (u) are not allowed to use this program (crontab)" text, exit 1,
//    for both `-l` and `-`
//  - invalid table on install: "errors in crontab file, can't install.\n", exit 1
//    (Debian crontab.c, copy_crontab). The per-line parse diagnostics preceding it are NOT
//    modelled because their exact format was not verified.
//  - header variant: Debian's install prepends a three-line "# DO NOT EDIT THIS FILE" header
//    to the stored table (copy_crontab) and `-l` prints the stored file unchanged.
//  - execFile shapes (Node docs): ENOENT -> error.code 'ENOENT'; exit status -> numeric code;
//    timeout -> killed true / signal SIGTERM / code null, delivered after options.timeout ms.
//  - the callback is always asynchronous; stdin of the child is a real Writable.
// ---------------------------------------------------------------------------

const DEBIAN_HEADER = '# DO NOT EDIT THIS FILE - edit the master and reinstall.\n' +
    '# (- installed on Thu Nov  6 10:00:00 2026)\n' +
    '# (Cron version -- $Id: crontab.c,v 2.13 1994/01/17 03:20:37 vixie Exp $)\n';

function createFake(initialTable) {
    const state = {
        table: initialTable, // null: the user has no crontab
        installed: true,
        allowed: true,
        header: false,
        hang: () => false,
        writeFailure: null, // stderr text of a failed install
        epipe: false, // the tool exits without reading stdin
        onRead: null, // (readNumber, state) => void, runs when a `-l` starts
        reads: 0,
        calls: [],
        installs: [], // raw bytes received on stdin by `crontab -`
    };

    function exit(code, stderr, args) {
        return Object.assign(new Error(`Command failed: crontab ${args.join(' ')}\n${stderr}`),
            { code, killed: false, signal: null, cmd: `crontab ${args.join(' ')}`, stdout: '', stderr });
    }

    function execFile(file, args, options, cb) {
        state.calls.push({ file, args: [...args], options });
        const child = new EventEmitter();
        const settle = (error, stdout = '', stderr = '') => setImmediate(() => cb(error, stdout, stderr));
        const timeout = Object.assign(new Error(`Command failed: crontab ${args.join(' ')}`),
            { code: null, killed: true, signal: 'SIGTERM', cmd: `crontab ${args.join(' ')}` });

        if (!state.installed) {
            settle(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT', errno: -2, syscall: `spawn ${file}`, path: file }));
            child.stdin = new Writable({ write(chunk, enc, done) { done(); } });
            return child;
        }
        if (state.hang(args)) {
            setTimeout(() => cb(timeout, '', ''), options.timeout);
            child.stdin = new Writable({ write(chunk, enc, done) { done(); } });
            return child;
        }
        if (args[0] === '-l') {
            state.reads++;
            if (state.onRead) state.onRead(state.reads, state);
            if (!state.allowed) settle(exit(1, NOT_ALLOWED, args), '', NOT_ALLOWED);
            else if (state.table === null) settle(exit(1, 'no crontab for alice\n', args), '', 'no crontab for alice\n');
            else settle(null, state.table, '');
            child.stdin = new Writable({ write(chunk, enc, done) { done(); } });
            return child;
        }
        assert.deepEqual(args, ['-'], 'only -l and - are modelled');
        const chunks = [];
        child.stdin = new Writable({
            write(chunk, enc, done) {
                if (state.epipe) done(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
                else { chunks.push(chunk); done(); }
            }
        });
        child.stdin.on('close', () => {
            if (state.epipe) return settle(exit(1, NOT_ALLOWED, args), '', NOT_ALLOWED);
            const data = Buffer.concat(chunks).toString('utf8');
            state.installs.push(data);
            if (!state.allowed) return settle(exit(1, NOT_ALLOWED, args), '', NOT_ALLOWED);
            if (state.writeFailure) return settle(exit(1, state.writeFailure, args), '', state.writeFailure);
            state.table = (state.header ? DEBIAN_HEADER : '') + data;
            settle(null);
        });
        return child;
    }
    return { state, execFile };
}

function removeLinesFor(name) {
    return content => {
        const lines = content.split('\n');
        const kept = lines.filter(line => !isCronLineFor(line, name));
        return kept.length === lines.length ? null : kept.join('\n');
    };
}

function privateTmpdir(t) {
    // os.tmpdir() honours $TMPDIR; point it at a private directory so a module that wrote a
    // temp file would be caught regardless of what other test processes do to the real one.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'de-rclone-test-'));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = root;
    t.after(() => {
        if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
        fs.rmSync(root, { recursive: true, force: true });
    });
    assert.equal(os.tmpdir(), root);
    return root;
}

const HARD_TIMEOUT = { timeout: 5000 };

// ---------------------------------------------------------------------------
// Client: read / write
// ---------------------------------------------------------------------------

test('read runs `crontab -l` with LC_ALL=C and the configured timeout, and classifies the result', HARD_TIMEOUT, async t => {
    const fake = createFake('@reboot a\n');
    const saved = process.env.LC_ALL;
    process.env.LC_ALL = 'de_DE.UTF-8';
    t.after(() => { if (saved === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = saved; });
    const client = createCrontabClient({ execFile: fake.execFile, timeoutMs: 1234 });
    const result = await client.read();
    assert.deepEqual(result, { status: 'ok', content: '@reboot a\n', reason: null, message: null });
    assert.equal(fake.state.calls.length, 1);
    const [call] = fake.state.calls;
    assert.equal(call.file, 'crontab');
    assert.deepEqual(call.args, ['-l']);
    assert.equal(call.options.env.LC_ALL, 'C');
    assert.equal(call.options.timeout, 1234);
});

test('default timeout is 10 seconds', HARD_TIMEOUT, async () => {
    const fake = createFake('x\n');
    await createCrontabClient({ execFile: fake.execFile }).read();
    assert.equal(fake.state.calls[0].options.timeout, 10000);
});

test('read never throws for tool failures', HARD_TIMEOUT, async () => {
    const cases = [
        ['not installed', f => { f.state.installed = false; }, { status: 'unavailable', reason: 'not-installed' }],
        ['denied', f => { f.state.allowed = false; }, { status: 'unavailable', reason: 'denied' }],
        ['no table', f => { f.state.table = null; }, { status: 'empty', content: '' }],
        ['hung', f => { f.state.hang = () => true; }, { status: 'error' }],
    ];
    for (const [name, arrange, expected] of cases) {
        const fake = createFake('@reboot a\n');
        arrange(fake);
        const result = await createCrontabClient({ execFile: fake.execFile, timeoutMs: 10 }).read();
        for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value, `${name}: ${key}`);
    }
});

test('a synchronously throwing execFile is reported as a read/write failure, not thrown', HARD_TIMEOUT, async () => {
    const execFile = () => { throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }); };
    const client = createCrontabClient({ execFile });
    const read = await client.read();
    assert.equal(read.status, 'error');
    assert.match(read.message, /EAGAIN/);
    const written = await client.write('x\n');
    assert.equal(written.ok, false);
    assert.match(written.message, /EAGAIN/);
});

test('write sends the exact bytes on stdin to `crontab -` with a single trailing newline', HARD_TIMEOUT, async () => {
    const cases = [
        ['@reboot a', '@reboot a\n'],
        ['@reboot a\n', '@reboot a\n'],
        ['# c\n\nMAILTO=x\n@reboot a\n', '# c\n\nMAILTO=x\n@reboot a\n'],
        ['a\n\n', 'a\n\n'], // blank lines belong to the user's table; never stripped
        ['a\r\nb', 'a\r\nb\n'],
        ['', ''],
        ['é ✓\n', 'é ✓\n'],
    ];
    for (const [input, expected] of cases) {
        const fake = createFake('old\n');
        const result = await createCrontabClient({ execFile: fake.execFile }).write(input);
        assert.deepEqual(result, { ok: true }, JSON.stringify(input));
        assert.deepEqual(fake.state.installs, [expected], JSON.stringify(input));
        assert.equal(fake.state.table, expected);
        const [call] = fake.state.calls;
        assert.equal(call.file, 'crontab');
        assert.deepEqual(call.args, ['-']);
        assert.equal(call.options.env.LC_ALL, 'C');
    }
    assert.equal(normalizeCrontabContent('x'), 'x\n');
    assert.equal(normalizeCrontabContent('x\n'), 'x\n');
    assert.equal(normalizeCrontabContent(''), '');
});

test('write reports failures without throwing: bad table, denied, hang, tool exiting before reading stdin', HARD_TIMEOUT, async () => {
    let fake = createFake('old\n');
    fake.state.writeFailure = "errors in crontab file, can't install.\n";
    let result = await createCrontabClient({ execFile: fake.execFile }).write('bad\n');
    assert.equal(result.ok, false);
    assert.match(result.message, /errors in crontab file, can't install/);
    assert.equal(fake.state.table, 'old\n');

    fake = createFake('old\n');
    fake.state.allowed = false;
    result = await createCrontabClient({ execFile: fake.execFile }).write('x\n');
    assert.equal(result.ok, false);
    assert.match(result.message, /not allowed to use this program/);

    fake = createFake('old\n');
    fake.state.hang = () => true;
    result = await createCrontabClient({ execFile: fake.execFile, timeoutMs: 10 }).write('x\n');
    assert.equal(result.ok, false);
    assert.match(result.message, /timed out/);

    // Real tools may exit before consuming stdin; the resulting EPIPE must not crash the process.
    fake = createFake('old\n');
    fake.state.epipe = true;
    result = await createCrontabClient({ execFile: fake.execFile }).write('x'.repeat(1000) + '\n');
    assert.equal(result.ok, false);
    assert.match(result.message, /not allowed/);

    fake = createFake('old\n');
    fake.state.installed = false;
    result = await createCrontabClient({ execFile: fake.execFile }).write('x\n');
    assert.equal(result.ok, false);
    assert.match(result.message, /ENOENT/);
});

// ---------------------------------------------------------------------------
// Client: edit
// ---------------------------------------------------------------------------

const manualTable = '# keep: m h dom mon dow command\n' +
    'MAILTO=ops@example.com\n' +
    'SHELL=/bin/sh\n' +
    '\n' +
    '0 1 * * * /usr/local/bin/backup --now   # trailing spaces   \n' +
    '\n\n' +
    '@reboot rclone mount prefixfoo: /managed/prefixfoo --daemon\n' +
    '0 2 * * * echo rclone mount foo:\n';

test('edit with nothing to do returns "unchanged" after a single read and performs no write', HARD_TIMEOUT, async () => {
    const fake = createFake(manualTable);
    const result = await createCrontabClient({ execFile: fake.execFile }).edit(removeLinesFor('foo'));
    assert.equal(result.outcome, 'unchanged');
    assert.equal(result.before.status, 'ok');
    assert.equal(result.before.content, manualTable);
    assert.equal(fake.state.installs.length, 0);
    assert.deepEqual(fake.state.calls.map(c => c.args[0]), ['-l']);
});

test('edit never writes and never calls compute when crontab is unavailable or erroring', HARD_TIMEOUT, async () => {
    const cases = [
        ['denied', f => { f.state.allowed = false; }, 'unavailable', 'denied'],
        ['not installed', f => { f.state.installed = false; }, 'unavailable', 'not-installed'],
        ['hung', f => { f.state.hang = () => true; }, 'error', null],
    ];
    for (const [name, arrange, outcome, reason] of cases) {
        const fake = createFake(manualTable + fooCron);
        arrange(fake);
        let computed = 0;
        const result = await createCrontabClient({ execFile: fake.execFile, timeoutMs: 10 })
            .edit(() => { computed++; return 'x\n'; });
        assert.equal(result.outcome, outcome, name);
        assert.equal(result.before.status, outcome, name);
        assert.equal(result.before.reason, reason, name);
        assert.equal(result.message, result.before.message, name);
        assert.equal(typeof result.message, 'string', name);
        assert.equal(computed, 0, name);
        assert.equal(fake.state.installs.length, 0, name);
        assert.equal(fake.state.table === null || fake.state.table === manualTable + fooCron, true, name);
    }
});

test('edit of a missing crontab computes from empty content and installs the result', HARD_TIMEOUT, async () => {
    const fake = createFake(null);
    let seen;
    const result = await createCrontabClient({ execFile: fake.execFile }).edit(content => { seen = content; return fooCron; });
    assert.equal(seen, '');
    assert.equal(result.outcome, 'written');
    assert.equal(result.before.status, 'empty');
    assert.equal(result.after.status, 'ok');
    assert.equal(result.after.content, fooCron);
    assert.deepEqual(fake.state.installs, [fooCron]);
});

test('edit that removes one line keeps every other byte (comments, blanks, MAILTO, spacing)', HARD_TIMEOUT, async () => {
    const table = manualTable + fooCron + '0 5 * * * echo last\n';
    const fake = createFake(table);
    const result = await createCrontabClient({ execFile: fake.execFile }).edit(removeLinesFor('foo'));
    assert.equal(result.outcome, 'written');
    assert.equal(fake.state.installs.length, 1);
    assert.equal(fake.state.installs[0], manualTable + '0 5 * * * echo last\n');
    assert.equal(result.before.content, table);
    assert.equal(result.after.content, manualTable + '0 5 * * * echo last\n');
    assert.deepEqual(fake.state.calls.map(c => c.args[0]), ['-l', '-l', '-', '-l']);
});

test('edit removing the last remaining line installs an empty crontab', HARD_TIMEOUT, async () => {
    const fake = createFake(fooCron);
    const result = await createCrontabClient({ execFile: fake.execFile }).edit(removeLinesFor('foo'));
    assert.equal(result.outcome, 'written');
    assert.deepEqual(fake.state.installs, ['']);
    assert.equal(result.after.status, 'empty');
});

test('a concurrent modification between the two reads triggers a retry computed from the new table', HARD_TIMEOUT, async () => {
    const fake = createFake(manualTable + fooCron);
    const concurrent = '@daily echo added-by-someone-else\n';
    fake.state.onRead = (n, state) => { if (n === 2) state.table += concurrent; };
    const computeInputs = [];
    const client = createCrontabClient({ execFile: fake.execFile });
    const result = await client.edit(content => { computeInputs.push(content); return removeLinesFor('foo')(content); });
    assert.equal(result.outcome, 'written');
    assert.equal(computeInputs.length, 2);
    assert.equal(computeInputs[0], manualTable + fooCron);
    assert.equal(computeInputs[1], manualTable + fooCron + concurrent);
    // The concurrent edit must not be lost.
    assert.deepEqual(fake.state.installs, [manualTable + concurrent]);
    assert.equal(result.before.content, manualTable + fooCron + concurrent);
});

test('a status change (table appears) between the reads is also a conflict that is retried', HARD_TIMEOUT, async () => {
    const fake = createFake(null);
    fake.state.onRead = (n, state) => { if (n === 2) state.table = '@daily other\n'; };
    const inputs = [];
    const result = await createCrontabClient({ execFile: fake.execFile })
        .edit(content => { inputs.push(content); return content + fooCron; });
    assert.deepEqual(inputs, ['', '@daily other\n']);
    assert.equal(result.outcome, 'written');
    assert.deepEqual(fake.state.installs, ['@daily other\n' + fooCron]);
});

test('persistent modification yields "conflict" after maxAttempts with zero writes', HARD_TIMEOUT, async () => {
    for (const [options, attempts] of [[undefined, 3], [{ maxAttempts: 2 }, 2], [{ maxAttempts: 1 }, 1]]) {
        const fake = createFake(manualTable + fooCron);
        let n = 0;
        fake.state.onRead = (reads, state) => { if (reads % 2 === 0) state.table += `# change ${++n}\n`; };
        let computed = 0;
        const result = await createCrontabClient({ execFile: fake.execFile })
            .edit(content => { computed++; return removeLinesFor('foo')(content); }, options);
        assert.equal(result.outcome, 'conflict');
        assert.match(result.message, /changed while editing/);
        assert.equal(computed, attempts);
        assert.equal(fake.state.installs.length, 0);
        assert.equal(fake.state.calls.length, attempts * 2);
    }
});

test('two successive conflicts still succeed on the third (default) attempt', HARD_TIMEOUT, async () => {
    const fake = createFake(manualTable + fooCron);
    fake.state.onRead = (reads, state) => { if (reads === 2 || reads === 4) state.table += '# x\n'; };
    const result = await createCrontabClient({ execFile: fake.execFile }).edit(removeLinesFor('foo'));
    assert.equal(result.outcome, 'written');
    assert.equal(fake.state.installs.length, 1);
    assert.equal(fake.state.installs[0], manualTable + '# x\n# x\n');
});

test('crontab becoming unavailable at the re-read is reported, not written or called a conflict', HARD_TIMEOUT, async () => {
    const fake = createFake(manualTable + fooCron);
    fake.state.onRead = (n, state) => { if (n === 2) state.allowed = false; };
    const result = await createCrontabClient({ execFile: fake.execFile }).edit(removeLinesFor('foo'), { maxAttempts: 1 });
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.before.status, 'ok');
    assert.equal(fake.state.installs.length, 0);
});

test('a failing install yields "write-failed" and leaves the table untouched', HARD_TIMEOUT, async () => {
    const fake = createFake(manualTable + fooCron);
    fake.state.writeFailure = "errors in crontab file, can't install.\n";
    const result = await createCrontabClient({ execFile: fake.execFile }).edit(removeLinesFor('foo'));
    assert.equal(result.outcome, 'write-failed');
    assert.match(result.message, /errors in crontab file/);
    assert.equal(fake.state.table, manualTable + fooCron);
    assert.equal(result.after, null);
    assert.equal(fake.state.calls.filter(c => c.args[0] === '-l').length, 2); // no post-write read after a failure
});

test('a throwing or invalid compute rejects and leaves nothing half-written', HARD_TIMEOUT, async () => {
    const original = manualTable + fooCron;
    let fake = createFake(original);
    await assert.rejects(
        createCrontabClient({ execFile: fake.execFile }).edit(() => { throw new Error('bug in caller'); }),
        /bug in caller/);
    assert.equal(fake.state.installs.length, 0);
    assert.equal(fake.state.table, original);

    for (const bad of [undefined, 42, Promise.resolve('x\n'), {}]) {
        fake = createFake(original);
        await assert.rejects(createCrontabClient({ execFile: fake.execFile }).edit(() => bad), TypeError);
        assert.equal(fake.state.installs.length, 0);
    }
});

test('header-prepending crontab variants: edit succeeds semantically, no byte equality is required', HARD_TIMEOUT, async () => {
    const fake = createFake(DEBIAN_HEADER + manualTable + fooCron);
    fake.state.header = true;
    let seen;
    const result = await createCrontabClient({ execFile: fake.execFile }).edit(content => { seen = content; return removeLinesFor('foo')(content); });
    assert.equal(seen, DEBIAN_HEADER + manualTable + fooCron);
    assert.equal(result.outcome, 'written');
    assert.notEqual(result.after.content, fake.state.installs[0]); // a new header was prepended by the tool
    assert.equal(isCronEntryFor(result.after.content, 'foo'), false);
    assert.equal(result.after.content.includes(manualTable), true);
});

test('write and edit create nothing in os.tmpdir()', HARD_TIMEOUT, async t => {
    const root = privateTmpdir(t);
    const fake = createFake(manualTable + fooCron);
    const client = createCrontabClient({ execFile: fake.execFile });
    assert.deepEqual(await client.write('@reboot a\n'), { ok: true });
    assert.equal((await client.edit(content => content + '# more\n')).outcome, 'written');
    fake.state.writeFailure = 'nope\n';
    assert.equal((await client.edit(content => content + '# more\n')).outcome, 'write-failed');
    assert.deepEqual(fs.readdirSync(root), []);
    // The tool is invoked with no file operand: only `-l` or `-`.
    for (const call of fake.state.calls) assert.equal(['-l', '-'].includes(call.args[0]) && call.args.length === 1, true);
});

test('createCrontabClient requires an execFile function', () => {
    assert.throws(() => createCrontabClient({}), TypeError);
    assert.throws(() => createCrontabClient(), TypeError);
});
