'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');

const { detectConfigFormat, assertPlainConfig, writeConfigAtomic } = require('../lib/configguard');
const { AppError } = require('../lib/errors');
const { createFakeRclone, createMissingRclone } = require('./helpers/fake-rclone.cjs');

// ---------------------------------------------------------------- helpers

function tmpDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'de-rclone-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function setUmask(t, mask) {
    const previous = process.umask(mask);
    t.after(() => process.umask(previous));
}

const PLAIN = '[a]\ntype = s3\nsecret_access_key = TOPSECRET\n\n[b]\ntype = local\n';
// Synthetic: real header, base64 body long enough to look like a real encrypted file.
const ENCRYPTED = `# Encrypted rclone configuration File\n\nRCLONE_ENCRYPT_V0:\n${Buffer.alloc(72, 7).toString('base64')}\n`;

function modeOf(file) {
    return fs.statSync(file).mode & 0o777;
}

async function rejectsWith(promise, code) {
    await assert.rejects(promise, (e) => {
        assert.ok(e instanceof AppError, `expected AppError, got ${e && e.stack}`);
        assert.equal(e.code, code, e.message);
        assert.ok(e.message.startsWith(`${code}: `));
        return true;
    });
}

async function rejectsWithError(promise, code) {
    let caught;
    try {
        await promise;
    } catch (e) {
        caught = e;
    }
    assert.ok(caught instanceof AppError, `expected AppError, got ${caught && caught.stack}`);
    assert.equal(caught.code, code, caught.message);
    return caught;
}

// Runs `hook(args)` after the underlying fake answered (so the file changes in the window
// between rclone's dump and the replace), or before when `when === 'before'`.
function withHook(fake, hook, when = 'after') {
    async function run(args, options) {
        if (when === 'before') hook(args);
        const result = await fake(args, options);
        if (when === 'after') hook(args);
        return result;
    }
    run.calls = fake.calls;
    return run;
}

// ---------------------------------------------------------------- format detection

test('detectConfigFormat follows rclone Decrypt: skip blanks/#/; lines, first line decides', () => {
    const header = 'RCLONE_ENCRYPT_V0:';
    const cases = [
        ['', 'plain'],
        ['\n\n  \n', 'plain'],
        ['# only a comment\n', 'plain'],
        ['[a]\ntype = x\n', 'plain'],
        [`${header}\nabc`, 'encrypted'],
        [`${header}`, 'encrypted'],
        [`# Encrypted rclone configuration File\n\n${header}\nabc\n`, 'encrypted'],
        [`; comment\n# comment\n\n${header}\n`, 'encrypted'],
        [`\r\n# Encrypted\r\n\r\n${header}\r\nabc\r\n`, 'encrypted'],
        [`   \t${header}  \n`, 'encrypted'],
        [`  # indented comment\n${header}\n`, 'encrypted'],
        // The header must be the FIRST significant line.
        [`[a]\ntype = x\n${header}\n`, 'plain'],
        [`# c\n[a]\n${header}\n`, 'plain'],
        // A header-looking string that is a value, not a line start.
        [`[a]\nkey = ${header}\n`, 'plain'],
        // rclone refuses other versions ("unsupported configuration encryption"); we cannot edit them either.
        ['RCLONE_ENCRYPT_V1:\nabc\n', 'encrypted'],
    ];
    for (const [content, expected] of cases) {
        assert.equal(detectConfigFormat(content), expected, JSON.stringify(content));
    }
});

test('detectConfigFormat rejects non-string input instead of guessing', () => {
    assert.throws(() => detectConfigFormat(undefined), TypeError);
    assert.throws(() => detectConfigFormat(null), TypeError);
});

test('assertPlainConfig throws the typed CONFIG_ENCRYPTED error and passes plain content', () => {
    assert.doesNotThrow(() => assertPlainConfig(''));
    assert.doesNotThrow(() => assertPlainConfig(PLAIN));
    assert.throws(() => assertPlainConfig(ENCRYPTED), (e) => {
        assert.ok(e instanceof AppError);
        assert.equal(e.code, 'CONFIG_ENCRYPTED');
        assert.equal(e.detail, 'Your rclone config is encrypted; de_rclone cannot edit it yet. Use `rclone config` meanwhile.');
        assert.equal(e.message, `CONFIG_ENCRYPTED: ${e.detail}`);
        return true;
    });
});

// ---------------------------------------------------------------- the fake itself (it underpins every test below)

