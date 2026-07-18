const assert = require('assert');
const AgentManager = require('../agent-manager');
const { SESSION_OUTPUT_LIMIT, trimSessionOutput } = require('../agent-manager');

async function run() {
  const runtimeEpoch1 = 'farming-runtime-v1:00000000000000000001:test-1';
  const runtimeEpoch2 = 'farming-runtime-v1:00000000000000000002:test-2';
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
    const activityUpdates = [];
    const agentUpdates = [];
    let updateCount = 0;
    manager.onSessionStream((stream) => {
      streams.push(stream);
    });
    manager.onUpdate(() => {
      updateCount += 1;
    });
    manager.onAgentActivity((activity) => {
      activityUpdates.push(activity);
    });
    manager.on('agent-update', update => agentUpdates.push(update));

    manager.agents.set('started-sync-agent', {
      id: 'started-sync-agent',
      command: 'bash',
      cwd: '/tmp',
      output: '',
      previewText: '',
      engineName: 'local',
      status: 'pending',
      validated: true,
    });
    const startedSyncEpoch = 'farming-runtime-v1:00000000000000000003:started-sync';
    manager.engineBridge.router.engines.local.emit('session-started', {
      sessionId: 'started-sync-agent',
      status: 'running',
      runtimeEpoch: startedSyncEpoch,
      outputSeq: 1,
      stateRevision: 1,
    });
    const streamsBeforeStartedSync = streams.length;
    const startedSync = {
      sessionId: 'started-sync-agent',
      output: 'restored rendered screen',
      textOutput: 'restored terminal text',
      replaceLive: true,
      runtimeEpoch: startedSyncEpoch,
      outputSeq: 1,
      stateRevision: 1,
      cols: 80,
      rows: 24,
    };
    manager.engineBridge.router.engines.local.emit('session-sync', startedSync);
    assert.strictEqual(
      manager.agents.get('started-sync-agent').output,
      'restored terminal text',
      'the first authoritative sync at the started cut must hydrate restored content',
    );
    assert.strictEqual(streams.length, streamsBeforeStartedSync + 1);
    manager.engineBridge.router.engines.local.emit('session-sync', startedSync);
    assert.strictEqual(
      streams.length,
      streamsBeforeStartedSync + 1,
      'a repeated sync at the already hydrated cut must be ignored',
    );
    manager.engineBridge.router.engines.local.emit('session-exited', {
      sessionId: 'started-sync-agent',
      code: 0,
      exitedAt: Date.now(),
      runtimeEpoch: startedSyncEpoch,
      outputSeq: 1,
      stateRevision: 1,
    });
    assert.strictEqual(manager.agents.get('started-sync-agent').status, 'stopped');
    manager.engineBridge.router.engines.local.emit('session-preview', {
      sessionId: 'started-sync-agent',
      previewText: 'final stopped screen',
      cols: 80,
      rows: 24,
      previewSnapshot: null,
      runtimeEpoch: startedSyncEpoch,
    });
    manager.engineBridge.router.engines.local.emit('session-title', {
      sessionId: 'started-sync-agent',
      title: 'final title',
      runtimeEpoch: startedSyncEpoch,
    });
    manager.engineBridge.router.engines.local.emit('session-activity', {
      sessionId: 'started-sync-agent',
      lastActivityAt: Date.now(),
      runtimeEpoch: startedSyncEpoch,
    });
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'started-sync-agent',
      terminalBusy: false,
      runtimeEpoch: startedSyncEpoch,
    });
    assert.strictEqual(
      manager.agents.get('started-sync-agent').status,
      'stopped',
      'final derived lifecycle metadata must not revive an exited runtime',
    );

    const proofFailureEpoch = 'farming-runtime-v1:00000000000000000004:proof-failure';
    manager.agents.set('proof-failure-agent', {
      id: 'proof-failure-agent',
      command: 'bash',
      cwd: '/tmp',
      output: 'terminal output before exit',
      previewText: '',
      engineName: 'local',
      status: 'running',
      validated: true,
    });
    manager.engineBridge.router.engines.local.emit('session-started', {
      sessionId: 'proof-failure-agent',
      status: 'running',
      runtimeEpoch: proofFailureEpoch,
      outputSeq: 0,
      stateRevision: 0,
    });
    manager.engineBridge.router.engines.local.emit('session-exited', {
      sessionId: 'proof-failure-agent',
      code: 1,
      exitedAt: Date.now(),
      runtimeEpoch: proofFailureEpoch,
      outputSeq: 1,
      stateRevision: 1,
      stateProofAvailable: false,
    });
    const proofFailureAgent = manager.agents.get('proof-failure-agent');
    assert.strictEqual(proofFailureAgent.status, 'dead');
    assert.strictEqual(proofFailureAgent.engineStatus, 'dead');
    assert.match(proofFailureAgent.output, /without an authoritative final checkpoint/);

    streams.length = 0;
    activityUpdates.length = 0;
    updateCount = 0;
    const resizeCalls = [];
    manager.engineBridge.router.engines.local.resizeSession = async (agentId, cols, rows) => {
      resizeCalls.push({ agentId, cols, rows });
      return { status: 'resize-committed', resized: true };
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
    assert.strictEqual(updateCount, 0);
    assert.strictEqual(activityUpdates.length, 1);
    assert.strictEqual(activityUpdates[0].agentId, 'local-agent');
    assert.strictEqual(activityUpdates[0].lastActivity, 1000);
    manager.engineBridge.router.engines.local.emit('session-activity', {
      sessionId: 'local-agent',
      lastActivityAt: 1200,
    });
    assert.strictEqual(updateCount, 0);
    assert.strictEqual(activityUpdates.length, 1);
    manager.engineBridge.router.engines.local.emit('session-activity', {
      sessionId: 'local-agent',
      lastActivityAt: 2100,
    });
    assert.strictEqual(updateCount, 0);
    assert.strictEqual(activityUpdates.length, 2);
    manager.engineBridge.router.engines.local.emit('session-sync', {
      sessionId: 'local-agent',
      output: 'rewritten stream',
      replaceLive: false,
    });
    const updateCountBeforeBusy = updateCount;
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'local-agent',
      terminalBusy: true,
    });
    assert.strictEqual(manager.agents.get('local-agent').terminalBusy, true);
    assert.strictEqual(updateCount, updateCountBeforeBusy);
    assert.strictEqual(agentUpdates.at(-1).patch.terminalBusy, true);
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
    const updateCountBeforeStart = updateCount;
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'local-agent',
      terminalBusy: true,
      shellEvent: 'start',
      shellCommand: 'git status --short',
      shellLastCommand: '',
      shellCommandStartedAt: 1234,
    });
    assert.strictEqual(manager.agents.get('local-agent').shellCommand, 'git status --short');
    assert.strictEqual(manager.agents.get('local-agent').shellCommandStartedAt, 1234);
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === 'local-agent').shellCommand,
      'git status --short'
    );
    assert.strictEqual(updateCount, updateCountBeforeStart);
    const updateCountBeforeFinish = updateCount;
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'local-agent',
      terminalBusy: false,
      shellEvent: 'finish',
      shellCommand: '',
      shellLastCommand: 'git status --short',
      shellCommandStartedAt: null,
      shellLastCommandStartedAt: 1234,
      shellLastCommandFinishedAt: 2234,
      shellLastCommandDurationMs: 1000,
    });
    assert.strictEqual(manager.agents.get('local-agent').terminalBusy, false);
    assert.strictEqual(manager.agents.get('local-agent').shellCommand, '');
    assert.strictEqual(manager.agents.get('local-agent').shellLastCommand, 'git status --short');
    assert.strictEqual(manager.agents.get('local-agent').shellLastCommandDurationMs, 1000);
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === 'local-agent').terminalStatus.lastCommand,
      'git status --short'
    );
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === 'local-agent').terminalStatus.lastCommandDurationMs,
      1000
    );
    assert.strictEqual(updateCount, updateCountBeforeFinish);
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

    manager.engineBridge.router.engines.local.clearBuffer = async () => {
      manager.engineBridge.router.engines.local.emit('session-transition', {
        sessionId: 'local-agent',
        kind: 'clear',
        data: '\x1b[2J\x1b[3J\x1b[H',
        runtimeEpoch: runtimeEpoch1,
        outputSeq: 1,
        stateRevision: 2,
        cols: 80,
        rows: 24,
      });
      manager.engineBridge.router.engines.local.emit('session-output', {
        sessionId: 'local-agent',
        data: 'output after clear',
        runtimeEpoch: runtimeEpoch1,
        outputSeq: 2,
        stateRevision: 3,
      });
      return { cleared: true };
    };
    await manager.clearAgentSessionBuffer('local-agent');
    assert.strictEqual(
      manager.agents.get('local-agent').output,
      'output after clear',
      'the clear RPC response must not erase output committed after the ordered clear transition',
    );
    assert.deepStrictEqual(streams.slice(-2).map(stream => stream.kind || 'output'), ['clear', 'output']);
    const streamCountAtCurrentCut = streams.length;
    manager.engineBridge.router.engines.local.emit('session-output', {
      sessionId: 'local-agent',
      data: 'duplicate old output',
      runtimeEpoch: runtimeEpoch1,
      outputSeq: 1,
      stateRevision: 2,
    });
    assert.strictEqual(manager.agents.get('local-agent').output, 'output after clear');
    assert.strictEqual(streams.length, streamCountAtCurrentCut, 'stale terminal events must not be forwarded or applied');

    manager.engineBridge.router.engines.local.emit('session-sync', {
      sessionId: 'local-agent',
      output: 'new runtime checkpoint',
      replaceLive: false,
      runtimeEpoch: runtimeEpoch2,
      outputSeq: 0,
      stateRevision: 0,
    });
    assert.strictEqual(manager.agents.get('local-agent').output, 'new runtime checkpoint');
    assert.strictEqual(manager.agents.get('local-agent').runtimeEpoch, runtimeEpoch2);
    manager.engineBridge.router.engines.local.emit('session-output', {
      sessionId: 'local-agent',
      data: 'late retired runtime output',
      runtimeEpoch: runtimeEpoch1,
      outputSeq: 3,
      stateRevision: 4,
    });
    assert.strictEqual(manager.agents.get('local-agent').output, 'new runtime checkpoint');
    assert.strictEqual(manager.agents.get('local-agent').runtimeEpoch, runtimeEpoch2);
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'local-agent',
      terminalBusy: true,
      runtimeEpoch: runtimeEpoch2,
    });
    manager.engineBridge.router.engines.local.emit('session-error', {
      sessionId: 'local-agent',
      error: 'native pty host disconnected',
      fatal: true,
      runtimeEpoch: runtimeEpoch2,
    });
    assert.strictEqual(manager.agents.get('local-agent').status, 'dead');
    assert.strictEqual(manager.agents.get('local-agent').engineStatus, 'dead');
    assert.strictEqual(manager.agents.get('local-agent').terminalBusy, false);
    assert.strictEqual(typeof manager.agents.get('local-agent').exitedAt, 'number');
    await manager.resizeAgentSession('local-agent', 10, 5);
    assert.deepStrictEqual(resizeCalls, []);
    await manager.resizeAgentSession('local-agent', 125.8, 41.2);
    await manager.resizeAgentSession('local-agent', 125, 41);
    await manager.resizeAgentSession('local-agent', 126, 41);
    assert.deepStrictEqual(resizeCalls, [
      { agentId: 'local-agent', cols: 125, rows: 41 },
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
    manager.engineBridge.router.engines.local.resizeSession = async () => ({
      status: 'resize-rejected',
      reason: 'session-unavailable',
      resized: false,
    });
    await manager.resizeAgentSession('missing-resize-agent', 120, 40);
    const missingResizeAgent = manager.agents.get('missing-resize-agent');
    assert.strictEqual(missingResizeAgent.status, 'dead');
    assert.strictEqual(missingResizeAgent.engineStatus, 'dead');
    assert.strictEqual(missingResizeAgent.terminalBusy, false);
    assert.match(missingResizeAgent.output, /Session not available/);

    assert.strictEqual(SESSION_OUTPUT_LIMIT, 10000);
    assert.strictEqual(trimSessionOutput('x'.repeat(10050)).length, 10000);

    console.log('✓ AgentManager emits checkpoint and ordered terminal transition streams');
  } finally {
    clearInterval(manager.heartbeatInterval);
    manager.engineBridge.dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
