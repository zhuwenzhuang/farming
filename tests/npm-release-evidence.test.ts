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
const publicationSteps = YAML.parse(fs.readFileSync(path.resolve(__dirname, '../.github/workflows/publish-release.yml'), 'utf8'))
  .jobs['publish-release'].steps;
const stepScript = (name: string): string => publicationSteps.find((step: { name: string }) => step.name === name).run;
const publicationScript = stepScript('Verify and publish npm package with provenance');
const observationScript = stepScript('Wait for npm package to become public');
const statusScript = stepScript('Record npm publication status');

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
    uploadResult?: { exitCode: number; gitHead?: string };
    workflow?: { recovery: boolean; exists: boolean; uploadExit: number; corrupt?: boolean; priorUploadExit?: number };
  } = {},
) {
  const files = fixture();
  const server = http.createServer(handler);
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const registry = `http://127.0.0.1:${address.port}/`;
    const uploadResult = path.join(files.directory, 'upload-result.json');
    if (options.uploadResult) fs.writeFileSync(uploadResult, JSON.stringify({ packageName: 'farming-code', version: '1.2.3',
      gitHead: options.uploadResult.gitHead || candidate, uploadExitCode: options.uploadResult.exitCode, observedAt: new Date().toISOString() }));
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
      fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TEST_STATUSES"\n', { mode: 0o755 });
      if (options.workflow.priorUploadExit !== undefined) {
        fs.mkdirSync(path.join(files.directory, 'prior-npm-evidence'));
        fs.writeFileSync(path.join(files.directory, 'prior-npm-evidence/upload-result.json'), JSON.stringify({
          uploadExitCode: options.workflow.priorUploadExit, observedAt: new Date().toISOString(),
        }));
      }
      fs.writeFileSync(path.join(bin, 'node'), '#!/bin/bash\nif [[ "$2" == watch ]]; then exec "$TEST_NODE" "$@" --registry "$TEST_REGISTRY" --timeout-ms "$TEST_TIMEOUT" --poll-ms 10; fi\nexec "$TEST_NODE" "$@"\n', { mode: 0o755 });
      Object.assign(env, { PATH: `${bin}${path.delimiter}${env.PATH}`, NPM_TOKEN: '', CANDIDATE_SHA: candidate, FARMING_RELEASE_VERSION: '1.2.3',
        NPM_UPLOAD_MAY_HAVE_STARTED: options.workflow.recovery ? '1' : '0', TEST_EXISTS_EXIT: options.workflow.exists ? '0' : '1',
        TEST_UPLOAD_EXIT: String(options.workflow.uploadExit), TEST_UPLOADS: path.join(files.directory, 'uploads'),
        TEST_PUBLISH_SCRIPT: publicationScript, TEST_OBSERVE_SCRIPT: observationScript, TEST_STATUS_SCRIPT: statusScript,
        GITHUB_OUTPUT: path.join(files.directory, 'outputs'), GITHUB_STEP_SUMMARY: path.join(files.directory, 'summary'),
        GITHUB_REPOSITORY: 'example/farming', GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '123',
        TEST_STATUSES: path.join(files.directory, 'statuses'), TEST_REGISTRY: registry, TEST_NODE: process.execPath, TEST_TIMEOUT: String(options.timeout || 2_000) });
    }
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const args = options.workflow ? ['-c', `
        bash -c "$TEST_PUBLISH_SCRIPT" || exit $?
        bash -c "$TEST_OBSERVE_SCRIPT"
        observation_exit=$?
        if [[ -f "$GITHUB_OUTPUT" ]]; then
          export PUBLICATION_STATE="$(sed -n 's/^commit_state=//p' "$GITHUB_OUTPUT")"
          export PUBLICATION_DESCRIPTION="$(sed -n 's/^description=//p' "$GITHUB_OUTPUT")"
          bash -c "$TEST_STATUS_SCRIPT" || exit $?
        fi
        exit "$observation_exit"
      `] : [script, 'watch', files.receipt, candidate, options.state?.(files.directory) || files.state,
        '--registry', registry, '--timeout-ms', String(options.timeout || 2_000), '--poll-ms', '10', ...(options.uploadResult ? ['--upload-result', uploadResult] : [])];
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
    const read = (name: string) => fs.existsSync(path.join(files.directory, name)) ? fs.readFileSync(path.join(files.directory, name), 'utf8') : '';
    return { ...result, state, uploads, summary: read('summary'), statuses: read('statuses') };
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


