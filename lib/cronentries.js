'use strict';

// ---------------------------------------------------------------------------
// Cron entries owned by de_rclone (#7). Pure string functions: no I/O.
//
// A *managed* line is one this app wrote. It carries a marker that names the
// remote unambiguously:
//
//     @reboot <command> # de_rclone:v2 remote=<base64url(utf8(remoteName))>
//
// The legacy (v1) marker `# Added by de_rclone: <remoteName>` is still
// recognised so existing installs can be disabled.
//
// A *manual* line is a cron line the user wrote that runs `rclone mount` for
// the remote. The app never edits those; it only reports them.
//
// Cron percent handling (why buildManagedLine escapes `%`)
//   crontab(5): "Percent-signs (%) in the command, unless escaped with
//   backslash (\), will be changed into newline characters, and all data
//   after the first % will be sent to the command as standard input."
//   cronie implements it in src/do_command.c (child_process):
//   https://github.com/cronie-crond/cronie/blob/master/src/do_command.c
//     - scanning the command, a backslash sets `escaped`; `\%` yields `%`;
//       the first unescaped `%` ends the command; `\` + any other char is
//       copied through unchanged, and BOTH chars are consumed as a pair, so a
//       backslash directly before `%` cannot be expressed by escaping.
//   buildManagedLine therefore writes every `%` as `\%`, and when the `%` is
//   directly preceded by a (shell-quoted) backslash it inserts an empty
//   single-quote pair `''` between them so cron never sees `\\%`.
// ---------------------------------------------------------------------------

const path = require('node:path');

const MANAGED_MARKER_V2 = '# de_rclone:v2 remote=';
const LEGACY_MARKER_V1 = '# Added by de_rclone: ';

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function requireLineSafe(label, value, { optional = false } = {}) {
    if (optional && (value === undefined || value === null || value === '')) return;
    if (typeof value !== 'string' || value === '') throw new Error(`${label} is required`);
    if (/[\r\n\0]/.test(value)) throw new Error(`${label} must not contain line breaks or NUL`);
}

// The exact command main.js getMountCmdString produced before #7 (no cron escaping).
// The retry loop for mkdir exists because on headless boots without
// loginctl enable-linger the XDG_RUNTIME_DIR may not exist immediately.
function buildMountCommand(remoteName, mountPoint, configPath) {
    const remote = shellQuote(`${remoteName}:`);
    const mount = shellQuote(mountPoint);
    let cmd = `for i in $(seq 1 30); do mkdir -p ${mount} 2>/dev/null && break; sleep 2; done; rclone mount ${remote} ${mount} --vfs-cache-mode writes --daemon`;
    if (configPath) cmd += ` --config ${shellQuote(configPath)}`;
    return cmd;
}

function escapeCronPercent(command) {
    let out = '';
    for (const ch of command) {
        if (ch === '%') {
            if (out.endsWith('\\')) out += "''";
            out += '\\%';
        } else {
            out += ch;
        }
    }
    return out;
}

function encodeRemote(remoteName) {
    return Buffer.from(remoteName, 'utf8').toString('base64url');
}

function buildManagedLine({ remoteName, mountPoint, configPath } = {}) {
    requireLineSafe('remoteName', remoteName);
    requireLineSafe('mountPoint', mountPoint);
    requireLineSafe('configPath', configPath, { optional: true });
    const cmd = escapeCronPercent(buildMountCommand(remoteName, mountPoint, configPath));
    return `@reboot ${cmd} ${MANAGED_MARKER_V2}${encodeRemote(remoteName)}`;
}

