const assert = require('assert');
const AgentManager = require('../agent-manager');

async function run() {
  const configManager = {
    getWorkspace() {
      return '/tmp';
    },
    getHeartbeatInterval() {
      return 1000;
    }
  };

  const manager = new AgentManager(configManager);

  try {
    manager.engineBridge.getEngine = () => ({
      async getSessionState(agentId) {
        if (agentId !== 'local-agent') return null;
        return { output: 'local full output' };
      },
    });

    manager.agents.set('local-agent', {
      id: 'local-agent',
      command: 'bash',
      cwd: '/tmp',
      output: 'local full output',
      engineName: 'local',
      status: 'running'
    });

    const localText = await manager.getAgentSessionText('local-agent');
    assert.strictEqual(localText, 'local full output');

    const missingText = await manager.getAgentSessionText('missing-agent');
    assert.strictEqual(missingText, null);

    let updateCount = 0;
    manager.onUpdate(() => {
      updateCount += 1;
    });
    manager.engineBridge.getEngine = () => ({
      async getSessionState() {
        throw new Error('Session not available');
      },
    });
    manager.agents.set('missing-session-text', {
      id: 'missing-session-text',
      command: 'bash',
      cwd: '/tmp',
      output: 'stale text',
      engineName: 'local',
      status: 'running',
      terminalBusy: true,
    });

    const originalConsoleError = console.error;
    const consoleErrors = [];
    console.error = (...args) => {
      consoleErrors.push(args);
    };
    let deadText;
    try {
      deadText = await manager.getAgentSessionText('missing-session-text');
    } finally {
      console.error = originalConsoleError;
    }

    const deadAgent = manager.agents.get('missing-session-text');
    assert.strictEqual(deadAgent.status, 'dead');
    assert.strictEqual(deadAgent.engineStatus, 'dead');
    assert.strictEqual(deadAgent.terminalBusy, false);
    assert.match(deadText, /Session not available/);
    assert.strictEqual(updateCount, 1, 'missing session text should notify the UI once');
    assert.strictEqual(consoleErrors.length, 1, 'missing session text should still be logged once');

    updateCount = 0;
    manager.engineBridge.getEngine = () => ({
      async getSessionState() {
        return null;
      },
    });
    manager.agents.set('null-session-text', {
      id: 'null-session-text',
      command: 'bash',
      cwd: '/tmp',
      output: 'stale null text',
      engineName: 'local',
      status: 'running',
      terminalBusy: true,
    });

    const nullText = await manager.getAgentSessionText('null-session-text');
    const nullAgent = manager.agents.get('null-session-text');
    assert.strictEqual(nullAgent.status, 'dead');
    assert.strictEqual(nullAgent.engineStatus, 'dead');
    assert.strictEqual(nullAgent.terminalBusy, false);
    assert.match(nullText, /Session not available/);
    assert.strictEqual(updateCount, 1, 'null session text should notify the UI once');

    updateCount = 0;
    manager.agents.set('pending-session-text', {
      id: 'pending-session-text',
      command: 'bash',
      cwd: '/tmp',
      output: 'pending text',
      engineName: 'local',
      status: 'pending',
      terminalBusy: null,
    });

    const pendingText = await manager.getAgentSessionText('pending-session-text');
    const pendingAgent = manager.agents.get('pending-session-text');
    assert.strictEqual(pendingAgent.status, 'pending');
    assert.strictEqual(pendingText, 'pending text');
    assert.strictEqual(updateCount, 0, 'pending session text should not be marked dead on an early empty read');

    console.log('✓ AgentManager session text source works for local engine buffers');
  } finally {
    clearInterval(manager.heartbeatInterval);
    manager.engineBridge.dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
