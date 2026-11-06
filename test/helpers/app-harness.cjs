'use strict';

// Runs the real main.js inside a vm with faithful fakes for everything outside
// the process: the kernel mount table, crontab, fusermount/umount, rclone.
//
// ISOLATION: every filesystem write main.js (or the lib modules it injects `fs`
// into) performs is checked against the test's temp root and throws otherwise,
// so a test that forgets a config path can never touch the developer's real
// ~/.config/rclone/rclone.conf.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { createFakeRclone } = require('./fake-rclone.cjs');

const root = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const appRequire = createRequire(path.join(root, 'main.js'));

const DEFAULT_CONFIG = '[foo]\ntype = sftp\npass = stored-secret\n\n[prefixfoo]\ntype = sftp\npass = keep-secret\n';

// The kernel escapes these four characters in mountinfo fields (proc(5)).
const escapeMountinfo = (value) => value
    .replace(/\\/g, '\\134').replace(/ /g, '\\040').replace(/\t/g, '\\011').replace(/\n/g, '\\012');

const noSuchTool = (tool) => Object.assign(new Error(`spawn ${tool} ENOENT`), { code: 'ENOENT' });
const exitError = (code, stderr) => ({ error: Object.assign(new Error('Command failed'), { code }), stdout: '', stderr });

// Exact messages: cronie / vixie-cron crontab.c.
const CRON_MESSAGES = {
    none: (user) => `no crontab for ${user}\n`,
    denied: (user) => `You (${user}) are not allowed to use this program (crontab)\nSee crontab(1) for more information\n`
};

