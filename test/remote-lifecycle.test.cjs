'use strict';

// Integration tests: the real main.js handlers against faithful fakes of the
// kernel mount table, crontab, fusermount and rclone (see helpers/app-harness).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./helpers/app-harness.cjs');

const fooCron = "@reboot rclone mount 'foo:' '/managed/foo' --daemon # Added by de_rclone: foo\n";
const unrelatedCron = '# keep this comment about rclone mount foo:\n' +
    '@reboot rclone mount prefixfoo: /managed/prefixfoo --daemon\n' +
    '@reboot rclone mount foo:subdir /managed/subdir --daemon\n' +
    '0 1 * * * echo backup # rclone mount foo:\n' +
    '0 2 * * * echo rclone mount foo:\n';
const ENCRYPTED = '# Encrypted rclone configuration File\n\nRCLONE_ENCRYPT_V0:\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n';
const sftp = (name) => ({ pluginName: 'sftp', config: { remote_name: name, host: 'host.example', user: 'alice' } });

// --- #3 mount state ---------------------------------------------------------

test('a dead mount is Stale and never stops the other remotes from loading', async t => {
    const app = createApp(t);
    app.mount('foo', { stale: true });
    app.mount('prefixfoo');
    const remotes = await app.invoke('get_remotes');
    const by = Object.fromEntries(remotes.map(r => [r.name, r]));
    assert.equal(by.foo.mount_state, 'stale');
    assert.equal(by.foo.mounted, 'Stale');
    assert.equal(by.prefixfoo.mount_state, 'mounted');
    assert.equal(by.prefixfoo.mounted, 'Yes');
});

test('an unreadable mount table degrades every remote to Unknown instead of failing the list', async t => {
    const app = createApp(t);
    app.state.cron = unrelatedCron + fooCron;
    app.state.mountinfoError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const remotes = await app.invoke('get_remotes');
    assert.equal(remotes.length, 2);
    for (const remote of remotes) {
        assert.equal(remote.mount_state, 'unknown');
        assert.match(remote.mount_note, /mount table/);
    }
    assert.equal(remotes.find(r => r.name === 'foo').cron, 'Yes', 'cron column is independent of the mount table');
});

test('a foreign mount at a managed path is shown as such and never touched', async t => {
    const app = createApp(t);
    fs.mkdirSync(app.mountDir('foo'), { recursive: true });
    app.state.foreignMounts.push({ mountPoint: app.mountDir('foo'), fsType: 'fuse.sshfs', source: 'me@host:/data' });
    app.state.cron = fooCron;
    const before = app.readConfig();

    assert.equal((await app.invoke('get_remotes')).find(r => r.name === 'foo').mount_state, 'foreign');
    for (const [handler, args] of [['mount_remote', {}], ['unmount_remote', {}], ['recover_mount', {}], ['delete_remote', {}]]) {
        const result = await app.invoke(handler, { remoteName: 'foo', ...args });
        assert.equal(result.success, false, handler);
        assert.equal(result.code, 'MOUNT_FOREIGN', handler);
        assert.match(result.message, /fuse\.sshfs/, handler);
    }
    for (const tool of ['fusermount', 'fusermount3', 'umount', 'rclone']) {
        assert.equal(app.calls(tool).length, 0, `${tool} must not run for a foreign mount`);
    }
    assert.equal(app.readConfig(), before);
    assert.equal(app.state.cron, fooCron);
    assert.equal(app.state.foreignMounts.length, 1);
});

test('a stale mount refuses mount, unmount and delete, and Recover releases it', async t => {
    const app = createApp(t);
    app.mount('foo', { stale: true });
    app.state.cron = fooCron;
    const before = app.readConfig();

    for (const handler of ['mount_remote', 'unmount_remote', 'delete_remote']) {
        const result = await app.invoke(handler, { remoteName: 'foo' });
        assert.equal(result.success, false, handler);
        assert.equal(result.code, 'MOUNT_STALE', handler);
        assert.match(result.message, /Recover/, handler);
    }
    assert.equal(app.calls('rclone').length, 0, 'no rclone mount for a stale mount');
    assert.equal(app.calls('fusermount').length + app.calls('umount').length, 0);
    assert.equal(app.readConfig(), before);
    assert.equal(app.state.cron, fooCron);

    const recovered = await app.invoke('recover_mount', { remoteName: 'foo' });
    assert.equal(recovered.success, true, recovered.message);
    assert.equal(app.state.mounts.size, 0);
    assert.equal(fs.existsSync(app.mountDir('foo')), false);
    assert.equal(app.readConfig(), before, 'recovery never edits the config');
});