// ---------------------------------------------------------------------------
// rclone flags that consume a separate value argument.
//
// Generated from rclone v1.75.1 on linux/amd64 with a scratch HOME and no
// config, by parsing the flag tables of `rclone help flags` (global and
// backend flags, which are accepted on any subcommand) and `rclone mount
// --help`. A flag is value-taking when its help line shows a type column
// (`--name <type>`), except `count` (-v), `Tristate` and `rclone size`, which
// pflag registers with NoOptDefVal so they never consume the next word. Flags
// without a type column are boolean. Names are stored without the leading
// dashes. Short flags with a value: -f (--filter) and -o (--option).
// `--flag=value` is always self-contained; unknown flags are treated as boolean.
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(`
    alias-description alias-remote archive-description archive-remote attr-timeout
    azureblob-access-tier azureblob-account azureblob-chunk-size
    azureblob-client-certificate-password azureblob-client-certificate-path
    azureblob-client-id azureblob-client-secret azureblob-connection-string
    azureblob-copy-concurrency azureblob-copy-cutoff azureblob-copy-total-concurrency
    azureblob-delete-snapshots azureblob-description azureblob-encoding azureblob-endpoint
    azureblob-key azureblob-list-chunk azureblob-msi-client-id azureblob-msi-mi-res-id
    azureblob-msi-object-id azureblob-password azureblob-public-access azureblob-sas-url
    azureblob-service-principal-file azureblob-tenant azureblob-upload-concurrency
    azureblob-upload-cutoff azureblob-username azurefiles-account azurefiles-chunk-size
    azurefiles-client-certificate-password azurefiles-client-certificate-path
    azurefiles-client-id azurefiles-client-secret azurefiles-connection-string
    azurefiles-description azurefiles-encoding azurefiles-endpoint azurefiles-key
    azurefiles-max-stream-size azurefiles-msi-client-id azurefiles-msi-mi-res-id
    azurefiles-msi-object-id azurefiles-password azurefiles-sas-url
    azurefiles-service-principal-file azurefiles-share-name azurefiles-tenant
    azurefiles-upload-concurrency azurefiles-username b2-account b2-chunk-size
    b2-copy-cutoff b2-description b2-download-auth-duration b2-download-url b2-encoding
    b2-endpoint b2-key b2-lifecycle b2-sse-customer-algorithm b2-sse-customer-key
    b2-sse-customer-key-base64 b2-sse-customer-key-md5 b2-test-mode b2-upload-concurrency
    b2-upload-cutoff b2-version-at backup-dir bind box-access-token box-auth-url
    box-box-config-file box-box-sub-type box-client-id box-client-secret box-commit-retries
    box-description box-encoding box-impersonate box-list-chunk box-owned-by
    box-root-folder-id box-token box-token-url box-upload-cutoff buffer-size bwlimit
    bwlimit-file ca-cert cache-chunk-clean-interval cache-chunk-path cache-chunk-size
    cache-chunk-total-size cache-db-path cache-db-wait-time cache-description cache-dir
    cache-info-age cache-plex-insecure cache-plex-password cache-plex-url
    cache-plex-username cache-read-retries cache-remote cache-rps cache-tmp-upload-path
    cache-tmp-wait-time cache-workers checkers chunker-chunk-size chunker-description
    chunker-hash-type chunker-remote client-cert client-key client-pass cloudinary-api-key
    cloudinary-api-secret cloudinary-cloud-name cloudinary-description cloudinary-encoding
    cloudinary-eventually-consistent-delay cloudinary-media-extensions
    cloudinary-upload-prefix cloudinary-upload-preset color combine-description
    combine-upstreams compare-dest compress-description compress-level compress-mode
    compress-ram-cache-limit compress-remote config contimeout copy-dest cpuprofile
    crypt-description crypt-filename-encoding crypt-filename-encryption crypt-password
    crypt-password2 crypt-remote crypt-suffix cutoff-mode daemon-timeout daemon-wait
    default-time devname dir-cache-time dir-perms disable doi-description doi-doi
    doi-doi-resolver-api-url doi-provider drime-access-token drime-chunk-size
    drime-description drime-encoding drime-list-chunk drime-root-folder-id
    drime-upload-concurrency drime-upload-cutoff drime-workspace-id drive-auth-url
    drive-chunk-size drive-client-id drive-client-secret drive-description drive-encoding
    drive-export-formats drive-formats drive-impersonate drive-import-formats
    drive-list-chunk drive-metadata-labels drive-metadata-owner drive-metadata-permissions
    drive-pacer-burst drive-pacer-min-sleep drive-resource-key drive-root-folder-id
    drive-scope drive-service-account-credentials drive-service-account-file
    drive-team-drive drive-token drive-token-url drive-upload-cutoff
    drive-v2-download-min-size dropbox-auth-url dropbox-batch-mode dropbox-batch-size
    dropbox-batch-timeout dropbox-chunk-size dropbox-client-id dropbox-client-secret
    dropbox-description dropbox-encoding dropbox-export-formats dropbox-impersonate
    dropbox-impersonate-admin dropbox-pacer-min-sleep dropbox-root-namespace dropbox-token
    dropbox-token-url dscp dump exclude exclude-from exclude-if-present
    expect-continue-timeout fichier-api-key fichier-description fichier-encoding
    fichier-file-password fichier-folder-password fichier-shared-folder file-perms
    filefabric-description filefabric-encoding filefabric-permanent-token
    filefabric-root-folder-id filefabric-token filefabric-token-expiry filefabric-url
    filefabric-version filelu-chunk-size filelu-description filelu-encoding filelu-key
    filelu-upload-cutoff filen-api-key filen-auth-version filen-base-folder-uuid
    filen-description filen-email filen-encoding filen-master-keys filen-password
    filen-private-key filen-public-key filen-upload-concurrency files-from files-from-raw
    files-from0 filescom-api-key filescom-description filescom-encoding filescom-password
    filescom-site filescom-username filter filter-from fs-cache-expire-duration
    fs-cache-expire-interval ftp-close-timeout ftp-concurrency ftp-description ftp-encoding
    ftp-host ftp-http-proxy ftp-idle-timeout ftp-pass ftp-port ftp-shut-timeout
    ftp-socks-proxy ftp-tls-cache-size ftp-user fuse-flag gcs-access-token gcs-auth-url
    gcs-bucket-acl gcs-client-id gcs-client-secret gcs-description gcs-encoding gcs-endpoint
    gcs-location gcs-object-acl gcs-project-number gcs-service-account-file
    gcs-storage-class gcs-token gcs-token-url gcs-user-project gid gofile-access-token
    gofile-account-id gofile-description gofile-encoding gofile-list-chunk
    gofile-root-folder-id gphotos-auth-url gphotos-batch-mode gphotos-batch-size
    gphotos-batch-timeout gphotos-client-id gphotos-client-secret gphotos-description
    gphotos-encoding gphotos-proxy gphotos-start-year gphotos-token gphotos-token-url group
    hash-filter hasher-auto-size hasher-description hasher-hashes hasher-max-age
    hasher-remote hdfs-data-transfer-protection hdfs-description hdfs-encoding hdfs-namenode
    hdfs-service-principal-name hdfs-username header header-download header-upload
    hidrive-auth-url hidrive-chunk-size hidrive-client-id hidrive-client-secret
    hidrive-description hidrive-encoding hidrive-endpoint hidrive-root-prefix
    hidrive-scope-access hidrive-scope-role hidrive-token hidrive-token-url
    hidrive-upload-concurrency hidrive-upload-cutoff http-description http-headers
    http-proxy http-url huaweidrive-auth-url huaweidrive-chunk-size huaweidrive-client-id
    huaweidrive-client-secret huaweidrive-description huaweidrive-encoding
    huaweidrive-list-chunk huaweidrive-root-folder-id huaweidrive-token
    huaweidrive-token-url huaweidrive-upload-cutoff iclouddrive-apple-id
    iclouddrive-client-id iclouddrive-description iclouddrive-encoding iclouddrive-password
    iclouddrive-service imagekit-description imagekit-encoding imagekit-endpoint
    imagekit-only-signed imagekit-private-key imagekit-public-key imagekit-upload-tags
    include include-from internetarchive-access-key-id internetarchive-description
    internetarchive-encoding internetarchive-endpoint internetarchive-front-endpoint
    internetarchive-item-metadata internetarchive-secret-access-key
    internetarchive-wait-archive internxt-chunk-size internxt-description internxt-email
    internxt-encoding internxt-pass internxt-upload-concurrency internxt-upload-cutoff
    jottacloud-auth-url jottacloud-client-id jottacloud-client-secret jottacloud-description
    jottacloud-encoding jottacloud-md5-memory-limit jottacloud-token jottacloud-token-url
    jottacloud-upload-resume-limit koofr-description koofr-encoding koofr-endpoint
    koofr-mountid koofr-password koofr-provider koofr-user kv-lock-time link-perms
    linkbox-description linkbox-email linkbox-password linkbox-token list-cutoff
    local-description local-encoding local-hashes local-time-type log-file log-file-max-age
    log-file-max-backups log-file-max-size log-format log-level low-level-retries
    mailru-auth-url mailru-client-id mailru-client-secret mailru-description mailru-encoding
    mailru-pass mailru-speedup-file-patterns mailru-speedup-max-disk
    mailru-speedup-max-memory mailru-token mailru-token-url mailru-user max-age max-backlog
    max-buffer-memory max-connections max-delete max-delete-size max-depth max-duration
    max-read-ahead max-size max-stats-groups max-transfer mega-2fa mega-description
    mega-encoding mega-pass mega-user memory-description memprofile metadata-exclude
    metadata-exclude-from metadata-filter metadata-filter-from metadata-include
    metadata-include-from metadata-mapper metadata-set metrics-addr metrics-allow-origin
    metrics-baseurl metrics-cert metrics-client-ca metrics-htpasswd metrics-key
    metrics-max-header-bytes metrics-min-tls-version metrics-pass metrics-realm
    metrics-response-header metrics-salt metrics-server-read-timeout
    metrics-server-write-timeout metrics-template metrics-user metrics-user-from-header
    min-age min-size modify-window multi-thread-chunk-size multi-thread-cutoff
    multi-thread-streams multi-thread-write-buffer-size name-transform netstorage-account
    netstorage-description netstorage-host netstorage-protocol netstorage-secret
    onedrive-access-scopes onedrive-auth-url onedrive-chunk-size onedrive-client-id
    onedrive-client-secret onedrive-description onedrive-drive-id onedrive-drive-type
    onedrive-encoding onedrive-hash-type onedrive-link-password onedrive-link-scope
    onedrive-link-type onedrive-list-chunk onedrive-metadata-permissions onedrive-region
    onedrive-root-folder-id onedrive-tenant onedrive-tenant-url onedrive-token
    onedrive-token-url onedrive-upload-cutoff oos-chunk-size oos-compartment oos-config-file
    oos-config-profile oos-copy-cutoff oos-copy-timeout oos-description oos-encoding
    oos-endpoint oos-max-upload-parts oos-namespace oos-provider oos-region
    oos-sse-customer-algorithm oos-sse-customer-key oos-sse-customer-key-file
    oos-sse-customer-key-sha256 oos-sse-kms-key-id oos-storage-tier oos-upload-concurrency
    oos-upload-cutoff opendrive-access opendrive-chunk-size opendrive-description
    opendrive-encoding opendrive-password opendrive-username option order-by partial-suffix
    password-command pcloud-auth-url pcloud-client-id pcloud-client-secret
    pcloud-description pcloud-encoding pcloud-hostname pcloud-password pcloud-root-folder-id
    pcloud-token pcloud-token-url pcloud-username pikpak-chunk-size pikpak-description
    pikpak-device-id pikpak-encoding pikpak-hash-memory-limit pikpak-pass
    pikpak-root-folder-id pikpak-upload-concurrency pikpak-upload-cutoff pikpak-user
    pikpak-user-agent pixeldrain-api-key pixeldrain-api-url pixeldrain-description
    pixeldrain-root-folder-id poll-interval premiumizeme-auth-url premiumizeme-client-id
    premiumizeme-client-secret premiumizeme-description premiumizeme-encoding
    premiumizeme-token premiumizeme-token-url protondrive-2fa protondrive-app-version
    protondrive-description protondrive-encoding protondrive-mailbox-password
    protondrive-otp-secret-key protondrive-password protondrive-username putio-auth-url
    putio-client-id putio-client-secret putio-description putio-encoding putio-token
    putio-token-url qingstor-access-key-id qingstor-chunk-size qingstor-connection-retries
    qingstor-description qingstor-encoding qingstor-endpoint qingstor-secret-access-key
    qingstor-upload-concurrency qingstor-upload-cutoff qingstor-zone quatrix-api-key
    quatrix-description quatrix-effective-upload-time quatrix-encoding quatrix-host
    quatrix-maximal-summary-chunk-size quatrix-minimal-chunk-size rc-addr rc-allow-origin
    rc-baseurl rc-cert rc-client-ca rc-files rc-htpasswd rc-job-expire-duration
    rc-job-expire-interval rc-key rc-max-header-bytes rc-min-tls-version rc-pass rc-realm
    rc-response-header rc-salt rc-server-read-timeout rc-server-write-timeout rc-template
    rc-user rc-user-from-header rc-web-fetch-url retries retries-sleep s3-access-key-id
    s3-acl s3-bucket-acl s3-chunk-size s3-copy-cutoff s3-description s3-download-url
    s3-encoding s3-endpoint s3-ibm-api-key s3-ibm-iam-endpoint s3-ibm-resource-instance-id
    s3-list-chunk s3-list-version s3-location-constraint s3-max-upload-parts
    s3-object-lock-legal-hold-status s3-object-lock-mode s3-object-lock-retain-until-date
    s3-profile s3-provider s3-region s3-role-arn s3-role-external-id
    s3-role-session-duration s3-role-session-name s3-sdk-log-mode s3-secret-access-key
    s3-server-side-encryption s3-session-token s3-shared-credentials-file
    s3-sse-customer-algorithm s3-sse-customer-key s3-sse-customer-key-base64
    s3-sse-customer-key-md5 s3-sse-kms-key-id s3-storage-class s3-upload-concurrency
    s3-upload-cutoff s3-use-accept-encoding-gzip s3-version-at seafile-description
    seafile-encoding seafile-library seafile-library-key seafile-pass seafile-url
    seafile-user sftp-blake3sum-command sftp-chunk-size sftp-ciphers sftp-concurrency
    sftp-connections sftp-crc32sum-command sftp-description sftp-encoding sftp-hashes
    sftp-host sftp-host-key-algorithms sftp-host-keys sftp-http-proxy sftp-idle-timeout
    sftp-key-exchange sftp-key-file sftp-key-file-pass sftp-key-pem sftp-known-hosts-file
    sftp-macs sftp-md5sum-command sftp-pass sftp-path-override sftp-port sftp-pubkey
    sftp-pubkey-file sftp-server-command sftp-set-env sftp-sha1sum-command
    sftp-sha256sum-command sftp-shell-type sftp-socks-proxy sftp-ssh sftp-subsystem
    sftp-user sftp-xxh128sum-command sftp-xxh3sum-command shade-api-key shade-chunk-size
    shade-description shade-drive-id shade-encoding shade-endpoint shade-max-upload-parts
    shade-token shade-token-expiry shade-upload-concurrency sharefile-auth-url
    sharefile-chunk-size sharefile-client-id sharefile-client-secret sharefile-description
    sharefile-encoding sharefile-endpoint sharefile-root-folder-id sharefile-token
    sharefile-token-url sharefile-upload-cutoff sia-api-password sia-api-url sia-description
    sia-encoding sia-user-agent smb-description smb-domain smb-encoding smb-host
    smb-idle-timeout smb-kerberos-ccache smb-pass smb-port smb-spn smb-user stats
    stats-file-name-length stats-log-level stats-one-line-date-format stats-unit
    storj-access-grant storj-api-key storj-description storj-passphrase storj-provider
    storj-satellite-address streaming-upload-cutoff suffix sugarsync-access-key-id
    sugarsync-app-id sugarsync-authorization sugarsync-authorization-expiry
    sugarsync-deleted-id sugarsync-description sugarsync-encoding
    sugarsync-private-access-key sugarsync-refresh-token sugarsync-root-id sugarsync-user
    swift-application-credential-id swift-application-credential-name
    swift-application-credential-secret swift-auth swift-auth-token swift-auth-version
    swift-chunk-size swift-description swift-domain swift-encoding swift-endpoint-type
    swift-key swift-partial-page-fetch-threshold swift-region swift-storage-policy
    swift-storage-url swift-tenant swift-tenant-domain swift-tenant-id swift-user
    swift-user-id syslog-facility temp-dir timeout tpslimit tpslimit-burst
    track-renames-strategy transfers uid ulozto-app-token ulozto-description ulozto-encoding
    ulozto-list-page-size ulozto-password ulozto-root-folder-slug ulozto-username umask
    union-action-policy union-cache-time union-create-policy union-description
    union-min-free-space union-search-policy union-upstreams user-agent vfs-cache-max-age
    vfs-cache-max-size vfs-cache-min-free-space vfs-cache-mode vfs-cache-poll-interval
    vfs-disk-space-total-size vfs-handle-caching vfs-metadata-extension vfs-read-ahead
    vfs-read-chunk-size vfs-read-chunk-size-limit vfs-read-chunk-streams vfs-read-wait
    vfs-write-back vfs-write-wait volname webdav-bearer-token webdav-bearer-token-command
    webdav-description webdav-encoding webdav-headers webdav-nextcloud-chunk-size
    webdav-pacer-min-sleep webdav-pass webdav-unix-socket webdav-url webdav-user
    webdav-vendor yandex-auth-url yandex-client-id yandex-client-secret yandex-description
    yandex-encoding yandex-token yandex-token-url yandex-upload-wait zoho-auth-url
    zoho-client-id zoho-client-secret zoho-description zoho-encoding zoho-list-folder-burst
    zoho-list-folder-limit zoho-list-folder-window zoho-region zoho-root-folder-id
    zoho-token zoho-token-url zoho-tpslimit zoho-tpslimit-burst zoho-upload-cutoff`.split(/\s+/).filter(Boolean));
