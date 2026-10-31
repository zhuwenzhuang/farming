#!/usr/bin/env -S npx tsx
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import { integrateCodexPeerMessages } from './vendor/codex-peer-integration';
import { integrateCodexRelatedHistory } from './vendor/codex-related-integration';
import { integrateCodexSubagentTurns } from './vendor/codex-subagent-integration';

const projectRoot = path.join(__dirname, '..');
const expectedVersion = '2.5.0';
const expectedUpstreamSha256 = '15de6b2dd5203876a48b12861378bcf87040d623ab2159e05052dc9d54c32b16';
const expectedBundleSha256 = 'd48968fd754c498d6c30de6a1e2f74653d0958244b10cbae72d66d8ceb5bd33f';
const expectedPatchedSha256 = '73d73ef90f16d726c3f5639846389ed6fb24301a8d130f1312c4f55e9d2dcdb7';
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
          contents: `import { farmingCodexPeerUpdate, farmingCodexPeerHistory, farmingMergePeerHistory, farmingSyncCodexPeerReceipts } from './scripts/vendor/codex-peer-messages.mjs';\n`
            + `import { farmingReadRelatedHistory } from './scripts/vendor/codex-related-history.mjs';\n`
            + integrateCodexSubagentTurns(integrateCodexRelatedHistory(integrateCodexPeerMessages(fs.readFileSync(sourceEntry, 'utf8')))),
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
