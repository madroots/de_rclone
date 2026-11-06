const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const os = require('os');
const { AppError } = require('./lib/errors');
const mountinfo = require('./lib/mountinfo');
const { createCrontabClient, isCronLineFor, isCronEntryFor } = require('./lib/crontab');
const { assertPlainConfig, writeConfigAtomic } = require('./lib/configguard');
const { createOperationLocks, busyMessage } = require('./lib/oplock');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        title: "de_rclone",
        icon: path.join(__dirname, 'icon.png'),
        autoHideMenuBar: true, // Hide menu bar (File, Edit, etc.)
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    // Explicitly remove the menu for production feel
    mainWindow.setMenu(null);
    mainWindow.loadFile('renderer/index.html');
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// --- Helper Functions ---

function expandTilde(filePath) {
    if (filePath.startsWith('~')) {
        return path.join(os.homedir(), filePath.slice(1));
    }
    return filePath;
}

function getRcloneConfigPath(customPath) {
    if (customPath) return expandTilde(customPath);
    return path.join(os.homedir(), '.config', 'rclone', 'rclone.conf');
}

// Names created by add_remote_with_plugin during this session. Only these may be
// removed through the rollback path of delete_remote, which skips cron and mount
// cleanup because nothing of ours can exist for a remote that was just created.
const createdThisSession = new Set();

function runRclone(args, options = {}) {
    return execFilePromise('rclone', args, { timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, ...options });
}

function readConfigFile(configPath) {
    try {
        return fs.readFileSync(configPath, 'utf8');
    } catch (e) {
        throw new AppError('CONFIG_UNREADABLE', `Could not read ${configPath}: ${e.message}`);
    }
}

function getMountDir(remoteName) {
    // Existing rclone names may contain spaces; only forbid unsafe path components.
    if (typeof remoteName !== 'string' || !remoteName ||
        /[/\\\0\r\n]/.test(remoteName) || remoteName === '.' || remoteName === '..') {
        throw new Error('Remote name cannot be used as a managed mount path');
    }
    const uid = os.userInfo().uid;
    const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
    return path.join(runtimeDir, 'rclone-mounts', remoteName);
}

// --- IPC Handlers ---

ipcMain.handle('get_remotes', async (event, { configPathOpt }) => {
    const configPath = getRcloneConfigPath(configPathOpt);

    if (!fs.existsSync(configPath)) {
        throw new Error(`rclone.conf not found at ${configPath}`);
    }

    const content = readConfigFile(configPath);
    assertPlainConfig(content);

    const parsed = [];
    let currentSection = null;
    let currentType = null;
    const flush = () => {
        if (currentSection && currentType) parsed.push({ name: currentSection, type: currentType });
    };
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            flush();
            currentSection = trimmed.slice(1, -1);
            currentType = null;
        } else {
            // Exact key match: only `type = ...` sets the remote type
            const eq = trimmed.indexOf('=');
            if (eq > 0 && trimmed.slice(0, eq).trim() === 'type') {
                currentType = trimmed.slice(eq + 1).trim();
            }
        }
    }
    flush();

    // Every probe below is isolated: an unreadable mount table, a dead mount or an
    // unavailable crontab degrades that one column, never the whole list.
    const table = await loadMountTable();
    const cron = await crontab.read();
    const cronKnown = cron.status === 'ok' || cron.status === 'empty';

    return Promise.all(parsed.map(async ({ name, type }) => {
        const st = await getMountState(name, table);
        return {
            name,
            type,
            mounted: MOUNT_LABELS[st.state],
            mount_state: st.state,
            mount_note: st.message || '',
            cron: cronKnown ? (isCronEntryFor(cron.content, name) ? 'Yes' : 'No') : 'Unknown',
            cron_note: cronKnown ? '' : `auto-mount status unavailable: ${cronProblem(cron)}`,
            mount_point: st.mountPoint
        };
    }));
});

// Helper for execFile (no shell — args passed verbatim) to promise. The child
// process is exposed as `.child` so a caller can cancel it.
function execFilePromise(file, args, options = {}) {
    let child;
    const promise = new Promise((resolve, reject) => {
        child = execFile(file, args, options, (error, stdout, stderr) => {
            if (error) {
                reject({ error, stderr, stdout });
                return;
            }
            resolve({ stdout, stderr });
        });
    });
    promise.child = child;
    return promise;
}

// --- Operation locks ---
// Operations that change state take non-blocking locks on what they touch (the
// remote, the config, the crontab). A conflicting request is refused at once with
// code BUSY instead of racing the running one, whichever window or IPC caller
// it comes from.
const locks = createOperationLocks();

function handleLocked(channel, { keys, operation, onBusy = 'result' }, handler) {
    ipcMain.handle(channel, async (event, args) => {
        const outcome = await locks.run(keys(args || {}), operation, () => handler(event, args));
        if (!outcome.busy) return outcome.value;
        const message = busyMessage(outcome);
        if (onBusy === 'throw') throw new AppError('BUSY', message);
        return { success: false, code: 'BUSY', message };
    });
}

