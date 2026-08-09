const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');
const { AgentManager } = require('../agent-manager.cjs');

const AGENT_COUNT = 100;
const EXPECTED_RECOVERY_CONCURRENCY = 8;

function sessionId(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

class DeferredRecoveryRuntime extends EventEmitter {
  constructor() {
    super();
    this.bindings = new Map();
    this.active = 0;
    this.maxActive = 0;
    this.startedAgentIds = [];
    this.release = null;
    this.released = new Promise(resolve => {
      this.release = resolve;
    });
    this.initialBatchReached = new Promise(resolve => {
      this.resolveInitialBatch = resolve;
    });
  }

  async initialize() {}

  publishRecoveredBindings() {}

  hasBinding() {
    return false;
  }

  async prepareAgent(options) {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.startedAgentIds.push(options.agentId);
    if (this.active === EXPECTED_RECOVERY_CONCURRENCY) this.resolveInitialBatch();
    try {
      await this.released;
      if (options.agentId === `agent-${AGENT_COUNT - 1}`) {
        throw new Error('synthetic Session restore failure');
      }
      return {
        sessionId: options.sessionId,
        historyMode: 'checkpoint',
        configOverrides: [],
      };
    } finally {
      this.active -= 1;
    }
  }

  getSessionRequestOptions() {
    return {
      additionalDirectories: [],
      configOverrides: [],
      mcpServers: [],
    };
  }

  bindingEpoch() {
    return '';
  }

  async unregisterAgentAndWait() {
    return false;
  }

  async dispose() {}
}

async function run() {
  const sharedProcessIdentity = {
    kind: 'acp-process-group',
    pid: 42_100,
    processGroupId: 42_100,
    startedAt: 'cold-recovery-shared-adapter',
  };
  const records = Array.from({ length: AGENT_COUNT }, (_, index) => {
    const providerSessionId = sessionId(index);
    return {
      id: `fsess-scale-${index}`,
      runtimeAgentId: `agent-${index}`,
      agentRuntimeMode: 'acp',
      providerSessionProvider: 'codex',
      providerSessionId,
      providerSessionKey: `agent-session:codex:${providerSessionId}`,
      providerHomeId: 'default',
      cwd: process.cwd(),
      projectWorkspace: process.cwd(),
      status: 'running',
      archived: false,
      acpRuntimeMode: 'custom',
      acpRuntimeExecutable: process.execPath,
      structuredRuntimeProcess: { ...sharedProcessIdentity },
    };
  });
  const mainPageSessionKeys = records.map(record => record.providerSessionKey);
  const runtime = new DeferredRecoveryRuntime();
  let persistedCleanupAttempts = 0;
  let mainPageMembershipWrites = 0;
  const manager = new AgentManager({
    getWorkspace: () => process.cwd(),
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
    getDangerouslySkipAgentPermissionsByDefault: () => false,
    getAgentLaunchProfiles: () => ({}),
    getCodexApprovalMode: () => 'full',
    getAgentHome: () => ({ id: 'default', path: path.join(process.cwd(), '.tmp', 'test-codex-home') }),
    getMainPageSessionKeys: () => mainPageSessionKeys.slice(),
    listAgentSessionRecords: () => records.map(record => ({ ...record })),
    ensureAgentSessionRecord: agent => agent.agentRecordId || `fsess-${agent.id}`,
    rememberAgentSessionRecord: agent => {
      mainPageMembershipWrites += 1;
      return agent.agentRecordId || `fsess-${agent.id}`;
    },
  }, {
    acpRuntime: runtime,
    agentShellEnvProvider: () => process.env,
    skipExecutablePreflight: true,
    stopPersistedAcpProcessGroup: async () => {
      persistedCleanupAttempts += 1;
      return { stopped: true };
    },
  });

  try {
    const recovery = manager.recoverAcpSessions();
    await Promise.race([
      runtime.initialBatchReached,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('initial recovery batch timed out')), 2_000);
        timer.unref?.();
      }),
    ]);

    assert.strictEqual(
      manager.agents.size,
      AGENT_COUNT,
      'all Agent rows must be materialized before provider Session recovery finishes',
    );
    assert.strictEqual(runtime.startedAgentIds.length, EXPECTED_RECOVERY_CONCURRENCY);
    assert.strictEqual(runtime.maxActive, EXPECTED_RECOVERY_CONCURRENCY);
    for (const agent of manager.agents.values()) {
      assert.strictEqual(agent.runtimeBinding.state, 'connecting');
    }

    runtime.release();
    await recovery;

    assert.strictEqual(runtime.startedAgentIds.length, AGENT_COUNT);
    assert.strictEqual(runtime.maxActive, EXPECTED_RECOVERY_CONCURRENCY);
    assert.strictEqual(
      persistedCleanupAttempts,
      1,
      'one shared persisted adapter identity must be killed exactly once',
    );
    assert.strictEqual(
      mainPageMembershipWrites,
      0,
      'cold recovery must not reorder Sessions already present on the main page',
    );
    assert.strictEqual(
      [...manager.agents.values()].filter(agent => agent.runtimeBinding.state === 'idle').length,
      AGENT_COUNT - 1,
    );
    const failed = manager.agents.get(`agent-${AGENT_COUNT - 1}`);
    assert.strictEqual(failed.runtimeBinding.state, 'error');
    assert.match(failed.runtimeBinding.error, /synthetic Session restore failure/);
  } finally {
    runtime.release();
    await manager.dispose();
  }

  console.log('agent manager ACP cold recovery scale tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
