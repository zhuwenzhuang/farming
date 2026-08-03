const assert = require('assert');
const { EventEmitter } = require('events');
const AgentManager = require('../agent-manager.cjs');

function config(overrides = {}) {
  return {
    getWorkspace: () => process.cwd(),
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
    getAgentLaunchProfiles: () => ({}),
    getCodexApprovalMode: () => 'full',
    getAgentHome: () => ({ id: 'default', path: process.cwd() }),
    ...overrides,
  };
}

function acpAgent(id, state = 'idle', options = {}) {
  return {
    id,
    command: 'opencode',
    cwd: process.cwd(),
    projectWorkspace: process.cwd(),
    status: 'running',
    source: 'ui',
    agentRuntimeMode: 'chat',
    providerSessionProvider: 'opencode',
    runtimeBinding: { kind: 'acp', state, stopReason: state === 'hibernated' ? 'hibernated' : '' },
    ...options,
  };
}

async function run() {
  const calls = [];
  const persistedRuntimeStates = [];
  const runtime = Object.assign(new EventEmitter(), {
    bindings: new Map(),
    hasBinding: agentId => runtime.bindings.has(agentId),
    bindingEpoch: agentId => String(runtime.bindings.get(agentId)?.runtimeEpoch || ''),
    async hibernateAgent(agentId) {
      calls.push(`hibernate:${agentId}`);
      return { hibernated: true };
    },
    async reconnectAgent(agentId) {
      calls.push(`reconnect:${agentId}`);
      return { reconnected: true };
    },
    async unregisterAgentAndWait(agentId) {
      runtime.bindings.delete(agentId);
      return true;
    },
    getSession(agentId) {
      calls.push(`get:${agentId}`);
      return { sessionId: `${agentId}-session`, state: 'hibernated' };
    },
    async listSessions(agentId) {
      calls.push(`list:${agentId}`);
      return { sessions: [] };
    },
    unregisterAgent() {},
    async dispose() {},
  });
  const revoked = [];
  const manager = new AgentManager(config({
    ensureAgentSessionRecord(agent) {
      persistedRuntimeStates.push(agent.runtimeBinding?.state || '');
      return agent.id;
    },
  }), {
    acpRuntime: runtime,
    browserMcpEnabled: true,
    revokeAgentCapabilityTokens: agentId => revoked.push(agentId),
    skipExecutablePreflight: true,
  });

  try {
    const now = Date.now();
    for (let index = 0; index < 32; index += 1) {
      const id = `agent-${index}`;
      const state = index % 2 === 0 ? 'idle' : 'working';
      manager.agents.set(id, acpAgent(id, state, {
        wantsMain: index === 0,
        pinned: index === 2,
      }));
      manager.lastActivity.set(id, now);
      runtime.bindings.set(id, { agentId: id, runtimeEpoch: `runtime-${id}`, state });
    }
    manager.mainAgentId = 'agent-0';

    assert.strictEqual(
      typeof manager.hibernateIdleAcpAgents,
      'undefined',
      'Agent count must not expose an automatic hibernation policy',
    );
    await manager.cleanupZombieAgents();
    assert.deepStrictEqual(
      calls,
      [],
      'many working and idle Agents must not be hibernated merely because they coexist',
    );

    manager.agents.set('agent-stale-working', acpAgent('agent-stale-working', 'working'));
    manager.lastActivity.set('agent-stale-working', now - AgentManager.ZOMBIE_IDLE_MS - 1);
    runtime.bindings.set('agent-stale-working', {
      agentId: 'agent-stale-working',
      runtimeEpoch: 'runtime-agent-stale-working',
      state: 'working',
    });
    assert.strictEqual(
      manager.isZombie('agent-stale-working', now),
      false,
      'a working ACP Agent must not become a zombie because its activity timestamp is stale',
    );
    await manager.cleanupZombieAgents();
    assert.strictEqual(
      manager.agents.has('agent-stale-working'),
      true,
      'zombie cleanup must not interrupt a working ACP Agent',
    );

    assert.deepStrictEqual(
      await manager.reclaimIdleAcpAgentForResourcePressure('agent-1', {
        source: 'worker-memory',
        reason: 'allocator reported pressure',
        observedAt: now,
      }),
      { reclaimed: false, state: 'working' },
      'a working Agent must be rejected immediately instead of queued for later reclaim',
    );
    assert.deepStrictEqual(calls, []);

    assert.deepStrictEqual(
      await manager.reclaimIdleAcpAgentForResourcePressure('agent-0', {
        source: 'worker-memory',
        reason: 'allocator reported pressure',
      }),
      { reclaimed: false, protected: true, state: 'idle' },
      'the main Agent remains protected during pressure handling',
    );
    assert.deepStrictEqual(
      await manager.reclaimIdleAcpAgentForResourcePressure('agent-2', {
        source: 'worker-memory',
        reason: 'allocator reported pressure',
      }),
      { reclaimed: false, protected: true, state: 'idle' },
      'a pinned Agent remains protected during pressure handling',
    );
    assert.deepStrictEqual(calls, []);

    assert.match(
      (await manager.reclaimIdleAcpAgentForResourcePressure('agent-4', {
        source: '',
        reason: '',
      })).error,
      /explicit source and reason/,
    );
    assert.deepStrictEqual(calls, []);

    assert.deepStrictEqual(
      await manager.reclaimIdleAcpAgentForResourcePressure('agent-4', {
        source: 'worker-memory',
        reason: 'allocator reported pressure',
        observedAt: now,
      }),
      {
        hibernated: true,
        reclaimed: true,
        pressure: {
          source: 'worker-memory',
          reason: 'allocator reported pressure',
          observedAt: now,
        },
      },
      'an explicit pressure signal may reclaim one exact idle recoverable runtime',
    );
    assert.deepStrictEqual(calls, ['hibernate:agent-4']);
    assert.deepStrictEqual(
      revoked,
      ['agent-4'],
      'successful hibernation must revoke every token from the stopped ACP runtime',
    );

    manager.agents.set('agent-sleeping', acpAgent('agent-sleeping', 'hibernated'));
    manager.lastActivity.set('agent-sleeping', now - AgentManager.ZOMBIE_IDLE_MS - 1);
    assert.strictEqual(
      manager.isZombie('agent-sleeping', now),
      false,
      'a hibernated logical Agent must not be deleted by zombie cleanup',
    );

    runtime.bindings.set('agent-sleeping', {
      agentId: 'agent-sleeping',
      runtimeEpoch: 'runtime-agent-sleeping',
    });
    assert.deepStrictEqual(
      manager.resolveAgentCapabilityBinding('agent-6', 'browser'),
      { runtimeEpoch: 'runtime-agent-6', workspace: process.cwd() },
      'capability admission must return the exact live ACP runtime epoch',
    );
    manager.agents.set('agent-wake-failed', acpAgent('agent-wake-failed', 'connecting', {
      structuredRuntimeProcess: { kind: 'acp-process-group', pid: 20, processGroupId: 20, startedAt: 'test' },
    }));
    runtime.bindings.set('agent-wake-failed', { agentId: 'agent-wake-failed' });
    runtime.emit('agent-runtime', {
      agentId: 'agent-wake-failed',
      state: 'error',
      error: 'wake failed before session load',
      stopReason: 'error',
      sessionId: '',
    });
    assert.strictEqual(
      persistedRuntimeStates.at(-1),
      'error',
      'a wake failure before session identity must persist its durable error state',
    );
    calls.length = 0;
    await manager.listAcpSessions('agent-sleeping');
    assert.deepStrictEqual(
      calls,
      ['reconnect:agent-sleeping', 'list:agent-sleeping'],
      'provider mutations must wake a hibernated Agent before use',
    );

    manager.agents.set('agent-runtime-switch', acpAgent('agent-runtime-switch', 'idle'));
    runtime.bindings.set('agent-runtime-switch', {
      agentId: 'agent-runtime-switch',
      runtimeEpoch: 'runtime-before-switch',
      state: 'idle',
    });
    const stoppedForSwitch = await manager.performKillAgent('agent-runtime-switch', {
      emitUpdate: false,
      persistDeleteOperation: false,
      recordHistory: false,
      retainAgentRecord: true,
    });
    assert.strictEqual(stoppedForSwitch.retained, true);
    assert.deepStrictEqual(
      revoked,
      ['agent-4', 'agent-runtime-switch'],
      'Chat to Terminal replacement must revoke the stopped ACP runtime token',
    );
    manager.forgetStoppedAgentRecord('agent-sleeping', { emitUpdate: false });
    assert.deepStrictEqual(
      revoked,
      ['agent-4', 'agent-runtime-switch', 'agent-sleeping'],
      'deleting the logical Agent must revoke any retained capability token',
    );
  } finally {
    await manager.dispose();
  }

  const recoveryRecords = Array.from({ length: 12 }, (_, index) => ({
    id: `fsess-recovery-${index}`,
    runtimeAgentId: `agent-recovery-${index}`,
    agentRuntimeMode: 'acp',
    providerSessionProvider: 'opencode',
    providerSessionId: `session-recovery-${index}`,
    providerSessionKey: `agent-session:opencode:session-recovery-${index}`,
    cwd: process.cwd(),
    projectWorkspace: process.cwd(),
    status: 'running',
    runtimeBinding: { kind: 'acp', state: 'hibernated', stopReason: 'hibernated' },
    structuredRuntimeProcess: null,
  }));
  let processStarts = 0;
  const recoveryHibernateCalls = [];
  const recoveryRuntime = Object.assign(new EventEmitter(), {
    bindings: new Map(),
    hasBinding(agentId) {
      return this.bindings.has(agentId);
    },
    bindingEpoch(agentId) {
      return String(this.bindings.get(agentId)?.runtimeEpoch || '');
    },
    async prepareAgent(options) {
      assert.strictEqual(options.restoreHibernated, true);
      this.bindings.set(options.agentId, { agentId: options.agentId, state: 'hibernated' });
      return { sessionId: options.sessionId, historyMode: 'hibernated' };
    },
    async hibernateAgent(agentId) {
      recoveryHibernateCalls.push(agentId);
      return { hibernated: true };
    },
    getSessionRequestOptions() {
      return { additionalDirectories: [], mcpServers: [] };
    },
    unregisterAgent() {},
    async dispose() {},
  });
  const recoveryManager = new AgentManager(config({
    getMainPageSessionKeys: () => recoveryRecords.map(record => record.providerSessionKey),
    listAgentSessionRecords: () => recoveryRecords,
  }), {
    acpRuntime: recoveryRuntime,
    allowUnprovenLegacyAcpRecovery: false,
    skipExecutablePreflight: true,
  });
  try {
    await recoveryManager.recoverAcpSessions();
    assert.strictEqual(
      recoveryRuntime.bindings.size,
      recoveryRecords.length,
      'cold recovery must retain every durable logical Agent binding',
    );
    assert.strictEqual(
      processStarts,
      0,
      'persisted hibernated Agents must not start provider processes during cold recovery',
    );
    assert(
      [...recoveryManager.agents.values()].every(agent => agent.runtimeBinding?.state === 'hibernated'),
      'cold recovery must preserve the hibernated lifecycle state',
    );
    assert.deepStrictEqual(
      recoveryHibernateCalls,
      [],
      'cold recovery must not trigger count-based hibernation',
    );
  } finally {
    await recoveryManager.dispose();
  }

  console.log('AgentManager ACP resource-pressure hibernation tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
