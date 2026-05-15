const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
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
            } else if (trimmed.startsWith('type')) {
                const parts = trimmed.split('=');
                if (parts.length > 1) {
                    currentType = parts[1].trim();
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
            const { stdout } = await execPromise('crontab -l');
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

// Helper for exec to promise
function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject({ error, stderr });
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

function isMounted(mountPoint) {
    return new Promise(resolve => {
        exec(`mountpoint -q "${mountPoint}"`, (err) => {
            if (err) resolve(false); // standard way to check mountpoint in linux
            else resolve(true);
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

    return new Promise((resolve, reject) => {
        // Using spawn specifically for rclone to detach? 
        // Actually, normal exec with --daemon should work, but spawn is safer for long running
        // However, --daemon flag makes rclone fork itself.

        const child = spawn('rclone', args, { stdio: 'ignore', detached: true });

        child.on('error', (err) => {
            return resolve({ success: false, message: `Failed to start rclone: ${err.message}` });
        });

        child.unref();

        // We wait a bit to see if it mounts? Or just assume success if it triggered?
        // rclone --daemon returns quickly.

        setTimeout(async () => {
            if (await isMounted(mountPoint)) {
                resolve({ success: true, message: `Successfully mounted ${remoteName} at ${mountPoint}` });
            } else {
                // Check if it's just slow or failed silently.
                // Ideally capture output before detaching, but --daemon suppresses it usually.
                // Let's rely on mountpoint check.
                resolve({ success: false, message: `Mount command executed but mountpoint not detected yet. Check logs.` });
            }
        }, 1000);
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
        await execPromise(`fusermount -u "${mountPoint}"`);
        // Clean up point
        try { if (fs.existsSync(mountPoint)) fs.rmdirSync(mountPoint); } catch (e) { }
        return { success: true, message: `Successfully unmounted ${remoteName}` };
    } catch (e) {
        // Fallback to umount
        try {
            await execPromise(`umount "${mountPoint}"`);
            // Clean up point
            try { if (fs.existsSync(mountPoint)) fs.rmdirSync(mountPoint); } catch (e) { }
            return { success: true, message: `Successfully unmounted ${remoteName}` };
        } catch (e2) {
            return { success: false, message: `Unmount failed: ${e.stderr || e.message}` };
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
    try {
        const cmd = `rclone lsf "${remoteName}:" ${configPathOpt ? `--config "${configPath}"` : ''}`;
        await execPromise(cmd);
        return { success: true, message: `Connection to ${remoteName} successful` };
    } catch (e) {
        return { success: false, message: `Connection test failed: ${e.stderr}` };
    }
});

// Latency check handler
ipcMain.handle('check_latency', async (event, { remoteName, configPathOpt }) => {
    const configPath = getRcloneConfigPath(configPathOpt);
    const start = Date.now();
    try {
        // Test connection with a timeout. lsf is lightweight.
        // We use a shorter timeout for latency checks (3s)
        const cmd = `rclone lsf "${remoteName}:" --max-depth 1 ${configPathOpt ? `--config "${configPath}"` : ''}`;

        await new Promise((resolve, reject) => {
            exec(cmd, { timeout: 3000 }, (error, stdout, stderr) => {
                if (error) {
                    // Check if it was a timeout
                    if (error.signal === 'SIGTERM') {
                        reject(new Error('Timeout'));
                    } else {
                        reject({ error, stderr });
                    }
                    return;
                }
                resolve();
            });
        });

        const duration = Date.now() - start;
        return { success: true, latency: duration };
    } catch (e) {
        return { success: false, error: e.message || 'Error' };
    }
});

ipcMain.handle('is_rclone_installed', async () => {
    try {
        await execPromise('rclone --version');
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
    // Construct the exact command line used for cron
    // We add a retry loop for mkdir because on headless boots without loginctl enable-linger,
    // the XDG_RUNTIME_DIR might not be created immediately by systemd.
    let cmd = `for i in $(seq 1 30); do mkdir -p "${mountPoint}" 2>/dev/null && break; sleep 2; done; rclone mount ${remoteName}: "${mountPoint}" --vfs-cache-mode writes --daemon`;
    if (configPath) {
        cmd += ` --config "${configPath}"`;
    }
    return cmd;
}

ipcMain.handle('add_to_cron', async (event, { remoteName, configPathOpt }) => {
    try {
        const mountPoint = getMountDir(remoteName);
        const configPath = getRcloneConfigPath(configPathOpt);
        const cmd = getMountCmdString(remoteName, mountPoint, configPath);
        // Add comment to identify entry
        const cronEntry = `@reboot ${cmd} # Added by de_rclone: ${remoteName}`;

        // Check if already exists (relaxed check)
        const list = await execPromise('crontab -l').catch(() => ({ stdout: '' }));
        if (list.stdout.includes(`rclone mount`) && list.stdout.includes(`${remoteName}:`)) {
            return { success: true, message: `${remoteName} is already enabled for auto-mount.` };
        }

        // Add to crontab
        await execPromise(`(crontab -l 2>/dev/null; echo "${cronEntry}") | crontab -`);

        return { success: true, message: `Enabled auto-mount for ${remoteName}.` };
    } catch (e) {
        return { success: false, message: `Failed to enable auto-mount: ${e.stderr || e.message}` };
    }
});

ipcMain.handle('remove_from_cron', async (event, { remoteName, configPathOpt }) => {
    try {
        const list = await execPromise('crontab -l').catch(() => ({ stdout: '' }));

        // Relaxed check for removal
        if (!list.stdout.includes(`rclone mount`) || !list.stdout.includes(`${remoteName}:`)) {
            return { success: true, message: `${remoteName} is not enabled for auto-mount.` };
        }

        const tempFile = path.join(os.tmpdir(), `cron_${Date.now()}`);
        fs.writeFileSync(tempFile, list.stdout);

        const content = fs.readFileSync(tempFile, 'utf8');
        const lines = content.split('\n');
        // Filter out lines that look like a mount for this remote
        const newLines = lines.filter(line => {
            const isTarget = line.includes('rclone mount') && line.includes(`${remoteName}:`);
            return !isTarget && line.trim() !== '';
        });

        const newContent = newLines.join('\n') + (newLines.length > 0 ? '\n' : '');

        fs.writeFileSync(tempFile, newContent);
        await execPromise(`crontab "${tempFile}"`);
        fs.unlinkSync(tempFile);

        return { success: true, message: `Disabled auto-mount for ${remoteName}.` };

    } catch (e) {
        return { success: false, message: `Failed to disable auto-mount: ${e.stderr || e.message}` };
    }
});




// --- Plugin & Config Functions ---

ipcMain.handle('add_remote_with_plugin', async (event, { pluginName, config, configPathOpt }) => {
    // 1. Find plugin to validate and get details
    const potentialPaths = [
        path.join(__dirname, 'plugins'),
        path.join(process.cwd(), 'plugins'),
    ];
    let pluginDir = null;
    for (const p of potentialPaths) {
        const testPath = path.join(p, pluginName);
        if (fs.existsSync(testPath)) {
            pluginDir = testPath;
            break;
        }
    }

    if (!pluginDir) {
        throw new Error(`Plugin ${pluginName} not found`);
    }

    const pluginConfigPath = path.join(pluginDir, 'config.json');
    const pluginData = JSON.parse(fs.readFileSync(pluginConfigPath, 'utf8'));

    // 2. Validate
    const allFields = [...(pluginData.basic_fields || []), ...(pluginData.advanced_fields || [])];
    for (const field of allFields) {
        if (field.required && !config[field.name]) {
            throw new Error(`Required field '${field.name}' is missing`);
        }
        // Basic type validation could go here
    }

    // 3. Process Config (Password Obfuscation)
    const processedConfig = { ...config };
    if (processedConfig.pass) {
        try {
            const { stdout } = await execPromise(`rclone obscure "${processedConfig.pass}"`);
            processedConfig.pass = stdout.trim();
        } catch (e) {
            throw new Error(`Failed to obscure password: ${e.message}`);
        }
    }

    // 4. Update rclone.conf
    const configPath = getRcloneConfigPath(configPathOpt);
    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

    let currentConfigContent = "";
    if (fs.existsSync(configPath)) {
        currentConfigContent = fs.readFileSync(configPath, 'utf8');
    }

    const remoteName = processedConfig.remote_name;
    if (!remoteName) throw new Error("remote_name is required");

    let newBlock = `\n[${remoteName}]\ntype = ${pluginName}\n`;
    for (const key in processedConfig) {
        if (key === 'remote_name') continue;
        newBlock += `${key} = ${processedConfig[key]}\n`;
    }

    fs.writeFileSync(configPath, currentConfigContent + newBlock);

    return { success: true, message: `Successfully added remote '${remoteName}'` };
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
                result[key] = value;
            }
        }
    }
    return result;
});

// --- Legacy Mount and Cron Handlers ---
ipcMain.handle('check_legacy_state', async () => {
    const legacyDir = path.join(os.homedir(), 'mnt');
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
        const list = await execPromise('crontab -l').catch(() => ({ stdout: '' }));
        if (list.stdout) {
            legacyCrons = list.stdout.split('\n').filter(line => 
                line.includes('rclone mount') && 
                line.includes('/mnt/') && 
                line.includes('# Added by de_rclone')
            );
        }
    } catch (e) {}

    return { mounts, legacyCrons };
});

ipcMain.handle('remove_legacy_crons', async () => {
    try {
        const list = await execPromise('crontab -l').catch(() => ({ stdout: '' }));
        if (!list.stdout) return { success: true, count: 0 };

        const lines = list.stdout.split('\n');
        const newLines = lines.filter(line => {
            const isLegacy = line.includes('rclone mount') && line.includes('/mnt/') && line.includes('# Added by de_rclone');
            return !isLegacy && line.trim() !== '';
        });

        if (lines.length === newLines.length) {
             return { success: true, count: 0 };
        }

        const tempFile = path.join(os.tmpdir(), `cron_${Date.now()}`);
        const newContent = newLines.join('\n') + (newLines.length > 0 ? '\n' : '');
        fs.writeFileSync(tempFile, newContent);
        await execPromise(`crontab "${tempFile}"`);
        fs.unlinkSync(tempFile);

        return { success: true, count: lines.length - newLines.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('unmount_legacy_mounts', async (event, paths) => {
    let successCount = 0;
    for (const mountPoint of paths) {
        try {
            await execPromise(`fusermount -u "${mountPoint}"`);
            try { if (fs.existsSync(mountPoint)) fs.rmdirSync(mountPoint); } catch (e) { }
            successCount++;
        } catch (e) {
            try {
                await execPromise(`umount "${mountPoint}"`);
                try { if (fs.existsSync(mountPoint)) fs.rmdirSync(mountPoint); } catch (e) { }
                successCount++;
            } catch (e2) {
                console.error(`Legacy unmount failed for ${mountPoint}: ${e2.message}`);
            }
        }
    }
    return { success: successCount === paths.length, count: successCount };
});
