import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

const script = path.resolve(__dirname, '../scripts/npm-release-evidence.mjs');
const candidate = 'a'.repeat(40);
const publicationScript = YAML.parse(fs.readFileSync(path.resolve(__dirname, '../.github/workflows/publish-release.yml'), 'utf8'))
  .jobs['publish-release'].steps.find((step: { name: string }) => step.name === 'Verify and publish npm package with provenance').run;

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-evidence-'));
  const tarball = path.join(directory, 'farming-code-1.2.3.tgz');
  const receipt = path.join(directory, 'receipt.json');
  const state = path.join(directory, 'state.json');
  const bytes = Buffer.from('one smoke-accepted tarball\n');
  fs.writeFileSync(tarball, bytes);
  const result = spawnSync(process.execPath, [script, 'write', tarball, 'farming-code@1.2.3', candidate, receipt], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  const metadata = { name: 'farming-code', version: '1.2.3', gitHead: candidate, dist: { integrity: evidence.integrity, shasum: evidence.shasum } };
  return { directory, tarball, receipt, state, bytes, evidence, metadata };
}

async function observe(
  handler: http.RequestListener,
  options: {
    timeout?: number;
    state?: (directory: string) => string;
    workflow?: { recovery: boolean; exists: boolean; uploadExit: number; corrupt?: boolean };
  } = {},
) {
  const files = fixture();
  const server = http.createServer(handler);
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const registry = `http://127.0.0.1:${address.port}/`;
    const env: NodeJS.ProcessEnv = { ...process.env, NPM_TOKEN: 'private-token-never-sent' };
    if (options.workflow) {
      const bin = path.join(files.directory, 'bin');
      const packageDirectory = path.join(files.directory, 'npm-package');
      fs.mkdirSync(bin);
      fs.mkdirSync(packageDirectory);
      fs.symlinkSync(path.dirname(script), path.join(files.directory, 'scripts'), 'dir');
      fs.copyFileSync(files.receipt, path.join(packageDirectory, 'npm-smoke-receipt.json'));
      fs.copyFileSync(files.tarball, path.join(packageDirectory, path.basename(files.tarball)));
      const transferredBytes = options.workflow.corrupt ? Buffer.from('corrupted transfer') : files.bytes;
      fs.writeFileSync(path.join(packageDirectory, path.basename(files.tarball)), transferredBytes);
      fs.writeFileSync(path.join(packageDirectory, `${path.basename(files.tarball)}.sha256`), `${crypto.createHash('sha256').update(transferredBytes).digest('hex')}  ${path.basename(files.tarball)}\n`);
      fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/bash\nif [[ "$1" == view ]]; then exit "$TEST_EXISTS_EXIT"; fi\nif [[ "$1" == publish ]]; then echo upload >> "$TEST_UPLOADS"; exit "$TEST_UPLOAD_EXIT"; fi\nexit 90\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'node'), '#!/bin/bash\nif [[ "$2" == watch ]]; then exec "$TEST_NODE" "$@" --registry "$TEST_REGISTRY" --timeout-ms "$TEST_TIMEOUT" --poll-ms 10; fi\nexec "$TEST_NODE" "$@"\n', { mode: 0o755 });
      Object.assign(env, { PATH: `${bin}${path.delimiter}${env.PATH}`, NPM_TOKEN: '', CANDIDATE_SHA: candidate, FARMING_RELEASE_VERSION: '1.2.3',
        NPM_UPLOAD_MAY_HAVE_STARTED: options.workflow.recovery ? '1' : '0', TEST_EXISTS_EXIT: options.workflow.exists ? '0' : '1',
        TEST_UPLOAD_EXIT: String(options.workflow.uploadExit), TEST_UPLOADS: path.join(files.directory, 'uploads'),
        TEST_REGISTRY: registry, TEST_NODE: process.execPath, TEST_TIMEOUT: String(options.timeout || 2_000) });
    }
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const args = options.workflow ? ['-c', publicationScript] : [script, 'watch', files.receipt, candidate, options.state?.(files.directory) || files.state,
        '--registry', registry, '--timeout-ms', String(options.timeout || 2_000), '--poll-ms', '10'];
      const child = spawn(options.workflow ? 'bash' : process.execPath, args, {
        env, cwd: files.directory,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      child.on('error', reject);
      child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
    });
    const stateFile = options.workflow ? path.join(files.directory, 'npm-evidence/publication-state.json') : files.state;
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
    assert(!result.output.includes('private-token-never-sent'));
    const uploadsFile = path.join(files.directory, 'uploads');
    const uploads = fs.existsSync(uploadsFile) ? fs.readFileSync(uploadsFile, 'utf8').trim().split('\n').length : 0;
    return { ...result, state, uploads };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
}

