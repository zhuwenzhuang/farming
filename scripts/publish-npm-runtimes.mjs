#!/usr/bin/env node
// Invoked only by Publish Release, after GitHub publication. Platform aliases
// must be publicly readable before publishing the main version that pins them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateReceipt } from './npm-release-evidence.mjs';

const [packageDirectory, evidenceDirectory, priorDirectory, candidateSha] = process.argv.slice(2);
assert(packageDirectory && evidenceDirectory && priorDirectory && candidateSha, 'Missing runtime publication arguments');
const receiptTool = fileURLToPath(new URL('./npm-release-evidence.mjs', import.meta.url));
const packages = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'runtime-packages.json'), 'utf8'));
fs.mkdirSync(evidenceDirectory, { recursive: true });
for (const item of packages) {
  assert(/^(darwin|linux|win32)-(arm64|x64)$/.test(item.platform));
  const label = `runtime-${item.platform}`;
  const receiptFile = path.join(packageDirectory, `${label}-receipt.json`);
  const receipt = validateReceipt(JSON.parse(fs.readFileSync(receiptFile, 'utf8')), candidateSha);
  assert.equal(receipt.version, item.version);
  assert.equal(receipt.integrity, item.integrity);
  execFileSync(process.execPath, [receiptTool, 'verify', receiptFile, candidateSha, path.join(packageDirectory, receipt.filename)], { stdio: 'inherit' });
  const intentFile = path.join(evidenceDirectory, `${label}-upload-intent.json`);
  const resultFile = path.join(evidenceDirectory, `${label}-upload-result.json`);
  for (const name of [`${label}-upload-intent.json`, `${label}-upload-result.json`]) {
    const prior = path.join(priorDirectory, name);
    if (fs.existsSync(prior)) fs.copyFileSync(prior, path.join(evidenceDirectory, name));
  }
  const response = await fetch(`https://registry.npmjs.org/farming-code/${encodeURIComponent(item.version)}`, { signal: AbortSignal.timeout(10_000) });
  if (response.status !== 200 && response.status !== 404) throw new Error(`Cannot reconcile ${item.version}: HTTP ${response.status}`);
  if (response.status === 404 && !fs.existsSync(intentFile)) {
    fs.writeFileSync(intentFile, `${JSON.stringify({ version: item.version, gitHead: candidateSha, integrity: receipt.integrity, observedAt: new Date().toISOString() })}\n`, { flag: 'wx' });
    const upload = spawnSync('npm', ['publish', path.resolve(packageDirectory, receipt.filename), '--access', 'public', '--provenance', '--tag', label, '--loglevel=error'], { stdio: 'inherit', timeout: 180_000 });
    fs.writeFileSync(resultFile, `${JSON.stringify({ packageName: 'farming-code', version: item.version, gitHead: candidateSha, uploadExitCode: upload.status ?? 1, observedAt: new Date().toISOString() })}\n`);
  }
  // Includes prior uncertain attempts and existing versions: never replay an
  // upload. The shared observer validates public gitHead and all archive digests.
  const options = fs.existsSync(resultFile) ? ['--upload-result', resultFile] : [];
  execFileSync(process.execPath, [receiptTool, 'watch', receiptFile, candidateSha, path.join(evidenceDirectory, `${label}-publication-state.json`), ...options], { stdio: 'inherit' });
}
