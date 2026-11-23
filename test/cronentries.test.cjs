'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
    MANAGED_MARKER_V2, buildMountCommand, buildManagedLine, classifyCronLine,
    findEntries, removeLines, removeManaged
} = require('../lib/cronentries');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// Independent re-implementation of cronie do_command.c: what cron passes to
// /bin/sh for the text after the schedule. `\%` -> `%`; first unescaped `%`
// ends the command; `\x` otherwise untouched (the pair is consumed together).
function cronCommand(text) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\' && i + 1 < text.length) {
            if (text[i + 1] === '%') out += '%';
            else out += ch + text[i + 1];
            i++;
        } else if (ch === '%') {
            break;
        } else {
            out += ch;
        }
    }
    return out;
}

const dirs = [];
function tmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'de-rclone-cronentries-'));
    dirs.push(dir);
    return dir;
}
test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

// Run the command cron would run, with fake seq/mkdir/sleep/rclone in a temp
// PATH that record their arguments (NUL-terminated). Nothing real is executed.
function runWithFakes(line) {
    const dir = tmpDir();
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(dir, 'calls.log');
    const fake = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const rec = name => `{ printf '%s\\0' ${name}; for a in "$@"; do printf '%s\\0' "$a"; done; printf '\\n'; } >> '${log}'`;
    fake('seq', 'echo 1');
    fake('sleep', 'exit 0');
    fake('mkdir', `${rec('mkdir')}; exit 0`);
    fake('rclone', `${rec('rclone')}; exit 0`);
    const command = cronCommand(line.replace(/^@reboot /, ''));
    const result = spawnSync('/bin/sh', ['-c', command], {
        env: { PATH: bin, HOME: dir },
        encoding: 'utf8'
    });
    const calls = fs.existsSync(log)
        ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => l.split('\0').slice(0, -1))
        : [];
    return { result, calls, command };
}

function syntaxOk(command) {
    const r = spawnSync('/bin/sh', ['-n', '-c', command], { encoding: 'utf8' });
    return { ok: r.status === 0, stderr: r.stderr };
}

const lineFor = (remoteName, mountPoint = '/mnt/x', configPath) =>
    buildManagedLine({ remoteName, mountPoint, configPath });

// ---------------------------------------------------------------------------
// buildManagedLine
// ---------------------------------------------------------------------------

test('managed command text equals the previous getMountCmdString output', () => {
    assert.equal(
        buildMountCommand('foo', '/run/user/1000/rclone-mounts/foo', '/home/u/.config/rclone/rclone.conf'),
        "for i in $(seq 1 30); do mkdir -p '/run/user/1000/rclone-mounts/foo' 2>/dev/null && break; sleep 2; done; rclone mount 'foo:' '/run/user/1000/rclone-mounts/foo' --vfs-cache-mode writes --daemon --config '/home/u/.config/rclone/rclone.conf'"
    );
    assert.equal(
        buildMountCommand('foo', '/mnt/foo'),
        "for i in $(seq 1 30); do mkdir -p '/mnt/foo' 2>/dev/null && break; sleep 2; done; rclone mount 'foo:' '/mnt/foo' --vfs-cache-mode writes --daemon"
    );
    assert.equal(
        buildMountCommand("it's", "/mnt/it's"),
        "for i in $(seq 1 30); do mkdir -p '/mnt/it'\\''s' 2>/dev/null && break; sleep 2; done; rclone mount 'it'\\''s:' '/mnt/it'\\''s' --vfs-cache-mode writes --daemon"
    );
});

test('buildManagedLine: @reboot, command, v2 marker with base64url name', () => {
    const line = buildManagedLine({ remoteName: 'foo', mountPoint: '/mnt/foo', configPath: '/c' });
    assert.equal(MANAGED_MARKER_V2, '# de_rclone:v2 remote=');
    assert.equal(
        line,
        "@reboot for i in $(seq 1 30); do mkdir -p '/mnt/foo' 2>/dev/null && break; sleep 2; done; rclone mount 'foo:' '/mnt/foo' --vfs-cache-mode writes --daemon --config '/c' # de_rclone:v2 remote=Zm9v"
    );
    assert.ok(!line.includes('\n'));
    // base64url: no '+', '/', '=' even where base64 would use them
    const odd = buildManagedLine({ remoteName: '\u00ff\u00fe?>', mountPoint: '/m' });
    assert.match(odd, /remote=[A-Za-z0-9_-]+$/);
});

