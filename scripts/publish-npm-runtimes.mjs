#!/usr/bin/env node
// Invoked only by Publish Release, after GitHub publication. Platform aliases
// must be publicly readable before publishing the main version that pins them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateReceipt, verifyTarballReceipt } from './npm-release-evidence.mjs';
import { verifyRecoveryJournals } from './verify-npm-recovery-journals.mjs';

function readRegistryStatus(url) {
  return new Promise((resolve, reject) => {
    // Own and drain each bounded preflight request, including parallel lanes.
    const request = https.get(url, { agent: false, signal: AbortSignal.timeout(10_000) }, response => {
      response.on('error', reject);
      response.on('end', () => resolve(response.statusCode));
      response.resume();
    });
    request.on('error', reject);
  });
}

const receiptTool = fileURLToPath(new URL('./npm-release-evidence.mjs', import.meta.url));
function runCommand(command, args, timeout) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: 'inherit', timeout, killSignal: 'SIGKILL' });
    child.on('error', () => {}); // close also follows a spawn error; settle only after owned I/O closes.
    child.on('close', code => resolve(code ?? 1));
  });
}

const operations = {
  readStatus: readRegistryStatus,
  upload: (tarball, label) => runCommand('npm', ['publish', tarball, '--access', 'public', '--provenance', '--tag', label, '--loglevel=error'], 180_000),
  observe: (receiptFile, candidateSha, stateFile, resultFile) => runCommand(process.execPath,
    [receiptTool, 'watch', receiptFile, candidateSha, stateFile, ...(resultFile ? ['--upload-result', resultFile] : [])], 620_000),
};

export async function publishRuntimePackages(packageDirectory, evidenceDirectory, priorDirectory, candidateSha, dependencies = operations) {
  assert(packageDirectory && evidenceDirectory && priorDirectory && candidateSha, 'Missing runtime publication arguments');
  const read = file => JSON.parse(fs.readFileSync(path.join(packageDirectory, file), 'utf8'));
  const main = validateReceipt(read('npm-smoke-receipt.json'), candidateSha);
  const packages = read('runtime-packages.json');
  assert(Array.isArray(packages) && packages.length === 6, 'Runtime inventory must contain all six supported platforms');
  // Validate the whole release, not just the next lane, before any public write.
  verifyTarballReceipt(main, path.join(packageDirectory, main.filename));
  const labels = new Set();
  const plans = packages.map(item => {
    assert(/^(darwin|linux|win32)-(arm64|x64)$/.test(item.platform), 'Invalid runtime platform');
    const label = `runtime-${item.platform}`;
    assert(!labels.has(label), 'Duplicate runtime platform');
    labels.add(label);
    const receiptFile = path.join(packageDirectory, `${label}-receipt.json`);
    const receipt = validateReceipt(read(`${label}-receipt.json`), candidateSha);
    assert.equal(item.version, `${main.version}-${label}`);
    assert.equal(receipt.version, item.version);
    assert.equal(receipt.integrity, item.integrity);
    assert.equal(item.filename, receipt.filename);
    verifyTarballReceipt(receipt, path.join(packageDirectory, receipt.filename));
    return { label, receipt, receiptFile };
  });
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  for (const directory of new Set([priorDirectory, evidenceDirectory])) {
    if (fs.existsSync(directory)) verifyRecoveryJournals(packageDirectory, directory, candidateSha, main.version);
  }
  if (fs.existsSync(priorDirectory)) for (const name of fs.readdirSync(priorDirectory)) {
    if (!name.endsWith('.json')) continue;
    const target = path.join(evidenceDirectory, name);
    if (fs.existsSync(target)) assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')),
      JSON.parse(fs.readFileSync(path.join(priorDirectory, name), 'utf8')), `Retained journal differs: ${name}`);
    else fs.copyFileSync(path.join(priorDirectory, name), target, fs.constants.COPYFILE_EXCL);
  }
  // At most six independent platform versions; a failure cannot abandon other
  // uploads or discard their outcomes. Each lane owns distinct journal files.
  const results = await Promise.allSettled(plans.map(async ({ label, receipt, receiptFile }) => {
    const intentFile = path.join(evidenceDirectory, `${label}-upload-intent.json`);
    const resultFile = path.join(evidenceDirectory, `${label}-upload-result.json`);
    const stateFile = path.join(evidenceDirectory, `${label}-publication-state.json`);
    const status = await dependencies.readStatus(`https://registry.npmjs.org/farming-code/${encodeURIComponent(receipt.version)}`);
    if (status !== 200 && status !== 404) throw new Error(`Cannot reconcile ${receipt.version}: HTTP ${status}`);
    if (status === 404 && !fs.existsSync(intentFile) && !fs.existsSync(stateFile)) {
      fs.writeFileSync(intentFile, `${JSON.stringify({ version: receipt.version, gitHead: candidateSha, integrity: receipt.integrity, observedAt: new Date().toISOString() })}\n`, { flag: 'wx' });
      const uploadExitCode = await dependencies.upload(path.resolve(packageDirectory, receipt.filename), label);
      fs.writeFileSync(resultFile, `${JSON.stringify({ packageName: 'farming-code', version: receipt.version, gitHead: candidateSha, uploadExitCode, observedAt: new Date().toISOString() })}\n`, { flag: 'wx' });
    }
    // Prior uncertain attempts and existing versions are observed, never replayed.
    const code = await dependencies.observe(receiptFile, candidateSha,
      stateFile, fs.existsSync(resultFile) ? resultFile : null);
    assert.equal(code, 0, `${label} is not publicly verified (observer exit ${code}); retain journals and reconcile without replay`);
    return label;
  }));
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [new Error(`${plans[index].label}: ${result.reason.message}`, { cause: result.reason })] : []);
  if (failures.length) throw new AggregateError(failures, 'Runtime publication incomplete; main package upload remains blocked.');
  return results.map(result => result.value);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publishRuntimePackages(...process.argv.slice(2)).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