test('receipt binds all smoke-accepted bytes to the exact candidate and rejects transfer corruption', () => {
  const files = fixture();
  try {
    assert.equal(files.evidence.bytes, files.bytes.length);
    assert.equal(files.evidence.sha256, crypto.createHash('sha256').update(files.bytes).digest('hex'));
    assert.equal(files.evidence.integrity, `sha512-${crypto.createHash('sha512').update(files.bytes).digest('base64')}`);
    assert.equal(files.evidence.shasum, crypto.createHash('sha1').update(files.bytes).digest('hex'));
    const verify = (sha = candidate) => spawnSync(process.execPath, [script, 'verify', files.receipt, sha, files.tarball], { encoding: 'utf8', timeout: 5_000 });
    assert.equal(verify().status, 0);
    assert.notEqual(verify('b'.repeat(40)).status, 0);
    fs.appendFileSync(files.tarball, 'changed after smoke');
    assert.notEqual(verify().status, 0);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('reconciliation observes transient and incomplete metadata until exact source and digests become public', async () => {
  const files = fixture();
  let requests = 0;
  try {
    const result = await observe((request, response) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/farming-code/1.2.3');
      assert.equal(request.headers.authorization, undefined);
      requests += 1;
      if (requests === 1 || requests === 3) {
        response.writeHead(requests === 1 ? 404 : 429).end();
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(requests === 2 ? {} : files.metadata));
      }
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.state.status, 'verified');
    assert.equal(result.state.attempts, 4);
    assert.match(result.state.observedAt, /^\d{4}-/);
    assert(result.state.elapsedMs >= 0);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

for (const conflict of ['source', 'digest', 'package'] as const) {
  test(`public ${conflict} conflict terminates without retries or uploads`, async () => {
    const files = fixture();
    let requests = 0;
    try {
      if (conflict === 'source') files.metadata.gitHead = 'b'.repeat(40);
      if (conflict === 'digest') files.metadata.dist.shasum = 'c'.repeat(40);
      if (conflict === 'package') files.metadata.name = 'another-package';
      const result = await observe((request, response) => {
        assert.equal(request.method, 'GET');
        requests += 1;
        response.writeHead(200).end(JSON.stringify(files.metadata));
      });
      assert.equal(result.code, 1, result.output);
      assert.equal(result.state.status, 'conflict');
      assert.equal(requests, 1);
    } finally {
      fs.rmSync(files.directory, { recursive: true, force: true });
    }
  });
}

test('404 remains uncertain at the bounded deadline without inferring maintainer approval', async () => {
  const result = await observe((_request, response) => response.writeHead(404).end(), { timeout: 150 });
  assert.equal(result.code, 2);
  assert.equal(result.state.status, 'uncertain');
  assert.match(result.state.reason, /does not prove manual approval/);
  assert(result.state.elapsedMs >= 150 && result.state.elapsedMs < 1_500);
});

test('a stalled public read is aborted within the reconciliation deadline', async () => {
  const result = await observe(() => {}, { timeout: 150 });
  assert.equal(result.code, 2);
  assert.equal(result.state.status, 'uncertain');
  assert(result.state.elapsedMs < 1_500);
});

test('forbidden metadata reads terminate as uncertain rather than polling for ten minutes', async () => {
  const result = await observe((_request, response) => response.writeHead(403).end());
  assert.equal(result.code, 2);
  assert.equal(result.state.attempts, 1);
  assert.equal(result.state.reason, 'Public registry HTTP 403.');
});

test('observation storage failure fails immediately before making a registry request', async () => {
  let requests = 0;
  const result = await observe((_request, response) => { requests += 1; response.end(); }, {
    state: directory => path.join(directory, 'missing', 'state.json'),
  });
  assert.equal(result.code, 2);
  assert.equal(requests, 0);
});

test('the publication workflow never replays an uncertain upload during recovery even on public 404', async () => {
  const result = await observe((_request, response) => response.writeHead(404).end(), {
    timeout: 150, workflow: { recovery: true, exists: false, uploadExit: 0 },
  });
  assert.equal(result.code, 2, result.output);
  assert.equal(result.state.status, 'uncertain');
  assert.equal(result.uploads, 0);
});

test('a pre-upload recovery may upload once and reconciles an ambiguous CLI failure to public success', async () => {
  const files = fixture();
  try {
    const result = await observe((_request, response) => response.writeHead(200).end(JSON.stringify(files.metadata)), {
      workflow: { recovery: false, exists: false, uploadExit: 1 },
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.state.status, 'verified');
    assert.equal(result.uploads, 1);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('the workflow checks the smoke receipt before any upload even when a transferred SHA-256 file was also replaced', async () => {
  const result = await observe((_request, response) => response.end(), {
    workflow: { recovery: false, exists: false, uploadExit: 0, corrupt: true },
  });
  assert.notEqual(result.code, 0);
  assert.equal(result.uploads, 0);
  assert.equal(result.state, null);
});
