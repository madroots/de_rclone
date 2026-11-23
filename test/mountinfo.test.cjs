'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    MOUNT_STATES,
    unescapeMountinfoField,
    parseMountinfo,
    classifyMount,
    createMountProbe,
    readMountinfo,
    canonicalizeMountPoint,
    mountsDirectlyUnder,
} = require('../lib/mountinfo');

// Fixtures are synthetic and follow the proc(5) /proc/[pid]/mountinfo format:
//   id parent major:minor root mountpoint options [optional fields...] - fstype source superoptions
// Kernel escaping (fs/proc_namespace.c show_mountinfo -> seq_path/mangle) uses
// \040 (space), \011 (tab), \012 (newline) and \134 (backslash).

const RCLONE = (id, mp, remote) => `${id} 20 0:50 / ${mp} rw,nosuid,nodev,relatime shared:9 - fuse.rclone ${remote} rw,user_id=1000,group_id=1000`;

function tmpDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'de-rclone-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return fs.realpathSync(dir);
}

function codeError(code, message = code) {
    const e = new Error(message);
    e.code = code;
    return e;
}

test('MOUNT_STATES is frozen with the documented values', () => {
    assert.deepEqual({ ...MOUNT_STATES }, {
        UNMOUNTED: 'unmounted',
        MOUNTED: 'mounted',
        STALE: 'stale',
        FOREIGN: 'foreign',
        UNKNOWN: 'unknown',
    });
    assert.ok(Object.isFrozen(MOUNT_STATES));
});

test('unescapeMountinfoField decodes the kernel escapes', () => {
    assert.equal(unescapeMountinfoField('a\\040b'), 'a b');
    assert.equal(unescapeMountinfoField('a\\011b'), 'a\tb');
    assert.equal(unescapeMountinfoField('a\\012b'), 'a\nb');
    assert.equal(unescapeMountinfoField('a\\134b'), 'a\\b');
    assert.equal(unescapeMountinfoField('plain'), 'plain');
    assert.equal(unescapeMountinfoField(''), '');
});

test('unescapeMountinfoField handles adjacent escapes', () => {
    assert.equal(unescapeMountinfoField('\\040\\040\\011\\012'), '  \t\n');
    assert.equal(unescapeMountinfoField('x\\134\\134y'), 'x\\\\y');
});

test('unescapeMountinfoField decodes in one pass: \\134040 is backslash + "040", not a space', () => {
    assert.equal(unescapeMountinfoField('\\134040'), '\\040');
    assert.equal(unescapeMountinfoField('a\\134040b'), 'a\\040b');
    assert.equal(unescapeMountinfoField('\\134134'), '\\134');
});

test('unescapeMountinfoField leaves invalid or short sequences literal', () => {
    assert.equal(unescapeMountinfoField('a\\04'), 'a\\04');
    assert.equal(unescapeMountinfoField('a\\0'), 'a\\0');
    assert.equal(unescapeMountinfoField('a\\'), 'a\\');
    assert.equal(unescapeMountinfoField('a\\089'), 'a\\089'); // 8 and 9 are not octal
    assert.equal(unescapeMountinfoField('a\\x40'), 'a\\x40');
    assert.equal(unescapeMountinfoField('a\\777'), 'a\\777'); // > 0o377 is not a byte
    assert.equal(unescapeMountinfoField('\\04\\040'), '\\04 ');
});

test('unescapeMountinfoField round-trips escaped UTF-8 bytes and passes raw UTF-8 through', () => {
    assert.equal(unescapeMountinfoField('caf\\303\\251'), 'café');
    assert.equal(unescapeMountinfoField('café\\040x'), 'café x');
});

test('parseMountinfo: zero optional fields', () => {
    const text = '36 35 98:0 /mnt1 /mnt2 rw,noatime - ext3 /dev/root rw,errors=continue\n';
    assert.deepEqual(parseMountinfo(text), [
        { mountId: 36, parentId: 35, root: '/mnt1', mountPoint: '/mnt2', fsType: 'ext3', source: '/dev/root' },
    ]);
});

test('parseMountinfo: several optional fields up to the "-" separator', () => {
    const text = '36 35 98:0 / /mnt rw,noatime shared:1 master:2 - ext3 /dev/root rw\n';
    const [e] = parseMountinfo(text);
    assert.equal(e.mountPoint, '/mnt');
    assert.equal(e.fsType, 'ext3');
    assert.equal(e.source, '/dev/root');
});