test('buildManagedLine rejects missing values and CR/LF', () => {
    const ok = { remoteName: 'a', mountPoint: '/m', configPath: '/c' };
    assert.doesNotThrow(() => buildManagedLine(ok));
    assert.doesNotThrow(() => buildManagedLine({ remoteName: 'a', mountPoint: '/m' }));
    for (const bad of ['a\nb', 'a\rb', 'a\r\nb', '\n']) {
        assert.throws(() => buildManagedLine({ ...ok, remoteName: bad }), /remoteName/);
        assert.throws(() => buildManagedLine({ ...ok, mountPoint: bad }), /mountPoint/);
        assert.throws(() => buildManagedLine({ ...ok, configPath: bad }), /configPath/);
    }
    assert.throws(() => buildManagedLine({ ...ok, remoteName: '' }), /remoteName/);
    assert.throws(() => buildManagedLine({ ...ok, mountPoint: '' }), /mountPoint/);
    assert.throws(() => buildManagedLine({ ...ok, remoteName: 5 }), /remoteName/);
    assert.throws(() => buildManagedLine(), /remoteName/);
});

test('every % is escaped so cron keeps the whole command', () => {
    const line = buildManagedLine({ remoteName: '100%', mountPoint: '/mnt/50%/x', configPath: '/c%d' });
    const body = line.slice('@reboot '.length);
    assert.equal(cronCommand(body), body.replace(/\\%/g, '%'));
    assert.ok(cronCommand(body).includes("'/mnt/50%/x'"));
    assert.ok(cronCommand(body).includes("'100%:'"));
    assert.ok(cronCommand(body).endsWith('# de_rclone:v2 remote=MTAwJQ'));
    assert.ok(!line.includes("'/mnt/50%/x'"));
});

const PERCENT_CASES = [
    ['percent in mount path', 'foo', '/mnt/50%/x'],
    ['percent in remote and config', '100%', '/mnt/a', '/cfg/%h/rclone.conf'],
    ['double percent', 'a%%b', '/mnt/%%'],
    ['percent at end', 'foo', '/mnt/x%'],
    ['backslash before percent', 'foo', '/mnt/a\\%b'],
    ['backslashes before percent', 'foo', '/mnt/a\\\\%b'],
    ['backslash before percent in remote and apostrophe', "it's\\%", "/mnt/it's\\%"],
    ['trailing backslash then percent in config', 'foo', '/mnt/a', '/c\\%'],
    ['backslash not before percent', 'foo', '/mnt/a\\b%c\\'],
    ['unicode and spaces', 'caf\u00e9 \u30c6\u30b9\u30c8 %', '/mnt/caf\u00e9 %/x y'],
    ['dollar, backtick, quotes', 'a$b`c"d', '/mnt/$HOME/`x`/"%"']
];

for (const [label, remoteName, mountPoint, configPath] of PERCENT_CASES) {
    test(`cron percent handling then sh: ${label}`, () => {
        const line = buildManagedLine({ remoteName, mountPoint, configPath });
        const command = cronCommand(line.replace(/^@reboot /, ''));
        // the command survives cron whole: marker still at the end
        assert.ok(command.endsWith(` ${MANAGED_MARKER_V2}${Buffer.from(remoteName).toString('base64url')}`), command);
        const syntax = syntaxOk(command);
        assert.ok(syntax.ok, `sh -n failed: ${syntax.stderr}\n${command}`);
        // and when executed (fakes) rclone/mkdir get the exact original strings
        const { result, calls } = runWithFakes(line);
        assert.equal(result.status, 0, result.stderr);
        const rclone = calls.find(c => c[0] === 'rclone');
        const mkdir = calls.find(c => c[0] === 'mkdir');
        assert.deepEqual(mkdir, ['mkdir', '-p', mountPoint]);
        const expected = ['rclone', 'mount', `${remoteName}:`, mountPoint, '--vfs-cache-mode', 'writes', '--daemon'];
        if (configPath) expected.push('--config', configPath);
        assert.deepEqual(rclone, expected);
        // and it still parses as this remote's managed line only
        assert.equal(classifyCronLine(line, remoteName), 'managed');
    });
}

