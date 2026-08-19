const assert = require('assert');
const { AgentManager } = require('../agent-manager.cjs');
const { createTestAcpRuntime } = require('./helpers/test-acp-runtime.ts');

function recoveredAgent(id, overrides = {}) {
  return {
    id,
    command: 'codex',
    cwd: '/tmp',
    projectWorkspace: '/tmp',
    output: '',
    status: 'running',
    engineName: 'native',
    runtimeBinding: { kind: 'acp', state: 'idle' },
    startedAt: 1_000,
    ...overrides,
  };
}

async function run() {
  const runtime = createTestAcpRuntime();
  const manager = new AgentManager({
    getWorkspace: () => '/tmp',
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
  }, { acpRuntime: runtime, skipExecutablePreflight: true });
  const now = 10_000;

  try {
    const persistedActivityAt = 4_000;
    manager.registerAgentRecord('persisted-idle', recoveredAgent('persisted-idle', {
      lastActivityAt: persistedActivityAt,
    }));
    runtime.emit('agent-runtime', {
      agentId: 'persisted-idle',
      state: 'idle',
      updatedAt: new Date(now).toISOString(),
    });
    assert.strictEqual(
      manager.getAgentState('persisted-idle', now).lastActivity,
      persistedActivityAt,
      'an idle ACP reconnect must preserve persisted activity time',
    );

    manager.registerAgentRecord('legacy-idle', recoveredAgent('legacy-idle', {
      attentionUpdatedAt: 3_000,
      readAttentionAt: 3_500,
    }));
    runtime.emit('agent-runtime', {
      agentId: 'legacy-idle',
      state: 'idle',
      updatedAt: new Date(now).toISOString(),
    });
    assert.strictEqual(
      manager.getAgentState('legacy-idle', now).lastActivity,
      3_000,
      'a legacy ACP record must fall back to its latest Agent activity instead of read or reconnect time',
    );

    manager.registerAgentRecord('viewed-idle', recoveredAgent('viewed-idle', {
      lastActivityAt: 4_000,
      readAttentionAt: 4_500,
    }));
    runtime.emit('agent-runtime', {
      agentId: 'viewed-idle',
      state: 'idle',
      updatedAt: new Date(now).toISOString(),
    });
    assert.strictEqual(
      manager.getAgentState('viewed-idle', now).lastActivity,
      4_000,
      'a later user read must not replace the Agent runtime activity timestamp',
    );

    manager.registerAgentRecord('recovery-error', recoveredAgent('recovery-error', {
      lastActivityAt: 4_000,
      exitedAt: 9_000,
      status: 'stopped',
      runtimeBinding: { kind: 'acp', state: 'error' },
    }));
    assert.strictEqual(
      manager.getAgentState('recovery-error', now).lastActivity,
      4_000,
      'a reconnect failure timestamp must not replace known Agent activity',
    );

    runtime.emit('agent-runtime', {
      agentId: 'persisted-idle',
      state: 'working',
      updatedAt: new Date().toISOString(),
    });
    assert(
      manager.getAgentState('persisted-idle').lastActivity > persistedActivityAt,
      'a real transition into working must still record fresh activity',
    );
  } finally {
    await manager.dispose();
  }

  console.log('agent manager ACP activity recovery tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