test('parseMountinfo: a "-" inside a field value does not act as separator', () => {
    const text = '40 20 0:50 /a-b /mnt/x-y rw - fuse.sshfs user@host-1:/dir rw\n';
    const [e] = parseMountinfo(text);
    assert.equal(e.root, '/a-b');
    assert.equal(e.mountPoint, '/mnt/x-y');
    assert.equal(e.fsType, 'fuse.sshfs');
    assert.equal(e.source, 'user@host-1:/dir');
});

test('parseMountinfo: unescapes mountPoint, root and source but not fsType', () => {
    const text = [
        '50 20 0:60 /sub\\040dir /mnt/my\\040remote rw - fuse.rclone my\\040remote: rw',
        '51 20 0:61 / /mnt/tab\\011here rw - tmpfs none rw',
        '52 20 0:62 / /mnt/back\\134slash rw - tmpfs none rw',
        '53 20 0:63 / /mnt/two\\040\\040spaces rw - tmpfs none rw',
        '54 20 0:64 / /mnt/lit\\134040 rw - tmpfs none rw',
        '55 20 0:65 / /mnt/nl\\012x rw - tmpfs none rw',
    ].join('\n');
    const e = parseMountinfo(text);
    assert.equal(e[0].root, '/sub dir');
    assert.equal(e[0].mountPoint, '/mnt/my remote');
    assert.equal(e[0].source, 'my remote:');
    assert.equal(e[1].mountPoint, '/mnt/tab\there');
    assert.equal(e[2].mountPoint, '/mnt/back\\slash');
    assert.equal(e[3].mountPoint, '/mnt/two  spaces');
    assert.equal(e[4].mountPoint, '/mnt/lit\\040');
    assert.equal(e[5].mountPoint, '/mnt/nl\nx');
});

test('parseMountinfo: distinguishes fuse.rclone, fuse.sshfs, nfs4 and tmpfs and keeps file order', () => {
    const text = [
        RCLONE(60, '/run/user/1000/rclone-mounts/gdrive', 'gdrive:'),
        '61 20 0:51 / /mnt/ssh rw - fuse.sshfs me@host:/data rw,user_id=1000',
        '62 20 0:52 / /mnt/nfs rw - nfs4 server:/export rw,vers=4.2',
        '63 20 0:53 / /mnt/tmp rw - tmpfs tmpfs rw,size=1k',
    ].join('\n') + '\n';
    const e = parseMountinfo(text);
    assert.deepEqual(e.map((x) => [x.mountId, x.fsType, x.source]), [
        [60, 'fuse.rclone', 'gdrive:'],
        [61, 'fuse.sshfs', 'me@host:/data'],
        [62, 'nfs4', 'server:/export'],
        [63, 'tmpfs', 'tmpfs'],
    ]);
    assert.equal(typeof e[0].mountId, 'number');
    assert.equal(typeof e[0].parentId, 'number');
});

test('parseMountinfo: skips malformed lines silently and keeps the good ones', () => {
    const good1 = '36 35 98:0 / /a rw - ext4 /dev/a rw';
    const good2 = '37 35 98:1 / /b rw shared:1 - ext4 /dev/b rw';
    const text = [
        good1,
        'garbage',
        '38 35 98:2 / /c rw ext4 /dev/c rw', // no separator
        '39 35 98:3 / /d rw - ext4', // no source
        'x y 98:4 / /e rw - ext4 /dev/e rw', // non-numeric ids
        '40 35 98:5 / /f', // truncated
        '',
        good2,
        '   ',
    ].join('\n');
    const e = parseMountinfo(text);
    assert.deepEqual(e.map((x) => x.mountPoint), ['/a', '/b']);
});

test('parseMountinfo: empty, trailing-newline-only and non-string input yield []', () => {
    assert.deepEqual(parseMountinfo(''), []);
    assert.deepEqual(parseMountinfo('\n\n'), []);
    assert.deepEqual(parseMountinfo(undefined), []);
    assert.deepEqual(parseMountinfo(null), []);
});

test('parseMountinfo: input without trailing newline still parses the last line', () => {
    assert.equal(parseMountinfo('36 35 98:0 / /a rw - ext4 /dev/a rw').length, 1);
});

