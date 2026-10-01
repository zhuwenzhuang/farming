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
    advanceAbortByMs?: number;
    workflow?: { recovery: boolean; exists: boolean; uploadExit: number; corrupt?: boolean; priorUploadExit?: number; automatic?: boolean; candidatePublicationRunId?: string };
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
    if (options.advanceAbortByMs) {
      const preload = path.join(files.directory, 'coarse-abort-timer.mjs');
      fs.writeFileSync(preload, `const timeout = AbortSignal.timeout.bind(AbortSignal);\nAbortSignal.timeout = milliseconds => timeout(Math.max(1, milliseconds - ${options.advanceAbortByMs}));\n`);
      env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --import=${preload}`;
    }
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
        if (options.workflow.automatic) fs.writeFileSync(path.join(files.directory, 'prior-npm-evidence/upload-origin.json'), JSON.stringify({
          schemaVersion: 1, repository: 'example/farming', runId: '101', runAttempt: '1',
          candidatePublicationRunId: '101', candidatePublicationRunAttempt: '1',
          candidateSha: candidate, version: '1.2.3', preparationRunId: '99',
        }));
      }
      fs.writeFileSync(path.join(bin, 'node'), `#!/bin/bash
if [[ "$2" == watch ]]; then
  args=("$@")
  timeout_present=0
  for index in "\${!args[@]}"; do
    if [[ "\${args[index]}" == '--timeout-ms' ]]; then
      args[index+1]="$TEST_TIMEOUT"
      timeout_present=1
    fi
  done
  if [[ "$timeout_present" == 0 ]]; then args+=(--timeout-ms "$TEST_TIMEOUT"); fi
  exec "$TEST_NODE" "\${args[@]}" --registry "$TEST_REGISTRY" --poll-ms 10
fi
exec "$TEST_NODE" "$@"
`, { mode: 0o755 });
      Object.assign(env, { PATH: `${bin}${path.delimiter}${env.PATH}`, NPM_TOKEN: '', CANDIDATE_SHA: candidate, FARMING_RELEASE_VERSION: '1.2.3',
        NPM_UPLOAD_MAY_HAVE_STARTED: options.workflow.recovery ? '1' : '0', TEST_EXISTS_EXIT: options.workflow.exists ? '0' : '1',
        TEST_UPLOAD_EXIT: String(options.workflow.uploadExit), TEST_UPLOADS: path.join(files.directory, 'uploads'),
        TEST_PUBLISH_SCRIPT: publicationScript,
        TEST_OBSERVE_SCRIPT: options.workflow.automatic
          ? continuationWorkflow.jobs.observe.steps.find((step: { name: string }) => step.name === 'Observe accepted upload without replay').run : observationScript,
        TEST_STATUS_SCRIPT: options.workflow.automatic
          ? continuationWorkflow.jobs.observe.steps.find((step: { name: string }) => step.name === 'Record npm publication status').run : statusScript,
        RELEASE_VERSION: '1.2.3', PREPARATION_RUN_ID: '99', GITHUB_RUN_ATTEMPT: '1',
        NPM_CANDIDATE_PUBLICATION_RUN_ID: options.workflow.candidatePublicationRunId || '',
        NPM_CANDIDATE_PUBLICATION_RUN_ATTEMPT: options.workflow.candidatePublicationRunId ? '1' : '',
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
    const originFile = path.join(files.directory, 'npm-evidence/upload-origin.json');
    const origin = fs.existsSync(originFile) ? JSON.parse(fs.readFileSync(originFile, 'utf8')) : null;
    return { ...result, state, uploads, origin, summary: read('summary'), statuses: read('statuses') };
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
          RUN_JSON: JSON.stringify({ id: 101, run_attempt: 1, event: 'workflow_dispatch', status: 'completed', conclusion: scenario.conclusion,
            head_sha: scenario.headSha || candidate }),
          JOBS_JSON: JSON.stringify({ jobs: [{ name: 'Publish verified release', steps }] }),
          WORKFLOW_JSON: JSON.stringify({ path: '.github/workflows/publish-release.yml' }) },
      });
      if (scenario.expected === null) {
        assert.notEqual(result.status, 0, JSON.stringify(scenario));
        assert(!fs.existsSync(environmentFile));
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.readFileSync(environmentFile, 'utf8'), `NPM_UPLOAD_MAY_HAVE_STARTED=${scenario.expected}\nNPM_CANDIDATE_PUBLICATION_RUN_ID=101\nNPM_CANDIDATE_PUBLICATION_RUN_ATTEMPT=1\n`);
      }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

const continuationScript = path.resolve(__dirname, '../scripts/continue-npm-publication.mjs');
const continuationWorkflow = YAML.parse(fs.readFileSync(path.resolve(__dirname, '../.github/workflows/observe-npm-publication.yml'), 'utf8'));

function continuationFixture() {
  const files = fixture();
  const repository = 'example/farming';
  const origin = { schemaVersion: 1, repository, runId: '101', runAttempt: '1', candidateSha: candidate,
    candidatePublicationRunId: '101', candidatePublicationRunAttempt: '1',
    version: '1.2.3', preparationRunId: '99' };
  const upload = { packageName: 'farming-code', version: '1.2.3', gitHead: candidate,
    uploadExitCode: 0, observedAt: '2026-10-01T04:29:39.000Z' };
  const state = { packageName: 'farming-code', version: '1.2.3', gitHead: candidate,
    uploadStatus: 'accepted', status: 'awaiting-public' };
  const evidence = { origin, upload, state, receipt: files.evidence };
  const steps = ['Verify exact preparation run', 'Require successful candidate push workflows',
    'Require successful automated and Computer Use acceptance', 'Publish the matching draft release',
    'Verify public tag, assets, and manifest', 'Verify and publish npm package with provenance',
    'Wait for npm package to become public'].map(name => ({ name, conclusion: 'success' }));
  const jobs = { total_count: 1, jobs: [{ name: 'Publish verified release', steps }] };
  const run = { id: 101, run_attempt: 1, repository: { full_name: repository }, head_repository: { full_name: repository },
    workflow_id: 7, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', head_sha: candidate };
  const workflow = { id: 7, path: '.github/workflows/publish-release.yml' };
  return { ...files, repository, evidence, jobs, run, workflow };
}

function callContinuationValidation(operation: string, payload: unknown) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    const module = await import(process.env.TEST_CONTINUATION_SCRIPT);
    const payload = JSON.parse(process.env.TEST_CONTINUATION_PAYLOAD);
    try { console.log(JSON.stringify(module[process.env.TEST_CONTINUATION_OPERATION](...payload))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  `], { encoding: 'utf8', timeout: 5_000, env: { ...process.env, TEST_CONTINUATION_SCRIPT: continuationScript,
    TEST_CONTINUATION_OPERATION: operation, TEST_CONTINUATION_PAYLOAD: JSON.stringify(payload) } });
}