test('without escaping, cron would cut the command at % (helper sanity check)', () => {
    const naive = buildMountCommand('foo', '/mnt/50%/x');
    assert.ok(!cronCommand(naive).includes('/x'));
    assert.ok(cronCommand(naive).endsWith("'/mnt/50"));
});

// ---------------------------------------------------------------------------
// classifyCronLine tables
// ---------------------------------------------------------------------------

const MANUAL = [
    // from the issue
    'rclone mount --vfs-cache-mode full foo: /x',
    'RCLONE_CONFIG_PASS=x rclone mount foo: /x',
    'nice rclone mount foo: /x',
    "sh -c 'rclone mount foo: /x'",
    '/usr/bin/rclone mount "foo:" /x',
    'rclone --config /c mount foo: /x',
    // more shapes
    'rclone mount foo: /x',
    'rclone mount foo:path/sub /x',
    "rclone mount 'foo:' /x",
    'rclone mount foo:\\ /x'.replace('foo:\\ ', 'foo:'),
    '/usr/local/bin/rclone mount foo: /x --daemon',
    'rclone mount --daemon --vfs-cache-mode writes --allow-other foo: /x',
    'rclone mount --vfs-cache-mode=full foo: /x',
    'rclone mount -o allow_other foo: /x',
    'rclone mount -o allow_other -o ro foo: /x',
    'rclone mount --option allow_other foo: /x',
    'rclone mount --config=/c foo: /x',
    'rclone --config /c --log-file /l mount foo: /x',
    'rclone --verbose mount foo: /x',
    'rclone -vv mount foo: /x',
    'rclone -P mount foo: /x',
    'rclone mount --uid 1000 --gid 1000 --umask 022 foo: /x',
    'rclone mount --dir-cache-time 5m --poll-interval 0 foo: /x',
    'rclone mount --exclude "*.tmp" --exclude secret foo: /x',
    'rclone mount --filter "- *.tmp" foo: /x',
    'rclone mount -f "- *.tmp" foo: /x',
    'rclone mount -- foo: /x',
    'rclone mount --daemon foo:',
    'FOO=1 BAR="a b" rclone mount foo: /x',
    'env rclone mount foo: /x',
    'env -i PATH=/usr/bin rclone mount foo: /x',
    'env -u HOME FOO=1 rclone mount foo: /x',
    'nice -n 10 rclone mount foo: /x',
    'nice -10 rclone mount foo: /x',
    'nice --adjustment=5 rclone mount foo: /x',
    'ionice -c 3 rclone mount foo: /x',
    'ionice -c2 -n7 rclone mount foo: /x',
    'nice ionice -c 3 nohup rclone mount foo: /x',
    'nohup rclone mount foo: /x',
    'nohup rclone mount foo: /x > /dev/null 2>&1',
    'nohup rclone mount foo: /x >/dev/null 2>&1 &',
    'timeout 30 rclone mount foo: /x',
    'timeout -s KILL 30s rclone mount foo: /x',
    'timeout --kill-after=5 30 nice rclone mount foo: /x',
    'exec rclone mount foo: /x',
    'sleep 30 && rclone mount foo: /x',
    'sleep 30; rclone mount foo: /x',
    'true || rclone mount foo: /x',
    'mkdir -p /x && rclone mount foo: /x',
    'for i in $(seq 1 30); do mkdir -p /x && break; sleep 2; done; rclone mount foo: /x --daemon',
    'if true; then rclone mount foo: /x; fi',
    'while true; do rclone mount foo: /x; done',
    '(rclone mount foo: /x)',
    "bash -c 'rclone mount foo: /x'",
    "sh -c 'sleep 5; rclone mount foo: /x'",
    'sh -c "rclone mount foo: /x"',
    "/bin/sh -c 'nice rclone mount foo: /x'",
    "bash -lc 'rclone --config /c mount foo: /x'",
    "bash -e -c 'rclone mount foo: /x'",
    "sh -c 'rclone mount \"foo:\" /x'",
    "rclone mount foo: /x # comment",
    'rclone mount foo: /x # rclone mount other:',
    'rclone mount foo: /x 2>&1 | logger',
    'rclone mount foo: /x >> /var/log/rc.log 2>&1',
    'rclone mount foo: /mnt/50\\%/x',
    'rclone mount foo: /x % some stdin text',
    'rclone mount foo: /x\\%y'
];