const VALUE_SHORT_FLAGS = new Set(['f', 'o']);

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

// What cron hands to /bin/sh: `\%` -> `%`, the first unescaped `%` ends the
// command (the rest is stdin data), other backslashes are kept. Mirrors
// cronie do_command.c (see header).
function cronCommandText(text) {
    let out = '';
    let escaped = false;
    for (const ch of text) {
        if (escaped) {
            if (ch === '%') out = out.slice(0, -1);
            out += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            out += ch;
            continue;
        }
        if (ch === '%') break;
        out += ch;
    }
    return out;
}

// Shell words without executing anything. Returns tokens
// { value, op, quoted } or null for an unterminated quote. `op` tokens are the
// single characters ; | & ( ) < >. A `#` at the start of a word begins a comment.
function tokenize(text) {
    const tokens = [];
    let word = '';
    let quote = '';
    let started = false;
    let quoted = false;
    const flush = () => {
        if (started) tokens.push({ value: word, op: false, quoted });
        word = '';
        started = false;
        quoted = false;
    };
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quote) {
            if (char === quote) quote = '';
            else if (char === '\\' && quote === '"' && /[$`"\\]/.test(text[i + 1] || '')) word += text[++i];
            else word += char;
        } else if (char === '#' && !started) {
            break;
        } else if (char === "'" || char === '"') {
            quote = char;
            started = true;
            quoted = true;
        } else if (char === '\\' && i + 1 < text.length) {
            word += text[++i];
            started = true;
            quoted = true;
        } else if (/\s|[;|&()<>]/.test(char)) {
            // `2>file`: a bare number glued to a redirection is a file descriptor.
            if ((char === '<' || char === '>') && started && !quoted && /^\d+$/.test(word)) {
                word = '';
                started = false;
            }
            flush();
            if (!/\s/.test(char)) tokens.push({ value: char, op: true, quoted: false });
        } else {
            word += char;
            started = true;
        }
    }
    if (quote) return null;
    flush();
    return tokens;
}

// Split tokens into simple commands (arrays of word strings). Control
// operators separate commands; redirection operators drop their target word.
function splitCommands(tokens) {
    const commands = [];
    let current = [];
    const end = () => {
        if (current.length) commands.push(current);
        current = [];
    };
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token.op) {
            current.push(token);
        } else if (token.value === '<' || token.value === '>') {
            // `>&2`, `2>&1`, `>>file`
            while (tokens[i + 1] && tokens[i + 1].op && (tokens[i + 1].value === '&' || tokens[i + 1].value === token.value)) i++;
            if (tokens[i + 1] && !tokens[i + 1].op) i++;
        } else {
            end();
        }
    }
    end();
    return commands;
}

// ---------------------------------------------------------------------------
// Does a simple command run `rclone mount <remote>:...`?
// ---------------------------------------------------------------------------

const RESERVED_PREFIX = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'exec']);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(['sh', 'bash', 'dash']);

// Options of wrapper commands that take a separate value.
const ENV_VALUE_OPTS = new Set(['-u', '--unset', '-C', '--chdir']);
const NICE_VALUE_OPTS = new Set(['-n', '--adjustment']);
const IONICE_VALUE_OPTS = new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid']);
const TIMEOUT_VALUE_OPTS = new Set(['-s', '--signal', '-k', '--kill-after']);

function skipOptions(words, index, valueOpts) {
    while (index < words.length && words[index].startsWith('-') && words[index] !== '-') {
        const word = words[index];
        if (word === '--') return index + 1;
        index += valueOpts.has(word) ? 2 : 1;
    }
    return index;
}

// Returns the index of the executable word after prefixes and wrappers, or -1.
function commandStart(words) {
    let i = 0;
    for (;;) {
        while (i < words.length && !words[i].quoted && RESERVED_PREFIX.has(words[i].value)) i++;
        while (i < words.length && ASSIGNMENT_RE.test(words[i].value)) i++;
        if (i >= words.length) return -1;
        const values = words.map(word => word.value);
        const name = words[i].quoted ? '' : values[i];
        if (name === 'exec' || name === 'nohup') {
            i++;
        } else if (name === 'env') {
            i = skipOptions(values, i + 1, ENV_VALUE_OPTS);
            while (i < words.length && ASSIGNMENT_RE.test(values[i])) i++;
        } else if (name === 'nice') {
            i = skipOptions(values, i + 1, NICE_VALUE_OPTS);
        } else if (name === 'ionice') {
            i = skipOptions(values, i + 1, IONICE_VALUE_OPTS);
        } else if (name === 'timeout') {
            i = skipOptions(values, i + 1, TIMEOUT_VALUE_OPTS) + 1; // + DURATION
        } else {
            return i;
        }
    }
}

function isValueFlag(word) {
    if (word.includes('=')) return false;
    if (word.startsWith('--')) return VALUE_FLAGS.has(word.slice(2));
    return word.length === 2 && VALUE_SHORT_FLAGS.has(word[1]);
}

// Walk rclone's arguments: global flags, subcommand, flags, first positional.
function mountsRemote(args, remoteName) {
    let subcommandSeen = false;
    let afterDashes = false;
    for (let i = 0; i < args.length; i++) {
        const word = args[i];
        if (!afterDashes && word === '--') {
            afterDashes = true;
            continue;
        }
        if (!afterDashes && word.startsWith('-') && word !== '-') {
            if (isValueFlag(word)) i++;
            continue;
        }
        if (!subcommandSeen) {
            if (word !== 'mount') return false;
            subcommandSeen = true;
            continue;
        }
        return word.startsWith(`${remoteName}:`);
    }
    return false;
}

function commandMountsRemote(words, remoteName, depth) {
    const start = commandStart(words);
    if (start < 0) return false;
    const exe = path.posix.basename(words[start].value);
    const args = words.slice(start + 1).map(word => word.value);
    if (exe === 'rclone') return mountsRemote(args, remoteName);
    if (depth === 0 && SHELLS.has(exe)) {
        // One level of `sh -c '<script>'`; options may precede -c (also `-ec`, `-lc`).
        for (let i = 0; i < args.length; i++) {
            if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(args[i])) {
                return i + 1 < args.length && scriptMountsRemote(args[i + 1], remoteName, depth + 1);
            }
            if (!args[i].startsWith('-') && args[i] !== '-') return false;
        }
    }
    return false;
}

function scriptMountsRemote(script, remoteName, depth) {
    const tokens = tokenize(script);
    if (!tokens) return false;
    return splitCommands(tokens).some(words => commandMountsRemote(words, remoteName, depth));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const COMMENT_RE = /^\s*#/;
const ENV_LINE_RE = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/;
const SCHEDULE_FIELD = '[0-9*/,A-Za-z?-]+';
const CRON_LINE_RE = new RegExp(`^\\s*(?:@[A-Za-z]+|(?:${SCHEDULE_FIELD}\\s+){4}${SCHEDULE_FIELD})\\s+(\\S[\\s\\S]*)$`);

function decodeRemote(encoded) {
    const name = Buffer.from(encoded, 'base64url').toString('utf8');
    return encodeRemote(name) === encoded ? name : null;
}

function isManagedLine(line, remoteName) {
    if (COMMENT_RE.test(line)) return false;
    const trimmed = line.trimEnd();
    const v2 = /(?:^|\s)# de_rclone:v2 remote=([A-Za-z0-9_-]+)$/.exec(trimmed);
    if (v2) return decodeRemote(v2[1]) === remoteName;
    const marker = `${LEGACY_MARKER_V1}${remoteName}`;
    if (!trimmed.endsWith(marker)) return false;
    const before = trimmed.slice(0, trimmed.length - marker.length);
    return before === '' || /\s$/.test(before);
}

function isManualLine(line, remoteName) {
    if (COMMENT_RE.test(line) || ENV_LINE_RE.test(line)) return false;
    const match = CRON_LINE_RE.exec(line);
    if (!match) return false;
    return scriptMountsRemote(cronCommandText(match[1]), remoteName, 0);
}

function classifyCronLine(line, remoteName) {
    line = String(line);
    if (isManagedLine(line, remoteName)) return 'managed';
    if (isManualLine(line, remoteName)) return 'manual';
    return 'none';
}

function findEntries(content, remoteName) {
    const managed = [];
    const manual = [];
    for (const line of String(content || '').split('\n')) {
        const kind = classifyCronLine(line, remoteName);
        if (kind === 'managed') managed.push(line);
        else if (kind === 'manual') manual.push(line);
    }
    return { managed, manual };
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

// Each entry of `lines` removes one line whose text (without its '\n') equals
// it exactly. Everything else, including CRLF, blank lines and a missing final
// newline, is returned byte for byte.
function removeLines(content, lines) {
    content = String(content);
    const pending = new Map();
    for (const line of lines) pending.set(line, (pending.get(line) || 0) + 1);
    if (!pending.size) return content;
    const pieces = content.split('\n');
    const last = pieces.length - 1;
    let out = '';
    pieces.forEach((piece, index) => {
        const count = pending.get(piece);
        if (count && !(index === last && piece === '')) {
            pending.set(piece, count - 1);
            return;
        }
        out += index < last ? `${piece}\n` : piece;
    });
    return out;
}

function removeManaged(content, remoteName) {
    const removed = findEntries(content, remoteName).managed;
    return { content: removeLines(content, removed), removed };
}

module.exports = {
    MANAGED_MARKER_V2,
    buildMountCommand,
    buildManagedLine,
    classifyCronLine,
    findEntries,
    removeLines,
    removeManaged,
};
