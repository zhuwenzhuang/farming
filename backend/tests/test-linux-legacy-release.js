#!/usr/bin/env node
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifyLinuxLegacyRelease } = require('../../scripts/verify-linux-legacy-release');

function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-linux-legacy-test-'));
  try {
    const bundleName = 'farming-2.2.6-linux-x64-legacy-glibc228';
    const bundleDir = path.join(root, bundleName);
    const runtimeDir = path.join(root, 'runtime/lib');
    fs.mkdirSync(path.join(bundleDir, 'vendor'), { recursive: true });
    fs.mkdirSync(path.join(bundleDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'scripts/install-release.sh'), '#!/bin/sh\n');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'ld-2.28.so'), 'loader fixture');
    const runtimePath = path.join(bundleDir, 'vendor/glibc228-lib.tar.gz');
    execFileSync('tar', ['-czf', runtimePath, '-C', path.join(root, 'runtime'), 'lib']);
    fs.writeFileSync(path.join(bundleDir, 'RELEASE.json'), JSON.stringify({
      type: 'app-bundle',
      releaseVersion: '2.2.6',
      packageVersion: '2.2.6',
      dirty: false,
      platform: 'linux',
      arch: 'x64',
      compatibilityProfile: 'linux-x64-legacy-glibc228',
      bundledNodeModules: true,
      bundledGlibcRuntime: true,
    }));
    const archivePath = path.join(root, `${bundleName}.tar.gz`);
    execFileSync('tar', ['-czf', archivePath, '-C', root, bundleName]);
    assert.doesNotThrow(() => verifyLinuxLegacyRelease(archivePath));
    const packageScript = fs.readFileSync(
      path.join(process.cwd(), 'scripts/package-release.sh'),
      'utf8',
    );
    assert(packageScript.includes('FARMING_GLIBC_RUNTIME_ROOT'));
    assert(packageScript.includes('--library-path'));
    console.log('Legacy Linux release tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run();
