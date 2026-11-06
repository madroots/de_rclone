'use strict';

// Real-FUSE scenarios (issue #11): real rclone, real kernel mounts, real
// /proc/self/mountinfo, a shim for crontab only. Everything lives in a temp
// directory (see test/helpers/real-app.cjs). Opt in with DE_RCLONE_REAL_FUSE=1.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRealApp, fuseUnavailableReason, which, sleep, CRON_DENIED_STDERR } = require('../helpers/real-app.cjs');

const skip = fuseUnavailableReason() || false;
const noOverlay = which('fuse-overlayfs') ? false : 'fuse-overlayfs is not installed';

async function waitFor(fn, what, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await fn();
        if (last) return last;
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
}

const entryFor = async (app, name) => (await app.invoke('get_remotes')).find(r => r.name === name);

test('mount_remote / unmount_remote round trip, including a remote name with a space', { skip }, async (t) => {
    const app = createRealApp(t);
    fs.writeFileSync(path.join(app.dataDir, 'plain', 'hello.txt'), 'hello from plain');
    fs.writeFileSync(path.join(app.dataDir, 'spaced', 'hello.txt'), 'hello from spaced');
    const before = app.readConfig();

    for (const name of ['plain', 'my remote']) {
        const dataSub = name === 'plain' ? 'plain' : 'spaced';
        const mounted = await app.invoke('mount_remote', { remoteName: name });
        assert.equal(mounted.success, true, JSON.stringify(mounted));

        // The kernel agrees, and the source is the backend's own path (alias), not "name:".
        const mount = app.mounts().find(m => m.mountPoint === app.mountDir(name));
        assert.ok(mount, `${name} missing from the mount table`);
        assert.equal(mount.fsType, 'fuse.rclone');
        assert.equal(mount.source, path.join(app.dataDir, dataSub));
        assert.equal(fs.readFileSync(path.join(app.mountDir(name), 'hello.txt'), 'utf8'), `hello from ${dataSub}`);

        const entry = await entryFor(app, name);
        assert.equal(entry.mounted, 'Yes');
        assert.equal(entry.mount_state, 'mounted');
        assert.equal(entry.mount_point, app.mountDir(name));

        const again = await app.invoke('mount_remote', { remoteName: name });
        assert.equal(again.success, true);
        assert.match(again.message, /already mounted/);
    }

    for (const name of ['plain', 'my remote']) {
        const result = await app.invoke('unmount_remote', { remoteName: name });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(app.mounts().some(m => m.mountPoint === app.mountDir(name)), false);
        assert.equal(fs.existsSync(app.mountDir(name)), false, 'managed directory removed');
        assert.equal((await entryFor(app, name)).mounted, 'No');

        const idle = await app.invoke('unmount_remote', { remoteName: name });
        assert.equal(idle.success, false);
        assert.match(idle.message, /not mounted/);
    }

    // A never-mounted-before directory is created again, and mounting still works.
    const remounted = await app.invoke('mount_remote', { remoteName: 'plain' });
    assert.equal(remounted.success, true, JSON.stringify(remounted));
    assert.equal((await app.invoke('unmount_remote', { remoteName: 'plain' })).success, true);
    assert.deepEqual(app.readConfig(), before, 'mounting never touches the config');
});

test('a killed rclone daemon leaves a stale mount: refused everywhere until recover_mount', { skip }, async (t) => {
    const app = createRealApp(t);
    const before = app.readConfig();
    assert.equal((await app.invoke('mount_remote', { remoteName: 'plain' })).success, true);
    const mountPoint = app.mountDir('plain');

    const pids = app.pidsWhere(/rclone.* mount .*rclone-mounts\/plain/);
    assert.ok(pids.length >= 1, 'found the rclone daemon by its command line');
    for (const pid of pids) app.kill9(pid);

    const stale = await waitFor(async () => {
        const e = await entryFor(app, 'plain');
        return e.mount_state === 'stale' && e;
    }, 'the mount to be reported stale');
    assert.equal(stale.mounted, 'Stale');
    assert.ok(app.mounts().some(m => m.mountPoint === mountPoint), 'the dead mount is still in the kernel table');

    for (const [channel, extra] of [['mount_remote', {}], ['unmount_remote', {}], ['delete_remote', {}]]) {
        const result = await app.invoke(channel, { remoteName: 'plain', ...extra });
        assert.equal(result.success, false, channel);
        assert.equal(result.code, 'MOUNT_STALE', `${channel}: ${JSON.stringify(result)}`);
    }
    assert.deepEqual(app.readConfig(), before);
    assert.ok(app.mounts().some(m => m.mountPoint === mountPoint), 'refusals left the mount alone');

    const recovered = await app.invoke('recover_mount', { remoteName: 'plain' });
    assert.equal(recovered.success, true, JSON.stringify(recovered));
    assert.equal(app.mounts().some(m => m.mountPoint === mountPoint), false);
    assert.equal(fs.existsSync(mountPoint), false, 'managed directory removed');
    assert.equal((await entryFor(app, 'plain')).mounted, 'No');

    // And the remote is usable again.
    assert.equal((await app.invoke('mount_remote', { remoteName: 'plain' })).success, true);
    assert.equal((await app.invoke('unmount_remote', { remoteName: 'plain' })).success, true);
});

