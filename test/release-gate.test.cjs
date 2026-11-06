'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { checkRelease, fetchRelease, run, requiredAssets } = require('../scripts/release-gate.cjs');

const VERSION = '1.2.9';
const TAG = `v${VERSION}`;
const draft = (names = requiredAssets(VERSION)) => ({
  tagName: TAG,
  isDraft: true,
  assets: names.map(name => ({ name })),
});
const base = { tag: TAG, version: VERSION, lockVersion: VERSION };

test('no release: full gate fails, --pre passes', () => {
  const full = checkRelease({ ...base, release: null });
  assert.equal(full.ok, false);
  assert.match(full.problems.join('\n'), /No GitHub release found/);
  assert.deepEqual(checkRelease({ ...base, release: null, pre: true }), { ok: true, problems: [] });
});

test('draft with both assets passes the full gate', () => {
  assert.deepEqual(checkRelease({ ...base, release: draft() }), { ok: true, problems: [] });
});

test('published release fails both modes', () => {
  for (const pre of [false, true]) {
    const r = checkRelease({ ...base, release: { ...draft(), isDraft: false }, pre });
    assert.equal(r.ok, false, `pre=${pre}`);
    assert.match(r.problems.join('\n'), /published release already exists/);
  }
});

test('published release with assets still fails (it was not produced by this run)', () => {
  const r = checkRelease({ ...base, release: { ...draft(), isDraft: false } });
  assert.equal(r.ok, false);
});

test('missing assets are each reported on a draft', () => {
  const noAppImage = checkRelease({ ...base, release: draft(['latest-linux.yml']) });
  assert.equal(noAppImage.ok, false);
  assert.deepEqual(noAppImage.problems.length, 1);
  assert.match(noAppImage.problems[0], /de_rclone-1\.2\.9\.AppImage/);

  const noYml = checkRelease({ ...base, release: draft(['de_rclone-1.2.9.AppImage']) });
  assert.equal(noYml.problems.length, 1);
  assert.match(noYml.problems[0], /latest-linux\.yml/);

  const none = checkRelease({ ...base, release: draft([]) });
  assert.equal(none.problems.length, 2);

  const wrongVersion = checkRelease({ ...base, release: draft(['de_rclone-1.2.8.AppImage', 'latest-linux.yml']) });
  assert.equal(wrongVersion.ok, false);

  const noAssetsField = checkRelease({ ...base, release: { tagName: TAG, isDraft: true } });
  assert.equal(noAssetsField.problems.length, 2);
});

test('--pre does not require assets on a draft', () => {
  assert.equal(checkRelease({ ...base, release: draft([]), pre: true }).ok, true);
});

test('tag, version and lock mismatches fail in both modes', () => {
  for (const pre of [false, true]) {
    const tagBad = checkRelease({ ...base, tag: 'v1.2.10', release: null, pre: true });
    assert.equal(tagBad.ok, false);
    assert.match(tagBad.problems[0], /must be v1\.2\.9/);

    const lockBad = checkRelease({ ...base, lockVersion: '1.2.8', release: draft(), pre });
    assert.equal(lockBad.ok, false);
    assert.match(lockBad.problems[0], /package-lock\.json version \(1\.2\.8\)/);

    const rootBad = checkRelease({ ...base, lockRootVersion: '1.2.8', release: draft(), pre });
    assert.equal(rootBad.ok, false);
    assert.match(rootBad.problems[0], /packages\[""\]/);
  }
  assert.equal(checkRelease({ ...base, tag: '1.2.9', release: draft() }).ok, false, 'tag needs v prefix');
  assert.equal(checkRelease({ ...base, lockVersion: undefined, release: draft() }).ok, false);
});

test('release tagName mismatch is reported', () => {
  const r = checkRelease({ ...base, release: { ...draft(), tagName: 'v9.9.9' } });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /does not match/);
});

test('fetchRelease: not found -> null, other failures throw, success parses', () => {
  const calls = [];
  assert.deepEqual(
    fetchRelease(TAG, args => { calls.push(args); return JSON.stringify(draft()); }),
    draft()
  );
  assert.deepEqual(calls[0], ['release', 'view', TAG, '--json', 'isDraft,assets,tagName']);

  assert.equal(fetchRelease(TAG, () => {
    throw Object.assign(new Error('Command failed'), { stderr: 'release not found\n' });
  }), null);

  assert.throws(() => fetchRelease(TAG, () => {
    throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 401: Bad credentials\n' });
  }), /Bad credentials/);
});

function makeRoot(version = VERSION, lock = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'de-rclone-gate-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    version, packages: { '': { version } }, ...lock,
  }));
  return dir;
}

function capture() {
  const out = { text: '', write(s) { this.text += s; } };
  return out;
}

