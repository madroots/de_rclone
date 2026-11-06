const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const appRequire = createRequire(path.join(root, 'main.js'));

function fixture(t, content = '[foo]\ntype = sftp\npass = stored-secret\n\n[prefixfoo]\ntype = sftp\npass = keep-secret\n') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'de-rclone-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, 'config', 'rclone.conf');
    fs.mkdirSync(path.dirname(configPath));
    if (content !== null) fs.writeFileSync(configPath, content);
    const handlers = new Map();
    const state = { cron: '', mounted: new Set(), calls: [], failures: {} };
    const mountDir = name => path.join(dir, 'runtime', 'rclone-mounts', name);
    const execFile = (file, args, options, callback) => {
        if (typeof options === 'function') callback = options;
        state.calls.push([file, ...args]);
        let stdout = '';
        let stderr = '';
        let error = null;
        const fail = state.failures[file === 'crontab' ? (args[0] === '-l' ? 'cronRead' : 'cronWrite') : file];
        if (fail) {
            error = Object.assign(new Error(fail.message || 'mock command failure'), { code: fail.code || 1 });
            stderr = fail.stderr || '';
        } else if (file === 'crontab') {
            if (args[0] === '-l') stdout = state.cron;
            else state.cron = fs.readFileSync(args[0], 'utf8');
        } else if (file === 'mountpoint') {
            if (!state.mounted.has(args[1])) error = Object.assign(new Error('not a mountpoint'), { code: 32 });
        } else if (file === 'fusermount' || file === 'umount') {
            if (!state.keepMounted) state.mounted.delete(args[args.length - 1]);
        } else if (file === 'rclone' && args[0] === 'obscure') {
            stdout = `obscured:${args[1]}\n`;
        } else {
            throw new Error(`Unexpected external command: ${file} ${args.join(' ')}`);
        }
        queueMicrotask(() => callback(error, stdout, stderr));
    };
    vm.runInNewContext(source, {
        require(name) {
            if (name === 'electron') return {
                app: { whenReady: () => ({ then() {} }), on() {} },
                ipcMain: { handle: (name, handler) => handlers.set(name, handler) }
            };
            if (name === 'child_process') return { execFile, spawn() { throw new Error('Unexpected spawn'); } };
            if (name === 'os') return { ...os, homedir: () => dir, tmpdir: () => dir };
            return appRequire(name);
        },
        __dirname: root,
        process: { ...process, env: { ...process.env, XDG_RUNTIME_DIR: path.join(dir, 'runtime') } },
        console, setInterval, clearInterval
    }, { filename: path.join(root, 'main.js') });
    return {
        state, configPath, mountDir,
        readConfig: () => fs.readFileSync(configPath, 'utf8'),
        invoke: (name, options = {}) => handlers.get(name)(null, { configPathOpt: configPath, ...options }),
        mount(name) {
            fs.mkdirSync(mountDir(name), { recursive: true });
            state.mounted.add(mountDir(name));
        }
    };
}

const fooCron = "@reboot rclone mount 'foo:' '/managed/foo' --daemon # Added by de_rclone: foo\n";
const unrelatedCron = '# keep this comment about rclone mount foo:\n' +
    '@reboot rclone mount prefixfoo: /managed/prefixfoo --daemon\n' +
    '@reboot rclone mount foo:subdir /managed/subdir --daemon\n' +
    '0 1 * * * echo backup # rclone mount foo:\n' +
    '0 2 * * * echo rclone mount foo:\n';

test('deletion unmounts only the target, removes its cron and directory, and preserves other config', async t => {
    const f = fixture(t);
    f.mount('foo');
    f.mount('prefixfoo');
    f.state.cron = unrelatedCron + fooCron;
    const result = await f.invoke('delete_remote', { remoteName: 'foo' });
    assert.equal(result.success, true, result.message);
    assert.equal(f.state.mounted.has(f.mountDir('foo')), false);
    assert.equal(f.state.mounted.has(f.mountDir('prefixfoo')), true);
    assert.equal(fs.existsSync(f.mountDir('foo')), false);
    assert.equal(f.state.cron, unrelatedCron);
    assert.equal(f.readConfig(), '[prefixfoo]\ntype = sftp\npass = keep-secret\n');
});

test('delete keeps credentials and cron when both unmount commands fail', async t => {
    const f = fixture(t);
    const before = f.readConfig();
    f.mount('foo');
    f.state.cron = fooCron;
    f.state.failures.fusermount = { stderr: 'device busy' };
    f.state.failures.umount = { stderr: 'target is busy' };
    const result = await f.invoke('delete_remote', { remoteName: 'foo' });
    assert.equal(result.success, false);
    assert.match(result.message, /unmount|busy/i);
    assert.equal(f.readConfig(), before);
    assert.equal(f.state.cron, fooCron);
    assert.equal(f.state.mounted.has(f.mountDir('foo')), true);
});