test('classifyMount: no matching entry is UNMOUNTED and the probe is never called', async () => {
    let probed = false;
    const entries = parseMountinfo(RCLONE(60, '/mnt/other', 'other:'));
    const r = await classifyMount({
        entries,
        mountPoint: '/mnt/gdrive',
        remoteName: 'gdrive',
        probe: async () => {
            probed = true;
        },
    });
    assert.equal(r.state, MOUNT_STATES.UNMOUNTED);
    assert.equal(r.entry, undefined);
    assert.equal(probed, false);
});

test('classifyMount: matching is exact string equality (prefix/suffix/trailing slash do not match)', async () => {
    const entries = parseMountinfo([
        RCLONE(60, '/mnt/gdrive2', 'gdrive:'),
        RCLONE(61, '/mnt/gdrive/sub', 'gdrive:'),
        RCLONE(62, '/mnt/gdrive/', 'gdrive:'),
    ].join('\n'));
    const r = await classifyMount({ entries, mountPoint: '/mnt/gdrive', remoteName: 'gdrive', probe: async () => {} });
    assert.equal(r.state, MOUNT_STATES.UNMOUNTED);
});

test('classifyMount: our fuse.rclone mount with a succeeding probe is MOUNTED', async () => {
    const entries = parseMountinfo(RCLONE(60, '/mnt/gdrive', 'gdrive:'));
    const seen = [];
    const r = await classifyMount({
        entries,
        mountPoint: '/mnt/gdrive',
        remoteName: 'gdrive',
        probe: async (mp) => {
            seen.push(mp);
        },
    });
    assert.equal(r.state, MOUNT_STATES.MOUNTED);
    assert.equal(r.entry.mountId, 60);
    assert.deepEqual(seen, ['/mnt/gdrive']);
});

test('classifyMount: probe rejections map to STALE / UNKNOWN', async () => {
    const entries = parseMountinfo(RCLONE(60, '/mnt/gdrive', 'gdrive:'));
    const run = (probe) => classifyMount({ entries, mountPoint: '/mnt/gdrive', remoteName: 'gdrive', probe });

    for (const code of ['ENOTCONN', 'EIO']) {
        const r = await run(async () => {
            throw codeError(code, `stat failed ${code}`);
        });
        assert.equal(r.state, MOUNT_STATES.STALE, code);
        assert.equal(r.entry.mountId, 60);
        assert.match(r.message, new RegExp(code));
    }

    let r = await run(async () => {
        throw codeError('PROBE_TIMEOUT', 'stat hung');
    });
    assert.equal(r.state, MOUNT_STATES.UNKNOWN);
    assert.match(r.message, /not responding/);

    r = await run(async () => {
        throw codeError('EACCES', 'permission denied, stat');
    });
    assert.equal(r.state, MOUNT_STATES.UNKNOWN);
    assert.match(r.message, /permission denied, stat/);
    assert.equal(r.entry.mountId, 60);
});

test('classifyMount never throws: non-Error and synchronous probe throws are UNKNOWN', async () => {
    const entries = parseMountinfo(RCLONE(60, '/mnt/gdrive', 'gdrive:'));
    const run = (probe) => classifyMount({ entries, mountPoint: '/mnt/gdrive', remoteName: 'gdrive', probe });
    for (const thrown of ['a string', null, undefined, 42, { weird: true }]) {
        const r = await run(async () => {
            throw thrown;
        });
        assert.equal(r.state, MOUNT_STATES.UNKNOWN);
        assert.equal(typeof r.message, 'string');
    }
    const r = await run(() => {
        throw new Error('sync boom');
    });
    assert.equal(r.state, MOUNT_STATES.UNKNOWN);
    assert.match(r.message, /sync boom/);
    assert.equal((await run(async () => { throw 'a string'; })).message, 'a string');
});

test('classifyMount: an rclone mount is ours whatever its source string (alias/union/crypt show the backend, not "name:")', async () => {
    // Verified on a real kernel: an alias remote mounted by rclone reports the
    // underlying path as the source, e.g. "fuse.rclone /srv/data".
    for (const source of ['gdrive:', 'other:', 'gdrive:sub', '/srv/data', 's3:bucket/prefix', 'my crypt:']) {
        const r = await classifyMount({
            entries: parseMountinfo(RCLONE(80, '/mnt/gdrive', source)),
            mountPoint: '/mnt/gdrive',
            probe: async () => {},
        });
        assert.equal(r.state, MOUNT_STATES.MOUNTED, source);
    }
});

