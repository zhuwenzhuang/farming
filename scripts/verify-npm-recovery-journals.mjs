#!/usr/bin/env node
// Validate the complete retained journal before any artifact can upload.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateReceipt } from './npm-release-evidence.mjs';

export function verifyRecoveryJournals(packageDirectory, priorDirectory, candidateSha, version, binding = process.env) {
  const read = (directory, file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
  const exists = file => fs.existsSync(path.join(priorDirectory, file));
  const main = validateReceipt(read(packageDirectory, 'npm-smoke-receipt.json'), candidateSha);
  assert.equal(main.version, version, 'Preparation main version mismatch');
  const packages = read(packageDirectory, 'runtime-packages.json');
  const labels = new Set();
  for (const item of packages) {
    assert(/^(darwin|linux|win32)-(arm64|x64)$/.test(item.platform), 'Invalid runtime platform');
    const label = `runtime-${item.platform}`;
    assert(!labels.has(label), 'Duplicate runtime platform');
    labels.add(label);
    const receipt = validateReceipt(read(packageDirectory, `${label}-receipt.json`), candidateSha);
    assert.equal(item.version, `${version}-runtime-${item.platform}`);
    assert.equal(receipt.version, item.version);
    assert.equal(receipt.integrity, item.integrity);
    const intentName = `${label}-upload-intent.json`;
    if (exists(intentName)) {
      const intent = read(priorDirectory, intentName);
      for (const key of ['version', 'gitHead', 'integrity']) assert.equal(intent[key], receipt[key], `Runtime intent ${label} ${key} mismatch`);
    }
    for (const suffix of ['upload-result', 'publication-state']) {
      const file = `${label}-${suffix}.json`;
      if (!exists(file)) continue;
      const evidence = read(priorDirectory, file);
      // An already-public version can have a read-only observation without an
      // upload intent. An upload result must always retain its preceding intent.
      assert(exists(intentName) || (suffix === 'publication-state' && evidence.uploadStatus === 'uncertain'), `${file} is missing its upload intent`);
      for (const key of ['version', 'gitHead']) assert.equal(evidence[key], receipt[key], `Runtime journal ${file} ${key} mismatch`);
      assert.equal(evidence.packageName, 'farming-code', `Runtime journal ${file} package mismatch`);
      if (suffix === 'upload-result') {
        assert(Number.isInteger(evidence.uploadExitCode) && evidence.uploadExitCode >= 0 && evidence.uploadExitCode <= 255, `Invalid runtime upload result ${file}`);
        assert(Number.isFinite(Date.parse(evidence.observedAt)), `Invalid runtime upload timestamp ${file}`);
      }
    }
  }
  for (const file of fs.readdirSync(priorDirectory)) {
    if (file.startsWith('runtime-')) {
      assert([...labels].some(label => ['upload-intent', 'upload-result', 'publication-state'].some(suffix => file === `${label}-${suffix}.json`)), `Unknown runtime journal ${file}`);
    }
  }
  if (exists('npm-smoke-receipt.json')) assert.deepEqual(validateReceipt(read(priorDirectory, 'npm-smoke-receipt.json'), candidateSha), main, 'Retained main receipt differs from preparation');
  if (exists('upload-intent.json') || exists('upload-result.json') || exists('upload-origin.json')) {
    assert(exists('npm-smoke-receipt.json') && exists('upload-origin.json'), 'Main upload journal lacks receipt or origin');
    const origin = read(priorDirectory, 'upload-origin.json');
    assert.equal(origin.schemaVersion, 1);
    assert.equal(origin.candidateSha, candidateSha);
    assert.equal(origin.version, version);
    assert.equal(origin.repository, binding.GITHUB_REPOSITORY);
    assert.equal(String(origin.preparationRunId), binding.PREPARATION_RUN_ID);
    // A legacy exact-SHA recovery may retain an earlier original uploader.
    // An explicit authorization anchor must match the retained origin exactly.
    if (binding.CANDIDATE_PUBLICATION_RUN_ID) {
      assert.equal(String(origin.candidatePublicationRunId), binding.NPM_CANDIDATE_PUBLICATION_RUN_ID);
      assert.equal(String(origin.candidatePublicationRunAttempt), binding.NPM_CANDIDATE_PUBLICATION_RUN_ATTEMPT);
    }
    if (exists('upload-result.json')) {
      const result = read(priorDirectory, 'upload-result.json');
      assert.equal(result.version, version);
      assert.equal(result.gitHead, candidateSha);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  verifyRecoveryJournals(...process.argv.slice(2));
}