test('fake rclone matches recorded rclone behavior (guards the other tests against a lying fake)', async (t) => {
    const dir = tmpDir(t);
    const fake = createFakeRclone();
    const dump = (name, text) => {
        const f = path.join(dir, name);
        if (text !== null) fs.writeFileSync(f, text);
        return fake(['--config', f, '--ask-password=false', 'config', 'dump']);
    };
    const messy = '\uFEFF# c\n[a]\r\ntype = local\r\nx = 1\r\nx: 2\r\n; c\n\n[ b ]\nk = a=b\n[a]\ny=3\n';
    const { stdout } = await dump('messy.conf', messy);
    assert.deepEqual(JSON.parse(stdout), { a: { type: 'local', x: '2', y: '3' }, b: { k: 'a=b' } });
    assert.equal((await dump('empty.conf', '')).stdout, '{}');

    const missing = await dump('missing.conf', null);
    assert.equal(missing.stdout, '{}');
    assert.match(missing.stderr, /NOTICE: Config file ".*missing\.conf" not found - using defaults/);

    await assert.rejects(dump('bad.conf', '[a]\nnoequals\n'), (r) => {
        assert.equal(r.error.code, 1);
        assert.match(r.stderr, /CRITICAL: Failed to load config file ".*bad\.conf": could not parse line: noequals/);
        return true;
    });
    await assert.rejects(dump('enc.conf', ENCRYPTED), (r) => {
        assert.match(r.stderr, /unable to decrypt configuration and not allowed to ask for password/);
        return true;
    });
    await assert.rejects(dump('enc2.conf', 'RCLONE_ENCRYPT_V0:\n[a]\ntype = x\n'), (r) => {
        assert.match(r.stderr, /failed to load base64 encoded data: illegal base64 data at input byte 0/);
        return true;
    });
    assert.throws(() => fake(['--config', 'x', 'listremotes']), /unsupported invocation/);
});

// ---------------------------------------------------------------- successful writes

test('creates a new config file (original null) with mode 0600 and leaves no stray files', async (t) => {
    setUmask(t, 0);
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    const fake = createFakeRclone();
    const content = '[a]\ntype = local\n';

    const result = await writeConfigAtomic({
        configPath: cfg, original: null, content, changedNames: ['a'],
        expect: { present: ['a'] }, runRclone: fake,
    });

    assert.deepEqual(result, { configPath: cfg });
    assert.equal(fs.readFileSync(cfg, 'utf8'), content);
    assert.equal(modeOf(cfg), 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);
    // A brand-new file has no previous version to dump.
    assert.equal(fake.calls.length, 1);
});

test('replaces an existing config: new bytes in place, mode forced to 0600 even from 0666 under umask 0', async (t) => {
    setUmask(t, 0);
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN, { mode: 0o666 });
    fs.chmodSync(cfg, 0o666);
    assert.equal(modeOf(cfg), 0o666);
    const fake = createFakeRclone();
    const content = `${PLAIN}\n[c]\ntype = local\n`;

    const result = await writeConfigAtomic({
        configPath: cfg, original: PLAIN, content, changedNames: ['c'],
        expect: { present: ['a', 'b', 'c'] }, runRclone: fake,
    });

    assert.deepEqual(result, { configPath: cfg });
    assert.equal(fs.readFileSync(cfg, 'utf8'), content);
    assert.equal(modeOf(cfg), 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);
    assert.equal(fake.calls.length, 2, 'new file and old file are both dumped');
});

test('every rclone call uses --config first and --ask-password=false, on the temp file and the target', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN);
    const fake = createFakeRclone();
    await writeConfigAtomic({
        configPath: cfg, original: PLAIN, content: `${PLAIN}[c]\ntype = local\n`,
        changedNames: ['c'], runRclone: fake,
    });
    assert.equal(fake.calls.length, 2);
    for (const args of fake.calls) {
        assert.equal(args[0], '--config');
        assert.equal(args[2], '--ask-password=false');
        assert.deepEqual(args.slice(3), ['config', 'dump']);
    }
    assert.notEqual(fake.calls[0][1], cfg, 'new content is validated in the temp file, never in place');
    assert.equal(fake.calls[1][1], cfg, 'old content is dumped at the target path');
});

test('temp file lives in the target directory with the documented name, and is gone afterwards', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN);
    const seen = [];
    const fake = withHook(createFakeRclone(), (args) => {
        const file = args[1];
        seen.push({ file, exists: fs.existsSync(file), mode: file === cfg ? null : modeOf(file), listing: fs.readdirSync(dir).sort() });
    }, 'before');

    await writeConfigAtomic({
        configPath: cfg, original: PLAIN, content: `${PLAIN}[c]\ntype = local\n`,
        changedNames: ['c'], runRclone: fake,
    });

    const tmp = seen[0].file;
    assert.equal(path.dirname(tmp), dir);
    assert.match(path.basename(tmp), new RegExp(`^\\.rclone\\.conf\\.de_rclone-${process.pid}-[0-9a-f]+\\.tmp$`));
    assert.ok(seen[0].exists);
    assert.equal(seen[0].mode, 0o600);
    assert.equal(seen[0].listing.length, 2);
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);
});