// Let in-flight changes finish (bounded) before the app exits, so a quit does not
// cut a mount, unmount or config write in half.
let quitInProgress = false;
app.on('before-quit', async (event) => {
    if (quitInProgress || locks.snapshot().length === 0) return;
    event.preventDefault();
    quitInProgress = true;
    const result = await locks.waitIdle(8000);
    if (!result.idle) {
        console.error('Quitting with operations still running:', result.pending.map(p => `${p.key} (${p.operation})`).join(', '));
    }
    app.quit();
});

// Quote a value for /bin/sh. Cron runs the generated line through a shell.
function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function validateRemoteName(name) {
    if (!name) throw new Error("remote_name is required");
    // Whitelist: prevents INI corruption ([, ], newlines) and broken shell commands
    if (!/^[A-Za-z0-9_.\-]+$/.test(name) || name === '.' || name === '..') {
        throw new Error("remote_name may only contain letters, digits, '_', '-', '.'");
    }
}

// --- Mount State ---
// Mount state comes from the kernel's mount table. It is never inferred from the
// exit codes of helper tools, and never from stat() on a mount that may be dead.

const mountProbe = mountinfo.createMountProbe({ fsPromises: fs.promises });
const MOUNT_LABELS = { mounted: 'Yes', unmounted: 'No', stale: 'Stale', foreign: 'Foreign', unknown: 'Unknown' };

async function loadMountTable() {
    try {
        return { entries: mountinfo.parseMountinfo(await mountinfo.readMountinfo(fs.promises)) };
    } catch (e) {
        return { error: e };
    }
}

// Never throws: anything unexpected is the 'unknown' state of that one remote.
async function getMountState(remoteName, table = null) {
    let mountPoint = '';
    try {
        mountPoint = getMountDir(remoteName);
        const { entries, error } = table || await loadMountTable();
        if (error) {
            return { state: 'unknown', message: `Cannot read the system mount table: ${error.message}`, mountPoint };
        }
        const canonical = mountinfo.canonicalizeMountPoint(mountPoint, fs);
        const result = await mountinfo.classifyMount({ entries, mountPoint: canonical, remoteName, probe: mountProbe });
        return { ...result, mountPoint };
    } catch (e) {
        return { state: 'unknown', message: e.message, mountPoint };
    }
}

// Errors for states in which nothing may be mounted, unmounted or deleted.
function refusalFor(remoteName, st) {
    if (st.state === 'stale') {
        return new AppError('MOUNT_STALE', `${remoteName} has a stale mount: its rclone process is gone. Use Recover first.`);
    }
    if (st.state === 'foreign') {
        return new AppError('MOUNT_FOREIGN', `${st.message}. de_rclone does not touch mounts it did not create.`);
    }
    return new AppError('MOUNT_UNKNOWN', `Cannot determine the mount state of ${remoteName}: ${st.message || 'unknown error'}`);
}

async function releaseMount(mountPoint, lazy) {
    const attempts = [
        ['fusermount3', ['-u', mountPoint]],
        ['fusermount', ['-u', mountPoint]],
        ['umount', [mountPoint]]
    ];
    // A lazy unmount is only used to recover a stale mount, whose rclone process
    // is already gone, so nothing can still be writing through it.
    if (lazy) attempts.push(['fusermount3', ['-uz', mountPoint]], ['fusermount', ['-uz', mountPoint]]);

    let firstFailure = null;
    for (const [tool, args] of attempts) {
        try {
            await execFilePromise(tool, args, { timeout: 15000 });
            return;
        } catch (e) {
            if (e.error?.code === 'ENOENT') continue;
            firstFailure = firstFailure || `${tool}: ${String(e.stderr || e.error?.message || 'failed').trim()}`;
        }
    }
    if (firstFailure === null) {
        throw new AppError('MOUNT_TOOL_MISSING', 'fusermount3, fusermount and umount were not found; install fuse3');
    }
    throw new AppError('MOUNT_BUSY', `Could not unmount ${mountPoint}: ${firstFailure}. Close programs using it and retry.`);
}

// Non-recursive, and only ever called once the path is known not to be a mount.
function removeEmptyMountDir(mountPoint) {
    try {
        fs.rmdirSync(mountPoint);
    } catch (e) {
        if (e.code === 'ENOENT') return;
        throw new AppError('MOUNT_DIR_NOT_EMPTY', `Could not remove managed mount directory '${mountPoint}': ${e.message}; check its contents and permissions, then retry`);
    }
}

async function unmountRemote(remoteName, { recover = false } = {}) {
    const st = await getMountState(remoteName);
    if (recover) {
        if (st.state !== 'stale') {
            throw st.state === 'mounted' || st.state === 'unmounted'
                ? new AppError('MOUNT_NOT_STALE', `${remoteName} does not have a stale mount`)
                : refusalFor(remoteName, st);
        }
    } else if (st.state !== 'mounted' && st.state !== 'unmounted') {
        throw refusalFor(remoteName, st);
    }

    const wasMounted = st.state !== 'unmounted';
    if (wasMounted) {
        await releaseMount(st.mountPoint, recover);
        // A tool that exits 0 proves nothing: confirm against the mount table.
        const after = await getMountState(remoteName);
        if (after.state !== 'unmounted') {
            throw new AppError('MOUNT_BUSY', `Unmount of '${remoteName}' did not release ${st.mountPoint}; close programs using it and retry`);
        }
    }
    removeEmptyMountDir(st.mountPoint);
    return wasMounted;
}

