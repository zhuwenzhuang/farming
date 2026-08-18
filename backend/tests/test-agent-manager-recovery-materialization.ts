const assert = require('assert');
const EventEmitter = require('events');

const { AgentManager } = require('../agent-manager.cjs');
const { encodeProviderSessionKey } = require('../../shared/provider-session-identity.js');

class RecoveryRuntime extends EventEmitter {
  bindings = new Map();

  async initialize() {}

  hasBinding(agentId) {
    return this.bindings.has(agentId);
  }

  publishRecoveredBindings() {}

  registerBindingCallbacks() {}

  getSession(agentId) {
    return this.bindings.get(agentId);
  }

  getSessionRequestOptions() {
    return { additionalDirectories: [], configOverrides: [], mcpServers: [] };
  }

  async getSessionForRead(agentId) {
    return this.getSession(agentId);
  }

  unregisterAgent(agentId) {
    this.bindings.delete(agentId);
  }

  async dispose() {
    this.bindings.clear();
  }
}

async function run() {
  const acpSessionId = '11111111-1111-4111-8111-111111111111';
  const terminalSessionId = '22222222-2222-4222-8222-222222222222';
  const acpSessionKey = encodeProviderSessionKey('codex', acpSessionId, 'default');
  const terminalSessionKey = encodeProviderSessionKey('codex', terminalSessionId, 'default');
  const records = [
    {
      id: 'agent_materialized_acp_record',
      runtimeAgentId: 'materialized-acp',
      command: 'codex',
      forkCommand: 'codex',
      cwd: '/repo',
      projectWorkspace: '/repo',
      provider: 'codex',
      providerHomeId: 'default',
      providerSessionId: acpSessionId,
      providerSessionKey: acpSessionKey,
      agentRuntimeMode: 'acp',
      lastActivityAt: 1_234_567,
      attentionSeq: 4,
      readAttentionSeq: 4,
      unread: true,
    },
    {
      id: 'agent_materialized_terminal_record',
      runtimeAgentId: 'materialized-terminal',
      command: 'codex',
      forkCommand: 'codex',
      cwd: '/repo',
      projectWorkspace: '/repo',
      provider: 'codex',
      providerHomeId: 'default',
      providerSessionId: terminalSessionId,
      providerSessionKey: terminalSessionKey,
      agentRuntimeMode: 'terminal',
      attentionSeq: 3,
      readAttentionSeq: 2,
      unread: true,
    },
  ];
  const runtime = new RecoveryRuntime();
  const manager = new AgentManager({
    farmingDir: '/tmp/farming-recovery-materialization',
    getWorkspace: () => '/repo',
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
    getCodingAgentEngine: () => 'local',
    getMainPageSessionKeys: () => [acpSessionKey, terminalSessionKey],
    listAgentSessionRecords: () => records,
  }, {
    acpRuntime: runtime,
    skipExecutablePreflight: true,
  });
  let releaseEngineRecovery;
  manager.engineBridge.recoverSessions = () => new Promise(resolve => {
    releaseEngineRecovery = resolve;
  });
  const recoveryUpdates = [];
  manager.onUpdate(update => recoveryUpdates.push(update));

  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(typeof releaseEngineRecovery, 'function');
    const initialAgents = manager.getState().agents;
    assert.deepStrictEqual(
      initialAgents.map(agent => agent.id).sort(),
      ['materialized-acp', 'materialized-terminal'],
      'all persisted rows must materialize before asynchronous Runtime enumeration completes',
    );
    assert.strictEqual(
      initialAgents.find(agent => agent.id === 'materialized-acp').status,
      'pending',
      'a persisted Chat waits for authoritative ACP binding recovery',
    );
    assert.strictEqual(
      initialAgents.find(agent => agent.id === 'materialized-terminal').status,
      'stopped',
      'an indexed Terminal without live-host evidence is visible but cold until user resume',
    );
    assert.strictEqual(
      initialAgents.find(agent => agent.id === 'materialized-acp').runtimeBinding.kind,
      'acp',
    );
    assert.strictEqual(
      initialAgents.find(agent => agent.id === 'materialized-acp').lastActivity,
      1_234_567,
      'materializing a persisted ACP Agent must preserve its activity time',
    );
    assert.strictEqual(
      initialAgents.find(agent => agent.id === 'materialized-acp').unread,
      false,
      'the persisted read cursor, not a stale unread boolean, owns restored unread state',
    );
    assert.strictEqual(
      initialAgents.find(agent => agent.id === 'materialized-terminal').unread,
      true,
    );
    assert.deepStrictEqual(
      recoveryUpdates[0]?.agentIds?.slice().sort(),
      ['materialized-acp', 'materialized-terminal'],
      'initial row publication must be one aggregate state change',
    );

    let readSettled = false;
    const pendingRead = manager.getAcpSessionForRead('materialized-acp')
      .then(session => {
        readSettled = true;
        return session;
      });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(readSettled, false, 'opening an unrecovered Chat must wait for recovery');

    runtime.bindings.set('materialized-acp', {
      agentId: 'materialized-acp',
      sessionId: acpSessionId,
      state: 'idle',
    });
    releaseEngineRecovery([]);
    const session = await pendingRead;
    assert.strictEqual(session.sessionId, acpSessionId);
    await manager.recoveryGate.wait();
    assert.strictEqual(
      manager.getAgentState('materialized-acp').lastActivity,
      1_234_567,
      'reconnecting the recovered ACP binding must not count as new Agent activity',
    );
  } finally {
    if (releaseEngineRecovery) releaseEngineRecovery([]);
    await manager.dispose();
  }

  console.log('Agent recovery materializes all rows before Runtime enumeration and waits on focused Chat recovery');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
