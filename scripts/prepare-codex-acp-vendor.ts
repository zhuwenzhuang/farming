#!/usr/bin/env -S npx tsx
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = path.join(__dirname, '..');
const expectedVersion = '1.4.0';
const expectedUpstreamSha256 = 'ba74f54f7c89ba61858e544eb3afefbb0c1b90f2b23a136664828816a8430dbf';
const expectedPatchedSha256 = 'b12502378ea4fda027b721902866ed27b600b5add6d019f5e5f00e84a0da0aed';
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

function prepareCodexAcpVendor({ copy = false } = {}): void {
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
      fs.copyFileSync(sourceEntry, temporaryEntry);
      if (sha256(temporaryEntry) !== expectedPatchedSha256) {
        throw new Error('Copied Codex ACP runtime failed its SHA-256 verification');
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

prepareCodexAcpVendor({ copy: process.argv.includes('--copy') });