test('automatic observation uses a trusted completion lifecycle with no npm upload authority or recursive trigger', () => {
  assert.deepEqual(continuationWorkflow.on.workflow_run, { workflows: ['Publish Release'], types: ['completed'] });
  assert.equal(continuationWorkflow.on.schedule, undefined);
  assert.equal(continuationWorkflow.permissions.contents, 'read');
  const observer = continuationWorkflow.jobs.observe;
  assert.deepEqual(observer.permissions, { actions: 'read', contents: 'read', statuses: 'write' });
  assert.equal(observer.timeoutMinutes ?? observer['timeout-minutes'], 25);
  assert.equal(observer.concurrency.group, 'farming-publication-${{ needs.identify.outputs.version }}');
  for (const job of Object.values(continuationWorkflow.jobs) as Array<{ steps: Array<{ name: string; run?: string; with?: Record<string, unknown> }> }>) {
    const checkout = job.steps.find(step => step.name === 'Checkout trusted publication verifier');
    assert.equal(checkout?.with?.ref, '${{ github.sha }}');
    assert.equal(checkout?.with?.['persist-credentials'], false);
    const scripts = job.steps.map(step => step.run || '').join('\n');
    assert(!scripts.includes('npm publish'));
    assert(!scripts.includes('NPM_TOKEN'));
    assert(!scripts.includes('gh release'));
  }
});