for (const failure of ['cronRead', 'cronWrite']) {
    test(`delete preserves config on ${failure} failure`, async t => {
        const f = fixture(t);
        const before = f.readConfig();
        f.state.cron = unrelatedCron + fooCron;
        f.state.failures[failure] = { stderr: 'permission denied reading/writing crontab' };
        const result = await f.invoke('delete_remote', { remoteName: 'foo' });
        assert.equal(result.success, false);
        assert.match(result.message, /crontab|cron/i);
        assert.match(result.message, /permission denied/);
        assert.equal(f.readConfig(), before);
        assert.equal(f.state.cron, unrelatedCron + fooCron);
    });
}

test('delete fails safely when mount status cannot be established', async t => {
    const f = fixture(t);
    f.mount('foo');
    const before = f.readConfig();
    f.state.failures.mountpoint = { code: 'ENOENT', message: 'mountpoint not installed' };
    const result = await f.invoke('delete_remote', { remoteName: 'foo' });
    assert.equal(result.success, false);
    assert.match(result.message, /mountpoint|mount point/i);
    assert.equal(f.readConfig(), before);
});

test('delete preserves a nonempty managed directory and credentials for manual cleanup', async t => {
    const f = fixture(t);
    fs.mkdirSync(f.mountDir('foo'), { recursive: true });
    fs.writeFileSync(path.join(f.mountDir('foo'), 'keep'), 'local data');
    const before = f.readConfig();
    const result = await f.invoke('delete_remote', { remoteName: 'foo' });
    assert.equal(result.success, false);
    assert.match(result.message, /directory|ENOTEMPTY|not empty/i);
    assert.equal(f.readConfig(), before);
    assert.equal(fs.readFileSync(path.join(f.mountDir('foo'), 'keep'), 'utf8'), 'local data');
});

test('unmount handler uses the same cleanup and falls back to umount', async t => {
    const f = fixture(t);
    f.mount('foo');
    f.state.failures.fusermount = { stderr: 'fusermount unavailable' };
    const result = await f.invoke('unmount_remote', { remoteName: 'foo' });
    assert.equal(result.success, true, result.message);
    assert.equal(f.state.mounted.size, 0);
    assert.equal(fs.existsSync(f.mountDir('foo')), false);
});

test('config create, update and delete force mode 0600 with permissive umask', async t => {
    const f = fixture(t, null);
    const oldUmask = process.umask(0);
    t.after(() => process.umask(oldUmask));
    const mode = () => fs.statSync(f.configPath).mode & 0o777;
    const config = { remote_name: 'foo', host: 'host.example', user: 'alice', pass: 'secret' };
    assert.equal((await f.invoke('add_remote_with_plugin', { pluginName: 'sftp', config })).success, true);
    assert.equal(mode(), 0o600);
    fs.chmodSync(f.configPath, 0o666);
    assert.equal((await f.invoke('add_remote_with_plugin', {
        pluginName: 'sftp', config: { ...config, remote_name: 'second' }
    })).success, true);
    assert.equal(mode(), 0o600);
    fs.chmodSync(f.configPath, 0o666);
    assert.equal((await f.invoke('update_remote_with_plugin', {
        remoteName: 'foo', pluginName: 'sftp', config: { host: 'new.example' }
    })).success, true);
    assert.equal(mode(), 0o600);
    fs.chmodSync(f.configPath, 0o666);
    assert.equal((await f.invoke('delete_remote', { remoteName: 'foo' })).success, true);
    assert.equal(mode(), 0o600);
});

test('cron status, add and remove use exact remote arguments and preserve unrelated bytes', async t => {
    const f = fixture(t);
    f.state.cron = unrelatedCron;
    const remotes = await f.invoke('get_remotes');
    assert.equal(remotes.find(remote => remote.name === 'foo').cron, 'No');
    assert.equal(remotes.find(remote => remote.name === 'prefixfoo').cron, 'Yes');
    assert.equal((await f.invoke('add_to_cron', { remoteName: 'foo' })).success, true);
    assert.equal(f.state.cron.startsWith(unrelatedCron), true);
    const withFoo = f.state.cron;
    assert.equal((await f.invoke('add_to_cron', { remoteName: 'foo' })).success, true);
    assert.equal(f.state.cron, withFoo);
    assert.equal((await f.invoke('remove_from_cron', { remoteName: 'foo' })).success, true);
    assert.equal(f.state.cron, unrelatedCron);
});

for (const name of ['name with spaces', "team's remote"]) {
    test(`existing remote ${JSON.stringify(name)} supports exact quoted cron and deletion`, async t => {
        const f = fixture(t, `[${name}]\ntype = sftp\npass = secret\n`);
        f.mount(name);
        f.state.cron = unrelatedCron;
        assert.equal((await f.invoke('add_to_cron', { remoteName: name })).success, true);
        assert.equal((await f.invoke('get_remotes'))[0].cron, 'Yes');
        assert.equal((await f.invoke('delete_remote', { remoteName: name })).success, true);
        assert.equal(f.state.cron, unrelatedCron);
        assert.equal(f.readConfig(), '');
        assert.equal(fs.existsSync(f.mountDir(name)), false);
    });
}

