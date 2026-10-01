import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { observeGitHub } from '../scripts/observe-release-gh.mjs';
import { firstWorkflowError } from '../scripts/release-workflow-first-error.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('workflow observation survives transport failure, retains its checkpoint, and completes the same run', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-workflow-monitor-'));
  try {
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$TEST_ROOT/calls"
count=0
if [[ -f "$TEST_ROOT/count" ]]; then count="$(cat "$TEST_ROOT/count")"; fi
count=$((count + 1))
printf '%s' "$count" > "$TEST_ROOT/count"
if [[ "$count" == 1 ]]; then exit 75; fi
if [[ "$count" == 2 ]]; then
  cat "$TEST_ROOT/running.json"
else
  cp "$TEST_ROOT/evidence/123/latest.json" "$TEST_ROOT/prior-checkpoint.json"
  cat "$TEST_ROOT/completed.json"
fi
`, { mode: 0o755 });
    const run = { workflowName: 'Release Preparation', headSha: 'a'.repeat(40), url: 'https://example.test/runs/123' };
    fs.writeFileSync(path.join(directory, 'running.json'), JSON.stringify({ ...run, status: 'in_progress', conclusion: '', jobs: [
      { name: 'Native app', status: 'in_progress', conclusion: '', steps: [{ name: 'Build native browser', status: 'in_progress' }] },
    ] }));
    fs.writeFileSync(path.join(directory, 'completed.json'), JSON.stringify({ ...run, status: 'completed', conclusion: 'success', jobs: [] }));
    const result = spawnSync('bash', [path.resolve(__dirname, '../scripts/watch-run.sh'), '123', 'example/farming'], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TEST_ROOT: directory,
        FARMING_RELEASE_WATCH_DIR: path.join(directory, 'evidence'), FARMING_RELEASE_WORKFLOW_POLL_SECONDS: '1',
        FARMING_RELEASE_OBSERVATION_TIMEOUT_MS: '30000' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /rechecking the same run/);
    assert.match(result.stdout, /Build native browser/);
    const preserved = JSON.parse(fs.readFileSync(path.join(directory, 'prior-checkpoint.json'), 'utf8'));
    assert.equal(preserved.conclusion, '');
    assert.equal(preserved.progress.jobs[0].step, 'Build native browser');
    const latest = JSON.parse(fs.readFileSync(path.join(directory, 'evidence/123/latest.json'), 'utf8'));
    assert.equal(latest.runId, '123');
    assert.equal(latest.headSha, run.headSha);
    assert.equal(latest.conclusion, 'success');
    assert.match(latest.observedAt, /^\d{4}-/);
    const calls = fs.readFileSync(path.join(directory, 'calls'), 'utf8').trim().split('\n');
    assert.equal(calls.length, 3);
    assert(calls.every(call => call.startsWith('run view 123 --repo example/farming ')));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('observation deadline applies before startup and kills the exact group when ownership becomes available', async () => {
  const child: EventEmitter & { pid?: number; kill(): boolean } = Object.assign(new EventEmitter(), { kill: () => true });
  const signals = new EventEmitter();
  const kills: unknown[][] = [];
  let expire: () => void = () => { throw new Error('deadline was not registered'); };
  let cleared = false;
  const result = observeGitHub(['run', 'view', '123'], {
    timeoutMs: 400,
    spawnProcess: () => child,
    signals,
    platform: 'linux',
    killProcess: (...args: unknown[]) => { kills.push(args); },
    schedule: (callback: () => void, duration: number) => { assert.equal(duration, 400); expire = callback; return 17; },
    unschedule: (timer: number) => { assert.equal(timer, 17); cleared = true; },
    stderr: () => {},
  });
  expire();
  assert.deepEqual(kills, [], 'no process group is owned before spawn');
  child.pid = 12345;
  child.emit('spawn');
  assert.deepEqual(kills, [[-12345, 'SIGKILL']]);
  child.emit('close', null);
  assert.equal(await result, 124);
  assert(cleared);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

async function readyFile(file: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Fixture readiness was not reached: ${file}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

for (const command of [['run', 'view', '123'], ['run', 'list', '--commit', 'b'.repeat(40)]]) {
  test(`cancel ready ${command.slice(0, 2).join(' ')} observation and clean exact descendants`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-observation-cancel-'));
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/bash
set -eu
printf '%s\\n' "$*" > "$TEST_ROOT/calls"
printf '%s' "$$" > "$TEST_ROOT/gh-pid"
node -e 'setInterval(() => {}, 1000)' &
printf '%s' "$!" > "$TEST_ROOT/descendant-pid"
touch "$TEST_ROOT/ready"
wait
`, { mode: 0o755 });
    const child = spawn(process.execPath, [path.resolve(__dirname, '../scripts/observe-release-gh.mjs'), ...command], {
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TEST_ROOT: directory,
        FARMING_RELEASE_OBSERVATION_TIMEOUT_MS: '30000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', data => { stderr += String(data); });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    try {
      await readyFile(path.join(directory, 'ready'));
      assert.match(fs.readFileSync(path.join(directory, 'calls'), 'utf8'), new RegExp(`^${command.slice(0, 2).join(' ')} `));
      child.kill('SIGTERM');
      assert.equal(await closed, 143, stderr);
      const pid = fs.readFileSync(path.join(directory, 'descendant-pid'), 'utf8');
      const state = spawnSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' });
      assert(!state.stdout.trim() || state.stdout.trim().startsWith('Z'), 'cancelled observation must kill exact owned descendants');
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await closed; }
      const owned = path.join(directory, 'gh-pid');
      if (child.exitCode !== 143 && fs.existsSync(owned)) {
        try { process.kill(-Number(fs.readFileSync(owned, 'utf8')), 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('candidate read failure retains its prior checkpoint and once mode fails closed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-candidate-monitor-'));
  try {
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/bash\nprintf "%s\\n" "$*" > "$TEST_ROOT/calls"\nexit 75\n', { mode: 0o755 });
    const sha = 'b'.repeat(40);
    const evidence = path.join(directory, 'evidence', `candidate-${sha}`);
    fs.mkdirSync(evidence, { recursive: true });
    const checkpoint = '[{"databaseId":123,"status":"in_progress"}]\n';
    fs.writeFileSync(path.join(evidence, 'workflows.json'), checkpoint);
    const result = spawnSync('bash', [path.resolve(__dirname, '../scripts/watch-candidate-workflows.sh'), sha, 'example/farming', '0', 'once'], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TEST_ROOT: directory,
        FARMING_RELEASE_WATCH_DIR: path.join(directory, 'evidence') },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /outcome remains unknown/);
    assert.equal(fs.readFileSync(path.join(evidence, 'workflows.json'), 'utf8'), checkpoint);
    assert.match(fs.readFileSync(path.join(directory, 'calls'), 'utf8'), /^run list /);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('bounded observation rejects mutating commands and invalid deadlines before spawning gh', () => {
  for (const args of [['workflow', 'run', 'release.yml'], ['api', 'repos/example/farming', '-XPOST'], ['api', 'repos/example/farming', '--method=POST']]) {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/observe-release-gh.mjs'), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /read-only GitHub observation/);
  }
  const invalidDeadline = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/observe-release-gh.mjs'), 'run', 'view', '123'], {
    encoding: 'utf8', env: { ...process.env, FARMING_RELEASE_OBSERVATION_TIMEOUT_MS: 'NaN' },
  });
  assert.equal(invalidDeadline.status, 2);
});

test('first error excludes echoed shell source and prioritizes substantive runtime evidence', () => {
  const log = [
    '2026-10-01 ##[group]Run set -euo pipefail',
    '\u001b[36;1m  throw new Error("Unexpected failed workflow");\u001b[0m',
    'echo "npm error source text"',
    '2026-10-01 ##[endgroup]',
    '2026-10-01 {"status":"uncertain","reason":"Reconciliation deadline reached. Upload outcome remains uncertain"}',
    '2026-10-01 ##[error]Process completed with exit code 2.',
  ].join('\n');
  assert.match(firstWorkflowError(log), /^5:.*Reconciliation deadline reached/);
  assert.equal(firstWorkflowError('\u001b[36;1mthrow new Error("Unexpected failed workflow");\u001b[0m'), '');
  assert.match(firstWorkflowError('earlier job failed\n##[error]npm artifact digest mismatch'), /^2:.*artifact digest mismatch/);
});

for (const mode of ['fail-fast', 'wait-terminal']) {
  test(`run watcher ${mode} distinguishes failed job from authoritative overall completion`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-job-failure-monitor-'));
    try {
      const bin = path.join(directory, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$TEST_ROOT/calls"
if [[ "$1 $2" == 'run view' ]]; then
  count=0
  if [[ -f "$TEST_ROOT/count" ]]; then count="$(cat "$TEST_ROOT/count")"; fi
  count=$((count + 1))
  printf '%s' "$count" > "$TEST_ROOT/count"
  if [[ "$count" == 1 ]]; then cat "$TEST_ROOT/running.json"; else cat "$TEST_ROOT/completed.json"; fi
elif [[ "$2" == */logs ]]; then
  cat "$TEST_ROOT/log"
else
  printf '%s\\n' 'scripts/example.ts'
fi
`, { mode: 0o755 });
      const run = {
        workflowName: 'Release Publication', headSha: 'c'.repeat(40), url: 'https://example.test/runs/456',
        jobs: [{ databaseId: 789, name: 'Publish', status: 'completed', conclusion: 'failure' },
          { databaseId: 790, name: 'Retain evidence', status: 'in_progress', conclusion: '' }],
      };
      fs.writeFileSync(path.join(directory, 'running.json'), JSON.stringify({ ...run, status: 'in_progress', conclusion: '' }));
      fs.writeFileSync(path.join(directory, 'completed.json'), JSON.stringify({ ...run, status: 'completed', conclusion: 'failure' }));
      fs.writeFileSync(path.join(directory, 'log'), '\u001b[36;1mthrow new Error("Unexpected failed workflow");\u001b[0m\nError: upload outcome remains uncertain\n##[error]Process completed with exit code 2.\n');
      const result = spawnSync('bash', [path.resolve(__dirname, '../scripts/watch-run.sh'), '456', 'example/farming', mode], {
        encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TEST_ROOT: directory,
          FARMING_RELEASE_WATCH_DIR: path.join(directory, 'evidence'), FARMING_RELEASE_WORKFLOW_POLL_SECONDS: '1' },
      });
      assert.equal(result.status, 1, result.stderr);
      const bundle = path.join(directory, 'evidence/456');
      const summary = JSON.parse(fs.readFileSync(path.join(bundle, 'summary.json'), 'utf8'));
      assert.equal(summary.runStatus, 'in_progress');
      assert.equal(summary.runCompleted, false);
      assert.match(summary.firstError, /^2:Error: upload outcome remains uncertain/);
      const checkpoint = JSON.parse(fs.readFileSync(path.join(bundle, 'latest.json'), 'utf8'));
      assert.equal(checkpoint.status, mode === 'fail-fast' ? 'in_progress' : 'completed');
      assert.equal(checkpoint.watcher.stopped, true);
      assert.equal(checkpoint.watcher.exitCode, 1);
      assert.equal(checkpoint.watcher.state, 'job-failed');
      assert.equal(checkpoint.watcher.mode, mode);
      const calls = fs.readFileSync(path.join(directory, 'calls'), 'utf8').trim().split('\n');
      assert.equal(calls.filter(call => call.endsWith('/logs')).length, 1, 'retain the first failure without replaying log downloads');
      assert.equal(calls.filter(call => call.startsWith('run view ')).length, mode === 'fail-fast' ? 1 : 2);
      assert(calls.every(call => /^(run view|api repos\/example\/farming\/(actions\/jobs|commits))/.test(call)), 'only read operations are allowed');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}

test('captured metadata output is bounded, suppresses raw stderr, and tears down the exact group on overflow', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 23456, stdout: new EventEmitter(), kill: () => true });
  const chunks: Buffer[] = [];
  const kills: unknown[][] = [];
  const messages: string[] = [];
  const result = observeGitHub(['api', 'repos/example/farming/actions/runs/123'], {
    spawnProcess: (_command: string, _args: string[], options: { stdio: 'inherit' | string[] }) => {
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']);
      return child;
    },
    signals: new EventEmitter(), platform: 'linux',
    killProcess: (...args: unknown[]) => { kills.push(args); },
    schedule: () => 17, unschedule: () => {},
    onStdout: (chunk: Buffer) => { chunks.push(chunk); }, maxOutputBytes: 4,
    stderr: (message: string) => { messages.push(message); },
  });
  child.stdout.emit('data', Buffer.from('1234'));
  child.stdout.emit('data', Buffer.from('5'));
  child.stdout.emit('data', Buffer.from('discarded after failure'));
  child.emit('close', 0);
  assert.equal(await result, 125, 'overflow cannot become successful parsed metadata');
  assert.equal(Buffer.concat(chunks).toString(), '1234');
  assert.deepEqual(kills, [[-23456, 'SIGKILL']], 'only one exact group teardown is performed');
  assert.deepEqual(messages, ['GitHub observation exceeded 4 output bytes; workflow outcome remains unknown.']);
});
