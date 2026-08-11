const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  TerminalStartupCoordinator,
  canonicalResourceKey,
} = require('../terminal-startup-coordinator.cjs');

const POLICY = {
  serialization: 'provider-home',
  readiness: { kind: 'output-includes', value: '\u001b' },
};

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 500;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(message);
}

function runningSnapshot() {
  return { engineStatus: 'running', status: 'working' };
}

async function run() {
  const coordinator = new TerminalStartupCoordinator({
    readyPollMs: 1,
    readyTimeoutMs: 250,
  });
  const starts: string[] = [];
  const first = coordinator.run({
    agentId: 'first',
    observe: runningSnapshot,
    policy: POLICY,
    resourceKey: '/tmp/farming-shared-provider-home',
    start: () => { starts.push('first'); },
  });
  await waitFor(() => starts.length === 1, 'first startup did not begin');
  const second = coordinator.run({
    agentId: 'second',
    observe: runningSnapshot,
    policy: POLICY,
    resourceKey: '/tmp/farming-shared-provider-home',
    start: () => { starts.push('second'); },
  });
  // Flush the queued Promise continuation without depending on elapsed time.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(starts, ['first'], 'the same resource must serialize startup');
  assert.strictEqual(coordinator.appendOutput('first', 'ready\u001b'), true);
  await waitFor(() => starts.length === 2, 'second startup did not follow the first');
  assert.strictEqual(coordinator.appendOutput('second', 'ready\u001b'), true);
  await Promise.all([first, second]);
  assert.strictEqual(coordinator.appendOutput('second', 'late'), false, 'startup output must be released');

  const parallelStarts: string[] = [];
  const left = coordinator.run({
    agentId: 'left',
    observe: runningSnapshot,
    policy: POLICY,
    resourceKey: '/tmp/farming-provider-home-left',
    start: () => { parallelStarts.push('left'); },
  });
  const right = coordinator.run({
    agentId: 'right',
    observe: runningSnapshot,
    policy: POLICY,
    resourceKey: '/tmp/farming-provider-home-right',
    start: () => { parallelStarts.push('right'); },
  });
  await waitFor(() => parallelStarts.length === 2, 'unrelated resources did not start independently');
  coordinator.appendOutput('left', '\u001b');
  coordinator.appendOutput('right', '\u001b');
  await Promise.all([left, right]);

  await assert.rejects(
    coordinator.run({
      agentId: 'failed',
      observe: () => ({ output: 'database is locked', status: 'stopped' }),
      policy: POLICY,
      resourceKey: '/tmp/farming-failed-provider-home',
      start: () => {},
    }),
    /database is locked/,
  );
  const recovered = coordinator.run({
    agentId: 'recovered',
    observe: runningSnapshot,
    policy: POLICY,
    resourceKey: '/tmp/farming-failed-provider-home',
    start: () => {},
  });
  await waitFor(
    () => coordinator.appendOutput('recovered', '\u001b'),
    'a failed startup left its resource queue blocked',
  );
  await recovered;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-terminal-startup-'));
  try {
    const alias = path.join(tempDir, 'alias');
    fs.symlinkSync(tempDir, alias);
    assert.strictEqual(canonicalResourceKey(alias), canonicalResourceKey(tempDir));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const bounded = new TerminalStartupCoordinator({ readyPollMs: 1, readyTimeoutMs: 10 });
  await assert.rejects(
    bounded.run({
      agentId: 'timeout',
      observe: runningSnapshot,
      policy: POLICY,
      resourceKey: '/tmp/farming-timeout-provider-home',
      start: () => {},
    }),
    /did not become ready within 10ms/,
  );
  bounded.dispose();
  coordinator.dispose();
}

run().then(() => {
  console.log('terminal startup coordinator tests passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
