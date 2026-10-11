#!/usr/bin/env -S npx tsx
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import { integrateCodexPeerMessages } from './vendor/codex-peer-integration';

const projectRoot = path.join(__dirname, '..');
const expectedVersion = '2.2.2';
const expectedUpstreamSha256 = '6b1bb4e7e9caaf4aeca1042ae4aec2dc2433b0b0e4b1614b38a4d41699902aaa';
const expectedBundleSha256 = '1c146559e1db013a5e6e3d352698c9ea2a6b019e53d330a7fc19ad11db9bdf7a';
const expectedPatchedSha256 = '40f90db7ace97f45a2caddafa97b2cad5bc2c38c4049c6a16ce96c79a3783ba7';
const packageRoot = path.dirname(require.resolve('@agentclientprotocol/codex-acp/package.json'));
const packageJsonPath = path.join(packageRoot, 'package.json');
const sourceEntry = path.join(packageRoot, 'dist', 'index.js');
const sourceLicense = path.join(packageRoot, 'LICENSE');
const targetDirectory = path.join(projectRoot, 'dist', 'acp');
const targetEntry = path.join(targetDirectory, `codex-acp-${expectedVersion}.mjs`);
const targetLicense = path.join(targetDirectory, 'LICENSE.codex-acp');

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function applyReviewedPatch(): void {
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

async function prepareCodexAcpVendor({ copy = false } = {}): Promise<void> {
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
    const temporaryEntry = `${targetEntry}.${process.pid}.${Date.now()}.tmp`;
    try {
      await esbuild.build({
        absWorkingDir: projectRoot, bundle: true, platform: 'node', format: 'esm',
        target: 'node22', legalComments: 'none', outfile: temporaryEntry,
        stdin: {
          contents: `import { farmingCodexPeerUpdate, farmingCodexPeerHistory, farmingMergePeerHistory } from './scripts/vendor/codex-peer-messages.mjs';\n`
            + integrateCodexPeerMessages(fs.readFileSync(sourceEntry, 'utf8')),
          resolveDir: projectRoot, sourcefile: 'farming-codex-acp.js', loader: 'js',
        },
      });
      if (sha256(temporaryEntry) !== expectedBundleSha256) {
        throw new Error(`Prepared Codex ACP bundle failed its reviewed SHA-256 verification: ${sha256(temporaryEntry)}`);
      }
      // The target can be the entry file of a live ACP adapter. Replace its
      // directory entry atomically instead of truncating the running file.
      fs.renameSync(temporaryEntry, targetEntry);
    } finally {
      fs.rmSync(temporaryEntry, { force: true });
    }
    fs.copyFileSync(sourceLicense, targetLicense);
    console.log(`Prepared version-locked Codex ACP runtime at ${targetEntry}`);
  }
}

prepareCodexAcpVendor({ copy: process.argv.includes('--copy') }).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