test('original upload authentication rejects forged event, repository, workflow, incomplete jobs and candidate identities', () => {
  const files = continuationFixture();
  try {
    const valid = callContinuationValidation('authenticateRun', [files.run, files.workflow, files.jobs, files.repository, '101', '1']);
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout.trim(), 'true');
    for (const mutated of [
      { ...files.run, event: 'pull_request' }, { ...files.run, status: 'in_progress' },
      { ...files.run, conclusion: 'cancelled' }, { ...files.run, run_attempt: 2 },
      { ...files.run, head_repository: { full_name: 'attacker/farming' } },
      { ...files.run, repository: { full_name: 'attacker/farming' } }, { ...files.run, head_sha: 'invalid' },
    ]) {
      const result = callContinuationValidation('authenticateRun', [mutated, files.workflow, files.jobs, files.repository, '101', '1']);
      assert.notEqual(result.status, 0, JSON.stringify(mutated));
    }
    assert.notEqual(callContinuationValidation('authenticateRun', [files.run, { ...files.workflow, path: '.github/workflows/fake.yml' }, files.jobs, files.repository, '101', '1']).status, 0);
    assert.notEqual(callContinuationValidation('authenticateRun', [files.run, files.workflow, { ...files.jobs, total_count: 2 }, files.repository, '101', '1']).status, 0);
    const preUpload = { ...files.jobs, jobs: [{ ...files.jobs.jobs[0], steps: files.jobs.jobs[0].steps.filter(step => step.name !== 'Verify public tag, assets, and manifest') }] };
    const earlyFailure = callContinuationValidation('authenticateRun', [files.run, files.workflow, preUpload, files.repository, '101', '1']);
    assert.equal(earlyFailure.status, 0);
    assert.equal(earlyFailure.stdout.trim(), 'false');
  } finally { fs.rmSync(files.directory, { recursive: true, force: true }); }
});

test('canonical original evidence rejects changed source, digest, upload timestamp and uncertain upload', () => {
  const files = continuationFixture();
  try {
    const valid = callContinuationValidation('validateEvidence', [files.evidence, files.evidence, files.run, files.repository, '1.2.3']);
    assert.equal(valid.status, 0, valid.stderr);
    const modifications = [
      { ...files.evidence, origin: { ...files.evidence.origin, runId: '102' } },
      { ...files.evidence, origin: { ...files.evidence.origin, candidateSha: 'b'.repeat(40) } },
      { ...files.evidence, receipt: { ...files.evidence.receipt, integrity: `sha512-${'A'.repeat(86)}==` } },
      { ...files.evidence, upload: { ...files.evidence.upload, observedAt: '2026-10-01T05:00:00.000Z' } },
      { ...files.evidence, upload: { ...files.evidence.upload, uploadExitCode: 1 } },
      { ...files.evidence, state: { ...files.evidence.state, status: 'verified' } },
    ];
    for (const trigger of modifications) {
      assert.notEqual(callContinuationValidation('validateEvidence', [trigger, files.evidence, files.run, files.repository, '1.2.3']).status, 0);
    }
    assert.notEqual(callContinuationValidation('validateEvidence', [files.evidence, files.evidence, { ...files.run, head_sha: 'b'.repeat(40) }, files.repository, '1.2.3']).status, 0);
  } finally { fs.rmSync(files.directory, { recursive: true, force: true }); }
});