test('two writes use distinct temp names', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    const names = [];
    const fake = withHook(createFakeRclone(), (args) => { if (args[1] !== cfg) names.push(args[1]); }, 'before');
    await writeConfigAtomic({ configPath: cfg, original: null, content: '[a]\ntype = x\n', changedNames: ['a'], runRclone: fake });
    await writeConfigAtomic({ configPath: cfg, original: '[a]\ntype = x\n', content: '[a]\ntype = x\n[b]\ntype = y\n', changedNames: ['b'], runRclone: fake });
    assert.equal(names.length, 2);
    assert.notEqual(names[0], names[1]);
});

test('symlinked config: link is kept, the link target is replaced, temp is created beside the target', async (t) => {
    const root = tmpDir(t);
    const realDir = path.join(root, 'dotfiles');
    const linkDir = path.join(root, 'config');
    fs.mkdirSync(realDir);
    fs.mkdirSync(linkDir);
    const real = path.join(realDir, 'rclone-real.conf');
    const link = path.join(linkDir, 'rclone.conf');
    fs.writeFileSync(real, PLAIN);
    fs.symlinkSync(real, link);
    const tmpDirs = [];
    const fake = withHook(createFakeRclone(), (args) => tmpDirs.push(path.dirname(args[1])), 'before');
    const content = `${PLAIN}[c]\ntype = local\n`;

    const result = await writeConfigAtomic({
        configPath: link, original: PLAIN, content, changedNames: ['c'], runRclone: fake,
    });

    assert.deepEqual(result, { configPath: fs.realpathSync(real) });
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the symlink must survive');
    assert.equal(fs.readlinkSync(link), real);
    assert.equal(fs.readFileSync(real, 'utf8'), content);
    assert.equal(fs.readFileSync(link, 'utf8'), content);
    assert.equal(fs.lstatSync(real).isSymbolicLink(), false);
    assert.deepEqual(tmpDirs, [fs.realpathSync(realDir), fs.realpathSync(realDir)]);
    assert.deepEqual(fs.readdirSync(realDir), ['rclone-real.conf']);
    assert.deepEqual(fs.readdirSync(linkDir), ['rclone.conf']);
});

test('remotes that are not in changedNames may differ textually (comments, whitespace, key order) but not semantically', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    const original = '[a]\ntype = s3\nregion = x\n\n[b]\ntype = local\n';
    fs.writeFileSync(cfg, original);
    const content = '# edited\n[b]\ntype=local\n\n[a]\n  region = x\n  type = s3\n[c]\ntype = local\n';
    await writeConfigAtomic({
        configPath: cfg, original, content, changedNames: ['c'], runRclone: createFakeRclone(),
    });
    assert.equal(fs.readFileSync(cfg, 'utf8'), content);
});

test('a remote in changedNames may differ arbitrarily (edit, delete, rename)', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    const original = '[a]\ntype = s3\n\n[b]\ntype = local\n\n[c]\ntype = local\n';
    fs.writeFileSync(cfg, original);
    // edit a, delete b, rename c -> d
    const content = '[a]\ntype = s3\nregion = new\n\n[d]\ntype = local\n';
    await writeConfigAtomic({
        configPath: cfg, original, content, changedNames: ['a', 'b', 'c', 'd'],
        expect: { present: ['a', 'd'], absent: ['b', 'c'] }, runRclone: createFakeRclone(),
    });
    assert.equal(fs.readFileSync(cfg, 'utf8'), content);
});

// ---------------------------------------------------------------- refusals

test('encrypted original: CONFIG_ENCRYPTED, bytes unchanged, rclone never called, nothing created', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, ENCRYPTED, { mode: 0o640 });
    fs.chmodSync(cfg, 0o640);
    const before = fs.readFileSync(cfg);
    const fake = createFakeRclone();

    const err = await rejectsWithError(writeConfigAtomic({
        configPath: cfg, original: ENCRYPTED, content: `${PLAIN}`, changedNames: ['a'], runRclone: fake,
    }), 'CONFIG_ENCRYPTED');

    assert.match(err.detail, /encrypted/);
    assert.equal(fake.calls.length, 0);
    assert.ok(Buffer.compare(fs.readFileSync(cfg), before) === 0);
    assert.equal(modeOf(cfg), 0o640);
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);
});

test('encrypted new content: CONFIG_ENCRYPTED, original untouched, rclone never called', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN);
    const fake = createFakeRclone();

    await rejectsWith(writeConfigAtomic({
        configPath: cfg, original: PLAIN, content: ENCRYPTED, changedNames: ['a'], runRclone: fake,
    }), 'CONFIG_ENCRYPTED');

    assert.equal(fake.calls.length, 0);
    assert.equal(fs.readFileSync(cfg, 'utf8'), PLAIN);
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);
});

