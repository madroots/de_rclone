#!/usr/bin/env node
'use strict';

// Mutation check for the safety guards (issue #11).
//
//   node scripts/mutation-check.cjs [--only <name>]...
//
// For every mutation: copy lib/, test/, plugins/, main.js and package.json to a
// fresh temp directory, replace the exact text `old` (which must occur EXACTLY
// once, otherwise the mutation is INVALID) with `replacement`, and run the
// mock-based suites there. The suite has to FAIL (CAUGHT). A mutation after which
// the suite still passes SURVIVED: a guard that no test would miss. Exit status
// is non-zero if any mutation SURVIVED or is INVALID (or the unmutated baseline
// does not pass).
//
// The real-FUSE suite (test/fuse) is deliberately not run: this is the fast,
// hermetic check. The repository itself is never modified.
//
// Equivalent mutants (behaviour cannot differ, so no test could catch them) must
// not be listed here; if one appears, delete it and say why in a comment.
// Currently none are known: a mutation is only kept while it is caught.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const SUITES = [
    'test/remote-lifecycle.test.cjs',
    'test/mountinfo.test.cjs',
    'test/crontab.test.cjs',
    'test/configguard.test.cjs',
    'test/operations.test.cjs',
    'test/cronentries.test.cjs',
    'test/oplock.test.cjs'
];
const COPY = ['lib', 'test', 'plugins', 'main.js', 'package.json'];
const CONCURRENCY = 4;

