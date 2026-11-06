# de_rclone

A robust, retro-styled GUI manager for **Rclone**, styled with the nostalgic CS 1.6 aesthetic, distributed as AppImage.

<img width="600" height="453" alt="36ec6d25-e185-4239-abfd-f187bb955959_removalai_preview" src="https://github.com/user-attachments/assets/eeffd72b-265c-4de5-b404-163d40e59d85" />


---

## Key Features

- **Manage your existing remotes**  
  App automatically detects your existing remotes by reading from `rclone.conf`. You can specify the path to conf yourself.

- **Parallel Latency Check**  
  Automatically checks availability and connection latency of all your remotes in parallel upon launch.

- **Remote management**  
  Add/Remove your rclone remotes, mount and unmount as you please and test connectivity directly from UI.

- **Secure & Plugin-Based**  
  Supports various Rclone providers (S3, SFTP, Webdav etc.) via a flexible plugin system. Plugin collection is growing.

- **Mount remote on startup**  
  Easily enable or disable auto-mount on startup (Cron integration) directly from the context menu. *(Note: For true headless auto-mounts on systems without an active desktop session, you must enable lingering for your user with `loginctl enable-linger`)*

- **Retro Aesthetics**  
  Nostalgic, fully themed UI based on the classic Counter-Strike 1.6 look.

- **Linux Native**  
  Optimized for Linux with AppImage distribution.

### Managing remotes

- Right-click a remote to **Edit**, **Delete**, or toggle auto-mount.
- Use the settings gear to select a custom `rclone.conf`.
- Deleting a remote first unmounts its managed mount, removes its empty mount
  directory, and removes matching auto-mount jobs. Other remotes and cron jobs
  are left unchanged. Remote data is not deleted.
- If unmounting or cron cleanup fails, the remote configuration is kept for
  retry. A failed cron cleanup can leave the remote already unmounted.
- If `crontab` is not installed, deletion remains available but warns that any
  existing auto-mount jobs must be removed manually.
- Configuration files written by the app are restricted to their owner
  (`0600`), including previously shared-readable files.

---

## Quick Start

### Recommended: Gear Lever

**[Gear Lever](https://github.com/mijorus/gearlever)** is the recommended way to manage your AppImages.  
It seamlessly integrates them into your system menu and handles updates.

1. Download the latest `.AppImage` from the [Releases](https://github.com/madroots/de_rclone/releases) page.  
2. Drag & Drop `de_rclone` into Gear Lever and click **Install/run**.

#### Automatic Updates

To take advantage of an update mechanism of Gear Lever and update de_rclone automatically when a new version is released, fill in these details in Gear Lever:

| Field | Value |
| :--- | :--- |
| **Repo URL** | `https://github.com/madroots/de_rclone` |
| **Release File Name** | `de_rclone-*.AppImage` |

---
  
### Manual Execution without launcher
1.  Download the `.AppImage`.
2.  Make it executable:
    ```bash
    chmod +x de_rclone-*.AppImage
    ```
3.  Run it:
    ```bash
    ./de_rclone-*.AppImage
    ```
## Prerequisites
*   **Rclone**: You must have `rclone` installed on your system.
*   **FUSE**: Required for mounting drives (usually pre-installed on most distros).
*   **mountpoint**: Provided by util-linux; required to verify mount state.
*   **crontab**: Optional for manual remote management; required for auto-mount.

## Development

Use Node.js 24 LTS, plus the runtime prerequisites above:

```bash
npm ci
npm run check
npm test
npm start
```

Build an AppImage without publishing a release:

```bash
npm run dist -- --linux AppImage --publish never
```

The package includes runtime code, provider plugins, UI assets, and the license.
Tests, CSS backups, and previous build output are not bundled.

### Releases

Commit matching versions in `package.json` and `package-lock.json` before pushing
a `v<version>` tag. CI rejects mismatched tags, checks syntax, runs regression
tests, and builds the AppImage. Tagged builds publish a non-draft release,
preserving existing release notes or generating notes from GitHub when empty.
Pull requests and ordinary branch builds never publish releases.

Electron and electron-builder are pinned in the lockfile. Run `npm audit` when
updating them; the current toolchain still reports moderate transitive minimatch
advisories. Do not use `npm audit fix --force` to downgrade the builder.

---
## Credits
*   **Development**: [madroots](https://github.com/madroots)
*   **UI Framework**: [CS 1.6 CSS](https://github.com/ekmas/cs16.css) by ekmas
---
*Counter-Terrorists Win.*
