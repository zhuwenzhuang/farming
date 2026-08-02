#!/usr/bin/env node
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifyLinuxCompatRelease } = require('../../scripts/verify-linux-compat-release');

function createBundle(root, glibcVersion, additionalNativeMarkers = '') {
  const bundleName = 'farming-2.2.5-linux-x64-glibc217';
  const bundleDir = path.join(root, bundleName);
  const ptyDir = path.join(bundleDir, 'node_modules/node-pty/build/Release');
  const browserExtensionDir = path.join(bundleDir, 'extensions/browser/backend');
  const computerExtensionDir = path.join(bundleDir, 'extensions/computer/backend');
  const languageServerExtensionDir = path.join(bundleDir, 'extensions/language-server/backend');
  fs.mkdirSync(path.join(bundleDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(bundleDir, 'shared'), { recursive: true });
  fs.mkdirSync(browserExtensionDir, { recursive: true });
  fs.mkdirSync(computerExtensionDir, { recursive: true });
  fs.mkdirSync(languageServerExtensionDir, { recursive: true });
  fs.mkdirSync(ptyDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'scripts/install-release.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(bundleDir, 'shared/browser-protocol.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(browserExtensionDir, 'index.cjs'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(computerExtensionDir, 'index.cjs'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(computerExtensionDir, 'cua-tools.json'), '{}\n');
  fs.writeFileSync(path.join(languageServerExtensionDir, 'index.cjs'), 'module.exports = {};\n');
  fs.writeFileSync(
    path.join(ptyDir, 'pty.node'),
    `ELF fixture GLIBC_2.2.5 GLIBC_${glibcVersion} ${additionalNativeMarkers}`,
  );
  fs.writeFileSync(path.join(bundleDir, 'RELEASE.json'), JSON.stringify({
    type: 'app-bundle',
    releaseVersion: '2.2.5',
    packageVersion: '2.2.5',
    dirty: false,
    platform: 'linux',
    arch: 'x64',
    compatibilityProfile: 'linux-x64-glibc217',
    bundledNodeModules: true,
  }));
  const archivePath = path.join(root, `${bundleName}-${glibcVersion}.tar.gz`);
  execFileSync('tar', ['-czf', archivePath, bundleName], { cwd: root });
  return archivePath;
}

function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-linux-compat-test-'));
  try {
    assert.doesNotThrow(() => verifyLinuxCompatRelease(createBundle(tempDir, '2.17')));
    assert.throws(
      () => verifyLinuxCompatRelease(createBundle(tempDir, '2.28')),
      /requires GLIBC_2\.28/,
    );
    assert.throws(
      () => verifyLinuxCompatRelease(createBundle(tempDir, '2.17', 'GLIBCXX_3.4.20')),
      /requires GLIBCXX_3\.4\.20/,
    );
    assert.throws(
      () => verifyLinuxCompatRelease(createBundle(tempDir, '2.17', 'CXXABI_1.3.8')),
      /requires CXXABI_1\.3\.8/,
    );

    const packageScript = fs.readFileSync(
      path.join(process.cwd(), 'scripts/package-linux-compat-release.sh'),
      'utf8',
    );
    assert(packageScript.includes('npm_config_build_from_source=true'));
    assert(packageScript.includes('-static-libstdc++ -static-libgcc'));
    assert(packageScript.includes('FARMING_RELEASE_PROFILE=linux-x64-glibc217'));
    console.log('Linux compatibility release tests passed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run();