const MUTATIONS = [
    // --- main.js ---------------------------------------------------------------
    {
        name: 'list-fails-when-mount-table-unreadable', file: 'main.js',
        old: '        return { error: e };', replacement: '        throw e;'
    },
    {
        name: 'mount-ignores-stale-foreign-unknown', file: 'main.js',
        old: "    if (st.state !== 'unmounted') return failureFrom(refusalFor(remoteName, st));",
        replacement: '    if (false) return failureFrom(refusalFor(remoteName, st));'
    },
    {
        name: 'delete-skips-crontab-preflight', file: 'main.js',
        old: "            if (cronNow.status === 'error') throw new AppError('CRON_ERROR', cronNow.message);",
        replacement: ''
    },
    {
        name: 'delete-skips-rollback-session-check', file: 'main.js',
        old: 'if (rollback && !createdThisSession.has(remoteName)) {', replacement: 'if (false) {'
    },
    {
        name: 'delete-rollback-ignores-mount-state', file: 'main.js',
        old: "            if (st.state !== 'unmounted') {\n                throw new AppError('ROLLBACK_NOT_ALLOWED'",
        replacement: "            if (false) {\n                throw new AppError('ROLLBACK_NOT_ALLOWED'"
    },
    {
        name: 'unmount-skips-release-verification', file: 'main.js',
        old: "        if (after.state !== 'unmounted') {", replacement: '        if (false) {'
    },
    {
        name: 'healthy-unmount-may-be-lazy', file: 'main.js',
        old: 'await releaseMount(st.mountPoint, recover);', replacement: 'await releaseMount(st.mountPoint, true);'
    },
    {
        name: 'legacy-lists-non-rclone-mounts', file: 'main.js',
        old: ".filter(entry => entry.fsType === 'fuse.rclone');", replacement: '.filter(() => true);'
    },
    {
        name: 'list-does-not-detect-encrypted-config', file: 'main.js',
        old: '    assertPlainConfig(content);\n\n    const parsed = [];', replacement: '    const parsed = [];'
    },
    {
        name: 'denied-crontab-breaks-the-list', file: 'main.js',
        old: "    const cronKnown = cron.status === 'ok' || cron.status === 'empty';",
        replacement: "    if (cron.status === 'unavailable') throw new Error(cron.message);\n    const cronKnown = cron.status === 'ok' || cron.status === 'empty';"
    },
    {
        name: 'created-remotes-not-remembered-for-rollback', file: 'main.js',
        old: '    createdThisSession.add(remoteName);\n\n    return { success: true, message: `Successfully added remote',
        replacement: '    return { success: true, message: `Successfully added remote'
    },
    {
        name: 'cron-add-write-not-verified', file: 'main.js',
        old: '        if (findEntries(outcome.after.content, remoteName).managed.length === 0) {', replacement: '        if (false) {'
    },
    {
        name: 'cron-remove-write-not-verified', file: 'main.js',
        old: "        if (findEntries(outcome.after.content, remoteName).managed.length > 0) {\n            throw new AppError('CRON_VERIFY_FAILED', 'crontab accepted the change but the entry is still present",
        replacement: "        if (false) {\n            throw new AppError('CRON_VERIFY_FAILED', 'crontab accepted the change but the entry is still present"
    },
    {
        name: 'cron-delete-write-not-verified', file: 'main.js',
        old: 'if (after.managed.length > 0 || removeManualCron.some(line => after.manual.includes(line))) {', replacement: 'if (false) {'
    },
    {
        name: 'mount-success-trusted-without-mount-table', file: 'main.js',
        old: "            if (now.state === 'mounted') {", replacement: '            if (true) {'
    },

    // --- main.js: operation locks, cancel, quit (#9) ---------------------------
    {
        name: 'handle-locked-bypasses-locks', file: 'main.js',
        old: 'const outcome = await locks.run(keys(args || {}), operation, () => handler(event, args));',
        replacement: 'const outcome = { busy: false, value: await handler(event, args) };'
    },
    {
        name: 'cancel-test-does-not-kill-the-child', file: 'main.js',
        old: "    if (entry.child) entry.child.kill('SIGTERM');", replacement: ''
    },
    {
        name: 'cancelled-test-not-reported-as-cancelled', file: 'main.js',
        old: "        if (entry.cancelled) return { success: false, cancelled: true, message: 'Connection test cancelled' };",
        replacement: ''
    },
    {
        name: 'before-quit-not-held-back', file: 'main.js',
        old: '    event.preventDefault();\n    quitInProgress = true;', replacement: '    quitInProgress = true;'
    },
    {
        name: 'delete-takes-no-per-remote-lock', file: 'main.js',
        old: "keys: ({ remoteName }) => ['config', 'crontab', `remote:${remoteName}`], operation: 'deleting'",
        replacement: "keys: () => ['config', 'crontab'], operation: 'deleting'"
    },
    {
        name: 'add-to-cron-takes-no-crontab-lock', file: 'main.js',
        old: "handleLocked('add_to_cron', { keys: ({ remoteName }) => ['crontab', `remote:${remoteName}`]",
        replacement: "handleLocked('add_to_cron', { keys: ({ remoteName }) => [`remote:${remoteName}`]"
    },

    // --- main.js: managed vs hand-written cron entries (#7, #8) -----------------
    {
        name: 'disable-also-removes-manual-lines', file: 'main.js',
        old: '            const { content: next, removed } = removeManaged(content, remoteName);\n            return removed.length ? next : null;',
        replacement: '            const { content: next, removed } = removeManaged(content, remoteName);\n            return removed.length ? removeLines(next, findEntries(content, remoteName).manual) : null;'
    },
    {
        name: 'add-to-cron-ignores-manual-entries', file: 'main.js',
        old: "            if (manual.length) {\n                throw new AppError('CRON_MANUAL_EXISTS'",
        replacement: "            if (false) {\n                throw new AppError('CRON_MANUAL_EXISTS'"
    },
    {
        name: 'delete-removes-selected-lines-without-eligibility-check', file: 'main.js',
        old: 'if (removeManualCron.some(line => !manual.includes(line))) {', replacement: 'if (false) {'
    },
    {
        name: 'legacy-cron-removal-ignores-selection', file: 'main.js',
        old: 'if (at !== -1 && isLegacyCronLine(line)) {', replacement: 'if (isLegacyCronLine(line)) {'
    },
    {
        name: 'legacy-cron-removal-ignores-legacy-check', file: 'main.js',
        old: 'if (at !== -1 && isLegacyCronLine(line)) {', replacement: 'if (at !== -1) {'
    },
    {
        name: 'legacy-unmount-allows-paths-not-in-mount-table', file: 'main.js',
        old: '        if (!allowed.has(mountPoint)) {', replacement: '        if (false) {'
    },
    {
        name: 'legacy-cron-line-counts-comments', file: 'main.js',
        old: '    if (/^\\s*#/.test(line)) return false; // a comment is never an entry\n', replacement: ''
    },

    // --- lib/cronentries.js ----------------------------------------------------
    {
        name: 'cronentries-percent-not-escaped', file: 'lib/cronentries.js',
        old: "        if (ch === '%') {", replacement: '        if (false) {'
    },
    {
        name: 'cronentries-managed-marker-name-not-compared', file: 'lib/cronentries.js',
        old: 'if (v2) return decodeRemote(v2[1]) === remoteName;', replacement: 'if (v2) return decodeRemote(v2[1]) !== null;'
    },

    // --- lib/mountinfo.js ------------------------------------------------------
    {
        name: 'mountinfo-foreign-ignores-non-rclone-fstype', file: 'lib/mountinfo.js',
        old: "matches.find((e) => e.fsType !== 'fuse.rclone');", replacement: 'undefined;'
    },
    {
        name: 'mountinfo-stale-enotconn-dropped', file: 'lib/mountinfo.js',
        old: "if (code === 'ENOTCONN' || code === 'EIO') {", replacement: "if (code === 'EIO') {"
    },

    // --- lib/crontab.js --------------------------------------------------------
    {
        name: 'crontab-edit-snapshot-compare-removed', file: 'lib/crontab.js',
        old: 'if (recheck.status !== before.status || recheck.content !== before.content) continue;', replacement: ''
    },
    {
        name: 'crontab-write-ignores-failure', file: 'lib/crontab.js',
        old: '        if (error) return { ok: false,', replacement: '        if (false) return { ok: false,'
    },

    // --- lib/configguard.js ----------------------------------------------------
    {
        name: 'configguard-new-content-not-checked-for-encryption', file: 'lib/configguard.js',
        old: '    assertPlainConfig(content);\n\n    const target', replacement: '    const target'
    },
    {
        name: 'configguard-disk-recheck-before-rename-removed', file: 'lib/configguard.js',
        old: '        checkDiskUnchanged(target, original, fsImpl);\n\n        try {\n            fsImpl.renameSync',
        replacement: '        try {\n            fsImpl.renameSync'
    }
];

