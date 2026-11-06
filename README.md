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
- If `crontab` is unavailable (not installed, or your user is not allowed to use
  it), listing, mounting and deletion keep working: the Cron column shows
  **Unknown**, enabling auto-mount reports why it cannot, and deleting a remote
  warns that any existing auto-mount jobs must be removed manually. Crontab is
  only ever changed after it was read successfully, and the result is read back
  to confirm it.
- Auto-mount lines written by de_rclone carry a `# de_rclone:v2` marker. A cron
  entry you wrote yourself that mounts the same remote is shown as **Manual**:
  de_rclone never edits it, will not add a second entry next to it, and
  **Disable auto-mount** leaves it alone. When you delete the remote, such
  entries are listed with unticked boxes; they are removed only if you tick them,
  and the result always names the ones that were kept.
- Mount state is read from the kernel's mount table, so a crashed rclone does not
  break the app. A remote can be **Yes**, **No**, **Stale**, **Foreign** or
  **Unknown**:
  - **Stale**: the rclone process died and left a dead mount. Select the remote
    and click **Recover** to release it. Mount and Delete are refused until then.
  - **Foreign**: something other than rclone is mounted at the remote's managed
    path. de_rclone never mounts, unmounts or deletes over it.
  - **Unknown**: the state could not be determined (the reason is shown); only
    that remote is affected.
- If your `rclone.conf` is encrypted, de_rclone says so and refuses to change it
  (it cannot edit encrypted files yet). Every other change is checked with
  `rclone` itself before the file is replaced atomically, and is abandoned if the
  file was modified by someone else in the meantime.
- Configuration files written by the app are restricted to their owner
  (`0600`), including previously shared-readable files.
- Only one operation can change a given remote (or the config, or the crontab) at
  a time. A conflicting request is refused immediately with a message saying what
  is in progress. Mount and unmount cannot be cancelled once started, so their
  dialogs show no Cancel button; a connection test can be cancelled and its
  `rclone` process is stopped. Quitting waits (up to 8 seconds) for work in
  progress.
- On first start, leftovers of the old `~/mnt` setup are listed with unticked
  boxes: only rclone mounts directly under `~/mnt` and legacy cron lines are
  offered, and only the items you tick are removed. Other mounts (sshfs, NFS,
  ...) are never listed.

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
*   **crontab**: Optional. Needed only for auto-mount; everything else works without it.

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
a `v<version>` tag. CI runs `scripts/release-gate.cjs` (`npm run release:gate`)
and fails before building when the tag is not `v<version>`, the two versions
differ, or a *published* release already exists for the tag (electron-builder
would skip the AppImage upload). A draft release for the tag, for example one
holding hand-written notes, is fine.

Tagged builds run in two jobs. The read-only `build` job checks syntax and runs
regression tests. The `publish` job, the only one with `contents: write`, uploads
the AppImage and `latest-linux.yml` to a draft release, verifies the draft holds
both assets, and only then publishes it, keeping non-empty draft notes or
generating notes from GitHub otherwise. To re-run a failed release, delete or
reset the release to a draft first, or use a new tag. Pull requests and ordinary
branch builds only build and upload an artifact; they never publish releases and
run without a write token.

Electron and electron-builder are pinned in the lockfile. Run `npm audit` when
updating them; the current toolchain still reports moderate transitive minimatch
advisories. Do not use `npm audit fix --force` to downgrade the builder.

---
## Credits
*   **Development**: [madroots](https://github.com/madroots)
*   **UI Framework**: [CS 1.6 CSS](https://github.com/ekmas/cs16.css) by ekmas
---
*Counter-Terrorists Win.*
