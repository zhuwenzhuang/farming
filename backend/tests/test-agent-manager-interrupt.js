const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AgentManager = require('../agent-manager');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-interrupt-'));
  const manager = new AgentManager({
    getWorkspace() {
      return tmpRoot;
    },
    getHeartbeatInterval() {
      return 1000;
    },
    getCodingAgentEngine() {
      return 'local';
    },
    getVtBaseUrl() {
      return 'http://localhost:4020';
    },
    getDangerouslySkipAgentPermissionsByDefault() {
      return false;
    },
  });

  const calls = [];
  manager.engineBridge.getEngine = () => ({
    async interruptSession(agentId, input) {
      calls.push({ agentId, input });
    },
  });

  try {
    manager.agents.set('agent-codex', {
      id: 'agent-codex',
      command: 'codex',
      engineName: 'local',
      status: 'running',
    });
    manager.agents.set('agent-claude', {
      id: 'agent-claude',
      command: 'claude',
      engineName: 'local',
      status: 'running',
    });
    manager.agents.set('agent-bash', {
      id: 'agent-bash',
      command: 'bash',
      engineName: 'local',
      status: 'running',
    });

    await manager.interruptAgent('agent-codex');
    await manager.interruptAgent('agent-claude');
    await manager.interruptAgent('agent-bash');

    assert.deepStrictEqual(calls, [
      { agentId: 'agent-codex', input: '\x1b' },
      { agentId: 'agent-claude', input: '\x1b' },
      { agentId: 'agent-bash', input: '\x03' },
    ]);

    let updateCount = 0;
    manager.onUpdate(() => {
      updateCount += 1;
    });
    manager.engineBridge.getEngine = () => ({
      async interruptSession() {
        throw new Error('Session not available');
      },
    });
    manager.agents.set('agent-missing-session', {
      id: 'agent-missing-session',
      command: 'codex',
      engineName: 'local',
      status: 'running',
      output: 'before interrupt',
      terminalBusy: true,
    });

    const originalConsoleError = console.error;
    const consoleErrors = [];
    console.error = (...args) => {
      consoleErrors.push(args);
    };
    try {
      await manager.interruptAgent('agent-missing-session');
    } finally {
      console.error = originalConsoleError;
    }

    const missingSessionAgent = manager.agents.get('agent-missing-session');
    assert.strictEqual(missingSessionAgent.status, 'dead');
    assert.strictEqual(missingSessionAgent.engineStatus, 'dead');
    assert.strictEqual(missingSessionAgent.terminalBusy, false);
    assert.match(missingSessionAgent.output, /Session not available/);
    assert.strictEqual(updateCount, 1);
    assert.strictEqual(consoleErrors.length, 1);

    console.log('✓ AgentManager interrupts coding agents with Esc and shells with Ctrl+C');
  } finally {
    clearInterval(manager.heartbeatInterval);
    manager.engineBridge.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
