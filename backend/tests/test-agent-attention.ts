const assert = require('assert');
const {
  AgentAttentionTracker,
  agentAttentionUnread,
  hasAgentOutputAfterAttentionBaseline,
} = require('../agent-attention.cjs');

function createFakeHost(overrides = {}) {
  const agents = new Map();
  const readEvents = [];
  return {
    agents,
    readEvents,
    getAgent: agentId => agents.get(agentId),
    isDisposed: () => false,
    isMainAgent: () => false,
    isTurnActive: agent => agent.terminalBusy === true,
    persistAgent: () => {},
    providerForAgent: () => 'codex',
    publishReadState: payload => readEvents.push(payload),
    updateProviderMetadata: () => {},
    ...overrides,
  };
}

function createAgent(overrides = {}) {
  return {
    id: 'agent-1',
    command: 'codex',
    status: 'running',
    terminalBusy: false,
    attentionSeq: 0,
    readAttentionSeq: 0,
    unread: false,
    attentionOutputEpoch: '',
    attentionOutputSeq: 0,
    attentionReason: '',
    attentionTrackingReady: false,
    lastObservedTurnActive: false,
    readOutputEpoch: '',
    readOutputSeq: 0,
    ...overrides,
  };
}

async function run() {
  assert.strictEqual(agentAttentionUnread({ attentionSeq: 2, readAttentionSeq: 1 }), true);
  assert.strictEqual(agentAttentionUnread({ attentionSeq: 2, readAttentionSeq: 2 }), false);
  assert.strictEqual(agentAttentionUnread({}), false);
  assert.strictEqual(agentAttentionUnread(null), false);
  assert.strictEqual(hasAgentOutputAfterAttentionBaseline({}), true);
  assert.strictEqual(hasAgentOutputAfterAttentionBaseline(null), true);
  assert.strictEqual(
    hasAgentOutputAfterAttentionBaseline({
      attentionRequiresNewOutput: true,
      attentionBaselineOutputSeq: 4,
      lastOutputSeq: 4,
    }),
    false,
    'output at the recovery baseline must not satisfy the guard',
  );
  assert.strictEqual(
    hasAgentOutputAfterAttentionBaseline({
      attentionRequiresNewOutput: true,
      attentionBaselineOutputSeq: 4,
      lastOutputSeq: 5,
    }),
    true,
  );

  let persisted = 0;
  let metadataUpdates = 0;
  const host = createFakeHost({
    persistAgent: () => { persisted += 1; },
    updateProviderMetadata: () => { metadataUpdates += 1; },
  });
  const tracker = new AgentAttentionTracker(host);
  const agent = createAgent({ runtimeEpoch: 'epoch-1', lastOutputSeq: 7 });
  host.agents.set(agent.id, agent);

  assert.strictEqual(
    tracker.observeAgentAttentionState(agent.id),
    false,
    'the first observation only arms tracking',
  );
  assert.strictEqual(agent.attentionTrackingReady, true);

  const event = tracker.recordAgentAttentionEvent(agent, 'turn-complete');
  assert.deepStrictEqual(event, {
    agentId: agent.id,
    attentionSeq: 1,
    readAttentionSeq: 0,
    unread: true,
  });
  assert.strictEqual(agent.attentionOutputSeq, 7);
  assert.strictEqual(agent.attentionOutputEpoch, 'epoch-1');
  assert.strictEqual(persisted, 1);
  assert.strictEqual(metadataUpdates, 1);
  assert.strictEqual(host.readEvents.length, 1);

  const readResult = tracker.markAgentReadCursor(agent.id);
  assert.strictEqual(readResult.changed, true);
  assert.strictEqual(readResult.readAttentionSeq, 1);
  assert.strictEqual(readResult.unread, false);
  const staleReadResult = tracker.markAgentReadCursor(agent.id, 0);
  assert.strictEqual(staleReadResult.readAttentionSeq, 1, 'read cursors must not move backward');
  assert.strictEqual(staleReadResult.changed, false, 'idempotent reads must not persist or publish');
  assert.strictEqual(persisted, 2);
  assert.strictEqual(host.readEvents.length, 2);

  agent.readOutputEpoch = 'epoch-1';
  agent.readOutputSeq = 7;
  const autoReadEvent = tracker.recordAgentAttentionEvent(agent, 'turn-complete');
  assert.strictEqual(autoReadEvent.unread, false, 'events inside the read output cut auto-read');
  assert.strictEqual(autoReadEvent.readAttentionSeq, 2);

  const mainHost = createFakeHost({ isMainAgent: () => true });
  const mainTracker = new AgentAttentionTracker(mainHost);
  assert.strictEqual(mainTracker.recordAgentAttentionEvent(null), null);
  assert.strictEqual(
    mainTracker.recordAgentAttentionEvent(createAgent(), 'turn-complete'),
    null,
    'the Main Agent must never receive attention',
  );

  const busyAgent = createAgent({
    id: 'agent-busy',
    attentionTrackingReady: true,
    lastObservedTurnActive: false,
  });
  host.agents.set(busyAgent.id, busyAgent);
  busyAgent.terminalBusy = true;
  tracker.observeAgentAttentionState(busyAgent.id);
  busyAgent.terminalBusy = false;
  assert.strictEqual(
    tracker.observeAgentAttentionState(busyAgent.id),
    true,
    'busy-to-idle completes one transition',
  );
  assert.strictEqual(busyAgent.attentionSeq, 1);
  assert.strictEqual(busyAgent.attentionReason, 'turn-complete');

  const exitedAgent = createAgent({
    id: 'agent-exited',
    status: 'stopped',
    attentionTrackingReady: true,
    lastObservedTurnActive: true,
  });
  host.agents.set(exitedAgent.id, exitedAgent);
  assert.strictEqual(tracker.completeAgentAttentionTransition(exitedAgent), true);
  assert.strictEqual(exitedAgent.attentionReason, 'process-exit');

  const baselineAgent = createAgent({
    id: 'agent-baseline',
    attentionRequiresNewOutput: true,
    attentionBaselineOutputSeq: 3,
    lastOutputSeq: 3,
  });
  assert.strictEqual(
    tracker.completeAgentAttentionTransition(baselineAgent),
    false,
    'completion without new authoritative output must not mint attention',
  );

  const shellAgent = createAgent({
    id: 'shell-agent',
    command: 'bash',
    attentionTrackingReady: true,
    lastObservedTurnActive: true,
  });
  host.agents.set(shellAgent.id, shellAgent);
  assert.strictEqual(tracker.observeAgentAttentionState(shellAgent.id), false);
  assert.strictEqual(shellAgent.attentionSeq, 0, 'shell busy-to-idle edges never mint attention');

  const legacyShellAgent = createAgent({
    id: 'legacy-shell',
    command: 'bash',
    attentionTrackingReady: true,
    attentionSeq: 1,
    readAttentionSeq: 0,
    unread: true,
    attentionReason: 'turn-complete',
  });
  host.agents.set(legacyShellAgent.id, legacyShellAgent);
  tracker.observeAgentAttentionState(legacyShellAgent.id);
  assert.strictEqual(legacyShellAgent.readAttentionSeq, 1);
  assert.strictEqual(legacyShellAgent.unread, false);

  const qwenHost = createFakeHost({ providerForAgent: () => 'qwen' });
  const qwenTracker = new AgentAttentionTracker(qwenHost);
  const qwenAgent = createAgent({ id: 'qwen-agent', runtimeEpoch: 'qwen-epoch' });
  qwenHost.agents.set(qwenAgent.id, qwenAgent);
  qwenTracker.scheduleQwenTerminalIdleCandidate(qwenAgent);
  assert.strictEqual(qwenTracker.hasQwenTerminalIdleCandidate(qwenAgent.id), true);
  assert.strictEqual(qwenTracker.cancelQwenTerminalIdleCandidate(qwenAgent.id), true);
  assert.strictEqual(qwenTracker.hasQwenTerminalIdleCandidate(qwenAgent.id), false);
  qwenTracker.cancelAllQwenTerminalIdleCandidates();

  assert.deepStrictEqual(tracker.markAgentReadCursor('missing'), { error: 'Agent not found' });
  assert.deepStrictEqual(tracker.markAgentUnreadCursor('missing'), { error: 'Agent not found' });

  console.log('✓ agent attention tracker preserves the unread cursor state machine');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
