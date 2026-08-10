const assert = require('assert');
const { EventEmitter } = require('events');
const { AgentManager } = require('../agent-manager.cjs');

function acpAgent(id) {
  const sessionId = `session-${id}`;
  return {
    id,
    command: 'opencode',
    forkCommand: 'opencode',
    cwd: process.cwd(),
    projectWorkspace: process.cwd(),
    output: '',
    previewText: '',
    previewCols: 80,
    previewRows: 24,
    sessionTitle: '',
    status: 'running',
    engineName: 'local',
    engineStarted: false,
    wantsMain: false,
    category: 'coding',
    task: `Scoped event scale task ${id}`,
    source: 'ui',
    providerSessionProvider: 'opencode',
    providerSessionId: sessionId,
    providerSessionKey: `agent-session:opencode:${sessionId}`,
    providerSessionTemporary: false,
    runtimeBinding: {
      kind: 'acp',
      state: 'idle',
      error: '',
      stopReason: '',
      supportsSteer: false,
      supportsFork: false,
      pendingPermission: null,
      pendingPermissions: [],
      pendingElicitation: null,
      pendingElicitations: [],
      activeElicitations: [],
      sessionUpdatedAt: '',
      sessionRevision: 0,
    },
    runtimeEpoch: `runtime-${id}`,
    lastOutputSeq: 1,
    readOutputEpoch: '',
    readOutputSeq: null,
    validated: true,
    startedAt: Date.now(),
  };
}

async function run() {
  let persistenceCount = 0;
  const runtime = Object.assign(new EventEmitter(), {
    bindings: new Map(),
    async dispose() {},
  });
  const manager = new AgentManager({
    getWorkspace: () => process.cwd(),
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
    getAgentLaunchProfiles: () => ({}),
    getDangerouslySkipAgentPermissionsByDefault: () => false,
    ensureAgentSessionRecord(agent) {
      persistenceCount += 1;
      return agent.agentRecordId || `record-${agent.id}`;
    },
  }, {
    acpRuntime: runtime,
    skipExecutablePreflight: true,
  });

  const agentUpdates = [];
  const revisions = [];
  const readUpdates = [];
  let fullUpdates = 0;
  manager.on('agent-update', update => agentUpdates.push(update));
  manager.on('acp-session-revision', update => revisions.push(update));
  manager.on('agent-read', update => readUpdates.push(update));
  manager.on('update', () => { fullUpdates += 1; });

  try {
    const count = 120;
    const agentIds = Array.from({ length: count }, (_, index) => `agent-scoped-${index}`);
    for (const agentId of agentIds) {
      manager.agents.set(agentId, acpAgent(agentId));
    }

    for (const agentId of agentIds) {
      runtime.emit('agent-runtime', { agentId, state: 'working' });
      runtime.emit('agent-runtime', { agentId, state: 'idle' });
    }
    assert.strictEqual(agentUpdates.length, count * 2, 'working/idle must publish one scoped update per transition');
    assert(agentUpdates.every(update => update.patch.runtimeBinding), 'runtime transitions must use runtimeBinding patches');
    assert(agentUpdates.every(update => update.patch.runtimeObservation), 'runtime transitions must update the derived observation atomically');
    assert.strictEqual(fullUpdates, 0, 'runtime transitions with stable provider identities must not broadcast full state');
    assert.strictEqual(persistenceCount, 0, 'high-frequency runtime transitions must not rewrite stable Agent records');

    const runtimeUpdatesBeforeDuplicates = agentUpdates.length;
    for (let iteration = 0; iteration < 10; iteration += 1) {
      for (const agentId of agentIds) {
        runtime.emit('agent-runtime', { agentId, state: 'idle' });
      }
    }
    assert.strictEqual(agentUpdates.length, runtimeUpdatesBeforeDuplicates, 'equal runtime events must be deduplicated');
    assert.strictEqual(fullUpdates, 0, 'equal runtime events must not broadcast full state');
    assert.strictEqual(persistenceCount, 0, 'equal runtime events must not trigger persistence');

    for (const agentId of agentIds) {
      runtime.emit('session', { agentId, revision: 1 });
    }
    assert.strictEqual(revisions.length, count, 'transcript revisions must use the dedicated scoped channel');
    assert.strictEqual(agentUpdates.length, runtimeUpdatesBeforeDuplicates, 'revision-only events must not publish Agent patches');
    assert.strictEqual(fullUpdates, 0, 'transcript revisions must not broadcast full state');

    const titleUpdatesStart = agentUpdates.length;
    for (const agentId of agentIds) {
      runtime.emit('session', { agentId, revision: 2, title: `Scoped title ${agentId}` });
    }
    const titleUpdates = agentUpdates.slice(titleUpdatesStart);
    assert.strictEqual(titleUpdates.length, count, 'title changes must publish one scoped Agent patch');
    assert(titleUpdates.every(update => Object.keys(update.patch).length === 1 && 'sessionTitle' in update.patch));
    assert.strictEqual(fullUpdates, 0, 'title changes must not broadcast full state');

    const providerTitleUpdatesStart = agentUpdates.length;
    for (const agentId of agentIds) {
      const agent = manager.agents.get(agentId);
      manager.providerSessionService.commit(agent, {
        kind: 'session-updated',
        event: {
          agentId,
          provider: agent.providerSessionProvider,
          sessionId: agent.providerSessionId,
          temporary: false,
          title: `Provider title ${agentId}`,
        },
      });
    }
    const providerTitleUpdates = agentUpdates.slice(providerTitleUpdatesStart);
    assert.strictEqual(
      providerTitleUpdates.length,
      count,
      'provider History title refreshes must publish one scoped Agent patch',
    );
    assert(providerTitleUpdates.every(update => (
      Object.keys(update.patch).length === 1 && 'sessionTitle' in update.patch
    )));
    assert.strictEqual(fullUpdates, 0, 'provider History title refreshes must not broadcast full state');

    const persistenceBeforeAttention = persistenceCount;
    for (const agentId of agentIds) {
      const agent = manager.agents.get(agentId);
      agent.attentionSummary = `Finished ${agentId}`;
      manager.attentionTracker.recordAgentAttentionEvent(agent, 'turn-complete');
    }
    assert.strictEqual(readUpdates.length, count, 'attention changes must use the Agent read channel');
    assert(readUpdates.every(update => update.attentionReason === 'turn-complete'));
    assert(readUpdates.every(update => update.attentionSummary === `Finished ${update.agentId}`));
    assert.strictEqual(fullUpdates, 0, 'attention changes must not broadcast full state');
    assert.strictEqual(
      agentUpdates.length,
      providerTitleUpdatesStart + count,
      'attention changes must not publish generic Agent patches',
    );
    assert.strictEqual(
      persistenceCount - persistenceBeforeAttention,
      count,
      'attention durability should remain exactly once per affected Agent',
    );

    console.log('✓ 120 fake ACP Agents keep runtime, revision, title, and attention events Agent-scoped');
  } finally {
    clearInterval(manager.heartbeatInterval);
    await manager.drainAcceptedAgentOperations();
    await manager.engineBridge.dispose();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
