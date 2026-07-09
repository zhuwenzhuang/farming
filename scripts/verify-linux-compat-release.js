#!/usr/bin/env node
const { execFileSync } = require('child_process');
const { verifyReleaseBundle } = require('./verify-release-bundle');

const PROFILE = 'linux-x64-glibc217';
const MAX_GLIBC = [2, 17];

function compareVersion(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function verifyLinuxCompatRelease(archivePath) {
  const bundle = verifyReleaseBundle(archivePath);
  const { release, entries } = bundle;
  if (release.platform !== 'linux' || release.arch !== 'x64') {
    throw new Error('compatibility bundle must target linux-x64');
  }
  if (release.compatibilityProfile !== PROFILE) {
    throw new Error(`compatibility bundle must use profile ${PROFILE}`);
  }
  if (release.bundledNodeModules !== true) {
    throw new Error('compatibility bundle must include production dependencies');
  }

  const ptyEntry = entries.find(entry => entry.endsWith('/node_modules/node-pty/build/Release/pty.node'));
  if (!ptyEntry) {
    throw new Error('compatibility bundle is missing the source-built linux-x64 node-pty module');
  }
  const nativeModule = execFileSync('tar', ['-xOf', archivePath, ptyEntry], {
    encoding: 'latin1',
    maxBuffer: 20 * 1024 * 1024,
  });
  const versions = [...nativeModule.matchAll(/GLIBC_(\d+)\.(\d+)/g)]
    .map(match => [Number(match[1]), Number(match[2])]);
  const newest = versions.sort(compareVersion).at(-1);
  if (!newest) {
    throw new Error('could not determine the node-pty glibc ABI requirement');
  }
  if (compareVersion(newest, MAX_GLIBC) > 0) {
    throw new Error(`node-pty requires GLIBC_${newest.join('.')}; expected GLIBC_2.17 or older`);
  }
  return bundle;
}

function main() {
  const archivePath = process.argv[2];
  if (!archivePath) {
    console.error('Usage: node scripts/verify-linux-compat-release.js <farming-linux-x64-glibc217.tar.gz>');
    process.exit(2);
  }
  const bundle = verifyLinuxCompatRelease(archivePath);
  console.log(`Verified ${PROFILE} bundle ${archivePath}: version ${bundle.release.releaseVersion}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}

module.exports = { verifyLinuxCompatRelease };