function failureFrom(e, fallbackCode = 'OPERATION_FAILED') {
    return { success: false, code: e.code || fallbackCode, message: e.detail || e.message };
}

handleLocked('mount_remote', { keys: ({ remoteName }) => [`remote:${remoteName}`], operation: 'mounting' }, async (event, { remoteName, configPathOpt }) => {
    const st = await getMountState(remoteName);
    if (st.state === 'mounted') {
        return { success: true, message: `${remoteName} is already mounted at ${st.mountPoint}` };
    }
    if (st.state !== 'unmounted') return failureFrom(refusalFor(remoteName, st));

    const mountPoint = st.mountPoint;
    const createdDir = !fs.existsSync(mountPoint);
    fs.mkdirSync(mountPoint, { recursive: true });

    const configPath = getRcloneConfigPath(configPathOpt);
    // rclone mount remote: /path/to/mount --vfs-cache-mode writes --daemon --config ...
    const args = [
        'mount',
        `${remoteName}:`,
        mountPoint,
        '--vfs-cache-mode', 'writes',
        '--daemon'
    ];
    if (configPathOpt) {
        args.push('--config', configPath);
    }

    const result = await new Promise((resolve) => {
        // --daemon makes rclone fork itself. The parent waits for the mount to be
        // ready (--daemon-wait, 60s) and exits 0, or non-zero with the reason on
        // stderr. That exit status is the authority; the mount table confirms it.
        const child = spawn('rclone', args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });

        let stderrBuf = '';
        child.stderr.on('data', (d) => {
            stderrBuf += d.toString();
            if (stderrBuf.length > 65536) stderrBuf = stderrBuf.slice(-65536);
        });

        let settled = false;
        const finish = (outcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.stderr.destroy(); // release pipe; daemon may hold it open
            resolve(outcome);
        };
        const timer = setTimeout(() => {
            finish({ success: false, code: 'MOUNT_TIMEOUT', message: `rclone did not report the mount ready within 65s. Refresh to see whether ${remoteName} mounted later.` });
        }, 65000);

        child.on('error', (err) => {
            finish({ success: false, code: 'RCLONE_MISSING', message: `Failed to start rclone: ${err.message}` });
        });

        child.on('exit', async (code, signal) => {
            if (code !== 0) {
                const detail = stderrBuf.trim();
                finish({ success: false, code: 'MOUNT_FAILED', message: `rclone mount failed: ${detail || `exit code ${code ?? signal}`}` });
                return;
            }
            const deadline = Date.now() + 5000;
            let now = await getMountState(remoteName);
            while (now.state !== 'mounted' && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 250));
                now = await getMountState(remoteName);
            }
            if (now.state === 'mounted') {
                finish({ success: true, message: `Successfully mounted ${remoteName} at ${mountPoint}` });
            } else {
                finish({ success: false, code: 'MOUNT_NOT_VISIBLE', message: `rclone reported success but ${remoteName} is not mounted (${now.state}${now.message ? `: ${now.message}` : ''})` });
            }
        });

        child.unref();
    });

    if (!result.success && createdDir) {
        // Remove the directory only if we created it and nothing is mounted on it.
        if ((await getMountState(remoteName)).state === 'unmounted') {
            try { fs.rmdirSync(mountPoint); } catch (e) { }
        }
    }
    return result;
});

handleLocked('unmount_remote', { keys: ({ remoteName }) => [`remote:${remoteName}`], operation: 'unmounting' }, async (event, { remoteName }) => {
    try {
        const wasMounted = await unmountRemote(remoteName);
        return { success: wasMounted, message: wasMounted ? `Successfully unmounted ${remoteName}` : `${remoteName} is not mounted.` };
    } catch (e) {
        return failureFrom(e);
    }
});

handleLocked('recover_mount', { keys: ({ remoteName }) => [`remote:${remoteName}`], operation: 'recovering the mount' }, async (event, { remoteName }) => {
    try {
        await unmountRemote(remoteName, { recover: true });
        return { success: true, message: `Recovered the stale mount of ${remoteName}` };
    } catch (e) {
        return failureFrom(e);
    }
});

ipcMain.handle('open_folder', async (event, { path: folderPath }) => {
    const error = await shell.openPath(folderPath);
    if (error) {
        throw new Error(error);
    }
    return { success: true, message: `Opened folder: ${folderPath}` };
});

ipcMain.handle('open_external', async (event, url) => {
    await shell.openExternal(url);
});

// Connection tests in flight, so the dialog's Cancel really stops the rclone process.
const inflightTests = new Map();

