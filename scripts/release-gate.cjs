#!/usr/bin/env node
'use strict';

// Release gate for tagged builds.
//
//   node scripts/release-gate.cjs --pre <tag>   before building: versions match and
//                                               no *published* release exists yet
//   node scripts/release-gate.cjs <tag>         after `electron-builder --publish always`:
//                                               a draft release holding both updater assets
//
// electron-builder skips the upload (and still exits 0) when a published release
// already exists for the tag, so publishing without this check could ship a release
// that has no AppImage and no latest-linux.yml.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RELEASE_FIELDS = 'isDraft,assets,tagName';

function requiredAssets(version) {
  return [`de_rclone-${version}.AppImage`, 'latest-linux.yml'];
}

/**
 * @param {object} input
 * @param {string} input.tag Git tag being released.
 * @param {string} input.version package.json version.
 * @param {string} input.lockVersion package-lock.json top-level version.
 * @param {string} [input.lockRootVersion] package-lock.json packages[""].version (checked when given).
 * @param {{isDraft: boolean, assets: {name: string}[], tagName?: string}|null} input.release
 *   Parsed `gh release view <tag> --json isDraft,assets,tagName`, or null when no release exists.
 * @param {boolean} [input.pre] Pre-build mode: assets are not required; a draft or no release is fine.
 * @returns {{ok: boolean, problems: string[]}}
 */
function checkRelease({ tag, version, lockVersion, lockRootVersion, release, pre = false }) {
  const problems = [];

  if (typeof version !== 'string' || version === '') {
    problems.push('package.json has no version');
  } else if (tag !== `v${version}`) {
    problems.push(`Release tag must be v${version}, received ${tag}`);
  }
  if (lockVersion !== version) {
    problems.push(`package-lock.json version (${lockVersion}) does not match package.json version (${version})`);
  }
  if (lockRootVersion !== undefined && lockRootVersion !== version) {
    problems.push(`package-lock.json packages[""] version (${lockRootVersion}) does not match package.json version (${version})`);
  }

  if (release == null) {
    if (!pre) {
      problems.push(`No GitHub release found for ${tag}; electron-builder did not create the draft`);
    }
  } else {
    if (release.tagName !== undefined && release.tagName !== tag) {
      problems.push(`Release tag ${release.tagName} does not match ${tag}`);
    }
    if (release.isDraft !== true) {
      problems.push(
        `A published release already exists for ${tag}, so electron-builder skipped the upload. ` +
        'Use a new tag, or delete/reset the release to a draft and re-run.'
      );
    } else if (!pre) {
      const names = new Set((Array.isArray(release.assets) ? release.assets : []).map(asset => asset && asset.name));
      for (const required of requiredAssets(version)) {
        if (!names.has(required)) {
          problems.push(`Draft release ${tag} is missing asset ${required}`);
        }
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

function defaultRunGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Returns the parsed release, or null when GitHub reports it does not exist. */
function fetchRelease(tag, runGh) {
  let out;
  try {
    out = runGh(['release', 'view', tag, '--json', RELEASE_FIELDS]);
  } catch (error) {
    const text = `${error && error.stderr ? error.stderr : ''}${error && error.message ? error.message : ''}`;
    if (/release not found/i.test(text)) return null;
    throw new Error(`gh release view ${tag} failed: ${text.trim() || 'unknown error'}`);
  }
  return JSON.parse(String(out));
}

function readVersions(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  return {
    version: pkg.version,
    lockVersion: lock.version,
    lockRootVersion: lock.packages && lock.packages[''] ? lock.packages[''].version : undefined,
  };
}

/** @returns {number} process exit code */
function run(argv, { root = path.join(__dirname, '..'), runGh = defaultRunGh, stdout = process.stdout, stderr = process.stderr } = {}) {
  const pre = argv.includes('--pre');
  const positional = argv.filter(arg => arg !== '--pre');
  if (positional.length !== 1 || positional[0] === '') {
    stderr.write('Usage: release-gate.cjs [--pre] <tag>\n');
    return 2;
  }
  const tag = positional[0];

  let result;
  try {
    const versions = readVersions(root);
    const release = fetchRelease(tag, runGh);
    result = checkRelease({ tag, ...versions, release, pre });
  } catch (error) {
    stderr.write(`release gate error: ${error.message}\n`);
    return 1;
  }

  if (!result.ok) {
    for (const problem of result.problems) stderr.write(`release gate: ${problem}\n`);
    return 1;
  }
  stdout.write(`release gate ${pre ? '(pre-build) ' : ''}passed for ${tag}\n`);
  return 0;
}

module.exports = { checkRelease, requiredAssets, fetchRelease, readVersions, run };

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}