test('canonical artifact selection rejects duplicate, expired and oversized evidence instead of guessing', () => {
  const artifact = { id: 3, name: 'farming-npm-publication-1.2.3', expired: false, size_in_bytes: 4096 };
  assert.equal(callContinuationValidation('selectEvidenceArtifact', [{ total_count: 1, artifacts: [artifact] }, '1.2.3']).status, 0);
  for (const artifacts of [[artifact, { ...artifact, id: 4 }], [{ ...artifact, expired: true }], [{ ...artifact, size_in_bytes: 1_000_001 }], []]) {
    assert.notEqual(callContinuationValidation('selectEvidenceArtifact', [{ total_count: artifacts.length, artifacts }, '1.2.3']).status, 0);
  }
});

for (const firstUploadInRecovery of [false, true]) test(firstUploadInRecovery
  ? 'first upload in a newer pre-upload recovery preserves exact candidate gate lineage and preparation'
  : 'a newer recovery verifier observes the original candidate only after authenticated canonical identity checks', () => {
  const files = continuationFixture();
  if (firstUploadInRecovery) files.evidence.origin.runId = '202';
  const prefix = `repos/${files.repository}`;
  const triggerRun = { ...files.run, id: 202, head_sha: 'b'.repeat(40) };
  const recoveryJobs = { total_count: 1, jobs: [{ name: 'Publish verified release', steps: [
    ...files.jobs.jobs[0].steps.map(step => ['Require successful candidate push workflows', 'Publish the matching draft release'].includes(step.name)
      ? { ...step, conclusion: 'skipped' } : step),
    { name: 'Checkout recovery verifier', conclusion: 'success' },
    { name: 'Download prior npm publication evidence', conclusion: firstUploadInRecovery ? 'skipped' : 'success' },
  ] }] };
  const artifact = { id: 3, name: 'farming-npm-publication-1.2.3', expired: false, size_in_bytes: 4096 };
  const candidateRun = firstUploadInRecovery ? { ...files.run, conclusion: 'failure' } : files.run;
  const candidateJobs = firstUploadInRecovery ? { ...files.jobs, jobs: [{ ...files.jobs.jobs[0],
    steps: files.jobs.jobs[0].steps.map(step => step.name === 'Verify public tag, assets, and manifest'
      ? { ...step, conclusion: 'failure' } : ['Verify and publish npm package with provenance', 'Wait for npm package to become public'].includes(step.name)
        ? { ...step, conclusion: 'skipped' } : step),
  }] } : files.jobs;
  const responses = {
    [`${prefix}/actions/runs/101/attempts/1`]: candidateRun,
    [`${prefix}/actions/runs/202/attempts/1`]: triggerRun,
    [`${prefix}/actions/workflows/7`]: files.workflow,
    [`${prefix}/actions/runs/99`]: { ...files.run, id: 99, workflow_id: 8 },
    [`${prefix}/actions/workflows/8`]: { id: 8, path: '.github/workflows/release.yml' },
    [`${prefix}/actions/runs/101/attempts/1/jobs?per_page=100`]: candidateJobs,
    [`${prefix}/actions/runs/202/attempts/1/jobs?per_page=100`]: recoveryJobs,
    [`${prefix}/compare/${candidate}...main`]: { status: 'ahead', base_commit: { sha: candidate } },
    [`${prefix}/compare/${'b'.repeat(40)}...main`]: { status: 'identical', base_commit: { sha: 'b'.repeat(40) } },
    [`${prefix}/actions/runs/101/artifacts?per_page=100`]: { total_count: 1, artifacts: [artifact] },
    [`${prefix}/actions/runs/202/artifacts?per_page=100`]: { total_count: 1, artifacts: [{ ...artifact, id: 4 }] },
  };
  try {
    assert.equal(callContinuationValidation('authenticateRun', [triggerRun, files.workflow, recoveryJobs, files.repository, '202', '1', 'trigger']).stdout.trim(), 'true');
    assert.equal(callContinuationValidation('authenticateRun', [triggerRun, files.workflow, recoveryJobs, files.repository, '202', '1']).stdout.trim(), 'false');
    const bin = path.join(files.directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nconst fs=require('node:fs'); const responses=JSON.parse(fs.readFileSync(process.env.TEST_API_FILE)); const response=responses[process.argv[3]]; if (!response) process.exit(91); console.log(JSON.stringify(response));\n`, { mode: 0o755 });
    const responseFile = path.join(files.directory, 'responses.json');
    fs.writeFileSync(responseFile, JSON.stringify(responses));
    const eventFile = path.join(files.directory, 'event.json');
    fs.writeFileSync(eventFile, JSON.stringify({ action: 'completed', repository: { full_name: files.repository }, workflow_run: triggerRun }));
    for (const name of ['trigger', 'canonical']) {
      fs.mkdirSync(path.join(files.directory, name));
      for (const [filename, content] of Object.entries({ 'upload-origin.json': files.evidence.origin,
        'upload-result.json': files.evidence.upload, 'npm-smoke-receipt.json': files.evidence.receipt,
        'publication-state.json': files.evidence.state })) fs.writeFileSync(path.join(files.directory, name, filename), JSON.stringify(content));
    }
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      TEST_API_FILE: responseFile, GITHUB_EVENT_PATH: eventFile, GITHUB_REPOSITORY: files.repository,
      RELEASE_VERSION: '1.2.3', TRIGGER_RUN_ID: '202', TRIGGER_RUN_ATTEMPT: '1' };
    for (const args of [['locate'], ['identify', 'trigger'], ['validate', 'trigger', 'canonical']]) {
      const result = spawnSync(process.execPath, [continuationScript, ...args], { env, cwd: files.directory, encoding: 'utf8', timeout: 5_000 });
      assert.equal(result.status, 0, result.stderr);
    }
    const preserved = JSON.parse(fs.readFileSync(path.join(files.directory, 'npm-evidence/upload-origin.json'), 'utf8'));
    assert.equal(preserved.candidateSha, candidate);
    assert.equal(preserved.runId, firstUploadInRecovery ? '202' : '101');
    assert.equal(preserved.candidatePublicationRunId, '101');
    assert.notEqual(preserved.candidateSha, triggerRun.head_sha);
    fs.writeFileSync(path.join(files.directory, 'trigger/npm-smoke-receipt.json'), JSON.stringify({ ...files.evidence.receipt, shasum: 'b'.repeat(40) }));
    assert.notEqual(spawnSync(process.execPath, [continuationScript, 'validate', 'trigger', 'canonical'], { env, cwd: files.directory, encoding: 'utf8', timeout: 5_000 }).status, 0);
    if (firstUploadInRecovery) {
      fs.writeFileSync(path.join(files.directory, 'trigger/npm-smoke-receipt.json'), JSON.stringify(files.evidence.receipt));
      responses[`${prefix}/actions/runs/99`].head_sha = triggerRun.head_sha;
      fs.writeFileSync(responseFile, JSON.stringify(responses));
      const preparationMismatch = spawnSync(process.execPath, [continuationScript, 'validate', 'trigger', 'canonical'], { env, cwd: files.directory, encoding: 'utf8', timeout: 5_000 });
      assert.notEqual(preparationMismatch.status, 0);
      assert.match(preparationMismatch.stderr, /Preparation does not prove the exact candidate source/);
      responses[`${prefix}/actions/runs/99`].head_sha = candidate;
      responses[`${prefix}/actions/runs/101/attempts/1`].head_sha = triggerRun.head_sha;
      fs.writeFileSync(responseFile, JSON.stringify(responses));
      const candidateMismatch = spawnSync(process.execPath, [continuationScript, 'validate', 'trigger', 'canonical'], { env, cwd: files.directory, encoding: 'utf8', timeout: 5_000 });
      assert.notEqual(candidateMismatch.status, 0);
      assert.match(candidateMismatch.stderr, /exact candidate publication/);
    }
  } finally { fs.rmSync(files.directory, { recursive: true, force: true }); }
});

test('automatic observer deadline retains accepted waiting state and records ended observation without uploading', async () => {
  const result = await observe((_request, response) => response.writeHead(404).end(), {
    timeout: 150, workflow: { recovery: true, exists: false, uploadExit: 90, priorUploadExit: 0, automatic: true },
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.uploads, 0);
  assert.equal(result.state.status, 'awaiting-public');
  assert.equal(result.state.observationStatus, 'ended');
  assert.equal(result.state.originalUploadRunId, '101');
  assert.match(result.summary, /bounded automatic continuation has ended/);
  assert.match(result.statuses, /state=pending/);
  assert(!result.statuses.includes('state=error'));
});

test('automatic observer updates the exact candidate to success only when the original digests become public', async () => {
  const files = fixture();
  try {
    const result = await observe((_request, response) => response.writeHead(200).end(JSON.stringify(files.metadata)), {
      workflow: { recovery: true, exists: false, uploadExit: 90, priorUploadExit: 0, automatic: true },
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.uploads, 0);
    assert.equal(result.state.status, 'verified');
    assert.equal(result.state.observationStatus, 'ended');
    assert.match(result.statuses, new RegExp(`statuses/${candidate}`));
    assert.match(result.statuses, /state=success/);
  } finally { fs.rmSync(files.directory, { recursive: true, force: true }); }
});

test('automatic observer records conflict as failure and registry transport uncertainty as error', async () => {
  const files = fixture();
  try {
    const conflict = await observe((_request, response) => response.writeHead(200).end(JSON.stringify({ ...files.metadata, gitHead: 'b'.repeat(40) })), {
      workflow: { recovery: true, exists: false, uploadExit: 90, priorUploadExit: 0, automatic: true },
    });
    assert.equal(conflict.code, 1, conflict.output);
    assert.equal(conflict.uploads, 0);
    assert.match(conflict.statuses, /state=failure/);
    const uncertain = await observe((_request, response) => response.writeHead(503).end(), {
      timeout: 150, workflow: { recovery: true, exists: false, uploadExit: 90, priorUploadExit: 0, automatic: true },
    });
    assert.equal(uncertain.code, 2, uncertain.output);
    assert.equal(uncertain.uploads, 0);
    assert.match(uncertain.statuses, /state=error/);
  } finally { fs.rmSync(files.directory, { recursive: true, force: true }); }
});

test('first recovery upload checkpoints the actual uploader separately from the authenticated candidate dispatch', async () => {
  const result = await observe((_request, response) => response.writeHead(404).end(), {
    timeout: 150, workflow: { recovery: false, exists: false, uploadExit: 0, candidatePublicationRunId: '101' },
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.uploads, 1);
  assert.equal(result.origin.runId, '123');
  assert.equal(result.origin.candidatePublicationRunId, '101');
  assert.equal(result.origin.candidateSha, candidate);
  assert.equal(result.origin.preparationRunId, '99');
  assert.equal(result.state.status, 'awaiting-public');
});

test('an owned observer-deadline abort preserves confirmed absence even when timer precision fires it early', async () => {
  let reads = 0;
  const result = await observe((_request, response) => {
    if (++reads === 1) response.writeHead(404).end();
    // The next request stalls until the observer-owned timeout fires.
  }, { timeout: 150, uploadResult: { exitCode: 0 }, advanceAbortByMs: 5 });
  assert(reads >= 2);
  assert.equal(result.code, 3, result.output);
  assert.equal(result.state.status, 'awaiting-public');
  assert.equal(result.state.uploadStatus, 'accepted');
});

test('ordinary transport failure before the global deadline does not preserve prior public absence', async () => {
  let reads = 0;
  const result = await observe((request, response) => {
    if (++reads === 1) response.writeHead(404).end();
    else request.socket.destroy();
  }, { timeout: 150, uploadResult: { exitCode: 0 } });
  assert(reads >= 2);
  assert.equal(result.code, 2, result.output);
  assert.equal(result.state.status, 'uncertain');
  assert.equal(result.state.uploadStatus, 'accepted');
});