ipcMain.handle('test_connection', async (event, { remoteName, configPathOpt, requestId }) => {
    const configPath = getRcloneConfigPath(configPathOpt);
    const args = ['lsf', `${remoteName}:`];
    if (configPathOpt) args.push('--config', configPath);

    const run = execFilePromise('rclone', args, { timeout: 12000, killSignal: 'SIGTERM' });
    const entry = { child: run.child, cancelled: false };
    if (requestId) inflightTests.set(requestId, entry);
    try {
        await run;
        return { success: true, message: `Connection to ${remoteName} successful` };
    } catch (e) {
        if (entry.cancelled) return { success: false, cancelled: true, message: 'Connection test cancelled' };
        const timedOut = e.error?.killed || e.error?.signal === 'SIGTERM';
        const detail = (e.stderr || '').trim();
        return {
            success: false,
            message: timedOut
                ? 'Connection test timed out after 12s'
                : `Connection test failed: ${detail || e.error?.message || 'unknown error'}`
        };
    } finally {
        if (requestId) inflightTests.delete(requestId);
    }
});

ipcMain.handle('cancel_test', async (event, { requestId }) => {
    const entry = inflightTests.get(requestId);
    if (!entry) return { success: false, message: 'No such connection test is running' };
    entry.cancelled = true;
    if (entry.child) entry.child.kill('SIGTERM');
    return { success: true };
});

// Latency check handler
ipcMain.handle('check_latency', async (event, { remoteName, configPathOpt }) => {
    const configPath = getRcloneConfigPath(configPathOpt);
    // Test connection with a timeout. lsf is lightweight.
    // We use a shorter timeout for latency checks (3s)
    const args = ['lsf', `${remoteName}:`, '--max-depth', '1'];
    if (configPathOpt) args.push('--config', configPath);

    const start = Date.now();
    try {
        await execFilePromise('rclone', args, { timeout: 3000, killSignal: 'SIGTERM' });
        return { success: true, latency: Date.now() - start };
    } catch (e) {
        const timedOut = e.error?.killed || e.error?.signal === 'SIGTERM';
        return { success: false, error: timedOut ? 'Timeout' : ((e.stderr || '').trim() || 'Error') };
    }
});

ipcMain.handle('is_rclone_installed', async () => {
    try {
        await execFilePromise('rclone', ['--version']);
        return true;
    } catch {
        return false;
    }
});

ipcMain.handle('get_app_version', () => {
    return app.getVersion();
});

ipcMain.handle('get_available_plugins', async () => {
    // Search for plugins
    const potentialPaths = [
        path.join(__dirname, 'plugins'),
        path.join(process.cwd(), 'plugins'),
        // Add more if needed depending on packaging
    ];

    const plugins = [];

    for (const p of potentialPaths) {
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
            const dirs = fs.readdirSync(p);
            for (const dir of dirs) {
                const configPath = path.join(p, dir, 'config.json');
                if (fs.existsSync(configPath)) {
                    try {
                        const content = fs.readFileSync(configPath, 'utf8');
                        plugins.push(JSON.parse(content));
                    } catch (err) {
                        console.error("Failed to load plugin", configPath, err);
                    }
                }
            }
            if (plugins.length > 0) break; // Use first found dir
        }
    }
    return plugins;
});

// --- Cron Functions ---

function getMountCmdString(remoteName, mountPoint, configPath) {
    // Construct the exact command line used for cron. Values are shell-quoted
    // here because cron runs the line through /bin/sh.
    // We add a retry loop for mkdir because on headless boots without loginctl enable-linger,
    // the XDG_RUNTIME_DIR might not be created immediately by systemd.
    const remote = shellQuote(`${remoteName}:`);
    const mount = shellQuote(mountPoint);
    let cmd = `for i in $(seq 1 30); do mkdir -p ${mount} 2>/dev/null && break; sleep 2; done; rclone mount ${remote} ${mount} --vfs-cache-mode writes --daemon`;
    if (configPath) {
        cmd += ` --config ${shellQuote(configPath)}`;
    }
    return cmd;
}

const crontab = createCrontabClient({ execFile });

function cronProblem(state) {
    if (state.status === 'unavailable') {
        if (state.reason === 'denied') return 'crontab access denied (see cron.allow / cron.deny)';
        if (state.reason === 'not-installed') return 'crontab is not installed';
    }
    return state.message || 'crontab could not be read';
}

// The state that made an edit unavailable: the first read, or the re-read when
// the crontab became unavailable in the middle of the edit.
function unavailableState(outcome) {
    return outcome.before && outcome.before.status === 'unavailable'
        ? outcome.before
        : { status: 'unavailable', reason: null, message: outcome.message };
}

function cronUnavailableWarning(state) {
    return `crontab is unavailable (${cronProblem(state)}); any existing auto-mount entries must be removed manually.`;
}

// Typed error for a crontab edit that did not complete.
function cronEditError(outcome, action) {
    switch (outcome.outcome) {
        case 'unavailable':
            return new AppError('CRON_UNAVAILABLE', `Cannot ${action}: ${cronProblem(unavailableState(outcome))}`);
        case 'conflict':
            return new AppError('CRON_CONFLICT', 'The crontab changed while it was being edited; no changes were made. Retry.');
        case 'write-failed':
            return new AppError('CRON_WRITE_FAILED', `Cannot ${action}: ${outcome.message}`);
        default:
            return new AppError('CRON_ERROR', `Cannot ${action}: ${outcome.message}`);
    }
}

