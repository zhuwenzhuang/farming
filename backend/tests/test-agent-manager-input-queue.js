const assert = require('assert');
const AgentManager = require('../agent-manager');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  const manager = new AgentManager({
    getWorkspace() {
      return '/tmp';
    },
    getHeartbeatInterval() {
      return 1000;
    },
  });

  const calls = [];
  manager.engineBridge.getEngine = () => ({
    async sendInput(agentId, input) {
      calls.push({ agentId, input });
      if (calls.length === 1) {
        await sleep(20);
      }
    },
  });

  try {
    manager.agents.set('agent-input', {
      id: 'agent-input',
      command: 'codex',
      cwd: '/tmp',
      engineName: 'local',
      status: 'running',
    });

    await Promise.all([
      manager.sendInput('agent-input', [{ type: 'paste', text: 'A' }, '\r']),
      manager.sendInput('agent-input', [{ type: 'paste', text: 'B' }, '\r']),
    ]);

    assert.deepStrictEqual(calls, [
      { agentId: 'agent-input', input: [{ type: 'paste', text: 'A' }, '\r'] },
      { agentId: 'agent-input', input: [{ type: 'paste', text: 'B' }, '\r'] },
    ], 'each composer input transaction should stay atomic in the per-agent queue');

    let unavailableCalls = 0;
    let updateCount = 0;
    manager.onUpdate(() => {
      updateCount += 1;
    });
    manager.engineBridge.getEngine = () => ({
      async sendInput() {
        unavailableCalls += 1;
        throw new Error('Session not available');
      },
    });
    manager.agents.set('agent-missing-session', {
      id: 'agent-missing-session',
      command: 'bash',
      cwd: '/tmp',
      output: 'still visible',
      engineName: 'local',
      status: 'running',
      terminalBusy: true,
    });

    const originalConsoleError = console.error;
    const consoleErrors = [];
    console.error = (...args) => {
      consoleErrors.push(args);
    };
    try {
      await manager.sendInput('agent-missing-session', 'echo lost\r');
    } finally {
      console.error = originalConsoleError;
    }

    const missingSessionAgent = manager.agents.get('agent-missing-session');
    assert.strictEqual(
      unavailableCalls,
      7,
      'session-not-available input should retry the configured short delays before declaring the terminal dead'
    );
    assert.strictEqual(missingSessionAgent.status, 'dead');
    assert.strictEqual(missingSessionAgent.engineStatus, 'dead');
    assert.strictEqual(missingSessionAgent.terminalBusy, false);
    assert.match(missingSessionAgent.output, /Session not available/);
    assert.strictEqual(typeof missingSessionAgent.exitedAt, 'number');
    assert.strictEqual(updateCount, 1, 'marking a missing terminal session dead should notify the UI once');
    assert.strictEqual(consoleErrors.length, 1, 'the exhausted missing-session input should still be logged once');

    console.log('test-agent-manager-input-queue passed');
  } finally {
    clearInterval(manager.heartbeatInterval);
    manager.engineBridge.dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
