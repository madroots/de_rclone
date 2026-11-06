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
    'test/configguard.test.cjs'
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
        old: '        if (!isCronEntryFor(outcome.after.content, remoteName)) {', replacement: '        if (false) {'
    },
    {
        name: 'cron-remove-write-not-verified', file: 'main.js',
        old: '\n        if (isCronEntryFor(outcome.after.content, remoteName)) {', replacement: '\n        if (false) {'
    },
    {
        name: 'cron-delete-write-not-verified', file: 'main.js',
        old: '\n                if (isCronEntryFor(outcome.after.content, remoteName)) {', replacement: '\n                if (false) {'
    },
    {
        name: 'mount-success-trusted-without-mount-table', file: 'main.js',
        old: "            if (now.state === 'mounted') {", replacement: '            if (true) {'
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
            const failed = Number((output.match(/^ℹ fail (\d+)/m) || [])[1] || 0);
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
