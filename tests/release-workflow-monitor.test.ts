import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('workflow observation survives transport failure and a hung request, retains its checkpoint, and completes the same run', () => {
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
elif [[ "$count" == 3 ]]; then
  node -e 'setInterval(() => {}, 1000)' &
  printf '%s' "$!" > "$TEST_ROOT/descendant-pid"
  wait
else
  node -e 'const s=require(process.env.TEST_ROOT+"/evidence/123/latest.json"); if(s.conclusion!=="" || s.progress.jobs[0].step!=="Build native browser") process.exit(1)'
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
        FARMING_RELEASE_OBSERVATION_TIMEOUT_MS: '400' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /rechecking the same run/);
    assert.match(result.stderr, /exceeded 400ms; workflow outcome remains unknown/);
    assert.match(result.stdout, /Build native browser/);
    const latest = JSON.parse(fs.readFileSync(path.join(directory, 'evidence/123/latest.json'), 'utf8'));
    assert.equal(latest.runId, '123');
    assert.equal(latest.headSha, run.headSha);
    assert.equal(latest.conclusion, 'success');
    assert.match(latest.observedAt, /^\d{4}-/);
    const calls = fs.readFileSync(path.join(directory, 'calls'), 'utf8').trim().split('\n');
    assert.equal(calls.length, 4);
    assert(calls.every(call => call.startsWith('run view 123 --repo example/farming ')));
    const pid = fs.readFileSync(path.join(directory, 'descendant-pid'), 'utf8');
    const state = spawnSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' });
    assert(!state.stdout.trim() || state.stdout.trim().startsWith('Z'), 'timed-out observation must kill its owned descendants');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('candidate observation timeout retains evidence and once mode fails closed without mutation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-candidate-monitor-'));
  try {
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/bash
printf '%s\\n' "$*" >> "$TEST_ROOT/calls"
node -e 'setInterval(() => {}, 1000)' &
printf '%s' "$!" > "$TEST_ROOT/descendant-pid"
wait
`, { mode: 0o755 });
    const sha = 'b'.repeat(40);
    const evidence = path.join(directory, 'evidence', `candidate-${sha}`);
    fs.mkdirSync(evidence, { recursive: true });
    const checkpoint = '[{"databaseId":123,"status":"in_progress"}]\n';
    fs.writeFileSync(path.join(evidence, 'workflows.json'), checkpoint);
    const result = spawnSync('bash', [path.resolve(__dirname, '../scripts/watch-candidate-workflows.sh'), sha, 'example/farming', '0', 'once'], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TEST_ROOT: directory,
        FARMING_RELEASE_WATCH_DIR: path.join(directory, 'evidence'), FARMING_RELEASE_OBSERVATION_TIMEOUT_MS: '400' },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /outcome remains unknown/);
    assert.equal(fs.readFileSync(path.join(evidence, 'workflows.json'), 'utf8'), checkpoint);
    const calls = fs.readFileSync(path.join(directory, 'calls'), 'utf8').trim().split('\n');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^run list /);
    const pid = fs.readFileSync(path.join(directory, 'descendant-pid'), 'utf8');
    const state = spawnSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' });
    assert(!state.stdout.trim() || state.stdout.trim().startsWith('Z'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
