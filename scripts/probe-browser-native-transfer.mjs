#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// This probe cannot grant release acceptance. Its inputs must be the artifacts
// of one successful preparation with unchanged source, patch and build recipe.
const [input, output, runFile, evidenceFile] = process.argv.slice(2);
assert(input && output && runFile && evidenceFile, 'Expected input, output, origin run and evidence paths');
assert.equal(process.platform, 'darwin');
assert(!fs.existsSync(output), 'Refuse to replace an existing probe binary');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
assert.equal(run.path, '.github/workflows/release.yml');
assert.equal(run.status, 'completed');
assert.equal(run.conclusion, 'success');
assert(/^[a-f0-9]{40}$/.test(run.head_sha));
execFileSync('git', ['merge-base', '--is-ancestor', run.head_sha, 'HEAD']);
const pinFile = 'backend/data/agent-browser-source.json';
const pin = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
for (const file of [pinFile, pin.patch, 'scripts/build-agent-browser-runtime.mjs']) {
  assert.equal(sha256(execFileSync('git', ['show', `${run.head_sha}:${file}`])), sha256(fs.readFileSync(file)), `Origin build input changed: ${file}`);
}
const identity = JSON.parse(fs.readFileSync(path.join(path.dirname(input), 'identity.json'), 'utf8'));
assert.equal(identity.farmingSha, run.head_sha);
assert.equal(identity.platformKey, `darwin-${process.arch}`);
assert.equal(identity.version, pin.version);
assert.equal(identity.sourceId, sha256(JSON.stringify(pin)));
const bytes = fs.readFileSync(input);
assert.equal(identity.sha256, sha256(bytes));
const version = binary => {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', detached: true });
  if (result.pid) {
    try { process.kill(-result.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return { status: result.status, signal: result.signal, error: result.error?.code, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
};
// Artifact download does not preserve executable mode. Restore it before the
// control launch, so permission failure cannot be mistaken for signing failure.
fs.chmodSync(input, 0o755);
const original = version(input);
fs.copyFileSync(input, output);
fs.chmodSync(output, 0o755);
execFileSync('codesign', ['--force', '--sign', '-', output], { stdio: 'inherit', timeout: 10_000 });
execFileSync('codesign', ['--verify', '--strict', output], { stdio: 'inherit', timeout: 10_000 });
const signed = version(output);
const evidence = { observedAt: new Date().toISOString(), platformKey: identity.platformKey, originRunId: run.id,
  originSha: run.head_sha, originDigest: identity.sha256, sourceId: identity.sourceId,
  recipeSha256: sha256(fs.readFileSync('scripts/build-agent-browser-runtime.mjs')), original, signed,
  signedDigest: sha256(fs.readFileSync(output)), releaseAcceptance: false };
fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
assert.equal(signed.status, 0, JSON.stringify(signed));
assert.equal(signed.stdout, `agent-browser ${pin.version}`);
console.log(JSON.stringify(evidence));
