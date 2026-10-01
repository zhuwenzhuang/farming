#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const sha = /^[a-f0-9]{40}$/;

function validateReceipt(receipt, expectedSha) {
  if (receipt.schemaVersion !== 1 || receipt.packageName !== 'farming-code'
    || !semver.test(receipt.version) || !sha.test(expectedSha) || receipt.gitHead !== expectedSha
    || receipt.filename !== `farming-code-${receipt.version}.tgz`
    || !Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 0
    || !/^[a-f0-9]{64}$/.test(receipt.sha256) || !sha.test(receipt.shasum)
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(receipt.integrity)) {
    throw new Error('Invalid npm receipt or candidate identity mismatch.');
  }
  return receipt;
}

function digestFile(tarball) {
  const hashes = ['sha256', 'sha512', 'sha1'].map(name => crypto.createHash(name));
  const fd = fs.openSync(tarball, 'r');
  let bytes = 0;
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (let count; (count = fs.readSync(fd, chunk)) > 0;) {
      for (const hash of hashes) hash.update(chunk.subarray(0, count));
      bytes += count;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { bytes, sha256: hashes[0].digest('hex'), integrity: `sha512-${hashes[1].digest('base64')}`, shasum: hashes[2].digest('hex') };
}

function checkpoint(file, state) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  console.log(JSON.stringify(state));
}

async function watch(receipt, file, options) {
  const upload = options['upload-result'] ? JSON.parse(fs.readFileSync(options['upload-result'], 'utf8')) : null;
  if (upload && (!Number.isInteger(upload.uploadExitCode) || upload.uploadExitCode < 0 || upload.uploadExitCode > 255
    || !Number.isFinite(Date.parse(upload.observedAt)))) throw new Error('Invalid upload result.');
  for (const key of ['packageName', 'version', 'gitHead']) {
    if (upload?.[key] !== undefined && upload[key] !== receipt[key]) throw new Error('Upload result does not identify the smoke receipt.');
  }
  const uploadAccepted = upload?.uploadExitCode === 0;
  const registry = new URL(options.registry || 'https://registry.npmjs.org/');
  if (!['https:', 'http:'].includes(registry.protocol) || registry.username || registry.password
    || registry.search || registry.hash) throw new Error('Registry must be an HTTP(S) base URL without credentials or query.');
  if (!registry.pathname.endsWith('/')) registry.pathname += '/';
  const timeoutMs = Number(options['timeout-ms'] || 600_000);
  const pollMs = Number(options['poll-ms'] || 20_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000
    || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 60_000) throw new Error('Invalid bounded reconciliation timing.');
  const started = performance.now();
  const headers = { accept: 'application/json', 'cache-control': 'no-cache' };
  const publicUrl = new URL(`${encodeURIComponent(receipt.packageName)}/${encodeURIComponent(receipt.version)}`, registry);
  const state = { packageName: receipt.packageName, version: receipt.version, gitHead: receipt.gitHead,
    uploadStatus: uploadAccepted ? 'accepted' : 'uncertain', uploadedAt: uploadAccepted ? upload.observedAt : null, attempts: 0 };
  const emit = (status, reason) => checkpoint(file, {
    ...state, status, reason, observedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
  });
  let awaitingPublic = false;
  emit(uploadAccepted ? 'awaiting-public' : 'reconciling', uploadAccepted
    ? 'Uploaded successfully; waiting for the package to become public.'
    : 'Waiting for the exact public source and smoke-accepted digest; no upload will be replayed.');
  while (performance.now() - started < timeoutMs) {
    state.attempts += 1;
    let reason;
    let result;
    const previousAwaitingPublic = awaitingPublic;
    awaitingPublic = false;
    const signal = AbortSignal.timeout(Math.max(1, Math.min(10_000, timeoutMs - Math.ceil(performance.now() - started))));
    try {
      const response = await fetch(publicUrl, {
        headers, redirect: 'error', signal,
      });
      if (response.status === 200) {
        const doc = await response.json();
        if ((doc.name && doc.name !== receipt.packageName) || (doc.version && doc.version !== receipt.version)
          || (doc.gitHead && doc.gitHead !== receipt.gitHead)) {
          result = ['conflict', 'Public package/version/source identity differs from the candidate.', 1];
        } else if (doc.name === receipt.packageName && doc.version === receipt.version
          && doc.gitHead && doc.dist?.integrity && doc.dist?.shasum) {
          if (!String(doc.dist.integrity).split(/\s+/).includes(receipt.integrity) || doc.dist.shasum !== receipt.shasum) {
            result = ['conflict', 'Public tarball digest differs from the smoke-accepted receipt.', 1];
          } else {
            result = ['verified', 'Public source, SHA-512 integrity and SHA-1 shasum match the smoke-accepted tarball.', 0];
          }
        } else {
          reason = 'Public metadata is incomplete.';
          awaitingPublic = uploadAccepted;
        }
      } else {
        await response.body?.cancel();
        reason = `Public registry HTTP ${response.status}.`;
        awaitingPublic = uploadAccepted && response.status === 404;
        if (response.status !== 404 && response.status !== 429 && response.status < 500) {
          result = ['uncertain', reason, 2];
        }
      }
    } catch {
      reason = 'Public registry transport or metadata read failed.';
      // Our own observation deadline does not invalidate the last confirmed
      // public absence. A transport failure before that deadline still does.
      if (signal.aborted && performance.now() - started >= timeoutMs) awaitingPublic = previousAwaitingPublic;
    }
    if (result) {
      emit(result[0], result[1]);
      return result[2];
    }
    emit(awaitingPublic ? 'awaiting-public' : 'reconciling', reason);
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining > 0) await sleep(Math.min(pollMs, remaining));
  }
  if (awaitingPublic) {
    emit('awaiting-public', 'Uploaded successfully; public verification is still pending at the observation deadline. Continue with read-only reconciliation; do not upload again.');
    return 3;
  }
  emit('uncertain', 'Reconciliation deadline reached. Public availability or upload outcome remains uncertain; this does not prove manual approval is required.');
  return 2;
}