const SCHEDULES = ['@reboot', '@daily', '*/5 * * * *', '0 3 * * 1-5', '15,45 8-18 1 JAN,JUL mon', '  @reboot', '@reboot\t'];

test('manual: table of real-looking cron lines (each schedule form)', () => {
    for (const body of MANUAL) {
        for (const schedule of SCHEDULES) {
            const line = `${schedule}${/\s$/.test(schedule) ? '' : ' '}${body}`;
            assert.equal(classifyCronLine(line, 'foo'), 'manual', line);
        }
    }
});

test('manual: names with spaces, quotes, unicode', () => {
    const cases = [
        ['foo bar', "rclone mount 'foo bar:' /x"],
        ['foo bar', 'rclone mount "foo bar:" /x'],
        ['foo bar', 'rclone mount foo\\ bar: /x'],
        ['foo bar', 'rclone mount "foo bar:sub dir" /x'],
        ["it's", "rclone mount 'it'\\''s:' /x"],
        ["it's", 'rclone mount "it\'s:" /x'],
        ['caf\u00e9', 'rclone mount caf\u00e9: /x'],
        ['\u30c6\u30b9\u30c8', "sh -c 'rclone mount \u30c6\u30b9\u30c8: /x'"],
        ['100%', 'rclone mount 100\\%: /x'],
        ['a.b-c_d', 'rclone mount a.b-c_d: /x']
    ];
    for (const [name, body] of cases) {
        assert.equal(classifyCronLine(`@reboot ${body}`, name), 'manual', body);
    }
});

const NONE = [
    // from the issue
    'rclone mount prefixfoo: /x',
    'rclone mount other: /mnt/foo:',
    'rclone mount other: /x # foo:',
    'echo rclone mount foo:',
    'rclone copy foo: /x',
    'rclone mount',
    'rclone mount --daemon',
    "rclone mount foo: '/x",           // unterminated quote
    'rclone mount "foo: /x',
    // more
    'rclone mount foofoo: /x',
    'rclone mount foo /x',               // no colon
    'rclone mount Foo: /x',              // case matters
    'rclone mount /x foo:',              // first positional is the mount point
    'rclone mount other: foo:',
    'rclone mount --vfs-cache-mode foo: other: /x',    // foo: is the value of the flag
    'rclone mount --config foo: other: /x',
    'rclone --config foo: mount other: /x',
    'rclone -o foo: mount other: /x',
    'rclone sync foo: /x',
    'rclone ls foo:',
    'rclone cmount foo: /x',
    'rclone copy other: /x && rclone mount other: foo:',
    'rclone lsd foo: ; rclone mount other: /x',
    'rclone mounts foo: /x',
    'rclone-wrapper mount foo: /x',
    'myrclone mount foo: /x',
    'rclone.sh mount foo: /x',
    'echo foo: | rclone mount other: /x',
    'echo "rclone mount foo: /x"',
    "echo 'rclone mount foo: /x'",
    'echo ";" rclone mount foo: /x',
    'printf rclone mount foo:',
    'ls /usr/bin/rclone mount foo:',
    'cat rclone mount foo: /x',
    'sudo rclone mount foo: /x',
    'sudo -u me rclone mount foo: /x',
    'rclone mount other: /x # rclone mount foo: /y',
    'rclone mount other: /x #foo:',
    '# rclone mount foo: /x',                // comment
    '#@reboot rclone mount foo: /x',
    '  # @reboot rclone mount foo: /x',
    '#',
    '',
    '   ',
    'FOO=bar',
    'FOO="rclone mount foo: /x"',
    'MAILTO=me@example.com',
    'PATH=/usr/bin:/bin',
    'SHELL=/bin/sh',
    'RCLONE_CONFIG_PASS=x',
    'FOO=rclone mount foo: /x',
    'RCLONE=rclone mount foo: /x',
    '@reboot',
    '@reboot ',
    '@reboot # rclone mount foo: /x',
    '@reboot rclone mount other: % foo: /x', // % ends the command: foo: is stdin text
    '@reboot rclone mount % foo: /x',        // text after % is stdin, not arguments
    '@reboot echo hi % rclone mount foo: /x',
    '@reboot true % ; rclone mount foo: /x',  // everything after % is stdin text
    '@reboot echo % && rclone mount foo: /x',
    '@reboot sh -c rclone mount foo: /x',      // script is just `rclone`
    "@reboot sh -c 'echo; rclone mount other: /x' foo:",
    "@reboot sh script.sh 'rclone mount foo: /x'",
    "@reboot sh -c 'sh -c \"rclone mount foo: /x\"'",   // only one level
    "@reboot sh -c 'rclone mount foo: /x",   // unterminated quote
    "@reboot sh -c ''",
    '@reboot nice -n rclone mount foo: /x',  // `rclone` consumed as -n's value
    '@reboot timeout rclone mount foo: /x',  // `rclone` consumed as the duration
    'not a cron line rclone mount foo: /x',
    '0 3 * *  rclone mount foo: /x'          // only 4 time fields + command
];

