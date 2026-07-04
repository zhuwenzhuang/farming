#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tarOutput(args, options = {}) {
  try {
    return execFileSync('tar', args, {
      encoding: options.encoding || 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : '';
    const wrapped = new Error(stderr || error.message || `tar failed: ${args.join(' ')}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function archiveEntries(archivePath) {
  return tarOutput(['-tzf', archivePath])
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function readArchiveJson(archivePath, entry) {
  return JSON.parse(tarOutput(['-xOf', archivePath, entry]));
}

function findBundleEntry(entries, suffix) {
  return entries.find(entry => entry.endsWith(suffix) && entry.split('/').length >= 2) || '';
}

function readBundleRelease(archivePath) {
  if (!archivePath || !fs.existsSync(archivePath)) {
    throw new Error(`release archive not found: ${archivePath || '(missing)'}`);
  }

  const entries = archiveEntries(archivePath);
  const releaseEntry = findBundleEntry(entries, '/RELEASE.json');
  if (!releaseEntry) {
    throw new Error(`release archive is missing RELEASE.json: ${archivePath}`);
  }

  const glibcEntry = findBundleEntry(entries, '/vendor/glibc228-lib.tar.gz');
  const installerEntry = findBundleEntry(entries, '/scripts/install-release.sh');
  return {
    entries,
    releaseEntry,
    glibcEntry,
    installerEntry,
    release: readArchiveJson(archivePath, releaseEntry),
  };
}

function verifyNestedGlibcArchive(archivePath, glibcEntry) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-release-verify.'));
  try {
    tarOutput(['-xzf', archivePath, '-C', tmpDir, glibcEntry]);
    const glibcArchive = path.join(tmpDir, glibcEntry);
    const nestedEntries = archiveEntries(glibcArchive);
    if (!nestedEntries.some(entry => /(^|\/)ld-2\.28\.so$/.test(entry))) {
      throw new Error(`bundled glibc archive does not contain ld-2.28.so: ${glibcEntry}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function verifyReleaseBundle(archivePath) {
  const bundle = readBundleRelease(archivePath);
  if (bundle.release.type !== 'app-bundle') {
    throw new Error(`release archive is not an app bundle: ${archivePath}`);
  }
  if (bundle.release.bundledGlibc !== true) {
    throw new Error(`release archive does not declare bundledGlibc=true: ${archivePath}`);
  }
  if (!bundle.installerEntry) {
    throw new Error(`release archive is missing scripts/install-release.sh: ${archivePath}`);
  }
  if (!bundle.glibcEntry) {
    throw new Error(`release archive is missing vendor/glibc228-lib.tar.gz: ${archivePath}`);
  }
  verifyNestedGlibcArchive(archivePath, bundle.glibcEntry);
  return bundle;
}

function main() {
  const archivePath = process.argv[2];
  if (!archivePath) {
    console.error('Usage: node scripts/verify-release-bundle.js <farming-release.tar.gz>');
    process.exit(2);
  }
  const bundle = verifyReleaseBundle(archivePath);
  console.log(`Verified app bundle ${archivePath}: glibc bundled, version ${bundle.release.releaseVersion || 'unknown'}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}

module.exports = {
  archiveEntries,
  readBundleRelease,
  verifyReleaseBundle,
};