test('a busy mount cannot be unmounted or deleted; config and crontab stay intact; works once released', { skip }, async (t) => {
    const app = createRealApp(t);
    const before = app.readConfig();
    assert.equal((await app.invoke('add_to_cron', { remoteName: 'plain' })).success, true);
    const cronBefore = app.cron.read();
    assert.match(cronBefore, /Added by de_rclone: plain/);
    assert.equal((await app.invoke('mount_remote', { remoteName: 'plain' })).success, true);
    const mountPoint = app.mountDir('plain');

    const holder = app.spawnHolder(mountPoint);
    await waitFor(() => holder.pid && fs.existsSync(`/proc/${holder.pid}/cwd`) &&
        fs.readlinkSync(`/proc/${holder.pid}/cwd`) === mountPoint, 'the holder to enter the mount');

    const unmount = await app.invoke('unmount_remote', { remoteName: 'plain' });
    assert.equal(unmount.success, false);
    assert.equal(unmount.code, 'MOUNT_BUSY', JSON.stringify(unmount));

    const del = await app.invoke('delete_remote', { remoteName: 'plain' });
    assert.equal(del.success, false);
    assert.equal(del.code, 'MOUNT_BUSY', JSON.stringify(del));

    assert.deepEqual(app.readConfig(), before, 'config bytes unchanged');
    assert.equal(app.cron.read(), cronBefore, 'the crontab entry is still there');
    assert.ok(app.mounts().some(m => m.mountPoint === mountPoint), 'still mounted');
    assert.equal((await entryFor(app, 'plain')).mounted, 'Yes');

    const exited = new Promise(resolve => holder.once('exit', resolve));
    holder.kill('SIGKILL');
    await exited;

    const released = await app.invoke('unmount_remote', { remoteName: 'plain' });
    assert.equal(released.success, true, JSON.stringify(released));

    assert.equal((await app.invoke('mount_remote', { remoteName: 'plain' })).success, true);
    const deleted = await app.invoke('delete_remote', { remoteName: 'plain' });
    assert.equal(deleted.success, true, JSON.stringify(deleted));
    assert.equal(app.mounts().length, 0);
    assert.doesNotMatch(app.readConfig().toString(), /\[plain\]/);
    assert.match(app.readConfig().toString(), /\[my remote\]/, 'the other remote is kept');
    assert.doesNotMatch(app.cron.read(), /Added by de_rclone: plain/);
});

test('a foreign fuse-overlayfs mount at a managed path is never touched', { skip: skip || noOverlay }, async (t) => {
    const app = createRealApp(t);
    const before = app.readConfig();
    const mountPoint = app.mountDir('plain');
    const lower = path.join(app.dir, 'overlay', 'lower');
    for (const d of [lower, path.join(app.dir, 'overlay', 'upper'), path.join(app.dir, 'overlay', 'work'), mountPoint]) {
        fs.mkdirSync(d, { recursive: true });
    }
    fs.writeFileSync(path.join(lower, 'marker.txt'), 'not yours');
    app.run('fuse-overlayfs', ['-o', `lowerdir=${lower},upperdir=${path.join(app.dir, 'overlay', 'upper')},workdir=${path.join(app.dir, 'overlay', 'work')}`, mountPoint]);

    const foreign = app.mounts().find(m => m.mountPoint === mountPoint);
    assert.ok(foreign, 'overlay mounted');
    assert.notEqual(foreign.fsType, 'fuse.rclone');

    const entry = await entryFor(app, 'plain');
    assert.equal(entry.mounted, 'Foreign');
    assert.equal(entry.mount_state, 'foreign');

    for (const channel of ['mount_remote', 'unmount_remote', 'recover_mount', 'delete_remote']) {
        const result = await app.invoke(channel, { remoteName: 'plain' });
        assert.equal(result.success, false, channel);
        assert.equal(result.code, 'MOUNT_FOREIGN', `${channel}: ${JSON.stringify(result)}`);
    }

    assert.deepEqual(app.readConfig(), before);
    assert.deepEqual(app.mounts().find(m => m.mountPoint === mountPoint), foreign, 'mount entry untouched');
    assert.equal(fs.readFileSync(path.join(mountPoint, 'marker.txt'), 'utf8'), 'not yours', 'still serving its files');
    assert.equal((await entryFor(app, 'plain')).mounted, 'Foreign');
});

