'use strict';

// Operation safety (#9): conflicting operations are refused at once, a refused
// operation changes nothing, connection tests can really be cancelled, and quitting
// waits for work in flight.

const baseTest = require('node:test');
const assert = require('node:assert/strict');
// A hung operation must fail the test, never stall the suite.
const test = (name, fn) => baseTest(name, { timeout: 10000 }, fn);
const fs = require('node:fs');
const { createApp } = require('./helpers/app-harness.cjs');

const deferred = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
};
const tick = () => new Promise(r => setImmediate(r));
const fooCron = "@reboot rclone mount 'foo:' '/managed/foo' --daemon # Added by de_rclone: foo\n";

test('while a remote is mounting, every conflicting operation on it is refused with BUSY and changes nothing', async t => {
    const app = createApp(t);
    app.state.cron = fooCron;
    const before = app.readConfig();
    const gate = deferred();
    app.state.mountGate = gate.promise;

    const mounting = app.invoke('mount_remote', { remoteName: 'foo' });
    await tick();

    for (const [handler, args] of [['unmount_remote', {}], ['recover_mount', {}], ['delete_remote', {}], ['add_to_cron', {}], ['remove_from_cron', {}]]) {
        const result = await app.invoke(handler, { remoteName: 'foo', ...args });
        assert.equal(result.success, false, handler);
        assert.equal(result.code, 'BUSY', handler);
        assert.match(result.message, /foo/, handler);
        assert.match(result.message, /mounting|auto-mount|deleting/, handler);
    }
    assert.equal(app.readConfig(), before);
    assert.equal(app.state.cron, fooCron);
    assert.equal(app.calls('fusermount').length + app.calls('umount').length, 0, 'a refused unmount must not run a tool');
    assert.equal(app.cronWrites().length, 0);

    gate.resolve();
    assert.equal((await mounting).success, true);
    assert.equal(app.calls('rclone').length, 1, 'exactly one rclone mount ran');
});

test('the lock is released when the operation finishes, fails or throws', async t => {
    const app = createApp(t);
    app.state.mountBehavior = 'fail';
    assert.equal((await app.invoke('mount_remote', { remoteName: 'foo' })).code, 'MOUNT_FAILED');
    app.state.mountBehavior = 'success';
    const retry = await app.invoke('mount_remote', { remoteName: 'foo' });
    assert.equal(retry.success, true, 'a failed mount must not leave the remote locked');

    await assert.rejects(app.invoke('add_remote_with_plugin', { pluginName: 'no-such-plugin', config: { remote_name: 'x' } }), /not found/);
    const added = await app.invoke('add_remote_with_plugin', { pluginName: 'sftp', config: { remote_name: 'x', host: 'h.example', user: 'u' } });
    assert.equal(added.success, true, 'a handler that threw must not leave the config locked');
});

test('different remotes are not blocked by each other', async t => {
    const app = createApp(t);
    const gate = deferred();
    app.state.mountGate = gate.promise;
    const first = app.invoke('mount_remote', { remoteName: 'foo' });
    await tick();
    app.mount('prefixfoo');
    const unmounted = await app.invoke('unmount_remote', { remoteName: 'prefixfoo' });
    assert.equal(unmounted.success, true, unmounted.message);
    gate.resolve();
    assert.equal((await first).success, true);
});

test('a config change in progress blocks other config and crontab changes, then releases them', async t => {
    const app = createApp(t);
    const gate = deferred();
    let held = false;
    app.state.onDump = () => { if (!held) { held = true; return gate.promise; } };

    const deleting = app.invoke('delete_remote', { remoteName: 'foo' });
    await tick(); await tick();

    await assert.rejects(app.invoke('add_remote_with_plugin', { pluginName: 'sftp', config: { remote_name: 'other', host: 'h.example', user: 'u' } }), /BUSY.*rclone config/);
    await assert.rejects(app.invoke('update_remote_with_plugin', { remoteName: 'prefixfoo', pluginName: 'sftp', config: { host: 'x.example' } }), /BUSY/);
    const cron = await app.invoke('add_to_cron', { remoteName: 'prefixfoo' });
    assert.deepEqual([cron.success, cron.code], [false, 'BUSY']);
    assert.match(cron.message, /crontab/);
    assert.equal(app.cronWrites().length, 0);

    gate.resolve();
    assert.equal((await deleting).success, true);
    assert.equal((await app.invoke('add_to_cron', { remoteName: 'prefixfoo' })).success, true, 'released afterwards');
});

test('a connection test is really cancelled: the rclone process is killed and the result says so', async t => {
    const app = createApp(t);
    app.state.lsfBehavior = 'hang';
    const running = app.invokeRaw('test_connection', { remoteName: 'foo', configPathOpt: app.configPath, requestId: 'req-1' });
    await tick();

    const cancelled = await app.invokeRaw('cancel_test', { requestId: 'req-1' });
    assert.equal(cancelled.success, true);
    const result = await running;
    assert.deepEqual([result.success, result.cancelled], [false, true]);
    assert.match(result.message, /cancelled/i);
    assert.deepEqual(app.state.killed, ['SIGTERM']);

    assert.equal((await app.invokeRaw('cancel_test', { requestId: 'req-1' })).success, false, 'finished tests are forgotten');
    assert.equal((await app.invokeRaw('cancel_test', { requestId: 'never-existed' })).success, false);
});

test('a connection test that fails on its own is not reported as cancelled', async t => {
    const app = createApp(t);
    app.state.lsfBehavior = 'fail';
    const result = await app.invokeRaw('test_connection', { remoteName: 'foo', configPathOpt: app.configPath, requestId: 'req-2' });
    assert.equal(result.success, false);
    assert.equal(result.cancelled, undefined);
    assert.match(result.message, /nope/);
});

test('quitting while idle exits immediately; quitting mid-operation waits for it to finish', async t => {
    const app = createApp(t);
    const beforeQuit = app.appEvents.get('before-quit');
    assert.equal(typeof beforeQuit, 'function');

    let prevented = 0;
    await beforeQuit({ preventDefault: () => { prevented++; } });
    assert.equal(prevented, 0);
    assert.equal(app.state.quitCalls, 0);

    const gate = deferred();
    app.state.mountGate = gate.promise;
    const mounting = app.invoke('mount_remote', { remoteName: 'foo' });
    await tick();

    const quitting = beforeQuit({ preventDefault: () => { prevented++; } });
    await tick();
    assert.equal(prevented, 1, 'quit is held back while a mount is in flight');
    assert.equal(app.state.quitCalls, 0);

    gate.resolve();
    await mounting;
    await quitting;
    assert.equal(app.state.quitCalls, 1, 'quit resumes once the work is done');
});
