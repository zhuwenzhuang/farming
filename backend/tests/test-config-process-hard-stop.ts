const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  hardStopConfigProcesses,
  registerConfigProcessGroup,
} = require('../config-process-ownership.cjs');

async function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-config-hard-stop.'));
  const otherConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-config-hard-stop-other.'));
  try {
    registerConfigProcessGroup(configDir, 'acp-runtime-host', {
      format: 'test-v1',
      pid: 41001,
      processGroupId: 41001,
      startedAt: 'Mon Aug 10 14:00:00 2026',
    });
    registerConfigProcessGroup(configDir, 'acp-provider', {
      format: 'test-v1',
      pid: 41002,
      processGroupId: 41002,
      startedAt: 'Mon Aug 10 14:00:01 2026',
    });
    registerConfigProcessGroup(otherConfigDir, 'native-pty-host', {
      format: 'test-v1',
      pid: 42001,
      processGroupId: 42001,
      startedAt: 'Mon Aug 10 14:00:02 2026',
    });

    const live = new Map([
      [41001, { pid: 41001, processGroupId: 41001, startedAt: 'Mon Aug 10 14:00:00 2026' }],
      [41002, { pid: 41002, processGroupId: 41002, startedAt: 'Mon Aug 10 14:00:01 2026' }],
      [42001, { pid: 42001, processGroupId: 42001, startedAt: 'Mon Aug 10 14:00:02 2026' }],
    ]);
    const signals = [];
    const result = await hardStopConfigProcesses(configDir, {
      readProcessIdentity(pid) {
        return live.get(pid) || null;
      },
      signalProcessGroup(processGroupId, signal) {
        signals.push({ processGroupId, signal });
        live.delete(processGroupId);
      },
      waitForProcessGroupExit: async () => true,
    });

    signals.sort((left, right) => left.processGroupId - right.processGroupId);
    assert.deepStrictEqual(signals, [
      { processGroupId: 41001, signal: 'SIGKILL' },
      { processGroupId: 41002, signal: 'SIGKILL' },
    ]);
    assert.strictEqual(result.stopped, 2);
    assert(live.has(42001), 'hard stop must not signal another Config process group');

    registerConfigProcessGroup(configDir, 'browser', {
      format: 'test-v1',
      pid: 43001,
      processGroupId: 43001,
      startedAt: 'persisted identity',
    });
    const mismatchedSignals = [];
    const mismatch = await hardStopConfigProcesses(configDir, {
      readProcessIdentity() {
        return { pid: 43001, processGroupId: 43001, startedAt: 'reused pid identity' };
      },
      signalProcessGroup(processGroupId, signal) {
        mismatchedSignals.push({ processGroupId, signal });
      },
      waitForProcessGroupExit: async () => true,
    });
    assert.deepStrictEqual(mismatchedSignals, []);
    assert.strictEqual(mismatch.refused, 1, 'PID reuse must fail closed without signaling');

    registerConfigProcessGroup(configDir, 'browser', {
      format: 'test-v1',
      pid: 44001,
      processGroupId: 44001,
      startedAt: 'exited identity',
    });
    const staleSignals = [];
    const stale = await hardStopConfigProcesses(configDir, {
      readProcessIdentity() {
        return null;
      },
      signalProcessGroup(processGroupId, signal) {
        staleSignals.push({ processGroupId, signal });
      },
      waitForProcessGroupExit: async () => true,
    });
    assert.deepStrictEqual(staleSignals, [], 'an exited persisted identity must not signal a reused process group');
    assert.strictEqual(stale.stopped, 0);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(otherConfigDir, { recursive: true, force: true });
  }

  if (process.platform !== 'win32') {
    const firstConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-config-hard-stop-live.'));
    const secondConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-config-hard-stop-live-other.'));
    const children = [firstConfig, secondConfig].map(config => spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, env: { ...process.env, FARMING_CONFIG_DIR: config }, stdio: 'ignore' },
    ));
    try {
      await Promise.all(children.map(child => new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      })));
      const identities = children.map(child => require('../server-process-identity.cjs').readServerProcessIdentity(child.pid));
      registerConfigProcessGroup(firstConfig, 'acp-runtime-host', identities[0]);
      registerConfigProcessGroup(secondConfig, 'acp-runtime-host', identities[1]);
      const firstExit = new Promise(resolve => children[0].once('exit', resolve));
      assert.strictEqual((await hardStopConfigProcesses(firstConfig)).stopped, 1);
      await firstExit;
      assert.doesNotThrow(() => process.kill(children[1].pid, 0), 'another Config process must remain live');
    } finally {
      for (const child of children) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The exact test process group may already have exited.
        }
      }
      fs.rmSync(firstConfig, { recursive: true, force: true });
      fs.rmSync(secondConfig, { recursive: true, force: true });
    }
  }
}

run().then(() => {
  console.log('config process hard-stop tests passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