function withoutCronEntries(remoteName) {
    return (content) => {
        if (!isCronEntryFor(content, remoteName)) return null;
        return content.split('\n').filter(line => !isCronLineFor(line, remoteName)).join('\n');
    };
}

handleLocked('add_to_cron', { keys: ({ remoteName }) => ['crontab', `remote:${remoteName}`], operation: 'changing auto-mount' }, async (event, { remoteName, configPathOpt }) => {
    try {
        if (/[\r\n]/.test(String(remoteName))) {
            throw new AppError('INVALID_NAME', 'Remote name contains unsupported characters');
        }
        const mountPoint = getMountDir(remoteName);
        const configPath = getRcloneConfigPath(configPathOpt);
        const cmd = getMountCmdString(remoteName, mountPoint, configPath);
        const cronEntry = `@reboot ${cmd} # Added by de_rclone: ${remoteName}`;

        // Append the new line verbatim; passing the entry through a shell would
        // expand $(seq ...) and strip its quotes.
        const outcome = await crontab.edit(content =>
            isCronEntryFor(content, remoteName)
                ? null
                : content + (content && !content.endsWith('\n') ? '\n' : '') + cronEntry + '\n');

        if (outcome.outcome === 'unchanged') {
            return { success: true, message: `${remoteName} is already enabled for auto-mount.` };
        }
        if (outcome.outcome !== 'written') throw cronEditError(outcome, 'enable auto-mount');
        if (!isCronEntryFor(outcome.after.content, remoteName)) {
            throw new AppError('CRON_VERIFY_FAILED', 'crontab accepted the change but the entry is not present when read back');
        }
        return { success: true, message: `Enabled auto-mount for ${remoteName}.` };
    } catch (e) {
        return failureFrom(e);
    }
});

handleLocked('remove_from_cron', { keys: ({ remoteName }) => ['crontab', `remote:${remoteName}`], operation: 'changing auto-mount' }, async (event, { remoteName, configPathOpt }) => {
    try {
        const outcome = await crontab.edit(withoutCronEntries(remoteName));
        if (outcome.outcome === 'unavailable') {
            return { success: true, warning: true, message: cronUnavailableWarning(unavailableState(outcome)) };
        }
        if (outcome.outcome === 'unchanged') {
            return { success: true, message: `${remoteName} is not enabled for auto-mount.` };
        }
        if (outcome.outcome !== 'written') throw cronEditError(outcome, 'disable auto-mount');
        if (isCronEntryFor(outcome.after.content, remoteName)) {
            throw new AppError('CRON_VERIFY_FAILED', 'crontab accepted the change but the entry is still present when read back');
        }
        return { success: true, message: `Disabled auto-mount for ${remoteName}.` };
    } catch (e) {
        return failureFrom(e);
    }
});




// --- Plugin & Config Functions ---

function loadPluginData(pluginName) {
    const potentialPaths = [
        path.join(__dirname, 'plugins'),
        path.join(process.cwd(), 'plugins'),
    ];
    for (const p of potentialPaths) {
        const pluginDir = path.join(p, pluginName);
        if (fs.existsSync(pluginDir)) {
            const pluginConfigPath = path.join(pluginDir, 'config.json');
            return JSON.parse(fs.readFileSync(pluginConfigPath, 'utf8'));
        }
    }
    throw new Error(`Plugin ${pluginName} not found`);
}

function getPluginFields(pluginData) {
    return [...(pluginData.basic_fields || []), ...(pluginData.advanced_fields || [])];
}

function getSecretFieldNames(pluginData) {
    return new Set(
        getPluginFields(pluginData)
            .filter(field => field.obscure === true || field.name === 'pass')
            .map(field => field.name)
    );
}

// Older versions wrote the literal string "undefined" into rclone.conf when an
// optional field was left blank. Treat it as unset so edits clean it up.
function isUnsetValue(value) {
    return value === undefined || value === null ||
        String(value).trim() === '' || String(value).trim() === 'undefined';
}

function assertNoNewlines(config) {
    for (const key of Object.keys(config)) {
        if (key === 'remote_name') continue;
        const value = config[key];
        if (value !== undefined && value !== null && /[\r\n]/.test(String(value))) {
            throw new Error(`Field '${key}' must not contain newlines`);
        }
    }
}

async function obscureSecretValues(processedConfig, secretNames) {
    for (const key of Object.keys(processedConfig)) {
        const value = processedConfig[key];
        if (!secretNames.has(key) || isUnsetValue(value)) continue;
        try {
            // execFile: no shell, so passwords with $, `, ", \ etc. reach rclone verbatim
            const { stdout } = await execFilePromise('rclone', ['obscure', String(value)]);
            processedConfig[key] = stdout.trim();
        } catch (e) {
            throw new Error(`Failed to obscure ${key}: ${e.stderr || e.error?.message || e.message}`);
        }
    }
}