test('classifyMount: other fsTypes at the path are FOREIGN and never probed', async () => {
    const cases = [
        ['41 20 0:51 / /mnt/gdrive rw - fuse.sshfs me@host:/data rw', 'fuse.sshfs', 'me@host:/data'],
        ['42 20 0:52 / /mnt/gdrive rw - nfs4 server:/export rw', 'nfs4', 'server:/export'],
        ['43 20 0:53 / /mnt/gdrive rw - tmpfs tmpfs rw', 'tmpfs', 'tmpfs'],
        ['45 20 0:55 / /mnt/gdrive rw - fuse gdrive: rw', 'fuse', 'gdrive:'], // right source, wrong fsType
    ];
    for (const [line, fsType, source] of cases) {
        let probed = false;
        const r = await classifyMount({
            entries: parseMountinfo(line),
            mountPoint: '/mnt/gdrive',
            probe: async () => {
                probed = true;
            },
        });
        assert.equal(r.state, MOUNT_STATES.FOREIGN, line);
        assert.ok(r.message.includes(fsType), r.message);
        assert.ok(r.message.includes(source), r.message);
        assert.equal(probed, false);
        assert.ok(r.entry);
    }
});

test('classifyMount: stacked mounts - foreign on top of ours and ours on top of foreign are both FOREIGN', async () => {
    const ours = RCLONE(60, '/mnt/gdrive', 'gdrive:');
    const foreign = '61 20 0:51 / /mnt/gdrive rw - fuse.sshfs me@host:/data rw';
    const probe = async () => assert.fail('probe must not run for foreign mounts');

    let r = await classifyMount({ entries: parseMountinfo(`${ours}\n${foreign}\n`), mountPoint: '/mnt/gdrive', probe });
    assert.equal(r.state, MOUNT_STATES.FOREIGN);
    assert.match(r.message, /fuse\.sshfs/);
    assert.equal(r.entry.mountId, 61); // topmost = last

    r = await classifyMount({ entries: parseMountinfo(`${foreign}\n${ours}\n`), mountPoint: '/mnt/gdrive', probe });
    assert.equal(r.state, MOUNT_STATES.FOREIGN);
    assert.match(r.message, /fuse\.sshfs/);
    assert.equal(r.entry.mountId, 60);
});

test('classifyMount: two of our own stacked mounts are probed once and entry is the topmost', async () => {
    let calls = 0;
    const entries = parseMountinfo(`${RCLONE(60, '/mnt/gdrive', 'gdrive:')}\n${RCLONE(61, '/mnt/gdrive', 'gdrive:')}`);
    const r = await classifyMount({
        entries,
        mountPoint: '/mnt/gdrive',
        probe: async () => {
            calls++;
        },
    });
    assert.equal(r.state, MOUNT_STATES.MOUNTED);
    assert.equal(r.entry.mountId, 61);
    assert.equal(calls, 1);
});

test('classifyMount: a remote named "name with spaces" round-trips through mountinfo escapes', async () => {
    const mp = '/run/user/1000/rclone-mounts/name with spaces';
    const line = '70 20 0:70 / /run/user/1000/rclone-mounts/name\\040with\\040spaces rw - fuse.rclone name\\040with\\040spaces: rw';
    const entries = parseMountinfo(line);
    assert.equal(entries[0].source, 'name with spaces:');
    const r = await classifyMount({ entries, mountPoint: mp, remoteName: 'name with spaces', probe: async () => {} });
    assert.equal(r.state, MOUNT_STATES.MOUNTED);
});

test('classifyMount: remote name containing a backslash and digits is not confused by decoding', async () => {
    // Remote literally named `a\040b` is escaped by the kernel as a\134040b.
    const entries = parseMountinfo('71 20 0:71 / /mnt/x rw - fuse.rclone a\\134040b: rw');
    assert.equal(entries[0].source, 'a\\040b:');
    const ok = await classifyMount({ entries, mountPoint: '/mnt/x', remoteName: 'a\\040b', probe: async () => {} });
    assert.equal(ok.state, MOUNT_STATES.MOUNTED);
});

test('createMountProbe resolves when stat resolves and passes the mount point', async () => {
    const calls = [];
    const probe = createMountProbe({
        fsPromises: {
            stat: async (p) => {
                calls.push(p);
                return {};
            },
        },
        timeoutMs: 1000,
    });
    assert.equal(await probe('/mnt/x'), undefined);
    assert.deepEqual(calls, ['/mnt/x']);
});