test('recover uses a lazy unmount only for a stale mount', async t => {
    const app = createApp(t);
    app.state.requireLazy = true;
    app.mount('foo', { stale: true });
    assert.equal((await app.invoke('recover_mount', { remoteName: 'foo' })).success, true);
    assert.ok(app.calls('fusermount').some(call => call.includes('-uz')));

    const healthy = createApp(t);
    healthy.state.requireLazy = true;
    healthy.mount('foo');
    const result = await healthy.invoke('unmount_remote', { remoteName: 'foo' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'MOUNT_BUSY');
    assert.equal(healthy.calls('fusermount').some(call => call.includes('-uz')), false, 'a healthy mount is never lazily unmounted');
    assert.equal(healthy.state.mounts.has('foo'), true);
});

test('recover refuses a healthy or absent mount', async t => {
    const app = createApp(t);
    app.mount('foo');
    for (const name of ['foo', 'prefixfoo']) {
        const result = await app.invoke('recover_mount', { remoteName: name });
        assert.equal(result.success, false);
        assert.equal(result.code, 'MOUNT_NOT_STALE');
    }
    assert.equal(app.calls('fusermount').length + app.calls('umount').length, 0);
    assert.equal(app.state.mounts.has('foo'), true);
});

test('mount starts rclone with the managed path and reports the mount only once it is visible', async t => {
    const app = createApp(t);
    const result = await app.invoke('mount_remote', { remoteName: 'foo' });
    assert.equal(result.success, true, result.message);
    const [, ...args] = app.calls('rclone')[0];
    assert.deepEqual(args.slice(0, 5), ['mount', 'foo:', app.mountDir('foo'), '--vfs-cache-mode', 'writes']);
    assert.ok(args.includes('--daemon'));
    assert.equal((await app.invoke('get_remotes')).find(r => r.name === 'foo').mount_state, 'mounted');
    assert.equal((await app.invoke('mount_remote', { remoteName: 'foo' })).success, true, 'already mounted is success');
    assert.equal(app.calls('rclone').length, 1, 'no second rclone for an existing mount');
});

test('a failed mount reports rclone\'s reason and removes the directory it created', async t => {
    const app = createApp(t);
    app.state.mountBehavior = 'fail';
    const result = await app.invoke('mount_remote', { remoteName: 'foo' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'MOUNT_FAILED');
    assert.match(result.message, /boom/);
    assert.equal(fs.existsSync(app.mountDir('foo')), false);
});

test('rclone exiting 0 without a visible mount is a failure, not a success', async t => {
    const app = createApp(t);
    app.state.mountBehavior = 'invisible';
    const result = await app.invoke('mount_remote', { remoteName: 'foo' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'MOUNT_NOT_VISIBLE');
    assert.equal(fs.existsSync(app.mountDir('foo')), false);
});

test('mount state does not depend on the mountpoint tool at all', async t => {
    const app = createApp(t);
    app.mount('foo');
    await app.invoke('get_remotes');
    await app.invoke('unmount_remote', { remoteName: 'foo' });
    assert.equal(app.calls('mountpoint').length, 0);
});

// --- deletion ---------------------------------------------------------------

test('deletion unmounts only the target, removes its cron and directory, and preserves other config', async t => {
    const app = createApp(t);
    app.mount('foo');
    app.mount('prefixfoo');
    app.state.cron = unrelatedCron + fooCron;
    const result = await app.invoke('delete_remote', { remoteName: 'foo' });
    assert.equal(result.success, true, result.message);
    assert.equal(app.state.mounts.has('foo'), false);
    assert.equal(app.state.mounts.has('prefixfoo'), true);
    assert.equal(fs.existsSync(app.mountDir('foo')), false);
    assert.equal(app.state.cron, unrelatedCron);
    assert.equal(app.readConfig(), '[prefixfoo]\ntype = sftp\npass = keep-secret\n');
});

test('delete keeps config, cron and mount when every unmount tool fails', async t => {
    const app = createApp(t);
    const before = app.readConfig();
    app.mount('foo');
    app.state.cron = fooCron;
    app.state.toolFailures.fusermount = 'fusermount: failed to unmount: Device or resource busy';
    app.state.toolFailures.umount = 'umount: target is busy';
    const result = await app.invoke('delete_remote', { remoteName: 'foo' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'MOUNT_BUSY');
    assert.match(result.message, /busy/i);
    assert.equal(app.readConfig(), before);
    assert.equal(app.state.cron, fooCron);
    assert.equal(app.state.mounts.has('foo'), true);
});

test('a crontab that cannot be read is detected before anything is unmounted', async t => {
    const app = createApp(t);
    const before = app.readConfig();
    app.mount('foo');
    app.state.cron = fooCron;
    app.state.cronMode = 'error';
    const result = await app.invoke('delete_remote', { remoteName: 'foo' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'CRON_ERROR');
    assert.equal(app.readConfig(), before);
    assert.equal(app.state.mounts.has('foo'), true, 'pre-flight failure must not disturb the mount');
    assert.equal(app.calls('fusermount').length + app.calls('umount').length, 0);
});

test('a crontab write failure keeps the config for retry', async t => {
    const app = createApp(t);
    const before = app.readConfig();
    app.mount('foo');
    app.state.cron = unrelatedCron + fooCron;
    app.state.cronWriteError = 'crontab: installing new crontab failed';
    const result = await app.invoke('delete_remote', { remoteName: 'foo' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'CRON_WRITE_FAILED');
    assert.match(result.message, /installing new crontab failed/);
    assert.equal(app.readConfig(), before);
    assert.equal(app.state.cron, unrelatedCron + fooCron);
});

test('a successful unmount command must actually release the mount before deletion', async t => {
    const app = createApp(t);
    app.mount('foo');
    app.state.keepMountedAfterUnmount = true;
    app.state.cron = fooCron;
    const before = app.readConfig();
    const result = await app.invoke('delete_remote', { remoteName: 'foo' });
    assert.equal(result.success, false);
    assert.match(result.message, /did not release/);
    assert.equal(app.readConfig(), before);
    assert.equal(app.state.cron, fooCron);
    assert.equal(fs.existsSync(app.mountDir('foo')), true);
});

test('delete preserves a nonempty managed directory and credentials for manual cleanup', async t => {
    const app = createApp(t);
    fs.mkdirSync(app.mountDir('foo'), { recursive: true });
    fs.writeFileSync(path.join(app.mountDir('foo'), 'keep'), 'local data');
    const before = app.readConfig();
    const result = await app.invoke('delete_remote', { remoteName: 'foo' });
    assert.equal(result.success, false);
    assert.match(result.message, /directory/i);
    assert.equal(app.readConfig(), before);
    assert.equal(fs.readFileSync(path.join(app.mountDir('foo'), 'keep'), 'utf8'), 'local data');
});

test('unmount falls back to the next available tool', async t => {
    const app = createApp(t);
    app.state.missingTools.add('fusermount');
    app.mount('foo');
    const result = await app.invoke('unmount_remote', { remoteName: 'foo' });
    assert.equal(result.success, true, result.message);
    assert.equal(app.calls('umount').length, 1);
    assert.equal(app.state.mounts.size, 0);
});

test('unmount with no usable tool says so instead of pretending', async t => {
    const app = createApp(t);
    for (const tool of ['fusermount', 'umount']) app.state.missingTools.add(tool);
    app.mount('foo');
    const result = await app.invoke('unmount_remote', { remoteName: 'foo' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'MOUNT_TOOL_MISSING');
    assert.equal(app.state.mounts.has('foo'), true);
});

test('config create, update and delete force mode 0600 with permissive umask', async t => {
    const app = createApp(t, { config: null });
    const oldUmask = process.umask(0);
    t.after(() => process.umask(oldUmask));
    const mode = () => fs.statSync(app.configPath).mode & 0o777;
    const config = { remote_name: 'foo', host: 'host.example', user: 'alice', pass: 'secret' };
    assert.equal((await app.invoke('add_remote_with_plugin', { pluginName: 'sftp', config })).success, true);
    assert.equal(mode(), 0o600);
    assert.match(app.readConfig(), /pass = obscured:secret/);
    fs.chmodSync(app.configPath, 0o666);
    assert.equal((await app.invoke('add_remote_with_plugin', { pluginName: 'sftp', config: { ...config, remote_name: 'second' } })).success, true);
    assert.equal(mode(), 0o600);
    fs.chmodSync(app.configPath, 0o666);
    assert.equal((await app.invoke('update_remote_with_plugin', { remoteName: 'foo', pluginName: 'sftp', config: { host: 'new.example' } })).success, true);
    assert.equal(mode(), 0o600);
    fs.chmodSync(app.configPath, 0o666);
    assert.equal((await app.invoke('delete_remote', { remoteName: 'foo' })).success, true);
    assert.equal(mode(), 0o600);
});

for (const name of ['name with spaces', "team's remote"]) {
    test(`existing remote ${JSON.stringify(name)} supports exact quoted cron, mount state and deletion`, async t => {
        const app = createApp(t, { config: `[${name}]\ntype = sftp\npass = secret\n` });
        app.mount(name);
        app.state.cron = unrelatedCron;
        assert.equal((await app.invoke('get_remotes'))[0].mount_state, 'mounted', 'escaped mountinfo path round-trips');
        assert.equal((await app.invoke('add_to_cron', { remoteName: name })).success, true);
        assert.equal((await app.invoke('get_remotes'))[0].cron, 'Yes');
        const result = await app.invoke('delete_remote', { remoteName: name });
        assert.equal(result.success, true, result.message);
        assert.equal(app.state.cron, unrelatedCron);
        assert.equal(app.readConfig(), '');
        assert.equal(fs.existsSync(app.mountDir(name)), false);
    });
}

for (const name of ['../escape', '..', '.', '/absolute', 'nested/name', 'nested\\name']) {
    test(`managed mount paths reject ${JSON.stringify(name)} without deleting credentials`, async t => {
        const app = createApp(t, { config: `[${name}]\ntype = sftp\npass = secret\n` });
        const before = app.readConfig();
        const result = await app.invoke('delete_remote', { remoteName: name });
        assert.equal(result.success, false);
        assert.match(result.message, /remote name|mount path/i);
        assert.equal(app.readConfig(), before);
        assert.equal(app.state.calls.length, 0);
        const listed = await app.invoke('get_remotes');
        assert.equal(listed.length, 1, 'one unusable name must not fail the whole list');
        assert.equal(listed[0].mount_state, 'unknown');
    });
}

// --- #4 crontab -------------------------------------------------------------

test('cron status, add and remove use exact remote arguments and preserve unrelated bytes', async t => {
    const app = createApp(t);
    app.state.cron = unrelatedCron;
    const remotes = await app.invoke('get_remotes');
    assert.equal(remotes.find(r => r.name === 'foo').cron, 'No');
    assert.equal(remotes.find(r => r.name === 'prefixfoo').cron, 'Yes');
    assert.equal((await app.invoke('add_to_cron', { remoteName: 'foo' })).success, true);
    assert.equal(app.state.cron.startsWith(unrelatedCron), true);
    const withFoo = app.state.cron;
    assert.equal((await app.invoke('add_to_cron', { remoteName: 'foo' })).success, true);
    assert.equal(app.state.cron, withFoo);
    assert.equal((await app.invoke('remove_from_cron', { remoteName: 'foo' })).success, true);
    assert.equal(app.state.cron, unrelatedCron);
});

test('a crontab that exits 0 without installing the change is reported, not trusted', async t => {
    const app = createApp(t);
    app.state.cronIgnoresWrites = true;
    const enabled = await app.invoke('add_to_cron', { remoteName: 'foo' });
    assert.equal(enabled.success, false);
    assert.equal(enabled.code, 'CRON_VERIFY_FAILED');

    app.state.cronIgnoresWrites = false;
    app.state.cron = fooCron;
    app.state.cronIgnoresWrites = true;
    const disabled = await app.invoke('remove_from_cron', { remoteName: 'foo' });
    assert.equal(disabled.success, false);
    assert.equal(disabled.code, 'CRON_VERIFY_FAILED');

    app.mount('foo');
    const deleted = await app.invoke('delete_remote', { remoteName: 'foo' });
    assert.equal(deleted.success, false, 'deletion must not claim the cron entry is gone');
    assert.equal(deleted.code, 'CRON_VERIFY_FAILED');
    assert.match(app.readConfig(), /\[foo\]/, 'config kept for retry');
});

test('crontab is only ever read with -l and written through stdin, never through a file', async t => {
    const app = createApp(t);
    await app.invoke('get_remotes');
    assert.equal((await app.invoke('add_to_cron', { remoteName: 'foo' })).success, true);
    assert.equal((await app.invoke('remove_from_cron', { remoteName: 'foo' })).success, true);
    assert.ok(app.cronWrites().length >= 2);
    for (const [, ...args] of app.calls('crontab')) assert.ok(args.length === 1 && (args[0] === '-l' || args[0] === '-'), `unexpected crontab args ${args}`);
    assert.deepEqual(fs.readdirSync(app.dir).sort(), ['config', 'runtime'], 'no temp files left in the temp dir');
});

test('a denied crontab degrades the Cron column and nothing else', async t => {
    const app = createApp(t);
    app.state.cronMode = 'denied';
    app.mount('foo');
    const remotes = await app.invoke('get_remotes');
    assert.equal(remotes.length, 2);
    for (const remote of remotes) {
        assert.equal(remote.cron, 'Unknown');
        assert.match(remote.cron_note, /denied/);
    }
    assert.equal(remotes.find(r => r.name === 'foo').mount_state, 'mounted');
});

for (const [mode, expectedNote] of [['missing', /not installed/], ['error', /temporary failure/]]) {
    test(`crontab ${mode}: the list still loads with Cron Unknown`, async t => {
        const app = createApp(t);
        app.state.cronMode = mode;
        const remotes = await app.invoke('get_remotes');
        assert.equal(remotes.length, 2);
        assert.equal(remotes[0].cron, 'Unknown');
        assert.match(remotes[0].cron_note, expectedNote);
    });
}

test('having no crontab at all is an empty table, not an error', async t => {
    const app = createApp(t);
    app.state.cron = null;
    assert.equal((await app.invoke('get_remotes'))[0].cron, 'No');
    assert.equal((await app.invoke('add_to_cron', { remoteName: 'foo' })).success, true);
    assert.match(app.state.cron, /rclone mount 'foo:'/);
});

test('enabling auto-mount without crontab access fails clearly and writes nothing', async t => {
    const app = createApp(t);
    app.state.cronMode = 'denied';
    const result = await app.invoke('add_to_cron', { remoteName: 'foo' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'CRON_UNAVAILABLE');
    assert.match(result.message, /cron\.allow/);
    assert.equal(app.cronWrites().length, 0);
});

test('an unexpected crontab error never turns into a write', async t => {
    const app = createApp(t);
    app.state.cron = unrelatedCron;
    app.state.cronMode = 'error';
    for (const handler of ['add_to_cron', 'remove_from_cron']) {
        const result = await app.invoke(handler, { remoteName: 'foo' });
        assert.equal(result.success, false, handler);
        assert.equal(result.code, 'CRON_ERROR', handler);
    }
    assert.equal(app.cronWrites().length, 0);
    assert.equal(app.state.cron, unrelatedCron);
});

test('disabling auto-mount without crontab access warns instead of claiming success', async t => {
    const app = createApp(t);
    app.state.cronMode = 'denied';
    const result = await app.invoke('remove_from_cron', { remoteName: 'foo' });
    assert.equal(result.success, true);
    assert.equal(result.warning, true);
    assert.match(result.message, /unavailable.*manually/);
    assert.doesNotMatch(result.message, /^Disabled/);
});

for (const mode of ['denied', 'missing']) {
    test(`delete works with crontab ${mode} and warns that cron entries need manual cleanup`, async t => {
        const app = createApp(t);
        app.mount('foo');
        app.state.cronMode = mode;
        const result = await app.invoke('delete_remote', { remoteName: 'foo' });
        assert.equal(result.success, true, result.message);
        assert.match(result.message, /unavailable.*manually/);
        assert.equal(app.state.mounts.size, 0);
        assert.equal(app.readConfig(), '[prefixfoo]\ntype = sftp\npass = keep-secret\n');
        assert.equal(app.cronWrites().length, 0);
    });
}

// --- #4 rollback of a remote created moments ago ----------------------------

for (const mode of ['ok', 'denied', 'error', 'missing']) {
    test(`rollback removes a just-created remote with crontab ${mode} and never touches cron`, async t => {
        const app = createApp(t);
        app.state.cronMode = mode;
        assert.equal((await app.invoke('add_remote_with_plugin', sftp('newone'))).success, true);
        assert.match(app.readConfig(), /\[newone\]/);
        const result = await app.invoke('delete_remote', { remoteName: 'newone', rollback: true });
        assert.equal(result.success, true, result.message);
        assert.doesNotMatch(app.readConfig(), /newone/);
        assert.match(app.readConfig(), /\[foo\]/);
        assert.equal(app.calls('crontab').length, 0);
    });
}

test('rollback is refused for a remote this session did not create', async t => {
    const app = createApp(t);
    const before = app.readConfig();
    const result = await app.invoke('delete_remote', { remoteName: 'foo', rollback: true });
    assert.equal(result.success, false);
    assert.equal(result.code, 'ROLLBACK_NOT_ALLOWED');
    assert.equal(app.readConfig(), before);
});

test('rollback is refused when the new remote has been mounted, and the name is forgotten after deletion', async t => {
    const app = createApp(t);
    await app.invoke('add_remote_with_plugin', sftp('newone'));
    app.mount('newone');
    const refused = await app.invoke('delete_remote', { remoteName: 'newone', rollback: true });
    assert.equal(refused.success, false);
    assert.equal(refused.code, 'ROLLBACK_NOT_ALLOWED');
    assert.match(app.readConfig(), /\[newone\]/);
    assert.equal(app.state.mounts.has('newone'), true);

    app.state.mounts.delete('newone');
    assert.equal((await app.invoke('delete_remote', { remoteName: 'newone', rollback: true })).success, true);
    // Re-created by hand outside the app: rollback must no longer apply.
    fs.appendFileSync(app.configPath, '\n[newone]\ntype = sftp\n');
    assert.equal((await app.invoke('delete_remote', { remoteName: 'newone', rollback: true })).code, 'ROLLBACK_NOT_ALLOWED');
});

// --- legacy ~/mnt cleanup ---------------------------------------------------

test('legacy mounts list only rclone mounts, even when crontab is denied', async t => {
    const app = createApp(t);
    const legacy = path.join(app.dir, 'mnt');
    fs.mkdirSync(legacy);
    app.state.foreignMounts.push(
        { mountPoint: path.join(legacy, 'old remote'), fsType: 'fuse.rclone', source: 'old remote:' },
        { mountPoint: path.join(legacy, 'nas'), fsType: 'fuse.sshfs', source: 'me@nas:/share' },
        { mountPoint: path.join(legacy, 'vault'), fsType: 'ext4', source: '/dev/mapper/vault' }
    );
    app.state.cronMode = 'denied';
    const state = await app.invoke('check_legacy_state');
    assert.deepEqual([...state.mounts], [path.join(legacy, 'old remote')]);
    assert.match(state.cronNote, /denied/);
    assert.deepEqual([...state.legacyCrons], []);
});

test('legacy unmount refuses anything the mount table does not list as a legacy rclone mount', async t => {
    const app = createApp(t);
    const legacy = path.join(app.dir, 'mnt');
    fs.mkdirSync(legacy);
    const rcloneMount = path.join(legacy, 'old');
    const sshfsMount = path.join(legacy, 'nas');
    app.state.foreignMounts.push(
        { mountPoint: rcloneMount, fsType: 'fuse.rclone', source: 'old:' },
        { mountPoint: sshfsMount, fsType: 'fuse.sshfs', source: 'me@nas:/share' }
    );
    const result = await app.invokeRaw('unmount_legacy_mounts', [sshfsMount, '/etc', path.join(legacy, '..', 'x')]);
    assert.equal(result.success, false);
    assert.equal(result.count, 0);
    assert.equal(app.calls('fusermount').length + app.calls('umount').length, 0);
    assert.equal(app.state.foreignMounts.length, 2);

    assert.equal((await app.invokeRaw('unmount_legacy_mounts', { 0: rcloneMount })).success, false, 'non-list input fails closed');
    const ok = await app.invokeRaw('unmount_legacy_mounts', [rcloneMount]);
    assert.deepEqual([ok.success, ok.count], [true, 1]);
    assert.deepEqual(app.state.foreignMounts.map(m => m.mountPoint), [sshfsMount]);
});

test('legacy cron removal touches only the exact lines selected, never other legacy or unrelated lines', async t => {
    const app = createApp(t);
    const home = app.dir;
    const legacy = (n) => `@reboot rclone mount r${n}: ${home}/mnt/r${n}/ --daemon`;
    const unrelated = '0 3 * * * /usr/bin/backup.sh\n# rclone mount r1: ~/mnt/ is mentioned here only in a comment\n';
    app.state.cron = `${unrelated}${legacy(1)}\n${legacy(2)}\n${legacy(3)}\n`;

    const state = await app.invoke('check_legacy_state');
    assert.deepEqual([...state.legacyCrons], [legacy(1), legacy(2), legacy(3)]);

    const result = await app.invokeRaw('remove_legacy_crons', [legacy(2)]);
    assert.deepEqual([result.success, result.count], [true, 1]);
    assert.equal(app.state.cron, `${unrelated}${legacy(1)}\n${legacy(3)}\n`);

    // A selected line that is not a legacy entry is refused even if it exists.
    const refused = await app.invokeRaw('remove_legacy_crons', ['0 3 * * * /usr/bin/backup.sh']);
    assert.equal(refused.success, false);
    assert.match(app.state.cron, /backup\.sh/);
});

test('legacy cron removal fails closed on bad input, vanished entries and an unavailable crontab', async t => {
    const app = createApp(t);
    const before = '0 3 * * * /usr/bin/backup.sh\n';
    app.state.cron = before;
    for (const bad of [undefined, 'a line', { 0: 'x' }, [1, 2]]) {
        assert.equal((await app.invokeRaw('remove_legacy_crons', bad)).success, false);
    }
    const vanished = await app.invokeRaw('remove_legacy_crons', [`@reboot rclone mount x: ${app.dir}/mnt/x/ --daemon`]);
    assert.equal(vanished.success, false);
    assert.match(vanished.error, /no longer/);
    assert.equal(app.state.cron, before);

    app.state.cronMode = 'denied';
    const denied = await app.invokeRaw('remove_legacy_crons', [`@reboot rclone mount x: ${app.dir}/mnt/x/ --daemon`]);
    assert.equal(denied.success, false);
    assert.match(denied.error, /unavailable/);
    assert.equal(app.cronWrites().length, 0);
});

test('legacy unmount reports every item with its reason and never touches unselected mounts', async t => {
    const app = createApp(t);
    const legacy = path.join(app.dir, 'mnt');
    fs.mkdirSync(legacy);
    const a = path.join(legacy, 'a');
    const b = path.join(legacy, 'b');
    app.state.foreignMounts.push(
        { mountPoint: a, fsType: 'fuse.rclone', source: '/srv/a' },
        { mountPoint: b, fsType: 'fuse.rclone', source: '/srv/b' }
    );
    const listed = await app.invoke('check_legacy_state');
    assert.deepEqual([...listed.mountDetails].map(d => [d.path, d.source]), [[a, '/srv/a'], [b, '/srv/b']]);

    const result = await app.invokeRaw('unmount_legacy_mounts', [a, '/etc/not-a-mount']);
    assert.equal(result.success, false);
    assert.deepEqual([...result.results].map(r => [r.path, r.ok]), [[a, true], ['/etc/not-a-mount', false]]);
    assert.match(result.results[1].error, /not a legacy rclone mount/);
    assert.deepEqual(app.state.foreignMounts.map(m => m.mountPoint), [b], 'the unselected mount stays mounted');
});

// --- #5 encrypted config and validated writes -------------------------------

test('an encrypted config is explained, never listed as empty, and never modified', async t => {
    const app = createApp(t, { config: ENCRYPTED });
    await assert.rejects(app.invoke('get_remotes'), /CONFIG_ENCRYPTED.*encrypted/);
    await assert.rejects(app.invoke('add_remote_with_plugin', sftp('newone')), /CONFIG_ENCRYPTED/);
    await assert.rejects(app.invoke('update_remote_with_plugin', { remoteName: 'foo', pluginName: 'sftp', config: { host: 'x.example' } }), /CONFIG_ENCRYPTED/);
    await assert.rejects(app.invoke('get_remote_config', { remoteName: 'foo' }), /CONFIG_ENCRYPTED/);
    const deleted = await app.invoke('delete_remote', { remoteName: 'foo' });
    assert.equal(deleted.success, false);
    assert.equal(deleted.code, 'CONFIG_ENCRYPTED');
    assert.equal(app.readConfig(), ENCRYPTED, 'bytes unchanged');
    assert.equal(app.calls('rclone').length, 0, 'refused before any external command');
    assert.deepEqual(fs.readdirSync(path.dirname(app.configPath)), ['rclone.conf'], 'no temp files');
});

test('a config edited by someone else mid-operation is not overwritten', async t => {
    const app = createApp(t);
    const intruder = '\n[intruder]\ntype = alias\nremote = /tmp\n';
    let fired = false;
    app.state.onDump = () => {
        if (fired) return;
        fired = true;
        fs.appendFileSync(app.configPath, intruder);
    };
    const result = await app.invoke('delete_remote', { remoteName: 'foo' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'CONFIG_CHANGED');
    assert.match(app.readConfig(), /\[foo\]/);
    assert.match(app.readConfig(), /\[intruder\]/);
    assert.deepEqual(fs.readdirSync(path.dirname(app.configPath)), ['rclone.conf'], 'no temp files');
});

test('every config write is validated by rclone before it replaces the file', async t => {
    const app = createApp(t);
    assert.equal((await app.invoke('add_remote_with_plugin', sftp('newone'))).success, true);
    const dumps = app.calls('rclone').filter(call => call.includes('dump'));
    assert.ok(dumps.length >= 2, 'old and new content are both dumped by rclone');
    for (const call of dumps) assert.ok(call.includes('--ask-password=false') && call.includes('--config'));
    assert.deepEqual(fs.readdirSync(path.dirname(app.configPath)), ['rclone.conf']);
});

// --- harness guard ----------------------------------------------------------

test('the harness refuses writes outside the test directory (protects the real rclone.conf)', async t => {
    const app = createApp(t, { config: null });
    const stray = '/tmp/de-rclone-must-never-exist.conf';
    t.after(() => fs.rmSync(stray, { force: true }));
    await assert.rejects(app.invoke('add_remote_with_plugin', { ...sftp('x'), configPathOpt: stray }), /TEST ISOLATION/);
    assert.equal(fs.existsSync(stray), false);
});
