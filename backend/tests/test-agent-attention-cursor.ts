const assert = require('assert');
const { AgentManager } = require('../agent-manager.cjs');
const { createTestAgentManager } = require('./helpers/test-acp-runtime.ts');
const { agentAttentionTurnActive } = require('../agent-attention.cjs');

function createManager() {
  return createTestAgentManager(AgentManager, {
    getWorkspace() {
      return '/tmp';
    },
    getHeartbeatInterval() {
      return 1000;
    },
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    let readUpdateCount = 0;
    manager.onUpdate(() => {
      updateCount += 1;
    });
    manager.on('agent-read', () => {
      readUpdateCount += 1;
    });

    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'cursor-agent',
      terminalBusy: true,
      runtimeEpoch: 'cursor-epoch',
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
      runtimeEpoch: 'cursor-epoch',
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
    let noOpPersistenceCount = 0;
    const originalEnsurePersistentAgentSession = manager.sessionPersistence.persist;
    manager.sessionPersistence.persist = (...args) => {
      noOpPersistenceCount += 1;
      return originalEnsurePersistentAgentSession.apply(manager.sessionPersistence, args);
    };
    const updatesBeforeNoopRead = updateCount;
    const noOpReadResult = manager.updateAgentFlags('cursor-agent', { unread: false });
    manager.sessionPersistence.persist = originalEnsurePersistentAgentSession;
    assert.strictEqual(noOpReadResult.changed, false);
    assert.strictEqual(noOpPersistenceCount, 0, 'an idempotent read must not rewrite persistent Agent state');
    assert.strictEqual(updateCount, updatesBeforeNoopRead, 'an idempotent read must not rebroadcast unchanged state');

    agent.runtimeEpoch = 'cursor-epoch';
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'cursor-agent',
      terminalBusy: true,
      runtimeEpoch: 'cursor-epoch',
    });
    manager.engineBridge.router.engines.local.emit('session-output', {
      sessionId: 'cursor-agent',
      data: 'visible before completion\n',
      runtimeEpoch: 'cursor-epoch',
      outputSeq: 8,
    });
    manager.updateAgentFlags('cursor-agent', {
      unread: false,
      readOutputEpoch: 'cursor-epoch',
      readOutputSeq: 8,
    });
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'cursor-agent',
      terminalBusy: false,
      runtimeEpoch: 'cursor-epoch',
    });
    assert.strictEqual(
      manager.agents.get('cursor-agent').unread,
      false,
      'a completion event derived from an already visible output cut must stay read',
    );

    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'cursor-agent',
      terminalBusy: true,
      runtimeEpoch: 'cursor-epoch',
    });
    manager.engineBridge.router.engines.local.emit('session-output', {
      sessionId: 'cursor-agent',
      data: 'new output after the read cut\n',
      runtimeEpoch: 'cursor-epoch',
      outputSeq: 9,
    });
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'cursor-agent',
      terminalBusy: false,
      runtimeEpoch: 'cursor-epoch',
    });
    assert.strictEqual(
      manager.agents.get('cursor-agent').unread,
      true,
      'output after the acknowledged cut must still create unread attention',
    );

    manager.attentionTracker.markAgentUnreadCursor('cursor-agent');
    agent = manager.agents.get('cursor-agent');
    assert.strictEqual(agent.attentionSeq, 3);
    assert.strictEqual(agent.readAttentionSeq, 2);
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

    manager.agents.set('shell-agent', {
      id: 'shell-agent',
      command: 'zsh',
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
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'shell-agent',
      terminalBusy: true,
      runtimeEpoch: 'shell-epoch',
    });
    manager.engineBridge.router.engines.local.emit('session-output', {
      sessionId: 'shell-agent',
      data: 'long ls output\n',
      runtimeEpoch: 'shell-epoch',
      outputSeq: 1,
    });
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'shell-agent',
      terminalBusy: false,
      runtimeEpoch: 'shell-epoch',
    });
    agent = manager.agents.get('shell-agent');
    assert.strictEqual(agent.attentionSeq, 0, 'a completed interactive shell command must not create sidebar attention');
    assert.strictEqual(agent.unread, false);

    manager.agents.set('stale-shell-agent', {
      id: 'stale-shell-agent',
      command: 'bash',
      cwd: '/tmp',
      output: '',
      previewText: '',
      engineName: 'local',
      status: 'running',
      terminalBusy: false,
      attentionSeq: 1,
      readAttentionSeq: 0,
      unread: true,
      attentionReason: 'turn-complete',
      attentionTrackingReady: true,
      lastObservedTurnActive: false,
      attentionSuppressUntil: 0,
    });
    manager.attentionTracker.observeAgentAttentionState('stale-shell-agent');
    agent = manager.agents.get('stale-shell-agent');
    assert.strictEqual(agent.readAttentionSeq, 1, 'automatic shell attention persisted by older releases must be read');
    assert.strictEqual(agent.unread, false);

    manager.agents.set('manual-shell-agent', {
      id: 'manual-shell-agent',
      command: 'bash',
      cwd: '/tmp',
      output: '',
      previewText: '',
      engineName: 'local',
      status: 'running',
      terminalBusy: false,
      attentionSeq: 1,
      readAttentionSeq: 0,
      unread: true,
      attentionReason: 'manual-unread',
      attentionTrackingReady: true,
      lastObservedTurnActive: false,
      attentionSuppressUntil: 0,
    });
    manager.attentionTracker.observeAgentAttentionState('manual-shell-agent');
    agent = manager.agents.get('manual-shell-agent');
    assert.strictEqual(agent.readAttentionSeq, 0, 'manual shell unread marks must remain deliberate');
    assert.strictEqual(agent.unread, true);

    for (const { provider, command, method, summary } of [
      { provider: 'codex', command: 'codex', method: 'bel', summary: '' },
      { provider: 'claude', command: 'claude', method: 'osc9', summary: 'Claude is ready to review.' },
      { provider: 'opencode', command: 'opencode', method: 'osc99', summary: 'OpenCode finished the requested edit.' },
      { provider: 'qoder', command: 'qodercli', method: 'osc99', summary: 'Qoder completed the task.' },
    ]) {
      const agentId = `terminal-notification-${provider}`;
      const runtimeEpoch = `${agentId}-epoch`;
      manager.agents.set(agentId, {
        id: agentId,
        command,
        cwd: '/tmp',
        output: '',
        previewText: '',
        engineName: 'local',
        status: 'running',
        runtimeEpoch,
        terminalBusy: true,
        attentionSeq: 0,
        readAttentionSeq: 0,
        unread: false,
        attentionTrackingReady: true,
        lastObservedTurnActive: true,
        attentionSuppressUntil: 0,
      });
      manager.engineBridge.router.engines.local.emit('session-notification', {
        sessionId: agentId,
        method,
        title: '',
        message: summary,
        runtimeEpoch,
        outputSeq: 4,
      });
      agent = manager.agents.get(agentId);
      assert.strictEqual(agent.attentionSeq, 1, `${provider} Terminal-native notifications should create attention`);
      assert.strictEqual(agent.attentionReason, 'terminal-notification');
      assert.strictEqual(agent.attentionSummary, summary);
      assert.strictEqual(agent.unread, true);
    }

    const qwenAgentId = 'terminal-notification-qwen';
    const qwenRuntimeEpoch = `${qwenAgentId}-epoch`;
    manager.agents.set(qwenAgentId, {
      id: qwenAgentId,
      command: 'qwen',
      providerSessionProvider: 'qwen',
      cwd: '/tmp',
      output: '',
      previewText: '',
      engineName: 'local',
      status: 'running',
      runtimeEpoch: qwenRuntimeEpoch,
      terminalBusy: true,
      attentionSeq: 0,
      readAttentionSeq: 0,
      unread: false,
      attentionTrackingReady: true,
      lastObservedTurnActive: true,
      attentionBaselineOutputSeq: 3,
      attentionRequiresNewOutput: true,
      lastOutputSeq: 3,
      attentionSuppressUntil: 0,
    });
    manager.engineBridge.router.engines.local.emit('session-output', {
      sessionId: qwenAgentId,
      data: 'A local agent completed while the parent turn continues.\n',
      runtimeEpoch: qwenRuntimeEpoch,
      outputSeq: 4,
    });
    manager.engineBridge.router.engines.local.emit('session-notification', {
      sessionId: qwenAgentId,
      method: 'osc777',
      title: '',
      message: 'Qwen has a result.',
      runtimeEpoch: qwenRuntimeEpoch,
      outputSeq: 4,
    });
    agent = manager.agents.get(qwenAgentId);
    assert.strictEqual(agent.attentionSeq, 0, 'Qwen notifications must not mark an active parent turn unread');
    assert.strictEqual(agent.unread, false);
    assert.strictEqual(agent.pendingTerminalNotificationSummary, 'Qwen has a result.');

    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: qwenAgentId,
      terminalBusy: false,
      runtimeEpoch: qwenRuntimeEpoch,
    });
    agent = manager.agents.get(qwenAgentId);
    assert.strictEqual(agent.attentionSeq, 0, 'the first Qwen idle edge should only start stability confirmation');
    assert.strictEqual(agent.unread, false);
    assert.strictEqual(agent.pendingTerminalNotificationSummary, 'Qwen has a result.');

    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: qwenAgentId,
      terminalBusy: true,
      runtimeEpoch: qwenRuntimeEpoch,
    });
    agent = manager.agents.get(qwenAgentId);
    assert.strictEqual(agent.attentionSeq, 0, 'Qwen becoming active again must cancel same-turn idle flicker');
    assert.strictEqual(agent.unread, false);
    assert.strictEqual(agent.pendingTerminalNotificationSummary, 'Qwen has a result.');

    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: qwenAgentId,
      terminalBusy: false,
      runtimeEpoch: qwenRuntimeEpoch,
    });
    await wait(3200);
    agent = manager.agents.get(qwenAgentId);
    assert.strictEqual(agent.attentionSeq, 1, 'Qwen notifications should become attention after sustained parent idle');
    assert.strictEqual(agent.attentionReason, 'terminal-notification');
    assert.strictEqual(agent.attentionSummary, 'Qwen has a result.');
    assert.strictEqual(agent.unread, true);
    assert.strictEqual(agent.pendingTerminalNotificationSummary, undefined);

    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: qwenAgentId,
      terminalBusy: true,
      runtimeEpoch: qwenRuntimeEpoch,
    });
    agent = manager.agents.get(qwenAgentId);
    assert.strictEqual(agentAttentionTurnActive(agent), true);
    assert.strictEqual(
      agent.unread,
      true,
      'a genuine unread completion must remain visible when a later Qwen turn starts',
    );

    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'terminal-notification-codex',
      terminalBusy: false,
      runtimeEpoch: 'terminal-notification-codex-epoch',
    });
    assert.strictEqual(
      manager.agents.get('terminal-notification-codex').attentionSeq,
      1,
      'the following inferred busy-to-idle edge must not overwrite the native notification event',
    );

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
    manager.mainAgentIdentity.setCurrent('main-agent');
    manager.engineBridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'main-agent',
      terminalBusy: false,
    });
    assert.strictEqual(manager.agents.get('main-agent').attentionSeq, 0, 'Main Agent rows should not get sidebar unread attention events');

    assert(readUpdateCount > 0, 'attention cursor changes should notify clients through scoped read deltas');
    console.log('✓ AgentManager tracks unread state with attention read cursors');
  } finally {
    manager.heartbeatScheduler.stop();
    manager.engineBridge.dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
