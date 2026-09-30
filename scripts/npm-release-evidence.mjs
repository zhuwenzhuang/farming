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
  const state = { packageName: receipt.packageName, version: receipt.version, gitHead: receipt.gitHead, status: 'reconciling', attempts: 0 };
  const emit = (status, reason) => checkpoint(file, {
    ...state, status, reason, observedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
  });
  emit('reconciling', 'Waiting for the exact public source and smoke-accepted digest; no upload will be replayed.');
  while (performance.now() - started < timeoutMs) {
    state.attempts += 1;
    let reason;
    let result;
    try {
      const response = await fetch(publicUrl, {
        headers, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, timeoutMs - Math.ceil(performance.now() - started)))),
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
        }
      } else {
        await response.body?.cancel();
        reason = `Public registry HTTP ${response.status}.`;
        if (response.status !== 404 && response.status !== 429 && response.status < 500) {
          result = ['uncertain', reason, 2];
        }
      }
    } catch {
      reason = 'Public registry transport or metadata read failed.';
    }
    if (result) {
      emit(result[0], result[1]);
      return result[2];
    }
    emit('reconciling', reason);
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining > 0) await sleep(Math.min(pollMs, remaining));
  }
  emit('uncertain', 'Reconciliation deadline reached. Upload outcome remains uncertain; this does not prove manual approval is required.');
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
  if (!first || !second || !third || !['verify', 'watch'].includes(command)) throw new Error('Usage: npm-release-evidence.mjs <verify|watch> <receipt> <SHA> <tarball|state-file> [--registry URL] [--timeout-ms MS] [--poll-ms MS]');
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
  const options = {};
  const argumentsLeft = [fourth, ...flags].filter(value => value !== undefined);
  for (let index = 0; index < argumentsLeft.length; index += 2) {
    const key = argumentsLeft[index];
    if (!['--registry', '--timeout-ms', '--poll-ms'].includes(key) || !argumentsLeft[index + 1]
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