function getConfigSections(content) {
    const lines = content.split('\n');
    const sections = [];
    lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            sections.push({ name: trimmed.slice(1, -1), start: index, end: lines.length });
        }
    });
    sections.forEach((section, i) => {
        if (i + 1 < sections.length) section.end = sections[i + 1].start;
    });
    return sections;
}

handleLocked('add_remote_with_plugin', { keys: ({ config }) => ['config', `remote:${config && config.remote_name}`], operation: 'adding a remote', onBusy: 'throw' }, async (event, { pluginName, config, configPathOpt }) => {
    const pluginData = loadPluginData(pluginName);
    const allFields = getPluginFields(pluginData);
    const secretNames = getSecretFieldNames(pluginData);

    for (const field of allFields) {
        if (field.required && isUnsetValue(config[field.name])) {
            throw new Error(`Required field '${field.name}' is missing`);
        }
    }
    assertNoNewlines(config);

    const configPath = getRcloneConfigPath(configPathOpt);
    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

    const original = fs.existsSync(configPath) ? readConfigFile(configPath) : null;
    assertPlainConfig(original ?? '');
    const currentConfigContent = original ?? '';

    const processedConfig = { ...config };
    await obscureSecretValues(processedConfig, secretNames);

    const remoteName = processedConfig.remote_name;
    validateRemoteName(remoteName);

    // Reject duplicates: appending a second [name] section silently corrupts
    // the remote definition (keys merge/override depending on parser).
    if (getConfigSections(currentConfigContent).some(section => section.name === remoteName)) {
        throw new Error(`Remote '${remoteName}' already exists in the config`);
    }

    let newBlock = `\n[${remoteName}]\ntype = ${pluginName}\n`;
    for (const key in processedConfig) {
        if (key === 'remote_name') continue;
        const value = processedConfig[key];
        // Skip empty optional fields instead of writing bare `key = ` lines
        if (isUnsetValue(value)) continue;
        newBlock += `${key} = ${value}\n`;
    }

    await writeConfigAtomic({
        configPath,
        original,
        content: currentConfigContent + newBlock,
        changedNames: [remoteName],
        expect: { present: [remoteName] },
        runRclone,
        fsImpl: fs
    });
    createdThisSession.add(remoteName);

    return { success: true, message: `Successfully added remote '${remoteName}'` };
});

handleLocked('update_remote_with_plugin', { keys: ({ remoteName, config }) => ['config', `remote:${remoteName}`, `remote:${(config && config.remote_name) || remoteName}`], operation: 'editing', onBusy: 'throw' }, async (event, { remoteName, pluginName, config, configPathOpt }) => {
    const pluginData = loadPluginData(pluginName);
    const allFields = getPluginFields(pluginData);
    const secretNames = getSecretFieldNames(pluginData);

    const configPath = getRcloneConfigPath(configPathOpt);
    if (!fs.existsSync(configPath)) throw new Error(`rclone.conf not found at ${configPath}`);

    const content = readConfigFile(configPath);
    assertPlainConfig(content);
    const lines = content.split('\n');
    const sections = getConfigSections(content);
    const target = sections.find(section => section.name === remoteName);
    if (!target) throw new Error(`Remote '${remoteName}' not found in the config`);

    // Preserve every existing key, including ones the form does not render
    // (token, shell_type, md5sum_command, ...), in their original order.
    const merged = {};
    const order = [];
    for (let i = target.start + 1; i < target.end; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (value === 'undefined') continue;
        if (!(key in merged)) order.push(key);
        merged[key] = value;
    }

    const newName = String(config.remote_name || remoteName).trim();
    if (!newName) throw new Error('remote_name is required');
    if (newName !== remoteName) {
        validateRemoteName(newName);
        if (sections.some(section => section.name === newName)) {
            throw new Error(`Remote '${newName}' already exists in the config`);
        }
    }
    assertNoNewlines(config);

    const incoming = { ...config };
    delete incoming.remote_name;
    for (const key of Object.keys(incoming)) {
        const value = incoming[key];
        if (isUnsetValue(value)) {
            // Empty secret fields mean "keep the stored value"; empty plain fields mean "clear it".
            if (!secretNames.has(key)) delete merged[key];
            continue;
        }
        merged[key] = String(value);
    }
    merged.type = pluginName;

    // Drop keys that older plugin versions wrote under the wrong name.
    for (const field of allFields) {
        for (const legacyName of field.legacy_names || []) {
            delete merged[legacyName];
        }
    }

    // Only newly entered secrets are plaintext; the renderer omits unchanged ones.
    for (const key of Object.keys(incoming)) {
        const value = incoming[key];
        if (!secretNames.has(key) || isUnsetValue(value)) continue;
        try {
            const { stdout } = await execFilePromise('rclone', ['obscure', String(value)]);
            merged[key] = stdout.trim();
        } catch (e) {
            throw new Error(`Failed to obscure ${key}: ${e.stderr || e.error?.message || e.message}`);
        }
    }

    for (const field of allFields) {
        if (field.required && isUnsetValue(merged[field.name])) {
            throw new Error(`Required field '${field.name}' is missing`);
        }
    }

    const keys = [];
    for (const key of ['type', ...order]) {
        if (key in merged && !keys.includes(key)) keys.push(key);
    }
    for (const key of Object.keys(merged)) {
        if (!keys.includes(key)) keys.push(key);
    }

    const before = lines.slice(0, target.start);
    const after = lines.slice(target.end);
    while (before.length && before[before.length - 1].trim() === '') before.pop();
    while (after.length && after[0].trim() === '') after.shift();

    const block = [`[${newName}]`, ...keys.map(key => `${key} = ${merged[key]}`)];
    const newContent = [...before, ...block, ...(after.length ? ['', ...after] : [])].join('\n') + '\n';
    await writeConfigAtomic({
        configPath,
        original: content,
        content: newContent,
        changedNames: [remoteName, newName],
        expect: { present: [newName], absent: newName !== remoteName ? [remoteName] : [] },
        runRclone,
        fsImpl: fs
    });
    if (newName !== remoteName && createdThisSession.delete(remoteName)) createdThisSession.add(newName);

    return { success: true, message: `Remote '${newName}' updated successfully` };
});

