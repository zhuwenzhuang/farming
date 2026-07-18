#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs');

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

function relativeBundleEntry(entry) {
  const normalized = String(entry || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new Error(`release archive contains an unsafe path: ${entry}`);
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some(part => part === '..')) {
    throw new Error(`release archive contains path traversal: ${entry}`);
  }
  return parts.slice(1).join('/');
}

function verifyArchiveEntries(entries) {
  const roots = new Set();
  const forbidden = /^(?:\.git|\.gc|\.beads|\.codex|\.claude|\.farming|\.tmp|tests|backend\/tests|docs\/internal)(?:\/|$)|^fa-[^/]*(?:\/|$)/;
  entries.forEach(entry => {
    const parts = String(entry || '').replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts[0]) roots.add(parts[0]);
    const relative = relativeBundleEntry(entry);
    if (forbidden.test(relative)) {
      throw new Error(`release archive contains forbidden private or test content: ${entry}`);
    }
  });
  if (roots.size !== 1) {
    throw new Error(`release archive must contain exactly one top-level directory, found ${roots.size}`);
  }
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

  const installerEntry = findBundleEntry(entries, '/scripts/install-release.sh');
  const browserProtocolEntry = findBundleEntry(entries, '/shared/browser-protocol.js');
  return {
    entries,
    releaseEntry,
    installerEntry,
    browserProtocolEntry,
    release: readArchiveJson(archivePath, releaseEntry),
  };
}

function verifyReleaseBundle(archivePath) {
  const bundle = readBundleRelease(archivePath);
  verifyArchiveEntries(bundle.entries);
  if (bundle.release.type !== 'app-bundle') {
    throw new Error(`release archive is not an app bundle: ${archivePath}`);
  }
  if (bundle.release.dirty !== false) {
    throw new Error(`release archive must be built from a clean working tree: ${archivePath}`);
  }
  if (!bundle.release.releaseVersion || bundle.release.releaseVersion !== bundle.release.packageVersion) {
    throw new Error(`release and package versions do not match: ${archivePath}`);
  }
  if (!bundle.installerEntry) {
    throw new Error(`release archive is missing scripts/install-release.sh: ${archivePath}`);
  }
  if (!bundle.browserProtocolEntry) {
    throw new Error(`release archive is missing shared/browser-protocol.js: ${archivePath}`);
  }
  return bundle;
}

function main() {
  const archivePath = process.argv[2];
  if (!archivePath) {
    console.error('Usage: node scripts/verify-release-bundle.js <farming-release.tar.gz>');
    process.exit(2);
  }
  const bundle = verifyReleaseBundle(archivePath);
  console.log(`Verified app bundle ${archivePath}: version ${bundle.release.releaseVersion || 'unknown'}`);
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
  verifyArchiveEntries,
  verifyReleaseBundle,
};