function createApp(t, { config = DEFAULT_CONFIG } = {}) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'de-rclone-test-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const runtimeDir = path.join(dir, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const configPath = path.join(dir, 'config', 'rclone.conf');
    fs.mkdirSync(path.dirname(configPath));
    if (config !== null) fs.writeFileSync(configPath, config);

    const state = {
        // null = the user has no crontab at all; a string = installed table.
        cron: '',
        // ok | denied | missing | error
        cronMode: 'ok',
        cronWriteError: null,
        mounts: new Map(),        // remote name -> { stale: boolean }
        foreignMounts: [],        // { mountPoint, fsType, source }
        mountinfoError: null,
        missingTools: new Set(['fusermount3']),
        toolFailures: {},         // tool name -> stderr; every call of the tool fails
        keepMountedAfterUnmount: false,
        mountBehavior: 'success', // success | fail | invisible
        onDump: null,
        calls: []
    };
    const mountDir = (name) => path.join(runtimeDir, 'rclone-mounts', name);

    const guardedPaths = (...paths) => {
        for (const p of paths) {
            if (typeof p === 'number') continue; // an already-open (and already-guarded) file descriptor
            const resolved = path.resolve(String(p));
            if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
                throw new Error(`TEST ISOLATION: write outside the test directory: ${resolved}`);
            }
        }
    };
    const guardWrites = (real) => {
        const wrapped = { ...real };
        for (const name of ['writeFileSync', 'mkdirSync', 'rmdirSync', 'rmSync', 'unlinkSync', 'copyFileSync', 'symlinkSync', 'linkSync', 'appendFileSync', 'truncateSync']) {
            wrapped[name] = (p, ...rest) => { guardedPaths(p); return real[name](p, ...rest); };
        }
        wrapped.renameSync = (from, to) => { guardedPaths(from, to); return real.renameSync(from, to); };
        wrapped.openSync = (p, flags, ...rest) => {
            if (typeof flags === 'string' && /[wax+]/.test(flags)) guardedPaths(p);
            return real.openSync(p, flags, ...rest);
        };
        wrapped.promises = {
            ...real.promises,
            readFile: async (file, ...rest) => {
                if (file === '/proc/self/mountinfo') {
                    if (state.mountinfoError) throw state.mountinfoError;
                    return mountinfoText();
                }
                return real.promises.readFile(file, ...rest);
            },
            stat: async (file, ...rest) => {
                for (const [name, info] of state.mounts) {
                    if (file === mountDir(name) && info.stale) {
                        throw Object.assign(new Error('Transport endpoint is not connected'), { code: 'ENOTCONN' });
                    }
                }
                return real.promises.stat(file, ...rest);
            }
        };
        return wrapped;
    };
    const guardedFs = guardWrites(fs);

    function mountinfoText() {
        let id = 100;
        const lines = [
            '22 1 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw',
            '23 1 0:22 / /run rw,nosuid,nodev shared:5 - tmpfs tmpfs rw,mode=755'
        ];
        for (const [name, info] of state.mounts) {
            // rclone records the backend's fs string as the source (for an alias
            // remote that is the underlying path, not "name:"), so tests use that.
            const source = info.source ?? `/srv/backend/${name}`;
            lines.push(`${id++} 23 0:${id} / ${escapeMountinfo(mountDir(name))} rw,nosuid,nodev,relatime shared:${id} - fuse.rclone ${escapeMountinfo(source)} rw,user_id=1000,group_id=1000`);
        }
        for (const m of state.foreignMounts) {
            lines.push(`${id++} 23 0:${id} / ${escapeMountinfo(m.mountPoint)} rw,relatime - ${m.fsType} ${escapeMountinfo(m.source)} rw`);
        }
        return lines.join('\n') + '\n';
    }

    const fakeDump = createFakeRclone({ fsImpl: guardedFs });

    function cronRead() {
        if (state.cronMode === 'missing') return { error: noSuchTool('crontab') };
        if (state.cronMode === 'denied') return exitError(1, CRON_MESSAGES.denied('tester'));
        if (state.cronMode === 'error') return exitError(1, 'crontab: temporary failure in the cron spool\n');
        if (state.cron === null) return exitError(1, CRON_MESSAGES.none('tester'));
        return { stdout: state.cron, stderr: '' };
    }

    function execFile(file, args, options, callback) {
        if (typeof options === 'function') callback = options;
        state.calls.push([file, ...args]);
        const done = (error, stdout = '', stderr = '') => queueMicrotask(() => callback(error, stdout, stderr));
        const child = { stdin: null };

        if (state.missingTools.has(file) && file !== 'crontab') {
            done(noSuchTool(file));
            return child;
        }
        if (state.toolFailures[file]) {
            done(Object.assign(new Error('Command failed'), { code: 1 }), '', state.toolFailures[file]);
            return child;
        }

        if (file === 'crontab' && args[0] === '-l') {
            const r = cronRead();
            done(r.error || null, r.stdout || '', r.stderr || '');
        } else if (file === 'crontab' && args[0] === '-') {
            // `crontab -` reads the new table from stdin.
            const chunks = [];
            child.stdin = {
                write: (data) => { chunks.push(String(data)); return true; },
                end: (data) => {
                    if (data !== undefined) chunks.push(String(data));
                    if (state.cronMode === 'denied') return done(...Object.values(exitError(1, CRON_MESSAGES.denied('tester'))));
                    if (state.cronMode === 'missing') return done(noSuchTool('crontab'));
                    if (state.cronWriteError) return done(Object.assign(new Error('Command failed'), { code: 1 }), '', state.cronWriteError);
                    // cronIgnoresWrites models a crontab that exits 0 but installs nothing.
                    if (!state.cronIgnoresWrites) state.cron = chunks.join('');
                    done(null, '', '');
                },
                on() {}, once() {}, emit() {}
            };
        } else if (file === 'fusermount' || file === 'fusermount3' || file === 'umount') {
            const target = args[args.length - 1];
            // Models a mount that only a lazy unmount (-uz) can release.
            if (state.requireLazy && !args.includes('-uz')) {
                done(Object.assign(new Error('Command failed'), { code: 1 }), '', `${file}: failed to unmount ${target}: Device or resource busy\n`);
                return child;
            }
            const entry = [...state.mounts.keys()].find(name => mountDir(name) === target);
            if (entry !== undefined && !state.keepMountedAfterUnmount) state.mounts.delete(entry);
            if (!state.keepMountedAfterUnmount) state.foreignMounts = state.foreignMounts.filter(m => m.mountPoint !== target);
            done(null);
        } else if (file === 'rclone' && args[0] === 'obscure') {
            done(null, `obscured:${args[1]}\n`);
        } else if (file === 'rclone' && args.includes('config')) {
            if (state.onDump) state.onDump(args);
            Promise.resolve(fakeDump(args, options)).then(
                (r) => callback(null, r.stdout, r.stderr),
                (e) => callback(e.error || e, e.stdout || '', e.stderr || '')
            );
        } else {
            throw new Error(`Unexpected external command: ${file} ${args.join(' ')}`);
        }
        return child;
    }

    function spawn(file, args) {
        state.calls.push([file, ...args]);
        const child = new EventEmitter();
        child.stderr = Object.assign(new EventEmitter(), { destroy() {} });
        child.unref = () => {};
        setImmediate(() => {
            if (state.mountBehavior === 'fail') {
                child.stderr.emit('data', Buffer.from('Failed to create file system for "x:": boom'));
                child.emit('exit', 1, null);
                return;
            }
            if (state.mountBehavior === 'success') state.mounts.set(args[1].slice(0, -1), { stale: false });
            child.emit('exit', 0, null);
        });
        return child;
    }

    const handlers = new Map();
    vm.runInNewContext(source, {
        require(name) {
            if (name === 'electron') return {
                app: { whenReady: () => ({ then() {} }), on() {} },
                ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
            };
            if (name === 'child_process') return { execFile, spawn };
            if (name === 'fs') return guardedFs;
            if (name === 'os') return { ...os, homedir: () => dir, tmpdir: () => dir };
            return appRequire(name);
        },
        __dirname: root,
        process: { ...process, env: { ...process.env, HOME: dir, XDG_RUNTIME_DIR: runtimeDir } },
        console, setInterval, clearInterval, setTimeout, clearTimeout
    }, { filename: path.join(root, 'main.js') });

    return {
        dir, state, configPath, mountDir,
        readConfig: () => fs.readFileSync(configPath, 'utf8'),
        invoke: (name, options = {}) => handlers.get(name)(null, { configPathOpt: configPath, ...options }),
        // For handlers whose argument is the data itself (not an options object).
        invokeRaw: (name, data) => handlers.get(name)(null, data),
        // A healthy rclone mount of `name`, with its managed directory in place.
        mount(name, { stale = false } = {}) {
            fs.mkdirSync(mountDir(name), { recursive: true });
            state.mounts.set(name, { stale });
        },
        calls: (file) => state.calls.filter(call => call[0] === file),
        cronWrites: () => state.calls.filter(call => call[0] === 'crontab' && call[1] === '-')
    };
}

module.exports = { createApp, DEFAULT_CONFIG, CRON_MESSAGES };