test('a denied crontab degrades only the Cron column', { skip }, async (t) => {
    const app = createRealApp(t);
    app.cron.mode('denied');

    const list = await app.invoke('get_remotes');
    assert.deepEqual(Array.from(list, r => r.name), ['plain', 'my remote']);
    for (const r of list) {
        assert.equal(r.cron, 'Unknown');
        assert.match(r.cron_note, /denied/);
        assert.equal(r.mounted, 'No');
    }

    const add = await app.invoke('add_to_cron', { remoteName: 'plain' });
    assert.equal(add.success, false);
    assert.equal(add.code, 'CRON_UNAVAILABLE');

    const remove = await app.invoke('remove_from_cron', { remoteName: 'plain' });
    assert.equal(remove.success, true);
    assert.equal(remove.warning, true);

    // The shim speaks cronie's exact text; make sure the app saw that and not something else.
    assert.ok(CRON_DENIED_STDERR('x').startsWith('You (x) are not allowed to use this program (crontab)'));
    assert.equal(app.cron.read(), null, 'nothing was written');

    const del = await app.invoke('delete_remote', { remoteName: 'plain' });
    assert.equal(del.success, true, JSON.stringify(del));
    assert.match(del.message, /Warning: crontab is unavailable/);
});

test('crontab round trip through `crontab -` keeps comments, blank lines and trailing spaces byte-identical', { skip }, async (t) => {
    const app = createRealApp(t);
    const original = '# m h dom mon dow command\n\n   \n0 5 * * * echo hi   \n# trailing comment   \n\n\t\n@daily /bin/true\t \n\n';
    app.cron.set(original);

    for (const name of ['plain', 'my remote']) {
        const added = await app.invoke('add_to_cron', { remoteName: name });
        assert.equal(added.success, true, JSON.stringify(added));
        const table = app.cron.read();
        assert.ok(table.startsWith(original), 'existing bytes preserved while adding');
        assert.equal((await entryFor(app, name)).cron, 'Yes');
        assert.equal((await app.invoke('add_to_cron', { remoteName: name })).message.includes('already enabled'), true);

        const removed = await app.invoke('remove_from_cron', { remoteName: name });
        assert.equal(removed.success, true, JSON.stringify(removed));
        assert.equal(app.cron.read(), original, `byte-identical after add+remove of "${name}"`);
        assert.equal((await entryFor(app, name)).cron, 'No');
    }
});

test('an encrypted config is refused and left byte-identical', { skip }, async (t) => {
    const app = createRealApp(t);
    try {
        app.run('rclone', ['--config', app.configPath, 'config', 'encryption', 'set', '--password-command', 'echo secretpw'], { stdio: 'pipe' });
    } catch (e) {
        t.skip(`this rclone cannot create an encrypted config: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
        return;
    }
    const encrypted = app.readConfig();
    if (!encrypted.toString().includes('RCLONE_ENCRYPT_V')) {
        t.skip('rclone did not produce an encrypted config');
        return;
    }

    await assert.rejects(app.invoke('get_remotes'), { code: 'CONFIG_ENCRYPTED' });
    const del = await app.invoke('delete_remote', { remoteName: 'plain' });
    assert.equal(del.success, false);
    assert.equal(del.code, 'CONFIG_ENCRYPTED');
    await assert.rejects(app.invoke('add_remote_with_plugin', {
        pluginName: 'sftp', config: { remote_name: 'extra', host: 'example.com', user: 'someone' }
    }), { code: 'CONFIG_ENCRYPTED' });

    assert.deepEqual(app.readConfig(), encrypted, 'config bytes unchanged');
    assert.deepEqual(fs.readdirSync(path.dirname(app.configPath)), ['rclone.conf'], 'no temp files left next to it');
});