test('createMountProbe propagates the stat error with its code', async () => {
    const probe = createMountProbe({
        fsPromises: {
            stat: async () => {
                throw codeError('ENOTCONN', 'transport endpoint is not connected');
            },
        },
    });
    await assert.rejects(probe('/mnt/x'), (e) => e.code === 'ENOTCONN');
});

test('createMountProbe rejects PROBE_TIMEOUT when stat never settles', async () => {
    const probe = createMountProbe({ fsPromises: { stat: () => new Promise(() => {}) }, timeoutMs: 20 });
    const started = Date.now();
    await assert.rejects(probe('/mnt/hung'), (e) => {
        assert.equal(e.code, 'PROBE_TIMEOUT');
        assert.ok(e instanceof Error);
        assert.match(e.message, /\/mnt\/hung/);
        return true;
    });
    assert.ok(Date.now() - started < 2000);
});

test('createMountProbe clears its timer on success and on failure', async (t) => {
    const cleared = [];
    const realSet = global.setTimeout;
    const realClear = global.clearTimeout;
    const timers = [];
    global.setTimeout = (fn, ms) => {
        const h = realSet(fn, ms);
        timers.push(h);
        return h;
    };
    global.clearTimeout = (h) => {
        cleared.push(h);
        return realClear(h);
    };
    t.after(() => {
        global.setTimeout = realSet;
        global.clearTimeout = realClear;
    });
    const ok = createMountProbe({ fsPromises: { stat: async () => ({}) }, timeoutMs: 60000 });
    await ok('/a');
    const bad = createMountProbe({
        fsPromises: {
            stat: async () => {
                throw codeError('EIO');
            },
        },
        timeoutMs: 60000,
    });
    await assert.rejects(bad('/b'));
    assert.equal(timers.length, 2);
    for (const h of timers) assert.ok(cleared.includes(h), 'timer was not cleared');
});

test('createMountProbe: a stat that fails after the timeout does not cause an unhandled rejection', async () => {
    let rejectStat;
    const probe = createMountProbe({
        fsPromises: { stat: () => new Promise((_, rej) => (rejectStat = rej)) },
        timeoutMs: 10,
    });
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
        await assert.rejects(probe('/mnt/slow'), (e) => e.code === 'PROBE_TIMEOUT');
        rejectStat(codeError('ENOTCONN'));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, []);
});

test('createMountProbe + classifyMount: a hung mount yields UNKNOWN end to end', async () => {
    const entries = parseMountinfo(RCLONE(60, '/mnt/gdrive', 'gdrive:'));
    const probe = createMountProbe({ fsPromises: { stat: () => new Promise(() => {}) }, timeoutMs: 20 });
    const r = await classifyMount({ entries, mountPoint: '/mnt/gdrive', remoteName: 'gdrive', probe });
    assert.equal(r.state, MOUNT_STATES.UNKNOWN);
    assert.match(r.message, /not responding/);
});

test('readMountinfo reads utf8 from /proc/self/mountinfo by default and passes the file through', async () => {
    const calls = [];
    const fsPromises = {
        readFile: async (...args) => {
            calls.push(args);
            return 'content';
        },
    };
    assert.equal(await readMountinfo(fsPromises), 'content');
    assert.equal(await readMountinfo(fsPromises, '/tmp/custom'), 'content');
    assert.deepEqual(calls, [
        ['/proc/self/mountinfo', 'utf8'],
        ['/tmp/custom', 'utf8'],
    ]);
});

test('readMountinfo rejects with the raw error', async () => {
    const err = codeError('EACCES', 'nope');
    await assert.rejects(readMountinfo({ readFile: async () => { throw err; } }), (e) => e === err);
});

test('readMountinfo reads a real temp file', async (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'mountinfo');
    fs.writeFileSync(file, '36 35 98:0 / /a rw - ext4 /dev/a rw\n');
    const text = await readMountinfo(fs.promises, file);
    assert.equal(parseMountinfo(text)[0].mountPoint, '/a');
});