handleLocked('delete_remote', { keys: ({ remoteName }) => ['config', 'crontab', `remote:${remoteName}`], operation: 'deleting' }, async (event, { remoteName, configPathOpt, rollback = false }) => {
    const configPath = getRcloneConfigPath(configPathOpt);
    if (!fs.existsSync(configPath)) {
        return { success: false, code: 'CONFIG_MISSING', message: 'Config file not found' };
    }

    try {
        if (rollback && !createdThisSession.has(remoteName)) {
            throw new AppError('ROLLBACK_NOT_ALLOWED', `'${remoteName}' was not created in this session, so it is not removed automatically`);
        }
        const content = readConfigFile(configPath);
        assertPlainConfig(content);
        getMountDir(remoteName);
        if (!getConfigSections(content).some(section => section.name === remoteName)) {
            throw new Error(`Remote '${remoteName}' not found in the config`);
        }

        // Pre-flight: check every precondition before changing anything, so a
        // failure leaves the mount, the crontab and the config untouched.
        const st = await getMountState(remoteName);
        if (rollback) {
            if (st.state !== 'unmounted') {
                throw new AppError('ROLLBACK_NOT_ALLOWED', `'${remoteName}' is not unmounted (${st.state}), so it is not removed automatically`);
            }
        } else {
            if (st.state !== 'mounted' && st.state !== 'unmounted') throw refusalFor(remoteName, st);
            const cronNow = await crontab.read();
            if (cronNow.status === 'error') throw new AppError('CRON_ERROR', cronNow.message);
        }

        let warning = '';
        if (!rollback) {
            await unmountRemote(remoteName);
            const outcome = await crontab.edit(withoutCronEntries(remoteName));
            if (outcome.outcome === 'unavailable') {
                warning = cronUnavailableWarning(unavailableState(outcome));
            } else if (outcome.outcome === 'written') {
                if (isCronEntryFor(outcome.after.content, remoteName)) {
                    throw new AppError('CRON_VERIFY_FAILED', 'crontab accepted the change but the entry is still present when read back');
                }
            } else if (outcome.outcome !== 'unchanged') {
                throw cronEditError(outcome, 'remove the auto-mount entry');
            }
        }

        const lines = content.split('\n');
        const newLines = [];
        let deleting = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                deleting = trimmed.slice(1, -1) === remoteName;
            }
            if (!deleting) {
                newLines.push(line);
            }
        }

        await writeConfigAtomic({
            configPath,
            original: content,
            content: newLines.join('\n'),
            changedNames: [remoteName],
            expect: { absent: [remoteName] },
            runRclone,
            fsImpl: fs
        });
        createdThisSession.delete(remoteName);
        return { success: true, message: `Deleted remote ${remoteName}${warning ? `. Warning: ${warning}` : ''}` };
    } catch (e) {
        return { success: false, code: e.code || 'DELETE_FAILED', message: `Failed to delete remote: ${e.detail || e.message}` };
    }
});

ipcMain.handle('open_file_dialog', async () => {
    const { filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Config Files', extensions: ['conf'] }]
    });
    return filePaths.length > 0 ? filePaths[0] : null;
});

ipcMain.handle('select_file', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        title: 'Select File'
    });
    return canceled || filePaths.length === 0 ? null : filePaths[0];
});

ipcMain.handle('get_remote_config', async (event, { remoteName, configPathOpt }) => {
    const configPath = getRcloneConfigPath(configPathOpt);
    if (!fs.existsSync(configPath)) throw new Error(`rclone.conf not found`);

    const content = readConfigFile(configPath);
    assertPlainConfig(content);
    const lines = content.split('\n');
    let inSection = false;
    const result = {};

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            const section = trimmed.slice(1, -1);
            if (inSection && section !== remoteName) break;
            inSection = section === remoteName;
        } else if (inSection) {
            const parts = trimmed.split('=');
            if (parts.length > 1) {
                const key = parts[0].trim();
                const value = parts.slice(1).join('=').trim();
                if (value === 'undefined') continue;
                result[key] = value;
            }
        }
    }
    return result;
});