test('successful upload and public 404 finish observation with a pending publication, never success or failure', async () => {
  const result = await observe((_request, response) => response.writeHead(404).end(), {
    timeout: 150, workflow: { recovery: false, exists: false, uploadExit: 0 },
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.state.status, 'awaiting-public');
  assert.equal(result.state.uploadStatus, 'accepted');
  assert.equal(result.uploads, 1);
  assert.match(result.summary, /Uploaded successfully; waiting for public availability/);
  assert.match(result.summary, /Release verification remains pending/);
  assert.match(result.statuses, /state=pending/);
  assert(!result.statuses.includes('state=success'));
});

test('known accepted upload remains pending at the bounded deadline, with dedicated exit code 3', async () => {
  const result = await observe((_request, response) => response.writeHead(404).end(), {
    timeout: 150, uploadResult: { exitCode: 0 },
  });
  assert.equal(result.code, 3, result.output);
  assert.equal(result.state.status, 'awaiting-public');
  assert(result.state.elapsedMs >= 150 && result.state.elapsedMs < 1_500);
});

test('read-only continuation preserves accepted upload evidence while still waiting for public availability', async () => {
  const result = await observe((_request, response) => response.writeHead(404).end(), {
    timeout: 150, workflow: { recovery: true, exists: false, uploadExit: 90, priorUploadExit: 0 },
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.state.status, 'awaiting-public');
  assert.equal(result.uploads, 0);
  assert.match(result.statuses, /state=pending/);
});

test('read-only continuation changes pending to verified only for the smoke-accepted public source and digests', async () => {
  const files = fixture();
  try {
    const result = await observe((_request, response) => response.writeHead(200).end(JSON.stringify(files.metadata)), {
      workflow: { recovery: true, exists: false, uploadExit: 90, priorUploadExit: 0 },
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.state.status, 'verified');
    assert.equal(result.uploads, 0);
    assert.match(result.statuses, /state=success/);
  } finally { fs.rmSync(files.directory, { recursive: true, force: true }); }
});

test('failed upload and public absence stay uncertain instead of being relabeled uploaded', async () => {
  const result = await observe((_request, response) => response.writeHead(404).end(), {
    timeout: 150, workflow: { recovery: false, exists: false, uploadExit: 1 },
  });
  assert.equal(result.code, 2, result.output);
  assert.equal(result.state.status, 'uncertain');
  assert.equal(result.uploads, 1);
  assert.match(result.statuses, /state=error/);
  assert(!result.summary.includes('Uploaded successfully'));
});

test('accepted upload does not turn a registry outage into evidence of normal pending publication', async () => {
  const result = await observe((_request, response) => response.writeHead(503).end(), {
    timeout: 150, uploadResult: { exitCode: 0 },
  });
  assert.equal(result.code, 2, result.output);
  assert.equal(result.state.status, 'uncertain');
  assert.equal(result.state.uploadStatus, 'accepted');
});

test('accepted upload still fails on a conflicting public tarball and records failure', async () => {
  const files = fixture();
  files.metadata.dist.shasum = 'b'.repeat(40);
  try {
    const result = await observe((_request, response) => response.writeHead(200).end(JSON.stringify(files.metadata)), {
      workflow: { recovery: false, exists: false, uploadExit: 0 },
    });
    assert.equal(result.code, 1, result.output);
    assert.equal(result.state.status, 'conflict');
    assert.equal(result.uploads, 1);
    assert.match(result.statuses, /state=failure/);
  } finally { fs.rmSync(files.directory, { recursive: true, force: true }); }
});

test('an upload result from another candidate is rejected before observing the registry', async () => {
  let reads = 0;
  const result = await observe((_request, response) => { reads++; response.writeHead(404).end(); }, {
    uploadResult: { exitCode: 0, gitHead: 'b'.repeat(40) },
  });
  assert.equal(result.code, 2);
  assert.equal(reads, 0);
  assert.equal(result.state, null);
});


test('recovery authenticates completed original runs and separates pre-upload from read-only boundaries', () => {
  const verification = stepScript('Verify exact preparation run');
  const start = verification.indexOf('const jobs = JSON.parse(process.env.JOBS_JSON).jobs || [];');
  const precedingRun = verification.lastIndexOf('const run = JSON.parse(process.env.RUN_JSON);', start);
  const end = verification.indexOf('\nNODE', start);
  assert(precedingRun >= 0 && end > precedingRun);
  const recovery = verification.slice(precedingRun, end);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-recovery-'));
  const cases = [
    { conclusion: 'success', publicResult: 'success', uploadResult: 'success', waitResult: 'success', expected: '1' },
    { conclusion: 'failure', publicResult: 'success', uploadResult: 'success', waitResult: 'failure', expected: '1' },
    { conclusion: 'failure', publicResult: 'success', uploadResult: 'failure', expected: '1' },
    { conclusion: 'failure', publicResult: 'failure', uploadResult: 'skipped', expected: '0' },
    { conclusion: 'success', publicResult: 'success', uploadResult: 'success', expected: null },
    { conclusion: 'cancelled', publicResult: 'success', uploadResult: 'success', waitResult: 'success', expected: null },
    { conclusion: 'success', publicResult: 'success', uploadResult: 'success', waitResult: 'success', headSha: 'b'.repeat(40), expected: null },
  ];
  try {
    for (const [index, scenario] of cases.entries()) {
      const environmentFile = path.join(directory, `environment-${index}`);
      const steps = ['Verify exact preparation run', 'Require successful candidate push workflows',
        'Require successful automated and Computer Use acceptance', 'Publish the matching draft release']
        .map(name => ({ name, conclusion: 'success' }));
      steps.push({ name: 'Verify public tag, assets, and manifest', conclusion: scenario.publicResult });
      steps.push({ name: 'Verify and publish npm package with provenance', conclusion: scenario.uploadResult });
      if (scenario.waitResult) steps.push({ name: 'Wait for npm package to become public', conclusion: scenario.waitResult });
      const result = spawnSync(process.execPath, ['-e', recovery], {
        encoding: 'utf8', timeout: 5_000,
        env: { ...process.env, CANDIDATE_SHA: candidate, GITHUB_ENV: environmentFile,
          RUN_JSON: JSON.stringify({ event: 'workflow_dispatch', status: 'completed', conclusion: scenario.conclusion,
            head_sha: scenario.headSha || candidate }),
          JOBS_JSON: JSON.stringify({ jobs: [{ name: 'Publish verified release', steps }] }),
          WORKFLOW_JSON: JSON.stringify({ path: '.github/workflows/publish-release.yml' }) },
      });
      if (scenario.expected === null) {
        assert.notEqual(result.status, 0, JSON.stringify(scenario));
        assert(!fs.existsSync(environmentFile));
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.readFileSync(environmentFile, 'utf8'), `NPM_UPLOAD_MAY_HAVE_STARTED=${scenario.expected}\n`);
      }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