function countOccurrences(text, needle) {
    let count = 0;
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++;
    return count;
}

function copyProject(destination) {
    for (const entry of COPY) {
        fs.cpSync(path.join(root, entry), path.join(destination, entry), { recursive: true });
    }
}

function runSuites(cwd, home) {
    return new Promise((resolve) => {
        const env = { ...process.env, HOME: home };
        delete env.XDG_CONFIG_HOME;
        delete env.DE_RCLONE_REAL_FUSE;
        const child = spawn(process.execPath, ['--test', ...SUITES], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (d) => { output += d; });
        child.stderr.on('data', (d) => { output += d; });
        child.on('close', (code) => {
            // node:test reports a timed-out test as "cancelled", not as "fail".
            const failed = Number((output.match(/^ℹ fail (\d+)/m) || [])[1] || 0)
                + Number((output.match(/^ℹ cancelled (\d+)/m) || [])[1] || 0);
            const passed = Number((output.match(/^ℹ pass (\d+)/m) || [])[1] || 0);
            resolve({ code, failed, passed, output });
        });
    });
}

async function check(mutation) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'de-rclone-mutation-'));
    try {
        copyProject(dir);
        fs.mkdirSync(path.join(dir, '.home'));
        if (mutation) {
            const target = path.join(dir, mutation.file);
            const text = fs.readFileSync(target, 'utf8');
            const found = countOccurrences(text, mutation.old);
            if (found !== 1) return { status: 'INVALID', detail: `pattern occurs ${found} times in ${mutation.file}` };
            fs.writeFileSync(target, text.replace(mutation.old, () => mutation.replacement));
            const syntax = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
            if (syntax.status !== 0) return { status: 'INVALID', detail: `mutated file does not parse: ${syntax.stderr.split('\n')[0]}` };
        }
        const result = await runSuites(dir, path.join(dir, '.home'));
        if (!mutation) return { status: result.code === 0 ? 'PASS' : 'FAIL', detail: `${result.passed} passed, ${result.failed} failed`, result };
        if (result.code === 0) return { status: 'SURVIVED', detail: `${result.passed} tests passed` };
        if (result.failed === 0) return { status: 'INVALID', detail: 'suite exited non-zero without a failing test (crash?)' };
        return { status: 'CAUGHT', detail: `${result.failed} failing test(s)` };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function main() {
    const only = [];
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--only' && args[i + 1]) only.push(args[++i]);
        else {
            console.error('usage: node scripts/mutation-check.cjs [--only <name>]...');
            process.exit(2);
        }
    }
    const unknown = only.filter(name => !MUTATIONS.some(m => m.name === name));
    if (unknown.length) {
        console.error(`unknown mutation(s): ${unknown.join(', ')}\navailable: ${MUTATIONS.map(m => m.name).join(', ')}`);
        process.exit(2);
    }
    const selected = only.length ? MUTATIONS.filter(m => only.includes(m.name)) : MUTATIONS;

    const baseline = await check(null);
    if (baseline.status !== 'PASS') {
        console.error(`The unmutated suite does not pass (${baseline.detail}); fix it before mutation testing.\n${baseline.result.output.split('\n').slice(-40).join('\n')}`);
        process.exit(1);
    }
    console.log(`baseline: ${baseline.detail}`);

    const results = new Array(selected.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, async () => {
        while (next < selected.length) {
            const index = next++;
            results[index] = await check(selected[index]);
        }
    }));

    const width = Math.max(...selected.map(m => m.name.length));
    console.log(`\n${'mutation'.padEnd(width)}  status    detail`);
    selected.forEach((m, i) => console.log(`${m.name.padEnd(width)}  ${results[i].status.padEnd(8)}  ${results[i].detail}`));

    const bad = results.filter(r => r.status !== 'CAUGHT').length;
    console.log(`\n${results.length - bad}/${results.length} caught${bad ? `, ${bad} SURVIVED or INVALID` : ''}`);
    process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