test('encrypted content for a brand-new file (original null) is refused and nothing is created', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    await rejectsWith(writeConfigAtomic({
        configPath: cfg, original: null, content: ENCRYPTED, changedNames: [], runRclone: createFakeRclone(),
    }), 'CONFIG_ENCRYPTED');
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('rclone not installed: RCLONE_MISSING, nothing written, no temp left (existing and new file)', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN);

    const missing = createMissingRclone();
    const err = await rejectsWithError(writeConfigAtomic({
        configPath: cfg, original: PLAIN, content: `${PLAIN}[c]\ntype = local\n`, changedNames: ['c'], runRclone: missing,
    }), 'RCLONE_MISSING');
    assert.equal(err.detail, 'rclone was not found; install rclone (needed to validate configuration changes)');
    assert.equal(fs.readFileSync(cfg, 'utf8'), PLAIN);
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);

    const fresh = path.join(dir, 'new.conf');
    await rejectsWith(writeConfigAtomic({
        configPath: fresh, original: null, content: '[a]\ntype = x\n', changedNames: ['a'], runRclone: createMissingRclone(),
    }), 'RCLONE_MISSING');
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);
});

test('new content rclone cannot parse: CONFIG_INVALID, original untouched, no temp, temp path not leaked', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN);

    const err = await rejectsWithError(writeConfigAtomic({
        configPath: cfg, original: PLAIN, content: `${PLAIN}\nthis line has no separator\n`,
        changedNames: ['c'], runRclone: createFakeRclone(),
    }), 'CONFIG_INVALID');

    assert.match(err.detail, /could not parse line: <line hidden>/);
    assert.ok(!err.detail.includes('this line has no separator'), 'offending line must not be echoed');
    assert.ok(err.detail.includes(cfg), 'message refers to the config path');
    assert.ok(!err.detail.includes('.de_rclone-'), 'message must not mention the temp file');
    assert.equal(fs.readFileSync(cfg, 'utf8'), PLAIN);
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);
});

test('new file with unparsable content is never created', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    await rejectsWith(writeConfigAtomic({
        configPath: cfg, original: null, content: '[a\n', changedNames: ['a'], runRclone: createFakeRclone(),
    }), 'CONFIG_INVALID');
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('rclone output that is not a JSON object is CONFIG_INVALID', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    for (const stdout of ['', 'not json', '[]', 'null', '"x"', '42']) {
        await rejectsWith(writeConfigAtomic({
            configPath: cfg, original: null, content: '[a]\ntype = x\n', changedNames: ['a'],
            runRclone: async () => ({ stdout, stderr: '' }),
        }), 'CONFIG_INVALID');
    }
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('other rclone failures: CONFIG_INVALID with stderr trimmed and truncated to 500 chars', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    const failing = async () => {
        throw { error: Object.assign(new Error('Command failed'), { code: 1 }), stderr: `  ${'x'.repeat(2000)}  \n`, stdout: '' };
    };
    const err = await rejectsWithError(writeConfigAtomic({
        configPath: cfg, original: null, content: '[a]\ntype = x\n', changedNames: ['a'], runRclone: failing,
    }), 'CONFIG_INVALID');
    assert.ok(err.detail.includes('x'.repeat(500)));
    assert.ok(!err.detail.includes('x'.repeat(501)));
    assert.ok(!/\n\s*$/.test(err.detail));

    const silent = async () => {
        throw { error: Object.assign(new Error('Command failed: killed'), { code: null, killed: true }), stderr: '', stdout: '' };
    };
    const err2 = await rejectsWithError(writeConfigAtomic({
        configPath: cfg, original: null, content: '[a]\ntype = x\n', changedNames: ['a'], runRclone: silent,
    }), 'CONFIG_INVALID');
    assert.match(err2.detail, /Command failed: killed/);
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('existing config rclone cannot parse: refused, nothing modified', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    const broken = '[a]\ntype = s3\ngarbage line\n';
    fs.writeFileSync(cfg, broken);

    const err = await rejectsWithError(writeConfigAtomic({
        configPath: cfg, original: broken, content: '[a]\ntype = s3\n[b]\ntype = x\n', changedNames: ['b'], runRclone: createFakeRclone(),
    }), 'CONFIG_INVALID');

    assert.equal(err.detail, 'existing config cannot be parsed by rclone; refusing to modify it');
    assert.equal(fs.readFileSync(cfg, 'utf8'), broken);
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);
});

test('new content that drops, alters or adds a remote NOT in changedNames: CONFIG_INVALID naming it, no secrets', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN);
    const cases = [
        ['drops a', '[b]\ntype = local\n[c]\ntype = x\n', 'a'],
        ['alters a', '[a]\ntype = s3\nsecret_access_key = CHANGED\n[b]\ntype = local\n[c]\ntype = x\n', 'a'],
        ['adds a key to a', '[a]\ntype = s3\nsecret_access_key = TOPSECRET\nextra = 1\n[b]\ntype = local\n[c]\ntype = x\n', 'a'],
        ['truncates a value (hand-writer bug)', '[a]\ntype = s3\nsecret_access_key =\n[b]\ntype = local\n[c]\ntype = x\n', 'a'],
        ['sneaks in z', `${PLAIN}[c]\ntype = x\n[z]\ntype = x\n`, 'z'],
        ['drops a and b', '[c]\ntype = x\n', 'a, b'],
    ];
    for (const [label, content, names] of cases) {
        const err = await rejectsWithError(writeConfigAtomic({
            configPath: cfg, original: PLAIN, content, changedNames: ['c'], runRclone: createFakeRclone(),
        }), 'CONFIG_INVALID');
        assert.ok(err.detail.endsWith(`: ${names}`), `${label}: ${err.detail}`);
        assert.ok(!err.message.includes('TOPSECRET') && !err.message.includes('CHANGED'), `${label}: secret leaked`);
        assert.equal(fs.readFileSync(cfg, 'utf8'), PLAIN, label);
        assert.deepEqual(fs.readdirSync(dir), ['rclone.conf'], label);
    }
});

