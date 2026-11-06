'use strict';

// Runs the real main.js inside a vm against REAL child_process / fs / os: real
// rclone, real fusermount, real FUSE mounts, real /proc/self/mountinfo. The only
// stand-in is `crontab`, replaced by a shell shim in a temp bin directory, so the
// developer's real crontab can never be touched.
//
// ISOLATION (a script once wrote to a developer's real ~/.config/rclone/rclone.conf):
//   * the vm sees process.env = { HOME, XDG_CONFIG_HOME, XDG_RUNTIME_DIR, PATH, AUDIT_DIR }
//     that all point into one temp directory (PATH only adds the shim in front);
//   * every fs write main.js / lib/* performs is checked against the temp directory;
//   * every child process main.js starts is checked: only rclone, fusermount(3),
//     umount and crontab are allowed, mount/unmount targets and rclone configs
//     must be inside the temp directory, and `crontab` is always the shim;
//   * cleanup kills only processes whose command line mentions the temp directory
//     (or whose cwd is inside it) and unmounts only mount points inside it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const childProcess = require('node:child_process');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const appRequire = createRequire(path.join(root, 'main.js'));

// Exact text of cronie's crontab.c for a user that is not allowed to use crontab.
const CRON_DENIED_STDERR = (user) => `You (${user}) are not allowed to use this program (crontab)\nSee crontab(1) for more information\n`;
const CRON_USER = 'tester';
const SHIM_ID = 'de-rclone-crontab-shim';

function which(tool) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, tool);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch (e) { /* not here */ }
    }
    return null;
}

// Reasons the real-FUSE tests cannot run here; null when everything is available.
function fuseUnavailableReason() {
    if (process.env.DE_RCLONE_REAL_FUSE !== '1') return 'DE_RCLONE_REAL_FUSE=1 is not set';
    try {
        fs.accessSync('/dev/fuse', fs.constants.R_OK | fs.constants.W_OK);
    } catch (e) {
        return `/dev/fuse is not readable and writable (${e.code})`;
    }
    if (!which('rclone')) return 'rclone is not installed';
    if (!which('fusermount3') && !which('fusermount')) return 'neither fusermount3 nor fusermount is installed';
    return null;
}

const unescapeField = (field) => field.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

// Independent of lib/mountinfo.js on purpose: cleanup must not depend on the code under test.
function readMounts() {
    return fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean).map((line) => {
        const f = line.split(' ');
        const sep = f.indexOf('-', 6);
        return { mountPoint: unescapeField(f[4]), fsType: f[sep + 1], source: unescapeField(f[sep + 2]) };
    });
}

const within = (dir, p) => {
    const resolved = path.resolve(String(p));
    return resolved === dir || resolved.startsWith(dir + path.sep);
};