async function main() {
  const [command, first, second, third, fourth, ...flags] = process.argv.slice(2);
  if (command === 'write') {
    const match = /^farming-code@(.+)$/.exec(second || '');
    if (!match || !semver.test(match[1]) || !sha.test(third || '') || !fourth || flags.length) throw new Error('Usage: npm-release-evidence.mjs write <tarball> <farming-code@version> <SHA> <receipt>');
    const receipt = validateReceipt({ schemaVersion: 1, packageName: 'farming-code', version: match[1], gitHead: third, filename: path.basename(first), ...digestFile(first) }, third);
    fs.writeFileSync(fourth, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify(receipt));
    return;
  }
  if (!first || !second || !third || !['verify', 'watch', 'report'].includes(command)) throw new Error('Usage: npm-release-evidence.mjs <verify|watch|report> <receipt> <SHA> <tarball|state-file> [--registry URL] [--timeout-ms MS] [--poll-ms MS] [--upload-result FILE]');
  const receipt = validateReceipt(JSON.parse(fs.readFileSync(first, 'utf8')), second);
  if (command === 'verify') {
    if (fourth || flags.length) throw new Error('Verify accepts no extra options.');
    const actual = digestFile(third);
    for (const key of ['bytes', 'sha256', 'integrity', 'shasum']) {
      if (receipt[key] !== actual[key]) throw new Error(`Transferred npm tarball ${key} differs from its smoke receipt.`);
    }
    console.log('Transferred npm tarball matches the exact-SHA smoke receipt.');
    return;
  }
  if (command === 'report') {
    if (fourth || flags.length) throw new Error('Report accepts no extra options.');
    const state = JSON.parse(fs.readFileSync(third, 'utf8'));
    if (state.packageName !== receipt.packageName || state.version !== receipt.version || state.gitHead !== receipt.gitHead) {
      throw new Error('Publication state does not identify the smoke receipt.');
    }
    const outcomes = {
      'awaiting-public': ['pending', 'Uploaded successfully; waiting for public availability'],
      verified: ['success', 'Public npm source and tarball digests verified'],
      conflict: ['failure', 'Public npm identity or tarball digest conflicts with the candidate'],
      uncertain: ['error', 'npm publication could not be confirmed; read-only reconciliation required'],
    };
    if (!(state.status in outcomes) || (state.status === 'awaiting-public' && state.uploadStatus !== 'accepted')) {
      throw new Error('Invalid terminal publication state.');
    }
    const [commitState, description] = outcomes[state.status];
    const output = `publication_status=${state.status}\ncommit_state=${commitState}\ndescription=${description}\n`;
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### npm publication: ${description}\n\nPackage: \`${receipt.packageName}@${receipt.version}\`\n\nCandidate: \`${receipt.gitHead}\`\n\nState: \`${state.status}\`\n\n${state.status === 'awaiting-public'
        ? 'Upload has completed. Release verification remains pending. Resume the original upload run in read-only recovery mode; do not publish again.'
        : state.status === 'verified' ? 'The public package matches the smoke-accepted source and tarball.'
          : 'Retain the evidence and reconcile before considering any publication mutation.'}\n`);
    console.log(output.trim());
    return;
  }
  const options = {};
  const argumentsLeft = [fourth, ...flags].filter(value => value !== undefined);
  for (let index = 0; index < argumentsLeft.length; index += 2) {
    const key = argumentsLeft[index];
    if (!['--registry', '--timeout-ms', '--poll-ms', '--upload-result'].includes(key) || !argumentsLeft[index + 1]
      || options[key.slice(2)] !== undefined) throw new Error('Invalid reconciliation option.');
    options[key.slice(2)] = argumentsLeft[index + 1];
  }
  process.exitCode = await watch(receipt, third, options);
}

main().catch(error => {
  const reason = error?.code || (error instanceof SyntaxError ? 'Invalid JSON receipt.' : error?.message);
  console.error(`npm evidence operation failed: ${reason || 'Invalid input or observation storage.'}`);
  process.exitCode = 2;
});
