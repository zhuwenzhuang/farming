const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  readBundleRelease,
  verifyReleaseBundle,
} = require('../../scripts/verify-release-bundle');

interface ArchiveOptions {
  releaseVersion?: string;
  missingBrowserProtocol?: boolean;
  missingBrowserExtension?: boolean;
  missingComputerExtension?: boolean;
  missingComputerSchema?: boolean;
  missingLanguageServerExtension?: boolean;
  missingSharedConfigExtension?: boolean;
  dirty?: boolean;
}

function makeArchive(options: ArchiveOptions = {}) {
  const releaseVersion = options.releaseVersion || '9.9.9';
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-release-test.'));
  const appDir = path.join(rootDir, `farming-${releaseVersion}`);
  fs.mkdirSync(path.join(appDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'scripts', 'install-release.sh'), '#!/usr/bin/env bash\n');
  if (!options.missingBrowserProtocol) {
    fs.mkdirSync(path.join(appDir, 'shared'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'shared', 'browser-protocol.js'), 'module.exports = {};\n');
  }
  if (!options.missingBrowserExtension) {
    fs.mkdirSync(path.join(appDir, 'extensions', 'browser', 'backend'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'extensions', 'browser', 'backend', 'index.cjs'), 'module.exports = {};\n');
  }
  if (!options.missingComputerExtension) {
    fs.mkdirSync(path.join(appDir, 'extensions', 'computer', 'backend'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'extensions', 'computer', 'backend', 'index.cjs'), 'module.exports = {};\n');
    if (!options.missingComputerSchema) {
      fs.writeFileSync(path.join(appDir, 'extensions', 'computer', 'backend', 'cua-tools.json'), '{}\n');
    }
  }
  if (!options.missingLanguageServerExtension) {
    fs.mkdirSync(path.join(appDir, 'extensions', 'language-server', 'backend'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'extensions', 'language-server', 'backend', 'index.cjs'), 'module.exports = {};\n');
  }
  if (!options.missingSharedConfigExtension) {
    fs.mkdirSync(path.join(appDir, 'extensions', 'shared-config', 'backend'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'extensions', 'shared-config', 'backend', 'index.cjs'), 'module.exports = {};\n');
  }
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
  assert.throws(
    () => verifyReleaseBundle(makeArchive({ missingBrowserProtocol: true })),
    /missing shared\/browser-protocol\.js/,
  );
  assert.throws(
    () => verifyReleaseBundle(makeArchive({ missingBrowserExtension: true })),
    /missing extensions\/browser\/backend\/index\.cjs/,
  );
  assert.throws(
    () => verifyReleaseBundle(makeArchive({ missingComputerExtension: true })),
    /missing extensions\/computer\/backend\/index\.cjs/,
  );
  assert.throws(
    () => verifyReleaseBundle(makeArchive({ missingComputerSchema: true })),
    /missing extensions\/computer\/backend\/cua-tools\.json/,
  );
  assert.throws(
    () => verifyReleaseBundle(makeArchive({ missingLanguageServerExtension: true })),
    /missing extensions\/language-server\/backend\/index\.cjs/,
  );
  assert.throws(
    () => verifyReleaseBundle(makeArchive({ missingSharedConfigExtension: true })),
    /missing extensions\/shared-config\/backend\/index\.cjs/,
  );

  console.log('✓ release bundle verification requires clean metadata and all built-in extension runtime files');
}

run();