// --- Legacy Mount and Cron Handlers ---
// Old versions mounted under ~/mnt and did not always write the marker comment,
// so identify legacy entries by the old mount path instead of the marker.
function getLegacyDir() {
    return path.join(os.homedir(), 'mnt');
}

function isLegacyCronLine(line) {
    if (/^\s*#/.test(line)) return false; // a comment is never an entry
    const legacyDir = getLegacyDir();
    return line.includes('rclone mount') && (
        line.includes(legacyDir + path.sep) ||
        line.includes('~/mnt/') ||
        line.includes('$HOME/mnt/')
    );
}

// Legacy mounts are rclone FUSE mounts directly under ~/mnt, taken from the mount
// table. Other mounts the user keeps there (sshfs, NFS, ...) are never listed.
function legacyRcloneMounts(entries) {
    const dirs = new Set([getLegacyDir()]);
    try { dirs.add(fs.realpathSync(getLegacyDir())); } catch (e) { }
    return [...dirs]
        .flatMap(dir => mountinfo.mountsDirectlyUnder(entries, dir))
        .filter(entry => entry.fsType === 'fuse.rclone');
}

ipcMain.handle('check_legacy_state', async () => {
    // Mounts and crontab are checked independently: one failing never hides the other.
    let mounts = [];
    let mountDetails = [];
    let mountsError = '';
    const table = await loadMountTable();
    if (table.error) {
        mountsError = table.error.message;
    } else {
        const found = legacyRcloneMounts(table.entries);
        mounts = found.map(entry => entry.mountPoint);
        mountDetails = found.map(entry => ({ path: entry.mountPoint, source: entry.source }));
    }

    let legacyCrons = [];
    let cronNote = '';
    const cron = await crontab.read();
    if (cron.status === 'ok') {
        legacyCrons = cron.content.split('\n').filter(isLegacyCronLine);
    } else if (cron.status !== 'empty') {
        cronNote = cronProblem(cron);
    }

    return { mounts, mountDetails, legacyCrons, mountsError, cronNote };
});

// Removes only the exact lines the user ticked in the dialog, and only if they are
// still legacy entries. Nothing is removed that was not individually selected.
handleLocked('remove_legacy_crons', { keys: () => ['crontab'], operation: 'cleaning up legacy entries' }, async (event, lines) => {
    if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string')) {
        return { success: false, count: 0, error: 'expected the list of selected cron lines' };
    }
    if (lines.length === 0) return { success: true, count: 0 };

    let removed = 0;
    const outcome = await crontab.edit(content => {
        const pending = [...lines];
        const kept = [];
        removed = 0;
        for (const line of content.split('\n')) {
            const at = pending.indexOf(line);
            if (at !== -1 && isLegacyCronLine(line)) {
                pending.splice(at, 1);
                removed++;
            } else {
                kept.push(line);
            }
        }
        return removed === 0 ? null : kept.join('\n');
    });
    if (outcome.outcome === 'unchanged') {
        return { success: false, count: 0, error: 'the selected entries are no longer in the crontab' };
    }
    if (outcome.outcome === 'unavailable') {
        return { success: false, count: 0, error: cronUnavailableWarning(unavailableState(outcome)) };
    }
    if (outcome.outcome === 'written') {
        return { success: removed === lines.length, count: removed, ...(removed === lines.length ? {} : { error: `${lines.length - removed} selected entries were no longer in the crontab` }) };
    }
    return { success: false, count: 0, error: cronEditError(outcome, 'remove legacy auto-mount entries').detail };
});

handleLocked('unmount_legacy_mounts', { keys: () => ['legacy-mounts'], operation: 'cleaning up legacy mounts' }, async (event, paths) => {
    if (!Array.isArray(paths)) {
        return { success: false, count: 0, results: [], error: 'expected a list of mount paths' };
    }
    const table = await loadMountTable();
    if (table.error) return { success: false, count: 0, results: [], error: table.error.message };

    // Only paths that the mount table currently reports as legacy rclone mounts.
    const allowed = new Set(legacyRcloneMounts(table.entries).map(entry => entry.mountPoint));
    const results = [];
    for (const mountPoint of paths) {
        if (!allowed.has(mountPoint)) {
            results.push({ path: mountPoint, ok: false, error: 'not a legacy rclone mount; left untouched' });
            continue;
        }
        try {
            await releaseMount(mountPoint, false);
            const after = await loadMountTable();
            if (after.error || legacyRcloneMounts(after.entries).some(entry => entry.mountPoint === mountPoint)) {
                throw new Error('the mount was not released; close programs using it and retry');
            }
            try { fs.rmdirSync(mountPoint); } catch (e) { }
            results.push({ path: mountPoint, ok: true });
        } catch (e) {
            results.push({ path: mountPoint, ok: false, error: e.detail || e.message });
        }
    }
    const count = results.filter(r => r.ok).length;
    return { success: count === paths.length, count, results };
});
