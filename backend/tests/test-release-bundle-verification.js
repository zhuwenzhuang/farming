const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  readBundleRelease,
  verifyReleaseBundle,
} = require('../../scripts/verify-release-bundle');

function makeArchive(options = {}) {
  const releaseVersion = options.releaseVersion || '9.9.9';
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-release-test.'));
  const appDir = path.join(rootDir, `farming-${releaseVersion}`);
  fs.mkdirSync(path.join(appDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'scripts', 'install-release.sh'), '#!/usr/bin/env bash\n');
  fs.writeFileSync(path.join(appDir, 'RELEASE.json'), JSON.stringify({
    name: 'farming',
    type: 'app-bundle',
    releaseVersion,
    packageVersion: releaseVersion,
    dirty: options.dirty === undefined ? false : options.dirty,
  }));

  const archivePath = path.join(rootDir, `farming-${releaseVersion}.tar.gz`);
  execFileSync('tar', ['-czf', archivePath, '-C', rootDir, `farming-${releaseVersion}`]);
  return archivePath;
}

function run() {
  const archive = makeArchive();
  const bundle = verifyReleaseBundle(archive);
  assert.strictEqual(bundle.release.releaseVersion, '9.9.9');
  assert.strictEqual(readBundleRelease(archive).release.type, 'app-bundle');
  assert.throws(
    () => verifyReleaseBundle(makeArchive({ dirty: true })),
    /must be built from a clean working tree/,
  );

  console.log('✓ release bundle verification requires clean release metadata');
}

run();