test('creating a file may not smuggle in remotes outside changedNames', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    const err = await rejectsWithError(writeConfigAtomic({
        configPath: cfg, original: null, content: '[a]\ntype = x\n[b]\ntype = y\n', changedNames: ['a'], runRclone: createFakeRclone(),
    }), 'CONFIG_INVALID');
    assert.ok(err.detail.endsWith(': b'));
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('expect.present / expect.absent violations are CONFIG_INVALID and name the offenders', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN);
    const content = `${PLAIN}[c]\ntype = local\n`;
    const base = { configPath: cfg, original: PLAIN, content, changedNames: ['c', 'd', 'e'] };

    const missing = await rejectsWithError(writeConfigAtomic({
        ...base, expect: { present: ['c', 'd', 'e'] }, runRclone: createFakeRclone(),
    }), 'CONFIG_INVALID');
    assert.ok(missing.detail.endsWith(': d, e'), missing.detail);

    const lingering = await rejectsWithError(writeConfigAtomic({
        ...base, expect: { absent: ['c', 'd'] }, runRclone: createFakeRclone(),
    }), 'CONFIG_INVALID');
    assert.ok(lingering.detail.endsWith(': c'), lingering.detail);

    // expect names are checked against rclone's view even when they are also unchanged remotes
    await rejectsWith(writeConfigAtomic({
        ...base, changedNames: ['c'], expect: { present: ['zzz'] }, runRclone: createFakeRclone(),
    }), 'CONFIG_INVALID');

    assert.equal(fs.readFileSync(cfg, 'utf8'), PLAIN);
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);

    // and a satisfied expectation passes
    await writeConfigAtomic({
        ...base, expect: { present: ['a', 'c'], absent: ['d', 'e'] }, runRclone: createFakeRclone(),
    });
    assert.equal(fs.readFileSync(cfg, 'utf8'), content);
});

// ---------------------------------------------------------------- concurrent modification

test('disk changed while rclone validated (after the dumps): CONFIG_CHANGED, intruder bytes kept, nothing of ours written', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN);
    const intruder = `${PLAIN}[x]\ntype = local\n`;
    const fake = withHook(createFakeRclone(), (args) => {
        if (args[1] === cfg) fs.writeFileSync(cfg, intruder);
    });

    const err = await rejectsWithError(writeConfigAtomic({
        configPath: cfg, original: PLAIN, content: `${PLAIN}[c]\ntype = local\n`, changedNames: ['c'], runRclone: fake,
    }), 'CONFIG_CHANGED');

    assert.equal(err.detail, 'config changed while it was being edited; no changes were made, retry');
    assert.equal(fs.readFileSync(cfg, 'utf8'), intruder);
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);
});

test('disk changed while the new file was validated: CONFIG_CHANGED rather than a bogus diff error', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN);
    const intruder = `${PLAIN}[x]\ntype = local\n`;
    const fake = withHook(createFakeRclone(), () => fs.writeFileSync(cfg, intruder), 'after');

    await rejectsWith(writeConfigAtomic({
        configPath: cfg, original: PLAIN, content: `${PLAIN}[c]\ntype = local\n`, changedNames: ['c'], runRclone: fake,
    }), 'CONFIG_CHANGED');
    assert.equal(fs.readFileSync(cfg, 'utf8'), intruder);
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);
});

