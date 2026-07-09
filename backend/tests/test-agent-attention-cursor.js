const assert = require('assert');
const AgentManager = require('../agent-manager');

function createManager() {
  return new AgentManager({
    getWorkspace() {
      return '/tmp';
    },
    getHeartbeatInterval() {
      return 1000;
    },
  });
}

async function run() {
  const manager = createManager();

  try {
    manager.agents.set('cursor-agent', {
      id: 'cursor-agent',
      command: 'codex',
      cwd: '/tmp',
      output: '',
      previewText: '',
      engineName: 'local',
      status: 'running',
      terminalBusy: false,
      attentionSeq: 0,
      readAttentionSeq: 0,
      unread: false,
      attentionTrackingReady: false,
      lastObservedTurnActive: false,
      attentionSuppressUntil: 0,
    });

    let updateCount = 0;
    manager.onUpdate(() => {
      updateCount += 1;
    });

    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'cursor-agent',
      terminalBusy: true,
    });
    let agent = manager.agents.get('cursor-agent');
    assert.strictEqual(agent.attentionSeq, 0, 'starting work should only establish/advance the active baseline');
    assert.strictEqual(agent.unread, false);

    manager.engineBridge.router.engines.local.emit('session-output', {
      sessionId: 'cursor-agent',
      data: 'done\n',
      outputSeq: 7,
    });
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'cursor-agent',
      terminalBusy: false,
    });
    agent = manager.agents.get('cursor-agent');
    assert.strictEqual(agent.attentionSeq, 1, 'finishing observed work should create an attention event');
    assert.strictEqual(agent.readAttentionSeq, 0);
    assert.strictEqual(agent.attentionOutputSeq, 7);
    assert.strictEqual(agent.attentionReason, 'turn-complete');
    assert.strictEqual(agent.unread, true);
    assert.strictEqual(manager.getState().agents.find(candidate => candidate.id === 'cursor-agent').unread, true);

    const readResult = manager.updateAgentFlags('cursor-agent', { readAttentionSeq: 1 });
    assert.strictEqual(readResult.unread, false);
    agent = manager.agents.get('cursor-agent');
    assert.strictEqual(agent.attentionSeq, 1);
    assert.strictEqual(agent.readAttentionSeq, 1);
    assert.strictEqual(agent.unread, false);

    const staleReadResult = manager.updateAgentFlags('cursor-agent', { readAttentionSeq: 0 });
    assert.strictEqual(staleReadResult.readAttentionSeq, 1, 'read cursors must not move backwards');
    assert.strictEqual(manager.agents.get('cursor-agent').unread, false);

    manager.setAgentUnread('cursor-agent', true);
    agent = manager.agents.get('cursor-agent');
    assert.strictEqual(agent.attentionSeq, 1);
    assert.strictEqual(agent.readAttentionSeq, 0);
    assert.strictEqual(agent.unread, true, 'manual unread should move the read cursor behind the latest attention event');

    manager.agents.set('recovered-agent', {
      id: 'recovered-agent',
      command: 'codex',
      cwd: '/tmp',
      output: '',
      previewText: '',
      engineName: 'local',
      status: 'running',
      terminalBusy: true,
      attentionSeq: 3,
      readAttentionSeq: 3,
      unread: false,
      attentionTrackingReady: true,
      lastObservedTurnActive: true,
      lastOutputSeq: 8,
      attentionRequiresNewOutput: true,
      attentionBaselineOutputSeq: 8,
      attentionBaselineOutputAt: Date.now(),
      attentionSuppressUntil: 0,
    });
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'recovered-agent',
      terminalBusy: false,
    });
    agent = manager.agents.get('recovered-agent');
    assert.strictEqual(agent.attentionSeq, 3, 'restart recovery busy→idle snapshots should not mint unread attention');
    assert.strictEqual(agent.readAttentionSeq, 3);
    assert.strictEqual(agent.unread, false);

    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'recovered-agent',
      terminalBusy: true,
    });
    manager.engineBridge.router.engines.local.emit('session-output', {
      sessionId: 'recovered-agent',
      data: 'real recovered output\n',
      outputSeq: 9,
    });
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'recovered-agent',
      terminalBusy: false,
    });
    agent = manager.agents.get('recovered-agent');
    assert.strictEqual(agent.attentionSeq, 4, 'real recovered output followed by idle should mint attention');
    assert.strictEqual(agent.readAttentionSeq, 3);
    assert.strictEqual(agent.attentionOutputSeq, 9);
    assert.strictEqual(agent.unread, true);

    manager.agents.set('auto-read-resumed-agent', {
      id: 'auto-read-resumed-agent',
      command: 'codex',
      cwd: '/tmp',
      output: '',
      previewText: '',
      engineName: 'local',
      status: 'running',
      terminalBusy: false,
      attentionSeq: 0,
      readAttentionSeq: 0,
      unread: false,
      attentionTrackingReady: false,
      lastObservedTurnActive: false,
      lastOutputSeq: null,
      attentionAutoReadNext: true,
      attentionSuppressUntil: 0,
    });
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'auto-read-resumed-agent',
      terminalBusy: true,
    });
    manager.engineBridge.router.engines.local.emit('session-output', {
      sessionId: 'auto-read-resumed-agent',
      data: 'resume handshake output\n',
      outputSeq: 1,
    });
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'auto-read-resumed-agent',
      terminalBusy: false,
    });
    agent = manager.agents.get('auto-read-resumed-agent');
    assert.strictEqual(agent.attentionSeq, 1, 'auto-resumed startup completion is still tracked');
    assert.strictEqual(agent.readAttentionSeq, 1, 'auto-resumed startup completion should be read by default');
    assert.strictEqual(agent.unread, false);

    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'auto-read-resumed-agent',
      terminalBusy: true,
    });
    manager.engineBridge.router.engines.local.emit('session-output', {
      sessionId: 'auto-read-resumed-agent',
      data: 'new work after resume\n',
      outputSeq: 2,
    });
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'auto-read-resumed-agent',
      terminalBusy: false,
    });
    agent = manager.agents.get('auto-read-resumed-agent');
    assert.strictEqual(agent.attentionSeq, 2);
    assert.strictEqual(agent.readAttentionSeq, 1);
    assert.strictEqual(agent.unread, true, 'work after the auto-read resume baseline should still become unread');

    manager.agents.set('main-agent', {
      id: 'main-agent',
      isMain: true,
      command: 'codex',
      cwd: '/tmp',
      output: '',
      previewText: '',
      engineName: 'local',
      status: 'running',
      terminalBusy: true,
      attentionSeq: 0,
      readAttentionSeq: 0,
      unread: false,
      attentionTrackingReady: true,
      lastObservedTurnActive: true,
      attentionSuppressUntil: 0,
    });
    manager.mainAgentId = 'main-agent';
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'main-agent',
      terminalBusy: false,
    });
    assert.strictEqual(manager.agents.get('main-agent').attentionSeq, 0, 'Main Agent rows should not get sidebar unread attention events');

    assert(updateCount > 0, 'attention cursor changes should notify clients');
    console.log('✓ AgentManager tracks unread state with attention read cursors');
  } finally {
    clearInterval(manager.heartbeatInterval);
    manager.engineBridge.dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