function listProcesses() {
    const result = [];
    for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        let cmdline = '';
        let cwd = '';
        try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch (e) { continue; }
        try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch (e) { /* kernel thread or not ours */ }
        result.push({ pid, cmdline, cwd });
    }
    return result;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createRealApp(t, { config } = {}) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'de-rclone-real-')));
    const home = path.join(dir, 'home');
    const runtimeDir = path.join(dir, 'runtime');
    const binDir = path.join(dir, 'bin');
    const dataDir = path.join(dir, 'data');
    const cronDir = path.join(dir, 'cron');
    const configPath = path.join(home, '.config', 'rclone', 'rclone.conf');
    for (const d of [path.dirname(configPath), runtimeDir, binDir, dataDir, cronDir]) fs.mkdirSync(d, { recursive: true });
    fs.chmodSync(runtimeDir, 0o700);

    const shimPath = path.join(binDir, 'crontab');
    fs.writeFileSync(shimPath, [
        '#!/bin/sh',
        `D='${cronDir}'`,
        `USER_NAME='${CRON_USER}'`,
        `if [ "$1" = "--de-rclone-shim" ]; then echo '${SHIM_ID}'; exit 0; fi`,
        'mode=$(cat "$D/mode" 2>/dev/null || echo ok)',
        'denied() {',
        `    printf '%b' "${CRON_DENIED_STDERR('$USER_NAME').replace(/\n/g, '\\n')}" >&2`,
        '    exit 1',
        '}',
        'case "$1" in',
        '    -l)',
        '        [ "$mode" = denied ] && denied',
        '        if [ -f "$D/table" ]; then cat "$D/table"; else printf \'no crontab for %s\\n\' "$USER_NAME" >&2; exit 1; fi',
        '        ;;',
        '    -)',
        '        [ "$mode" = denied ] && denied',
        '        cat > "$D/table.new" && mv "$D/table.new" "$D/table"',
        '        ;;',
        '    *)',
        '        echo "crontab shim: unsupported arguments: $*" >&2',
        '        exit 2',
        '        ;;',
        'esac',
        ''
    ].join('\n'), { mode: 0o755 });

    const env = {
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_RUNTIME_DIR: runtimeDir,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        AUDIT_DIR: dir
    };

    // The shim must win before anything else runs. Check both what the shell
    // resolves and what the shim answers, and never continue otherwise.
    const resolved = childProcess.execFileSync('sh', ['-c', 'command -v crontab'], { env, encoding: 'utf8' }).trim();
    if (resolved !== shimPath) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error(`REAL-APP SAFETY: crontab resolves to ${resolved}, not the shim ${shimPath}; refusing to run`);
    }
    const shimAnswer = childProcess.execFileSync(shimPath, ['--de-rclone-shim'], { env, encoding: 'utf8' }).trim();
    if (shimAnswer !== SHIM_ID) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error('REAL-APP SAFETY: the crontab shim does not identify itself; refusing to run');
    }

    const tracked = new Set(); // children spawned by tests (e.g. a cwd holder), killed on cleanup
    let cleaned = false;
    async function cleanup() {
        if (cleaned) return;
        cleaned = true;
        for (const child of tracked) {
            try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
        }
        // Kill only what demonstrably belongs to this temp directory.
        for (const p of listProcesses()) {
            if (p.pid === process.pid || p.pid === process.ppid) continue;
            if (p.cmdline.includes(dir) || (p.cwd && within(dir, p.cwd))) {
                try { process.kill(p.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
            }
        }
        await sleep(300);
        // Lazy-unmount only mount points inside the temp directory, deepest first.
        for (let round = 0; round < 5; round++) {
            const mine = readMounts().map(m => m.mountPoint).filter(mp => mp.startsWith(dir + path.sep));
            if (mine.length === 0) break;
            for (const mp of mine.sort((a, b) => b.length - a.length)) {
                if (!mp.startsWith(dir + path.sep)) throw new Error(`refusing to unmount ${mp}`);
                for (const tool of ['fusermount3', 'fusermount']) {
                    try { childProcess.execFileSync(tool, ['-uz', mp], { env, stdio: 'ignore' }); break; } catch (e) { /* try next */ }
                }
            }
            await sleep(200);
        }
        const left = readMounts().filter(m => m.mountPoint.startsWith(dir + path.sep));
        if (left.length > 0) {
            // rm -rf through a live mount could delete through to the backend; leave the directory.
            throw new Error(`could not unmount ${left.map(m => m.mountPoint).join(', ')}; ${dir} was left in place`);
        }
        fs.rmSync(dir, { recursive: true, force: true });
    }
    t.after(cleanup);

    // --- guarded fs (real underneath) -------------------------------------------------
    const guardedPaths = (...paths) => {
        for (const p of paths) {
            if (typeof p === 'number') continue; // an already-open (and already-guarded) file descriptor
            if (!within(dir, p)) throw new Error(`TEST ISOLATION: write outside the test directory: ${path.resolve(String(p))}`);
        }
    };
    const guardedFs = { ...fs };
    for (const name of ['writeFileSync', 'mkdirSync', 'rmdirSync', 'rmSync', 'unlinkSync', 'copyFileSync', 'symlinkSync', 'linkSync', 'appendFileSync', 'truncateSync']) {
        guardedFs[name] = (p, ...rest) => { guardedPaths(p); return fs[name](p, ...rest); };
    }
    guardedFs.renameSync = (from, to) => { guardedPaths(from, to); return fs.renameSync(from, to); };
    guardedFs.openSync = (p, flags, ...rest) => {
        if (typeof flags === 'string' && /[wax+]/.test(flags)) guardedPaths(p);
        return fs.openSync(p, flags, ...rest);
    };

    // --- guarded child_process (real underneath) --------------------------------------
    const ALLOWED_TOOLS = new Set(['rclone', 'fusermount3', 'fusermount', 'umount', 'crontab']);
    function checkedCall(file, args, options) {
        if (!ALLOWED_TOOLS.has(file)) throw new Error(`TEST ISOLATION: unexpected external command: ${file}`);
        args = args.map(String);
        if (file === 'rclone') {
            if (args[0] === 'obscure') {
                // no config involved
            } else {
                const at = args.indexOf('--config');
                if (at === -1 || !within(dir, args[at + 1])) {
                    throw new Error(`TEST ISOLATION: rclone without a --config inside the test directory: ${args.join(' ')}`);
                }
                if (args[0] === 'mount' && !within(dir, args[2])) {
                    throw new Error(`TEST ISOLATION: rclone mount outside the test directory: ${args[2]}`);
                }
            }
        } else if (file === 'crontab') {
            file = shimPath; // never resolve the real binary
        } else if (!within(dir, args[args.length - 1])) {
            throw new Error(`TEST ISOLATION: ${file} target outside the test directory: ${args[args.length - 1]}`);
        }
        return { file, args, options: { ...options, env: { ...(options && options.env), ...env } } };
    }
    const fakeChildProcess = {
        execFile(file, args, options, callback) {
            if (typeof options === 'function') { callback = options; options = {}; }
            const call = checkedCall(file, args, options);
            return childProcess.execFile(call.file, call.args, call.options, callback);
        },
        spawn(file, args, options) {
            const call = checkedCall(file, args, options);
            return childProcess.spawn(call.file, call.args, call.options);
        }
    };

    // --- seed the config and run main.js ----------------------------------------------
    const fixtureConfig = config ?? [
        '[plain]', 'type = alias', `remote = ${path.join(dataDir, 'plain')}`, '',
        '[my remote]', 'type = alias', `remote = ${path.join(dataDir, 'spaced')}`, ''
    ].join('\n');
    if (config !== null) {
        fs.mkdirSync(path.join(dataDir, 'plain'));
        fs.mkdirSync(path.join(dataDir, 'spaced'));
        fs.writeFileSync(configPath, fixtureConfig, { mode: 0o600 });
    }

    const handlers = new Map();
    vm.runInNewContext(source, {
        require(name) {
            if (name === 'electron') return {
                app: { whenReady: () => ({ then() {} }), on() {} },
                ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
            };
            if (name === 'child_process') return fakeChildProcess;
            if (name === 'fs') return guardedFs;
            if (name === 'os') return { ...os, homedir: () => home, tmpdir: () => dir };
            return appRequire(name);
        },
        __dirname: root,
        process: { ...process, env: { ...env } },
        console, setInterval, clearInterval, setTimeout, clearTimeout
    }, { filename: path.join(root, 'main.js') });

    const run = (file, args, options = {}) => childProcess.execFileSync(file, args, { env, encoding: 'utf8', ...options });
    const mountDir = (name) => path.join(runtimeDir, 'rclone-mounts', name);

    return {
        dir, home, dataDir, configPath, runtimeDir, env, mountDir,
        invoke: (name, options = {}) => handlers.get(name)(null, { configPathOpt: configPath, ...options }),
        // For handlers whose argument is the data itself (not an options object).
        invokeRaw: (name, data) => handlers.get(name)(null, data),
        readConfig: () => fs.readFileSync(configPath),

        // Mount table, restricted to this app's directory.
        mounts: () => readMounts().filter(m => m.mountPoint.startsWith(dir + path.sep)),
        // PIDs of processes that belong to this temp directory (command line mentions it).
        pidsWhere: (pattern) => listProcesses()
            .filter(p => p.pid !== process.pid && p.cmdline.includes(dir) && pattern.test(p.cmdline)).map(p => p.pid),
        kill9(pid) {
            const p = listProcesses().find(x => x.pid === pid);
            if (!p || !p.cmdline.includes(dir)) throw new Error(`refusing to kill pid ${pid}: not one of this test's processes`);
            process.kill(pid, 'SIGKILL');
        },
        // A long-running process whose working directory is `cwd` (inside the temp dir).
        spawnHolder(cwd) {
            if (!within(dir, cwd)) throw new Error(`refusing to hold ${cwd}`);
            const child = childProcess.spawn('sleep', ['300'], { cwd, env, stdio: 'ignore' });
            tracked.add(child);
            return child;
        },
        // Helper tools run with the isolated environment (e.g. fuse-overlayfs, rclone config encryption).
        run,

        // crontab shim state.
        cron: {
            set: (text) => (text === null ? fs.rmSync(path.join(cronDir, 'table'), { force: true }) : fs.writeFileSync(path.join(cronDir, 'table'), text)),
            read: () => (fs.existsSync(path.join(cronDir, 'table')) ? fs.readFileSync(path.join(cronDir, 'table'), 'utf8') : null),
            mode: (mode) => fs.writeFileSync(path.join(cronDir, 'mode'), mode)
        },
        cleanup
    };
}

module.exports = { createRealApp, fuseUnavailableReason, which, sleep, readMounts, CRON_DENIED_STDERR };
