const assert = require('assert');
const AgentManager = require('../agent-manager');

async function run() {
  const manager = new AgentManager({
    getWorkspace() {
      return process.cwd();
    },
    getHeartbeatInterval() {
      return 1000;
    }
  });

  try {
    manager.engineBridge.getEngine = () => ({
      async getSessionState(agentId) {
        if (agentId !== 'local-agent') return null;
        return {
          output: 'local output',
          previewText: 'local preview',
          startedAt: 123,
        };
      },
      getSessionSource() {
        return 'buffer';
      },
    });

    manager.agents.set('local-agent', {
      id: 'local-agent',
      command: 'claude',
      cwd: '/tmp/local',
      output: 'local output',
      previewText: 'local preview',
      engineName: 'local',
      status: 'running',
      startedAt: 123
    });
    manager.lastActivity.set('local-agent', Date.now());

    const localView = await manager.getAgentSessionView('local-agent');
    assert.strictEqual(localView.agentId, 'local-agent');
    assert.strictEqual(localView.engineName, 'local');
    assert.strictEqual(localView.sessionSource, 'buffer');
    assert.strictEqual(localView.output, 'local output');
    assert.strictEqual(localView.previewText, 'local preview');
    assert.strictEqual(localView.startedAt, 123);

    const missingView = await manager.getAgentSessionView('missing-agent');
    assert.strictEqual(missingView, null);

    let updateCount = 0;
    manager.onUpdate(() => {
      updateCount += 1;
    });
    manager.engineBridge.getEngine = () => ({
      async getSessionState() {
        throw new Error('Session not available');
      },
    });
    manager.agents.set('missing-session-view', {
      id: 'missing-session-view',
      command: 'bash',
      cwd: '/tmp/missing',
      output: 'last visible output',
      previewText: 'last preview',
      engineName: 'local',
      status: 'running',
      terminalBusy: true,
      startedAt: 456,
    });
    manager.lastActivity.set('missing-session-view', Date.now());

    const originalConsoleError = console.error;
    const consoleErrors = [];
    console.error = (...args) => {
      consoleErrors.push(args);
    };
    let deadView;
    try {
      deadView = await manager.getAgentSessionView('missing-session-view');
    } finally {
      console.error = originalConsoleError;
    }

    const deadAgent = manager.agents.get('missing-session-view');
    assert.strictEqual(deadAgent.status, 'dead');
    assert.strictEqual(deadAgent.engineStatus, 'dead');
    assert.strictEqual(deadAgent.terminalBusy, false);
    assert.strictEqual(deadView.status, 'dead');
    assert.strictEqual(deadView.terminalBusy, false);
    assert.match(deadView.output, /Session not available/);
    assert.strictEqual(typeof deadView.exitedAt, 'number');
    assert.strictEqual(updateCount, 1, 'missing session view should notify the UI once');
    assert.strictEqual(consoleErrors.length, 1, 'missing session view should still be logged once');

    updateCount = 0;
    manager.engineBridge.getEngine = () => ({
      async getSessionState() {
        const error = new Error('Native PTY host is not reachable ENOENT. See /tmp/native-pty-host.log.');
        error.code = 'ENOENT';
        throw error;
      },
    });
    manager.agents.set('native-host-missing-view', {
      id: 'native-host-missing-view',
      command: 'bash',
      cwd: '/tmp/native-missing',
      output: 'last native output',
      previewText: 'last native preview',
      engineName: 'native',
      status: 'running',
      terminalBusy: true,
      startedAt: 654,
    });
    manager.lastActivity.set('native-host-missing-view', Date.now());

    console.error = (...args) => {
      consoleErrors.push(args);
    };
    let nativeHostMissingView;
    try {
      nativeHostMissingView = await manager.getAgentSessionView('native-host-missing-view');
    } finally {
      console.error = originalConsoleError;
    }
    const nativeHostMissingAgent = manager.agents.get('native-host-missing-view');
    assert.strictEqual(nativeHostMissingAgent.status, 'dead');
    assert.strictEqual(nativeHostMissingAgent.engineStatus, 'dead');
    assert.strictEqual(nativeHostMissingAgent.terminalBusy, false);
    assert.strictEqual(nativeHostMissingView.status, 'dead');
    assert.strictEqual(nativeHostMissingView.terminalBusy, false);
    assert.match(nativeHostMissingView.output, /Native PTY host is not reachable ENOENT/);
    assert.strictEqual(updateCount, 1, 'native host connection failure should notify the UI once');
    assert.strictEqual(consoleErrors.length, 2, 'native host connection failure should still be logged once');

    updateCount = 0;
    manager.engineBridge.getEngine = () => ({
      async getSessionState() {
        return null;
      },
    });
    manager.agents.set('null-session-view', {
      id: 'null-session-view',
      command: 'bash',
      cwd: '/tmp/null',
      output: 'last null output',
      previewText: 'last null preview',
      engineName: 'local',
      status: 'running',
      terminalBusy: true,
      startedAt: 789,
    });
    manager.lastActivity.set('null-session-view', Date.now());

    const nullView = await manager.getAgentSessionView('null-session-view');
    const nullAgent = manager.agents.get('null-session-view');
    assert.strictEqual(nullAgent.status, 'dead');
    assert.strictEqual(nullAgent.engineStatus, 'dead');
    assert.strictEqual(nullAgent.terminalBusy, false);
    assert.strictEqual(nullView.status, 'dead');
    assert.strictEqual(nullView.terminalBusy, false);
    assert.match(nullView.output, /Session not available/);
    assert.strictEqual(typeof nullView.exitedAt, 'number');
    assert.strictEqual(updateCount, 1, 'null session view should notify the UI once');

    updateCount = 0;
    manager.agents.set('pending-session-view', {
      id: 'pending-session-view',
      command: 'bash',
      cwd: '/tmp/pending',
      output: 'starting output',
      engineName: 'local',
      status: 'pending',
      terminalBusy: null,
    });
    manager.lastActivity.set('pending-session-view', Date.now());

    const pendingView = await manager.getAgentSessionView('pending-session-view');
    const pendingAgent = manager.agents.get('pending-session-view');
    assert.strictEqual(pendingAgent.status, 'pending');
    assert.strictEqual(pendingView.status, 'pending');
    assert.strictEqual(pendingView.output, 'starting output');
    assert.strictEqual(updateCount, 0, 'pending session view should not be marked dead on an early empty read');

    console.log('✓ AgentManager session view model works for local states');
  } finally {
    clearInterval(manager.heartbeatInterval);
    manager.engineBridge.dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