test('canonicalizeMountPoint resolves a symlinked parent but not the leaf', (t) => {
    const dir = tmpDir(t);
    fs.mkdirSync(path.join(dir, 'real'));
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
    fs.mkdirSync(path.join(dir, 'real', 'leafdir'));
    fs.mkdirSync(path.join(dir, 'elsewhere'));
    fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, 'real', 'leaflink'));

    assert.equal(canonicalizeMountPoint(path.join(dir, 'link', 'leafdir'), fs), path.join(dir, 'real', 'leafdir'));
    // The leaf is a symlink: it must stay as is (it could be a dead mount).
    assert.equal(canonicalizeMountPoint(path.join(dir, 'link', 'leaflink'), fs), path.join(dir, 'real', 'leaflink'));
});

test('canonicalizeMountPoint climbs over a nonexistent parent chain and re-appends it', (t) => {
    const dir = tmpDir(t);
    fs.mkdirSync(path.join(dir, 'real'));
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));

    assert.equal(
        canonicalizeMountPoint(path.join(dir, 'link', 'a', 'b', 'leaf'), fs),
        path.join(dir, 'real', 'a', 'b', 'leaf'),
    );
    assert.equal(canonicalizeMountPoint(path.join(dir, 'missing', 'leaf'), fs), path.join(dir, 'missing', 'leaf'));
    // Existing parent, missing leaf.
    assert.equal(canonicalizeMountPoint(path.join(dir, 'link', 'leaf'), fs), path.join(dir, 'real', 'leaf'));
});

test('canonicalizeMountPoint treats a file in the parent chain (ENOTDIR) like a missing directory', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'file'), 'x');
    assert.equal(canonicalizeMountPoint(path.join(dir, 'file', 'sub', 'leaf'), fs), path.join(dir, 'file', 'sub', 'leaf'));
});

test('canonicalizeMountPoint never calls realpathSync on the leaf (dead mount)', () => {
    const calls = [];
    const fsSync = {
        realpathSync: (p) => {
            calls.push(p);
            if (p === '/links/runtime/rclone-mounts/gdrive') throw codeError('ENOTCONN');
            if (p === '/links/runtime/rclone-mounts') return '/real/runtime/rclone-mounts';
            throw codeError('ENOENT');
        },
    };
    const out = canonicalizeMountPoint('/links/runtime/rclone-mounts/gdrive', fsSync);
    assert.equal(out, '/real/runtime/rclone-mounts/gdrive');
    assert.deepEqual(calls, ['/links/runtime/rclone-mounts']);
});

test('canonicalizeMountPoint climbs when an ancestor is itself a dead mount (ENOTCONN) and rethrows unexpected errors', () => {
    const climbing = {
        realpathSync: (p) => {
            if (p === '/a/dead') throw codeError('ENOTCONN');
            if (p === '/a') return '/real-a';
            throw codeError('ENOENT');
        },
    };
    assert.equal(canonicalizeMountPoint('/a/dead/leaf', climbing), '/real-a/dead/leaf');

    const denied = {
        realpathSync: () => {
            throw codeError('EACCES');
        },
    };
    assert.throws(() => canonicalizeMountPoint('/a/b/leaf', denied), (e) => e.code === 'EACCES');
});

test('canonicalizeMountPoint normalises the input and handles the root', () => {
    const fsSync = { realpathSync: (p) => p };
    assert.equal(canonicalizeMountPoint('/a/b/../c/leaf/', fsSync), '/a/c/leaf');
    assert.equal(canonicalizeMountPoint('/', fsSync), '/');
});

test('mountsDirectlyUnder returns only direct children of dir', () => {
    const entries = parseMountinfo([
        '1 0 0:1 / /home/u/mnt/a rw - fuse.rclone a: rw',
        '2 0 0:2 / /home/u/mnt/b\\040c rw - fuse.sshfs h:/x rw',
        '3 0 0:3 / /home/u/mnt/a/nested rw - tmpfs none rw',
        '4 0 0:4 / /home/u/mnt rw - tmpfs none rw',
        '5 0 0:5 / /home/u/mnt2/x rw - tmpfs none rw',
        '6 0 0:6 / /elsewhere/a rw - tmpfs none rw',
    ].join('\n'));
    assert.deepEqual(mountsDirectlyUnder(entries, '/home/u/mnt').map((e) => e.mountId), [1, 2]);
    assert.deepEqual(mountsDirectlyUnder(entries, '/nonexistent'), []);
    assert.deepEqual(mountsDirectlyUnder([], '/home/u/mnt'), []);
});
