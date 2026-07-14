#!/usr/bin/env node
const { execFileSync } = require('child_process');
const { verifyReleaseBundle } = require('./verify-release-bundle');

const PROFILE = 'linux-x64-legacy-glibc228';

function verifyLinuxLegacyRelease(archivePath) {
  const bundle = verifyReleaseBundle(archivePath);
  const { release, entries } = bundle;
  if (release.platform !== 'linux' || release.arch !== 'x64') {
    throw new Error('legacy compatibility bundle must target linux-x64');
  }
  if (release.compatibilityProfile !== PROFILE || release.bundledGlibcRuntime !== true) {
    throw new Error(`legacy compatibility bundle must use profile ${PROFILE} with its glibc runtime`);
  }
  if (release.updateMethod !== 'npm') {
    throw new Error('legacy compatibility bundle must bootstrap into npm-managed updates');
  }
  const runtimeEntry = entries.find(entry => entry.endsWith('/vendor/glibc228-lib.tar.gz'));
  if (!runtimeEntry) {
    throw new Error('legacy compatibility bundle is missing vendor/glibc228-lib.tar.gz');
  }
  const runtime = execFileSync('tar', ['-xOf', archivePath, runtimeEntry], {
    maxBuffer: 256 * 1024 * 1024,
  });
  const tempDir = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
  try {
    const runtimePath = `${tempDir}/glibc228-lib.tar.gz`;
    require('fs').writeFileSync(runtimePath, runtime);
    const names = execFileSync('tar', ['-tzf', runtimePath], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!names.split('\n').some(name => /(^|\/)ld-2\.28\.so$/.test(name))) {
      throw new Error('legacy glibc runtime is missing ld-2.28.so');
    }
  } finally {
    require('fs').rmSync(tempDir, { recursive: true, force: true });
  }
  return bundle;
}

if (require.main === module) {
  const archivePath = process.argv[2];
  if (!archivePath) {
    console.error('Usage: node scripts/verify-linux-legacy-release.js <farming-linux-x64-legacy-glibc228.tar.gz>');
    process.exit(2);
  }
  try {
    const bundle = verifyLinuxLegacyRelease(archivePath);
    console.log(`Verified ${PROFILE} bundle ${archivePath}: version ${bundle.release.releaseVersion}`);
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}

module.exports = { verifyLinuxLegacyRelease };
