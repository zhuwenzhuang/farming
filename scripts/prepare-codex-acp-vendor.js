const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const expectedVersion = '1.1.4';
const expectedUpstreamSha256 = '7534a0ad3cc4c9affd0b2da5007fa53ea0f1d6fcd71b2c5ef202e2056a976a97';
const expectedPatchedSha256 = 'f2298e389785cccf5db9226bd5505ae3b833f601d8f8f672f3c3704a90493c2e';
const packageRoot = path.dirname(require.resolve('@agentclientprotocol/codex-acp/package.json'));
const packageJsonPath = path.join(packageRoot, 'package.json');
const sourceEntry = path.join(packageRoot, 'dist', 'index.js');
const sourceLicense = path.join(packageRoot, 'LICENSE');
const targetDirectory = path.join(projectRoot, 'dist', 'acp');
const targetEntry = path.join(targetDirectory, `codex-acp-${expectedVersion}.js`);
const targetLicense = path.join(targetDirectory, 'LICENSE.codex-acp');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function applyReviewedPatch() {
  const patchPackageEntry = require.resolve('patch-package');
  const result = spawnSync(
    process.execPath,
    [patchPackageEntry, '--error-on-fail'],
    { cwd: projectRoot, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`patch-package exited with status ${result.status}`);
  }
}

function prepareCodexAcpVendor({ copy = false } = {}) {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (packageJson.version !== expectedVersion) {
    throw new Error(
      `Expected @agentclientprotocol/codex-acp ${expectedVersion}, found ${packageJson.version}`,
    );
  }

  let currentSha256 = sha256(sourceEntry);
  if (currentSha256 === expectedUpstreamSha256) {
    applyReviewedPatch();
    currentSha256 = sha256(sourceEntry);
  }
  if (currentSha256 !== expectedPatchedSha256) {
    throw new Error(
      `Refusing unreviewed codex-acp bytes: expected ${expectedPatchedSha256}, found ${currentSha256}`,
    );
  }

  if (copy) {
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.copyFileSync(sourceEntry, targetEntry);
    fs.copyFileSync(sourceLicense, targetLicense);
    if (sha256(targetEntry) !== expectedPatchedSha256) {
      throw new Error('Copied codex-acp runtime failed its SHA-256 verification');
    }
    console.log(`Prepared version-locked Codex ACP runtime at ${targetEntry}`);
  }
}

prepareCodexAcpVendor({ copy: process.argv.includes('--copy') });
