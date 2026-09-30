import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('workflow observation survives a transport failure, checkpoints progress, and follows the same live run to completion', () => {
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
        FARMING_RELEASE_WATCH_DIR: path.join(directory, 'evidence'), FARMING_RELEASE_WORKFLOW_POLL_SECONDS: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /rechecking the same run/);
    assert.match(result.stdout, /Build native browser/);
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
