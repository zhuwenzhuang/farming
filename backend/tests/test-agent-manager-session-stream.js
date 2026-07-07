const assert = require('assert');
const AgentManager = require('../agent-manager');
const { SESSION_OUTPUT_LIMIT, trimSessionOutput } = require('../agent-manager');

async function run() {
  const manager = new AgentManager({
    getWorkspace() {
      return '/tmp';
    },
    getHeartbeatInterval() {
      return 1000;
    }
  });

  try {
    manager.agents.set('local-agent', {
      id: 'local-agent',
      command: 'claude',
      cwd: '/tmp',
      output: '',
      previewText: '',
      engineName: 'local',
      status: 'running'
    });

    const streams = [];
    let updateCount = 0;
    manager.onSessionStream((stream) => {
      streams.push(stream);
    });
    manager.onUpdate(() => {
      updateCount += 1;
    });
    const resizeCalls = [];
    manager.engineBridge.router.engines.local.resizeSession = async (agentId, cols, rows) => {
      resizeCalls.push({ agentId, cols, rows });
    };

    manager.engineBridge.router.engines.local.emit('session-output', {
      sessionId: 'local-agent',
      data: 'hello stream',
      outputSeq: 1,
    });
    assert.strictEqual(updateCount, 0);
    manager.engineBridge.router.engines.local.emit('session-activity', {
      sessionId: 'local-agent',
      lastActivityAt: 1000,
    });
    assert.strictEqual(updateCount, 1);
    manager.engineBridge.router.engines.local.emit('session-activity', {
      sessionId: 'local-agent',
      lastActivityAt: 1200,
    });
    assert.strictEqual(updateCount, 1);
    manager.engineBridge.router.engines.local.emit('session-activity', {
      sessionId: 'local-agent',
      lastActivityAt: 2100,
    });
    assert.strictEqual(updateCount, 2);
    manager.engineBridge.router.engines.local.emit('session-sync', {
      sessionId: 'local-agent',
      output: 'rewritten stream',
      replaceLive: false,
    });
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'local-agent',
      terminalBusy: true,
    });
    assert.strictEqual(manager.agents.get('local-agent').terminalBusy, true);
    assert.strictEqual(updateCount, 4);
    manager.agents.get('local-agent').command = 'bash';
    manager.engineBridge.router.engines.local.emit('session-preview', {
      sessionId: 'local-agent',
      previewText: '/tmp $ ',
      cols: 80,
      rows: 24,
      previewSnapshot: null,
    });
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === 'local-agent').terminalStatus.activity,
      'idle',
      'agent list terminal status should not stay busy when a shell prompt is visible'
    );
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'local-agent',
      terminalBusy: true,
    });
    assert.strictEqual(updateCount, 4);
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'local-agent',
      terminalBusy: false,
    });
    assert.strictEqual(manager.agents.get('local-agent').terminalBusy, false);
    assert.strictEqual(updateCount, 5);
    manager.engineBridge.router.engines.local.emit('session-error', {
      sessionId: 'local-agent',
      error: 'temporary local engine warning',
      fatal: false,
    });

    assert.deepStrictEqual(streams, [
      {
        agentId: 'local-agent',
        data: 'hello stream',
        sessionSource: 'buffer',
        outputSeq: 1,
      }
    ]);
    assert.strictEqual(manager.agents.get('local-agent').output, 'rewritten stream');
    assert.strictEqual(manager.agents.get('local-agent').status, 'running');
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'local-agent',
      terminalBusy: true,
    });
    manager.engineBridge.router.engines.local.emit('session-error', {
      sessionId: 'local-agent',
      error: 'native pty host disconnected',
      fatal: true,
    });
    assert.strictEqual(manager.agents.get('local-agent').status, 'dead');
    assert.strictEqual(manager.agents.get('local-agent').engineStatus, 'dead');
    assert.strictEqual(manager.agents.get('local-agent').terminalBusy, false);
    assert.strictEqual(typeof manager.agents.get('local-agent').exitedAt, 'number');
    await manager.resizeAgentSession('local-agent', 10, 5);
    assert.deepStrictEqual(resizeCalls, []);
    await manager.resizeAgentSession('local-agent', 125.8, 41.2);
    assert.deepStrictEqual(resizeCalls, [{ agentId: 'local-agent', cols: 125, rows: 41 }]);
    await manager.resizeAgentSession('local-agent', 125, 41);
    assert.deepStrictEqual(
      resizeCalls,
      [{ agentId: 'local-agent', cols: 125, rows: 41 }],
      'duplicate terminal resize events should not hit the session engine'
    );
    await manager.resizeAgentSession('local-agent', 126, 41);
    assert.deepStrictEqual(resizeCalls, [
      { agentId: 'local-agent', cols: 125, rows: 41 },
      { agentId: 'local-agent', cols: 126, rows: 41 },
    ]);

    manager.agents.set('missing-resize-agent', {
      id: 'missing-resize-agent',
      command: 'bash',
      cwd: '/tmp',
      output: 'terminal before resize',
      previewText: '',
      engineName: 'local',
      status: 'running',
      terminalBusy: true,
    });
    manager.engineBridge.router.engines.local.resizeSession = async () => ({ resized: false });
    await manager.resizeAgentSession('missing-resize-agent', 120, 40);
    const missingResizeAgent = manager.agents.get('missing-resize-agent');
    assert.strictEqual(missingResizeAgent.status, 'dead');
    assert.strictEqual(missingResizeAgent.engineStatus, 'dead');
    assert.strictEqual(missingResizeAgent.terminalBusy, false);
    assert.match(missingResizeAgent.output, /Session not available/);

    assert.strictEqual(SESSION_OUTPUT_LIMIT, 10000);
    assert.strictEqual(trimSessionOutput('x'.repeat(10050)).length, 10000);

    console.log('✓ AgentManager emits append and replace session stream events');
  } finally {
    clearInterval(manager.heartbeatInterval);
    manager.engineBridge.dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