test('single-byte change in the config after validation is detected', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN);
    const flipped = PLAIN.replace('local', 'locaL');
    const fake = withHook(createFakeRclone(), (args) => { if (args[1] === cfg) fs.writeFileSync(cfg, flipped); });
    await rejectsWith(writeConfigAtomic({
        configPath: cfg, original: PLAIN, content: `${PLAIN}[c]\ntype = local\n`, changedNames: ['c'], runRclone: fake,
    }), 'CONFIG_CHANGED');
    assert.equal(fs.readFileSync(cfg, 'utf8'), flipped);
});

test('config deleted while it was being edited: CONFIG_CHANGED, file not resurrected', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN);
    const fake = withHook(createFakeRclone(), (args) => { if (args[1] === cfg) fs.unlinkSync(cfg); });
    await rejectsWith(writeConfigAtomic({
        configPath: cfg, original: PLAIN, content: `${PLAIN}[c]\ntype = local\n`, changedNames: ['c'], runRclone: fake,
    }), 'CONFIG_CHANGED');
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('file appeared although the caller saw none (original null): CONFIG_CHANGED, other writer wins', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    const theirs = '[theirs]\ntype = local\n';
    const fake = withHook(createFakeRclone(), () => fs.writeFileSync(cfg, theirs));
    await rejectsWith(writeConfigAtomic({
        configPath: cfg, original: null, content: '[a]\ntype = local\n', changedNames: ['a'], runRclone: fake,
    }), 'CONFIG_CHANGED');
    assert.equal(fs.readFileSync(cfg, 'utf8'), theirs);
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);
});

test('stale original (file already differs when the write starts): CONFIG_CHANGED before anything else', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    const current = `${PLAIN}[x]\ntype = local\n`;
    fs.writeFileSync(cfg, current);
    await rejectsWith(writeConfigAtomic({
        configPath: cfg, original: PLAIN, content: `${PLAIN}[c]\ntype = local\n`, changedNames: ['c'], runRclone: createFakeRclone(),
    }), 'CONFIG_CHANGED');
    assert.equal(fs.readFileSync(cfg, 'utf8'), current);
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);
});

// ---------------------------------------------------------------- filesystem failure injection

function errno(code, message = code) {
    return Object.assign(new Error(message), { code });
}

test('fchmod failures that mean "no permission bits here" are tolerated; the call targets 0600', async (t) => {
    for (const code of ['EPERM', 'ENOTSUP', 'EINVAL', 'ENOSYS']) {
        const dir = tmpDir(t);
        const cfg = path.join(dir, 'rclone.conf');
        fs.writeFileSync(cfg, PLAIN);
        const modes = [];
        const fsImpl = { ...fs, fchmodSync(fd, mode) { modes.push(mode); throw errno(code); } };
        const content = `${PLAIN}[c]\ntype = local\n`;
        await writeConfigAtomic({
            configPath: cfg, original: PLAIN, content, changedNames: ['c'], runRclone: createFakeRclone({ fsImpl: fs }), fsImpl,
        });
        assert.deepEqual(modes, [0o600], code);
        assert.equal(fs.readFileSync(cfg, 'utf8'), content, code);
        assert.deepEqual(fs.readdirSync(dir), ['rclone.conf'], code);
    }
});

test('other fchmod errors: CONFIG_WRITE_FAILED, original untouched, temp removed, rclone never called', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN);
    const fsImpl = { ...fs, fchmodSync() { throw errno('EIO', 'input/output error'); } };
    const fake = createFakeRclone();

    const err = await rejectsWithError(writeConfigAtomic({
        configPath: cfg, original: PLAIN, content: `${PLAIN}[c]\ntype = local\n`, changedNames: ['c'], runRclone: fake, fsImpl,
    }), 'CONFIG_WRITE_FAILED');

    assert.match(err.detail, /input\/output error/);
    assert.equal(fake.calls.length, 0);
    assert.equal(fs.readFileSync(cfg, 'utf8'), PLAIN);
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);
});

test('the original file is never chmod-ed (only the temp fd is)', async (t) => {
    setUmask(t, 0);
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN);
    const calls = [];
    const fsImpl = {
        ...fs,
        chmodSync(...a) { calls.push(['chmodSync', ...a]); return fs.chmodSync(...a); },
        fchmodSync(...a) { calls.push(['fchmodSync']); return fs.fchmodSync(...a); },
        lchmodSync: undefined,
    };
    await writeConfigAtomic({
        configPath: cfg, original: PLAIN, content: `${PLAIN}[c]\ntype = local\n`, changedNames: ['c'], runRclone: createFakeRclone(), fsImpl,
    });
    assert.deepEqual(calls, [['fchmodSync']]);
});

