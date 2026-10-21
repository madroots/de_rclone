const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const os = require('os');

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

function getMountDir(remoteName) {
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

    try {
        const content = fs.readFileSync(configPath, 'utf8');
        const remotes = [];
        let currentSection = null;
        let currentType = null;

        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                // Save previous remote
                if (currentSection && currentType) {
                    const mountPoint = getMountDir(currentSection);
                    // Use robust check
                    const mounted = await isMounted(mountPoint);

                    remotes.push({
                        name: currentSection,
                        type: currentType,
                        mounted: mounted ? "Yes" : "No",
                        cron: "No", // Configured later
                        mount_point: mountPoint
                    });
                }
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

        // Add last one
        if (currentSection && currentType) {
            const mountPoint = getMountDir(currentSection);
            const mounted = await isMounted(mountPoint);
            remotes.push({
                name: currentSection,
                type: currentType,
                mounted: mounted ? "Yes" : "No",
                cron: "No",
                mount_point: mountPoint
            });
        }

        // Populate cron status
        try {
            const { stdout } = await execFilePromise('crontab', ['-l']);
            remotes.forEach(r => {
                // Relaxed check: rclone mount ... remoteName: ...
                // We check if the line contains "rclone mount" and "remoteName:"
                // This covers manual entries with different flags or quoting
                const lines = stdout.split('\n');
                const isCron = lines.some(line => {
                    return line.includes('rclone mount') && line.includes(`${r.name}:`);
                });

                if (isCron) {
                    r.cron = "Yes";
                }
            });
        } catch (e) {
            // Crontab might be empty or fail
        }

        return remotes;

    } catch (e) {
        throw new Error(`Failed to read config: ${e.message}`);
    }
});