for (const name of ['../escape', '..', '.', '/absolute', 'nested/name', 'nested\\name']) {
    test(`managed mount paths reject ${JSON.stringify(name)} without deleting credentials`, async t => {
        const f = fixture(t, `[${name}]\ntype = sftp\npass = secret\n`);
        const before = f.readConfig();
        const result = await f.invoke('delete_remote', { remoteName: name });
        assert.equal(result.success, false);
        assert.match(result.message, /remote name|mount path/i);
        assert.equal(f.readConfig(), before);
        assert.equal(f.state.calls.length, 0);
    });
}

test('actual no-crontab result permits first add and deletion without a cron write', async t => {
    const f = fixture(t);
    f.state.failures.cronRead = { code: 1, stderr: 'no crontab for test-user\n' };
    assert.equal((await f.invoke('get_remotes'))[0].cron, 'No');
    assert.equal((await f.invoke('add_to_cron', { remoteName: 'foo' })).success, true);
    delete f.state.failures.cronRead;
    assert.equal((await f.invoke('remove_from_cron', { remoteName: 'foo' })).success, true);
    f.state.failures.cronRead = { code: 1, stderr: 'no crontab for test-user\n' };
    const writes = f.state.calls.filter(call => call[0] === 'crontab' && call[1] !== '-l').length;
    assert.equal((await f.invoke('delete_remote', { remoteName: 'foo' })).success, true);
    assert.equal(f.state.calls.filter(call => call[0] === 'crontab' && call[1] !== '-l').length, writes);
});

for (const failure of [
    { code: 1, stderr: 'crontab: permission denied' }
]) {
    test(`crontab read error ${failure.code} is never treated as an empty table`, async t => {
        const f = fixture(t);
        const before = f.readConfig();
        f.state.cron = unrelatedCron;
        f.state.failures.cronRead = failure;
        await assert.rejects(f.invoke('get_remotes'), /crontab/i);
        for (const handler of ['add_to_cron', 'remove_from_cron', 'delete_remote']) {
            const result = await f.invoke(handler, { remoteName: 'foo' });
            assert.equal(result.success, false, handler);
            assert.match(result.message, /crontab/i);
        }
        assert.equal(f.readConfig(), before);
        assert.equal(f.state.cron, unrelatedCron);
        assert.equal(f.state.calls.some(call => call[0] === 'crontab' && call[1] !== '-l'), false);
    });
}

test('missing optional crontab permits deletion with an explicit manual-cleanup warning', async t => {
    const f = fixture(t);
    f.mount('foo');
    f.state.cron = unrelatedCron + fooCron;
    f.state.failures.cronRead = { code: 'ENOENT', message: 'spawn crontab ENOENT' };
    assert.equal((await f.invoke('get_remotes'))[0].cron, 'No');
    const add = await f.invoke('add_to_cron', { remoteName: 'foo' });
    assert.equal(add.success, false);
    assert.match(add.message, /install.*crontab|crontab.*install/i);
    const remove = await f.invoke('remove_from_cron', { remoteName: 'foo' });
    assert.equal(remove.success, true);
    assert.match(remove.message, /unavailable.*manually/);
    const deletion = await f.invoke('delete_remote', { remoteName: 'foo' });
    assert.equal(deletion.success, true, deletion.message);
    assert.match(deletion.message, /unavailable.*manually/);
    assert.equal(fs.existsSync(f.mountDir('foo')), false);
    assert.equal(f.state.cron, unrelatedCron + fooCron);
    assert.equal(f.state.calls.some(call => call[0] === 'crontab' && call[1] !== '-l'), false);
});

test('cron matching accepts absolute rclone commands and double-quoted remote names', async t => {
    const f = fixture(t);
    f.state.cron = unrelatedCron + '@reboot /usr/bin/rclone mount "foo:" /managed/foo --daemon\n';
    assert.equal((await f.invoke('get_remotes'))[0].cron, 'Yes');
    assert.equal((await f.invoke('remove_from_cron', { remoteName: 'foo' })).success, true);
    assert.equal(f.state.cron, unrelatedCron);
});

test('cron add preserves extra blank lines and comments in the existing table', async t => {
    const f = fixture(t);
    f.state.cron = unrelatedCron + '\n\n';
    assert.equal((await f.invoke('add_to_cron', { remoteName: 'foo' })).success, true);
    assert.equal(f.state.cron.startsWith(unrelatedCron + '\n\n'), true);
    assert.equal((await f.invoke('remove_from_cron', { remoteName: 'foo' })).success, true);
    assert.equal(f.state.cron, unrelatedCron + '\n\n');
});

test('a successful unmount command must actually release the mount before deletion', async t => {
    const f = fixture(t);
    f.mount('foo');
    f.state.keepMounted = true;
    f.state.cron = fooCron;
    const before = f.readConfig();
    const result = await f.invoke('delete_remote', { remoteName: 'foo' });
    assert.equal(result.success, false);
    assert.match(result.message, /did not release/);
    assert.equal(f.readConfig(), before);
    assert.equal(f.state.cron, fooCron);
    assert.equal(fs.existsSync(f.mountDir('foo')), true);
});