test('rename failure: CONFIG_WRITE_FAILED, original untouched, temp removed', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN);
    const renames = [];
    const fsImpl = { ...fs, renameSync(from, to) { renames.push([from, to]); throw errno('EXDEV', 'cross-device link not permitted'); } };

    const err = await rejectsWithError(writeConfigAtomic({
        configPath: cfg, original: PLAIN, content: `${PLAIN}[c]\ntype = local\n`, changedNames: ['c'], runRclone: createFakeRclone(), fsImpl,
    }), 'CONFIG_WRITE_FAILED');

    assert.match(err.detail, /cross-device/);
    assert.equal(renames.length, 1);
    assert.equal(renames[0][1], cfg);
    assert.equal(path.dirname(renames[0][0]), dir);
    assert.equal(fs.readFileSync(cfg, 'utf8'), PLAIN);
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);
});

test('temp write failure (disk full): CONFIG_WRITE_FAILED, temp removed, fd closed', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN);
    const opened = new Set();
    const fsImpl = {
        ...fs,
        openSync(...a) { const fd = fs.openSync(...a); opened.add(fd); return fd; },
        closeSync(fd) { opened.delete(fd); return fs.closeSync(fd); },
        writeFileSync() { throw errno('ENOSPC', 'no space left on device'); },
    };
    const err = await rejectsWithError(writeConfigAtomic({
        configPath: cfg, original: PLAIN, content: `${PLAIN}[c]\ntype = local\n`, changedNames: ['c'], runRclone: createFakeRclone(), fsImpl,
    }), 'CONFIG_WRITE_FAILED');
    assert.match(err.detail, /no space left/);
    assert.equal(opened.size, 0, 'no leaked file descriptors');
    assert.equal(fs.readFileSync(cfg, 'utf8'), PLAIN);
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);
});

test('no file descriptors leak on a successful write (temp fd and directory fd are closed)', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN);
    const opened = new Set();
    let opens = 0;
    const fsImpl = {
        ...fs,
        openSync(...a) { const fd = fs.openSync(...a); opened.add(fd); opens++; return fd; },
        closeSync(fd) { opened.delete(fd); return fs.closeSync(fd); },
    };
    await writeConfigAtomic({
        configPath: cfg, original: PLAIN, content: `${PLAIN}[c]\ntype = local\n`, changedNames: ['c'], runRclone: createFakeRclone(), fsImpl,
    });
    assert.equal(opens, 2, 'temp file + directory sync');
    assert.equal(opened.size, 0);
});

test('missing parent directory: CONFIG_WRITE_FAILED (the module does not create directories)', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'nope', 'rclone.conf');
    await rejectsWith(writeConfigAtomic({
        configPath: cfg, original: null, content: '[a]\ntype = x\n', changedNames: ['a'], runRclone: createFakeRclone(),
    }), 'CONFIG_WRITE_FAILED');
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('directory fsync failure after a successful rename does not fail the write', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    fs.writeFileSync(cfg, PLAIN);
    const content = `${PLAIN}[c]\ntype = local\n`;
    let renamed = false;
    const fsImpl = {
        ...fs,
        renameSync(...a) { fs.renameSync(...a); renamed = true; },
        openSync(file, ...rest) { if (renamed && file === dir) throw errno('EACCES'); return fs.openSync(file, ...rest); },
    };
    await writeConfigAtomic({
        configPath: cfg, original: PLAIN, content, changedNames: ['c'], runRclone: createFakeRclone(), fsImpl,
    });
    assert.equal(fs.readFileSync(cfg, 'utf8'), content);
});

test('dangling symlink config path: CONFIG_WRITE_FAILED, nothing created', async (t) => {
    const dir = tmpDir(t);
    const link = path.join(dir, 'rclone.conf');
    fs.symlinkSync(path.join(dir, 'missing-target.conf'), link);
    await rejectsWith(writeConfigAtomic({
        configPath: link, original: null, content: '[a]\ntype = x\n', changedNames: ['a'], runRclone: createFakeRclone(),
    }), 'CONFIG_WRITE_FAILED');
    assert.deepEqual(fs.readdirSync(dir), ['rclone.conf']);
    assert.ok(fs.lstatSync(link).isSymbolicLink());
});