test('run(): exit codes with an injected runner', () => {
  const root = makeRoot();
  try {
    const go = (argv, release) => {
      const stdout = capture(); const stderr = capture();
      const code = run(argv, {
        root, stdout, stderr,
        runGh: () => {
          if (release === null) throw Object.assign(new Error('x'), { stderr: 'release not found' });
          return JSON.stringify(release);
        },
      });
      return { code, stdout: stdout.text, stderr: stderr.text };
    };
    assert.equal(go([TAG], draft()).code, 0);
    assert.equal(go([TAG], null).code, 1);
    assert.equal(go(['--pre', TAG], null).code, 0);
    assert.match(go(['--pre', TAG], null).stdout, /pre-build/);
    assert.equal(go([TAG], { ...draft(), isDraft: false }).code, 1);
    assert.match(go([TAG], draft(['latest-linux.yml'])).stderr, /missing asset/);
    assert.equal(go(['v0.0.1'], null).code, 1);
    assert.equal(go([], null).code, 2);
    assert.equal(go(['--pre'], null).code, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run(): lockfile version mismatch fails the gate with a clear message', () => {
  const root = makeRoot(VERSION, { version: '1.2.8' });
  try {
    const stderr = capture();
    const code = run([TAG], { root, stdout: capture(), stderr, runGh: () => JSON.stringify(draft()) });
    assert.equal(code, 1);
    assert.match(stderr.text, /package-lock\.json version \(1\.2\.8\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run(): a gh failure other than not-found fails the gate', () => {
  const root = makeRoot();
  try {
    const stderr = capture();
    const code = run([TAG], {
      root, stdout: capture(), stderr,
      runGh: () => { throw Object.assign(new Error('boom'), { stderr: 'HTTP 500' }); },
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /HTTP 500/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- CLI through child_process with a fake `gh` first (and only) on PATH ---

const FAKE_GH = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake-gh 0.0"; exit 0; fi
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
case "$FAKE_GH_MODE" in
  notfound) echo "release not found" >&2; exit 1 ;;
  error) echo "HTTP 401: Bad credentials" >&2; exit 1 ;;
  *) while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done < "$FAKE_GH_JSON" ;;
esac
`;

function cliEnv(binDir, extra) {
  // PATH is only the temp dir; HOME is a temp dir so nothing real can be reached.
  return { PATH: binDir, HOME: binDir, ...extra };
}

test('CLI via child process with fake gh', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'de-rclone-gate-bin-'));
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'release-gate.cjs'), path.join(root, 'scripts', 'release-gate.cjs'));
    const gh = path.join(bin, 'gh');
    fs.writeFileSync(gh, FAKE_GH, { mode: 0o755 });
    const jsonFile = path.join(bin, 'release.json');
    const logFile = path.join(bin, 'gh.log');

    // Prove `gh` resolves to the fake before running anything that could reach GitHub.
    assert.match(execFileSync('gh', ['--version'], { env: cliEnv(bin, {}), encoding: 'utf8' }), /^fake-gh/);

    const cli = (args, mode, release) => {
      if (release !== undefined) fs.writeFileSync(jsonFile, JSON.stringify(release));
      fs.writeFileSync(logFile, '');
      const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'release-gate.cjs'), ...args], {
        env: cliEnv(bin, { FAKE_GH_MODE: mode, FAKE_GH_JSON: jsonFile, FAKE_GH_LOG: logFile }),
        encoding: 'utf8',
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, log: fs.readFileSync(logFile, 'utf8') };
    };

    let r = cli([TAG], 'json', draft());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.log.trim(), `release view ${TAG} --json isDraft,assets,tagName`);

    r = cli([TAG], 'notfound');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No GitHub release found/);

    r = cli(['--pre', TAG], 'notfound');
    assert.equal(r.status, 0, r.stderr);

    r = cli(['--pre', TAG], 'json', { ...draft([]), isDraft: true });
    assert.equal(r.status, 0, r.stderr);

    r = cli([TAG], 'json', { ...draft(), isDraft: false });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /published release already exists/);

    r = cli(['--pre', TAG], 'json', { ...draft(), isDraft: false });
    assert.equal(r.status, 1);

    r = cli([TAG], 'json', draft(['de_rclone-1.2.9.AppImage']));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /latest-linux\.yml/);

    r = cli([TAG], 'error');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Bad credentials/);

    r = cli(['v9.9.9'], 'notfound');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be v1\.2\.9/);

    r = cli([], 'json', draft());
    assert.equal(r.status, 2);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository package.json and package-lock.json versions agree and release:gate is wired', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.scripts['release:gate'], 'node scripts/release-gate.cjs');
  assert.equal(pkg.build.publish[0].releaseType, 'draft');
  assert.equal(pkg.build.linux.syncDesktopName, true);
  assert.ok(pkg.desktopName);
});