test('none: must-not-match table', () => {
    for (const body of NONE) {
        const lines = body.startsWith('@reboot') || /^(#|\s|FOO|MAILTO|PATH|SHELL|RCLONE|not |0 3|$)/.test(body)
            ? [body]
            : SCHEDULES.slice(0, 4).map(s => `${s} ${body}`);
        for (const line of lines) {
            assert.equal(classifyCronLine(line, 'foo'), 'none', JSON.stringify(line));
        }
    }
});

test('manual name must match the remote exactly at the colon', () => {
    assert.equal(classifyCronLine('@reboot rclone mount foo: /x', 'fo'), 'none');
    assert.equal(classifyCronLine('@reboot rclone mount foo: /x', 'foo bar'), 'none');
    assert.equal(classifyCronLine('@reboot rclone mount "foo bar:" /x', 'foo'), 'none');
    assert.equal(classifyCronLine('@reboot rclone mount "foo bar:" /x', 'bar'), 'none');
    assert.equal(classifyCronLine('@reboot rclone mount "foo bar:" /x', 'foo bar'), 'manual');
});

test('every example from the issue is manual for foo and none for similar names', () => {
    const issue = [
        'rclone mount --vfs-cache-mode full foo: /x',
        'RCLONE_CONFIG_PASS=x rclone mount foo: /x',
        'nice rclone mount foo: /x',
        "sh -c 'rclone mount foo: /x'",
        '/usr/bin/rclone mount "foo:" /x',
        'rclone --config /c mount foo: /x'
    ];
    for (const body of issue) {
        const line = `@reboot ${body}`;
        assert.equal(classifyCronLine(line, 'foo'), 'manual', line);
        for (const other of ['prefixfoo', 'foo2', 'fo', 'foo bar', 'x']) {
            assert.equal(classifyCronLine(line, other), 'none', `${other}: ${line}`);
        }
    }
});

// ---------------------------------------------------------------------------
// managed classification
// ---------------------------------------------------------------------------

const NAMES = ['foo', 'prefixfoo', 'foo bar', "it's", '100%', 'caf\u00e9', '\u30c6\u30b9\u30c8 \u{1F600}', 'a"b', 'a$b`c', 'back\\slash', 'a\\%b', '-', 'x.y_z-1'];

test('round trip: buildManagedLine is managed for its own name only', () => {
    for (const name of NAMES) {
        for (const configPath of [undefined, '/home/u/.config/rclone/rclone.conf', "/tmp/it's %x/rclone.conf"]) {
            const line = lineFor(name, `/run/user/1000/rclone-mounts/${name}`, configPath);
            assert.equal(classifyCronLine(line, name), 'managed', line);
            for (const other of NAMES.filter(n => n !== name).concat(['', 'fo', 'foo ', ' foo', 'FOO'])) {
                assert.equal(classifyCronLine(line, other), 'none', `${JSON.stringify(other)} vs ${line}`);
            }
        }
    }
});

test('managed: v2 marker details', () => {
    const line = lineFor('foo');
    assert.equal(classifyCronLine(line + '   ', 'foo'), 'managed');
    assert.equal(classifyCronLine(line + '\r', 'foo'), 'managed');
    // marker must decode to exactly the name; non-canonical base64url is not accepted
    assert.equal(classifyCronLine('@reboot x # de_rclone:v2 remote=Zm9v', 'foo'), 'managed');
    assert.equal(classifyCronLine('@reboot x # de_rclone:v2 remote=Zm9vYg', 'foo'), 'none');
    assert.equal(classifyCronLine('@reboot x # de_rclone:v2 remote=Zm9=', 'foo'), 'none');
    assert.equal(classifyCronLine('@reboot x # de_rclone:v2 remote=Zm9', 'fo'), 'none', 'non-canonical base64url');
    assert.equal(classifyCronLine('@reboot x # de_rclone:v2 remote=Zm8', 'fo'), 'managed');
    assert.equal(classifyCronLine('@reboot x # de_rclone:v2 remote=Zm9v', 'foob'), 'none');
    assert.equal(classifyCronLine('@reboot x # de_rclone:v2 remote=', 'foo'), 'none');
    // marker must be at the end of the line
    assert.equal(classifyCronLine('@reboot x # de_rclone:v2 remote=Zm9v # more', 'foo'), 'none');
    assert.equal(classifyCronLine('@reboot x # de_rclone:v2 remote=Zm9v trailing', 'foo'), 'none');
    // a comment line carrying the marker is not managed
    assert.equal(classifyCronLine('# @reboot x # de_rclone:v2 remote=Zm9v', 'foo'), 'none');
    assert.equal(classifyCronLine('   #x # de_rclone:v2 remote=Zm9v', 'foo'), 'none');
    // marker glued to other text is not a comment start
    assert.equal(classifyCronLine('@reboot x# de_rclone:v2 remote=Zm9v', 'foo'), 'none');
});

test('managed: legacy v1 marker', () => {
    assert.equal(classifyCronLine("@reboot rclone mount 'foo:' '/x' # Added by de_rclone: foo", 'foo'), 'managed');
    assert.equal(classifyCronLine("@reboot rclone mount 'foo:' '/x' # Added by de_rclone: foo  ", 'foo'), 'managed');
    assert.equal(classifyCronLine("@reboot rclone mount 'foo:' '/x' # Added by de_rclone: foo\r", 'foo'), 'managed');
    assert.equal(classifyCronLine("@reboot cmd # Added by de_rclone: foo bar", 'foo bar'), 'managed');
    assert.equal(classifyCronLine("@reboot cmd # Added by de_rclone: foo bar", 'foo'), 'none');
    assert.equal(classifyCronLine("@reboot cmd # Added by de_rclone: foo bar", 'bar'), 'none');
    assert.equal(classifyCronLine("@reboot cmd # Added by de_rclone: prefixfoo", 'foo'), 'none');
    assert.equal(classifyCronLine("@reboot cmd # Added by de_rclone: foo", 'foo2'), 'none');
    assert.equal(classifyCronLine("@reboot cmd # Added by de_rclone: foo # x", 'foo'), 'none');
    assert.equal(classifyCronLine("@reboot cmd # Added by de_rclone: Foo", 'foo'), 'none');
    assert.equal(classifyCronLine("# @reboot cmd # Added by de_rclone: foo", 'foo'), 'none');
    assert.equal(classifyCronLine("@reboot cmd #Added by de_rclone: foo", 'foo'), 'none');
    assert.equal(classifyCronLine("@reboot cmd# Added by de_rclone: foo", 'foo'), 'none');
    // the old main.js line shape, for a name with a space is still ours
    assert.equal(classifyCronLine("@reboot for i in $(seq 1 30); do mkdir -p '/m/a b' 2>/dev/null && break; sleep 2; done; rclone mount 'a b:' '/m/a b' --vfs-cache-mode writes --daemon # Added by de_rclone: a b", 'a b'), 'managed');
});

test('a managed line is never also reported as manual', () => {
    const content = `${lineFor('foo')}\n@reboot rclone mount foo: /x\n`;
    const found = findEntries(content, 'foo');
    assert.deepEqual(found.managed, [lineFor('foo')]);
    assert.deepEqual(found.manual, ['@reboot rclone mount foo: /x']);
});

test('managed line whose marker was stripped becomes manual', () => {
    const line = lineFor('foo', '/mnt/foo', '/c').replace(/ # de_rclone:v2 remote=.*$/, '');
    assert.equal(classifyCronLine(line, 'foo'), 'manual');
});

test('managed lines for other remotes are not manual for this one', () => {
    for (const name of ['prefixfoo', 'foo bar']) {
        assert.equal(classifyCronLine(lineFor(name, '/mnt/foo'), 'foo'), 'none');
    }
});

// ---------------------------------------------------------------------------
// findEntries
// ---------------------------------------------------------------------------

test('findEntries returns exact lines in order', () => {
    const m1 = lineFor('foo', '/m/foo');
    const m2 = "@reboot cmd # Added by de_rclone: foo";
    const manual1 = '  0 3 * * *   /usr/bin/rclone mount "foo:" /x  ';
    const manual2 = "@daily nice rclone mount foo: /y\r";
    const content = [
        '# my crontab', 'MAILTO=me@example.com', '',
        m1, lineFor('prefixfoo', '/m/p'), manual1, 'rclone mount foo: /not-a-cron-line-but-no-schedule',
        '@reboot rclone mount other: /x # foo:', m2, manual2, '# @reboot rclone mount foo: /x', ''
    ].join('\n');
    const found = findEntries(content, 'foo');
    assert.deepEqual(found.managed, [m1, m2]);
    assert.deepEqual(found.manual, [manual1, manual2]);
    assert.deepEqual(findEntries(content, 'nothing'), { managed: [], manual: [] });
    assert.deepEqual(findEntries('', 'foo'), { managed: [], manual: [] });
    assert.deepEqual(findEntries(undefined, 'foo'), { managed: [], manual: [] });
});

test('findEntries on CRLF content keeps the CR in returned lines', () => {
    const m = lineFor('foo');
    const found = findEntries(`MAILTO=x\r\n${m}\r\n@reboot rclone mount foo: /x\r\n`, 'foo');
    assert.deepEqual(found.managed, [`${m}\r`]);
    assert.deepEqual(found.manual, ['@reboot rclone mount foo: /x\r']);
});

// ---------------------------------------------------------------------------
// removeLines / removeManaged
// ---------------------------------------------------------------------------

test('removeLines: removes exactly the given occurrences, preserves all other bytes', () => {
    const content = '# c\n\nMAILTO=a@b \n  \n@daily x  \n@hourly y\n\n\n';
    assert.equal(removeLines(content, ['@daily x  ']), '# c\n\nMAILTO=a@b \n  \n@hourly y\n\n\n');
    assert.equal(removeLines(content, ['@hourly y']), '# c\n\nMAILTO=a@b \n  \n@daily x  \n\n\n');
    assert.equal(removeLines(content, []), content);
    assert.equal(removeLines(content, ['not present']), content);
    assert.equal(removeLines(content, ['@daily x']), content, 'exact match only (trailing spaces matter)');
    assert.equal(removeLines(content, ['@daily x  ', '@hourly y', '# c', 'MAILTO=a@b ']), '\n  \n\n\n');
});

test('removeLines: CRLF content', () => {
    const content = 'MAILTO=x\r\n@reboot a\r\n@reboot b\r\n\r\n';
    assert.equal(removeLines(content, ['@reboot a\r']), 'MAILTO=x\r\n@reboot b\r\n\r\n');
    assert.equal(removeLines(content, ['@reboot a']), content, 'CR is part of the line');
});

test('removeLines: missing final newline', () => {
    assert.equal(removeLines('a\nb\nc', ['a']), 'b\nc');
    assert.equal(removeLines('a\nb\nc', ['b']), 'a\nc');
    assert.equal(removeLines('a\nb\nc', ['c']), 'a\nb\n');
    assert.equal(removeLines('a', ['a']), '');
    assert.equal(removeLines('a\n', ['a']), '');
    assert.equal(removeLines('a\nb', ['a', 'b']), '');
    assert.equal(removeLines('', ['a']), '');
    assert.equal(removeLines('', []), '');
});

test('removeLines: duplicates remove one occurrence per given line, first ones first', () => {
    assert.equal(removeLines('x\ny\nx\nz\nx\n', ['x']), 'y\nx\nz\nx\n');
    assert.equal(removeLines('x\ny\nx\nz\nx\n', ['x', 'x']), 'y\nz\nx\n');
    assert.equal(removeLines('x\ny\nx\nz\nx\n', ['x', 'x', 'x', 'x']), 'y\nz\n');
});

test('removeLines: blank given line removes one blank line, never the end sentinel', () => {
    assert.equal(removeLines('a\n\nb\n', ['']), 'a\nb\n');
    assert.equal(removeLines('a\n', ['']), 'a\n');
});

test('removeLines: lone CR and unusual bytes survive', () => {
    const content = 'a\rb\n\ttab\n\u00e9\u30c6\n\0nul\n';
    assert.equal(removeLines(content, ['\ttab']), 'a\rb\n\u00e9\u30c6\n\0nul\n');
});

test('removeManaged removes only managed lines of that remote and reports them', () => {
    const mFoo = lineFor('foo', '/m/foo', '/c');
    const mFoo2 = '@reboot old # Added by de_rclone: foo';
    const mOther = lineFor('prefixfoo');
    const manual = '@reboot nice rclone mount foo: /x';
    const content = `# top\nMAILTO=me\n\n${mFoo}\n${manual}\n${mOther}\n${mFoo2}\n\n@daily backup  \n`;
    const out = removeManaged(content, 'foo');
    assert.deepEqual(out.removed, [mFoo, mFoo2]);
    assert.equal(out.content, `# top\nMAILTO=me\n\n${manual}\n${mOther}\n\n@daily backup  \n`);
    // second run is a no-op
    const again = removeManaged(out.content, 'foo');
    assert.deepEqual(again.removed, []);
    assert.equal(again.content, out.content);
});

test('removeManaged: duplicates, CRLF, no trailing newline, manual-only content', () => {
    const m = lineFor('foo');
    assert.deepEqual(removeManaged(`${m}\n${m}\nkeep`, 'foo'), { content: 'keep', removed: [m, m] });
    assert.deepEqual(removeManaged(`keep\r\n${m}\r\nkeep2\r\n`, 'foo'), { content: 'keep\r\nkeep2\r\n', removed: [`${m}\r`] });
    assert.deepEqual(removeManaged(`keep\n${m}`, 'foo'), { content: 'keep\n', removed: [m] });
    const manualOnly = '@reboot rclone mount foo: /x\n  \n#c';
    assert.deepEqual(removeManaged(manualOnly, 'foo'), { content: manualOnly, removed: [] });
    assert.deepEqual(removeManaged('', 'foo'), { content: '', removed: [] });
});

test('removeManaged keeps a remote with a similar name intact', () => {
    const content = [lineFor('foo'), lineFor('foo bar'), lineFor('prefixfoo'), lineFor('Foo')].join('\n') + '\n';
    const out = removeManaged(content, 'foo');
    assert.equal(out.content, [lineFor('foo bar'), lineFor('prefixfoo'), lineFor('Foo')].join('\n') + '\n');
    assert.deepEqual(out.removed, [lineFor('foo')]);
});