test('programmer errors (bad argument types) throw TypeError before touching the disk', async (t) => {
    const dir = tmpDir(t);
    const cfg = path.join(dir, 'rclone.conf');
    const ok = { configPath: cfg, original: null, content: '[a]\ntype = x\n', changedNames: ['a'], runRclone: createFakeRclone() };
    await assert.rejects(writeConfigAtomic({ ...ok, content: undefined }), TypeError);
    await assert.rejects(writeConfigAtomic({ ...ok, original: undefined }), TypeError);
    await assert.rejects(writeConfigAtomic({ ...ok, changedNames: 'a' }), TypeError);
    await assert.rejects(writeConfigAtomic({ ...ok, configPath: '' }), TypeError);
    assert.deepEqual(fs.readdirSync(dir), []);
});

// ---------------------------------------------------------------- integration with the real rclone binary

const hasRclone = spawnSync('rclone', ['version'], { stdio: 'ignore' }).status === 0;
// `rclone config encryption` appeared in newer releases (the apt rclone 1.60 lacks it).
const canEncryptConfig = hasRclone && /\bencryption\b/.test(spawnSync('rclone', ['config', '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir() } }).stdout || '');

// Isolated environment: rclone must never see the developer's HOME or config.
function realRclone(t) {
    const home = tmpDir(t);
    const cfgDir = path.join(home, 'cfg');
    fs.mkdirSync(cfgDir);
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home };
    const run = (args, options = {}) => new Promise((resolve, reject) => {
        execFile('rclone', args, { ...options, env, encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error) reject({ error, stderr, stdout });
            else resolve({ stdout, stderr });
        });
    });
    return { cfgDir, run, dump: async (file) => JSON.parse((await run(['--config', file, '--ask-password=false', 'config', 'dump'])).stdout) };
}

test('integration: real rclone validates add/delete and refuses corrupting writes', { skip: hasRclone ? false : 'rclone not on PATH' }, async (t) => {
    const { cfgDir, run, dump } = realRclone(t);
    const cfg = path.join(cfgDir, 'rclone.conf');

    // add to a brand-new file
    const first = '[a]\ntype = local\n';
    await writeConfigAtomic({ configPath: cfg, original: null, content: first, changedNames: ['a'], expect: { present: ['a'] }, runRclone: run });
    assert.deepEqual(Object.keys(await dump(cfg)), ['a']);
    assert.equal(modeOf(cfg), 0o600);

    // add a second remote
    const second = `${first}\n[b]\ntype = local\nnounc = true\n`;
    await writeConfigAtomic({ configPath: cfg, original: first, content: second, changedNames: ['b'], expect: { present: ['a', 'b'] }, runRclone: run });
    assert.deepEqual(Object.keys(await dump(cfg)).sort(), ['a', 'b']);

    // delete one
    const third = '[b]\ntype = local\nnounc = true\n';
    await writeConfigAtomic({ configPath: cfg, original: second, content: third, changedNames: ['a'], expect: { absent: ['a'], present: ['b'] }, runRclone: run });
    assert.deepEqual(await dump(cfg), { b: { type: 'local', nounc: 'true' } });

    // a corrupting write is refused by real rclone and leaves the file alone
    await rejectsWith(writeConfigAtomic({ configPath: cfg, original: third, content: `${third}garbage without separator\n`, changedNames: ['c'], runRclone: run }), 'CONFIG_INVALID');
    assert.equal(fs.readFileSync(cfg, 'utf8'), third);

    // an unintended change of an unchanged remote is refused
    await rejectsWith(writeConfigAtomic({ configPath: cfg, original: third, content: '[b]\ntype = local\n[c]\ntype = local\n', changedNames: ['c'], runRclone: run }), 'CONFIG_INVALID');
    assert.equal(fs.readFileSync(cfg, 'utf8'), third);
    assert.deepEqual(fs.readdirSync(cfgDir), ['rclone.conf']);

});

test('integration: a config encrypted by real rclone is refused and left byte-identical', { skip: canEncryptConfig ? false : 'rclone is missing or too old for `config encryption`' }, async (t) => {
    const { cfgDir, run } = realRclone(t);
    const third = '[b]\ntype = local\nnounc = true\n';
    const encPath = path.join(cfgDir, 'encrypted.conf');
    fs.writeFileSync(encPath, third);
    await run(['--config', encPath, 'config', 'encryption', 'set', '--password-command', 'echo pw']);
    const encrypted = fs.readFileSync(encPath, 'utf8');
    assert.equal(detectConfigFormat(encrypted), 'encrypted', 'the fixture must really be encrypted by rclone');
    const bytes = fs.readFileSync(encPath);

    await rejectsWith(writeConfigAtomic({
        configPath: encPath, original: encrypted, content: `${third}[c]\ntype = local\n`, changedNames: ['c'], runRclone: run,
    }), 'CONFIG_ENCRYPTED');
    assert.ok(Buffer.compare(fs.readFileSync(encPath), bytes) === 0);
    assert.deepEqual(fs.readdirSync(cfgDir), ['encrypted.conf']);
});