// Helper for execFile (no shell — args passed verbatim) to promise
function execFilePromise(file, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(file, args, options, (error, stdout, stderr) => {
            if (error) {
                reject({ error, stderr, stdout });
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

// Quote a value for /bin/sh. Cron runs the generated line through a shell.
function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function validateRemoteName(name) {
    if (!name) throw new Error("remote_name is required");
    // Whitelist: prevents INI corruption ([, ], newlines) and broken shell commands
    if (!/^[A-Za-z0-9_.\-]+$/.test(name)) {
        throw new Error("remote_name may only contain letters, digits, '_', '-', '.'");
    }
}

function isMounted(mountPoint) {
    return new Promise(resolve => {
        execFile('mountpoint', ['-q', mountPoint], (err) => {
            resolve(!err); // exit 0 means it is a mountpoint
        });
    });
}

ipcMain.handle('mount_remote', async (event, { remoteName, configPathOpt }) => {
    const mountPoint = getMountDir(remoteName);

    // Check if mounted
    if (await isMounted(mountPoint)) {
        return { success: true, message: `${remoteName} is already mounted at ${mountPoint}` };
    }

    if (!fs.existsSync(mountPoint)) {
        fs.mkdirSync(mountPoint, { recursive: true });
    }

    const configPath = getRcloneConfigPath(configPathOpt);

    // Construct command
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

    return new Promise((resolve) => {
        // --daemon makes rclone fork itself; parent exits 0 once the mount is ready,
        // non-zero on failure. We pipe stderr so real errors reach the user.
        const child = spawn('rclone', args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });

        let stderrBuf = '';
        child.stderr.on('data', (d) => {
            stderrBuf += d.toString();
            if (stderrBuf.length > 65536) stderrBuf = stderrBuf.slice(-65536);
        });

        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearInterval(poll);
            child.stderr.destroy(); // release pipe; daemon may hold it open
            resolve(result);
        };

        child.on('error', (err) => {
            finish({ success: false, message: `Failed to start rclone: ${err.message}` });
        });

        child.on('exit', (code) => {
            if (code !== 0 && code !== null) {
                const detail = stderrBuf.trim();
                finish({ success: false, message: `rclone mount failed: ${detail || `exit code ${code}`}` });
            }
            // exit code 0: daemon reported ready; the poll below confirms the mountpoint
        });

        child.unref();

        // Poll for the mountpoint: slow remotes (sftp handshake, webdav token
        // refresh) can take several seconds to become ready.
        const deadline = Date.now() + 8000;
        const poll = setInterval(async () => {
            if (await isMounted(mountPoint)) {
                finish({ success: true, message: `Successfully mounted ${remoteName} at ${mountPoint}` });
            } else if (Date.now() > deadline) {
                const detail = stderrBuf.trim();
                finish({ success: false, message: `Mount not detected within 8s.${detail ? ` rclone: ${detail}` : ''}` });
            }
        }, 250);
    });
});

ipcMain.handle('unmount_remote', async (event, { remoteName }) => {
    const mountPoint = getMountDir(remoteName);

    if (!(await isMounted(mountPoint))) {
        // Try cleanup if directory exists but not mounted (stale state)
        if (fs.existsSync(mountPoint)) {
            try { fs.rmdirSync(mountPoint); } catch (e) { }
        }
        return { success: false, message: `${remoteName} is not mounted.` };
    }

    try {
        await execFilePromise('fusermount', ['-u', mountPoint]);
        // Clean up point
        try { if (fs.existsSync(mountPoint)) fs.rmdirSync(mountPoint); } catch (e) { }
        return { success: true, message: `Successfully unmounted ${remoteName}` };
    } catch (e) {
        // Fallback to umount
        try {
            await execFilePromise('umount', [mountPoint]);
            // Clean up point
            try { if (fs.existsSync(mountPoint)) fs.rmdirSync(mountPoint); } catch (e2) { }
            return { success: true, message: `Successfully unmounted ${remoteName}` };
        } catch (e2) {
            return { success: false, message: `Unmount failed: ${e.stderr || e.error?.message || e2.stderr || 'unknown error'}` };
        }
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

ipcMain.handle('test_connection', async (event, { remoteName, configPathOpt }) => {
    const configPath = getRcloneConfigPath(configPathOpt);
    const args = ['lsf', `${remoteName}:`];
    if (configPathOpt) args.push('--config', configPath);

    try {
        await execFilePromise('rclone', args, { timeout: 12000, killSignal: 'SIGTERM' });
        return { success: true, message: `Connection to ${remoteName} successful` };
    } catch (e) {
        const timedOut = e.error?.killed || e.error?.signal === 'SIGTERM';
        const detail = (e.stderr || '').trim();
        return {
            success: false,
            message: timedOut
                ? 'Connection test timed out after 12s'
                : `Connection test failed: ${detail || e.error?.message || 'unknown error'}`
        };
    }
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

function isCronEntryFor(content, remoteName) {
    return String(content || '').split('\n').some(line =>
        line.includes('rclone mount') && line.includes(`${remoteName}:`)
    );
}

function writeCrontab(content) {
    const tempFile = path.join(os.tmpdir(), `de_rclone_cron_${process.pid}_${Date.now()}`);
    fs.writeFileSync(tempFile, content);
    return execFilePromise('crontab', [tempFile])
        .finally(() => { try { fs.unlinkSync(tempFile); } catch (e) { } });
}

ipcMain.handle('add_to_cron', async (event, { remoteName, configPathOpt }) => {
    try {
        if (/[\r\n]/.test(String(remoteName))) {
            throw new Error('Remote name contains unsupported characters');
        }
        const mountPoint = getMountDir(remoteName);
        const configPath = getRcloneConfigPath(configPathOpt);
        const cmd = getMountCmdString(remoteName, mountPoint, configPath);
        const cronEntry = `@reboot ${cmd} # Added by de_rclone: ${remoteName}`;

        // Read the existing crontab and append the new line verbatim. Passing the
        // entry through a shell would expand $(seq ...) and strip its quotes.
        const list = await execFilePromise('crontab', ['-l']).catch(() => ({ stdout: '' }));
        const existing = (list.stdout || '').replace(/\n+$/, '');
        if (isCronEntryFor(existing, remoteName)) {
            return { success: true, message: `${remoteName} is already enabled for auto-mount.` };
        }

        const content = (existing ? existing + '\n' : '') + cronEntry + '\n';
        await writeCrontab(content);
        return { success: true, message: `Enabled auto-mount for ${remoteName}.` };
    } catch (e) {
        return { success: false, message: `Failed to enable auto-mount: ${e.stderr || e.error?.message || e.message}` };
    }
});

ipcMain.handle('remove_from_cron', async (event, { remoteName, configPathOpt }) => {
    try {
        const list = await execFilePromise('crontab', ['-l']).catch(() => ({ stdout: '' }));
        const content = list.stdout || '';
        if (!isCronEntryFor(content, remoteName)) {
            return { success: true, message: `${remoteName} is not enabled for auto-mount.` };
        }

        const lines = content.replace(/\n$/, '').split('\n');
        const newLines = lines.filter(line => !(line.includes('rclone mount') && line.includes(`${remoteName}:`)));
        await writeCrontab(newLines.join('\n') + (newLines.length > 0 ? '\n' : ''));
        return { success: true, message: `Disabled auto-mount for ${remoteName}.` };
    } catch (e) {
        return { success: false, message: `Failed to disable auto-mount: ${e.stderr || e.error?.message || e.message}` };
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

ipcMain.handle('add_remote_with_plugin', async (event, { pluginName, config, configPathOpt }) => {
    const pluginData = loadPluginData(pluginName);
    const allFields = getPluginFields(pluginData);
    const secretNames = getSecretFieldNames(pluginData);

    for (const field of allFields) {
        if (field.required && isUnsetValue(config[field.name])) {
            throw new Error(`Required field '${field.name}' is missing`);
        }
    }
    assertNoNewlines(config);

    const processedConfig = { ...config };
    await obscureSecretValues(processedConfig, secretNames);

    const configPath = getRcloneConfigPath(configPathOpt);
    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

    const currentConfigContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : "";
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

    fs.writeFileSync(configPath, currentConfigContent + newBlock);

    return { success: true, message: `Successfully added remote '${remoteName}'` };
});

ipcMain.handle('update_remote_with_plugin', async (event, { remoteName, pluginName, config, configPathOpt }) => {
    const pluginData = loadPluginData(pluginName);
    const allFields = getPluginFields(pluginData);
    const secretNames = getSecretFieldNames(pluginData);

    const configPath = getRcloneConfigPath(configPathOpt);
    if (!fs.existsSync(configPath)) throw new Error(`rclone.conf not found at ${configPath}`);

    const content = fs.readFileSync(configPath, 'utf8');
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
    fs.writeFileSync(configPath, newContent);

    return { success: true, message: `Remote '${newName}' updated successfully` };
});

ipcMain.handle('delete_remote', async (event, { remoteName, configPathOpt }) => {
    const configPath = getRcloneConfigPath(configPathOpt);
    if (!fs.existsSync(configPath)) {
        return { success: false, message: 'Config file not found' };
    }

    try {
        const content = fs.readFileSync(configPath, 'utf8');
        const lines = content.split('\n');
        const newLines = [];
        let deleting = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                const section = trimmed.slice(1, -1);
                if (section === remoteName) {
                    deleting = true;
                } else {
                    deleting = false;
                }
            }

            if (!deleting) {
                newLines.push(line);
            }
        }

        fs.writeFileSync(configPath, newLines.join('\n'));
        return { success: true, message: `Deleted remote ${remoteName}` };
    } catch (e) {
        return { success: false, message: `Failed to delete remote: ${e.message}` };
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

    const content = fs.readFileSync(configPath, 'utf8');
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
    const legacyDir = getLegacyDir();
    return line.includes('rclone mount') && (
        line.includes(legacyDir + path.sep) ||
        line.includes('~/mnt/') ||
        line.includes('$HOME/mnt/')
    );
}

ipcMain.handle('check_legacy_state', async () => {
    const legacyDir = getLegacyDir();
    const mounts = [];
    if (fs.existsSync(legacyDir)) {
        try {
            const dirs = fs.readdirSync(legacyDir);
            for (const dir of dirs) {
                const fullPath = path.join(legacyDir, dir);
                if (fs.statSync(fullPath).isDirectory()) {
                    if (await isMounted(fullPath)) {
                        mounts.push(fullPath);
                    }
                }
            }
        } catch (e) {
            console.error('Error checking legacy mounts:', e);
        }
    }

    let legacyCrons = [];
    try {
        const list = await execFilePromise('crontab', ['-l']).catch(() => ({ stdout: '' }));
        if (list.stdout) {
            legacyCrons = list.stdout.split('\n').filter(isLegacyCronLine);
        }
    } catch (e) {}

    return { mounts, legacyCrons };
});

ipcMain.handle('remove_legacy_crons', async () => {
    try {
        const list = await execFilePromise('crontab', ['-l']).catch(() => ({ stdout: '' }));
        if (!list.stdout) return { success: true, count: 0 };

        const lines = list.stdout.split('\n');
        const kept = lines.filter(line => !isLegacyCronLine(line));
        const removed = lines.length - kept.length;

        if (removed === 0) return { success: true, count: 0 };

        await writeCrontab(kept.join('\n').replace(/\n+$/, '') + '\n');
        return { success: true, count: removed };
    } catch (e) {
        return { success: false, error: e.stderr || e.error?.message || e.message };
    }
});

ipcMain.handle('unmount_legacy_mounts', async (event, paths) => {
    const legacyDir = getLegacyDir();
    // Only allow paths inside the legacy mount directory.
    const targets = paths
        .map(mountPoint => path.resolve(mountPoint))
        .filter(resolved => resolved.startsWith(legacyDir + path.sep));
    let successCount = 0;
    for (const resolved of targets) {
        try {
            await execFilePromise('fusermount', ['-u', resolved]);
            try { if (fs.existsSync(resolved)) fs.rmdirSync(resolved); } catch (e) { }
            successCount++;
        } catch (e) {
            try {
                await execFilePromise('umount', [resolved]);
                try { if (fs.existsSync(resolved)) fs.rmdirSync(resolved); } catch (e2) { }
                successCount++;
            } catch (e2) {
                console.error(`Legacy unmount failed for ${resolved}: ${e2.stderr || e2.message}`);
            }
        }
    }
    return { success: successCount === targets.length, count: successCount };
});
