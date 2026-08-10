const assert = require('assert');
const EventEmitter = require('events');
const { AgentManager } = require('../agent-manager.cjs');

function configManager() {
  return {
    getWorkspace() {
      return process.cwd();
    },
    getHeartbeatInterval() {
      return 1000;
    },
    getCodingAgentEngine() {
      return 'local';
    },
    getVtBaseUrl() {
      return 'http://localhost:4020';
    },
    getTaskHistory() {
      return [];
    },
    getDangerouslySkipAgentPermissionsByDefault() {
      return false;
    },
  };
}

class FakeStructuredRuntime extends EventEmitter {
  constructor(agentIds = []) {
    super();
    this.bindings = new Map(agentIds.map(agentId => [agentId, { agentId }]));
  }

  unregisterAgent(agentId) {
    this.bindings.delete(agentId);
  }
}

async function run() {
  const manager = new AgentManager(configManager(), { skipExecutablePreflight: true });

  try {
    manager.agents.set('agent-lifecycle', {
      id: 'agent-lifecycle',
      command: 'codex',
      cwd: process.cwd(),
      output: '',
      status: 'running',
      engineName: 'local',
      source: 'ui',
      providerSessionProvider: 'codex',
      providerSessionId: 'session-lifecycle',
      providerSessionTemporary: false,
    });

    let finishRuntimeSwitch;
    let permissionRestartCalls = 0;
    manager.performAgentRuntimeModeRestart = (_agentId, _mode, lifecycleToken) => new Promise(resolve => {
      manager.agents.set('agent-replacement', {
        id: 'agent-replacement',
        command: 'codex',
        cwd: process.cwd(),
        output: '',
        status: 'pending',
        engineName: 'local',
        source: 'ui',
        providerSessionProvider: 'codex',
        providerSessionId: 'session-lifecycle',
        providerSessionTemporary: false,
      });
      assert.strictEqual(manager.adoptAgentLifecycleOperation('agent-replacement', lifecycleToken), true);
      finishRuntimeSwitch = resolve;
    });
    manager.performAgentPermissionRestart = async () => {
      permissionRestartCalls += 1;
      return { restarted: true };
    };

    const runtimeSwitch = manager.restartAgentRuntimeMode('agent-lifecycle', 'chat');
    await Promise.resolve();

    const duplicateRuntimeSwitch = manager.restartAgentRuntimeMode('agent-lifecycle', 'chat');
    let permissionRestartSettled = false;
    const queuedPermissionRestart = manager.restartAgentWithPermissionMode('agent-lifecycle', 'approve')
      .then(result => {
        permissionRestartSettled = true;
        return result;
      });
    await Promise.resolve();
    assert.strictEqual(permissionRestartSettled, false, 'different lifecycle operations must wait');
    const conflictingRename = manager.renameAgent('agent-lifecycle', 'renamed');
    const conflictingTaskUpdate = manager.setAgentTask('agent-lifecycle', 'new task');
    const conflictingFlagUpdate = manager.updateAgentFlags('agent-lifecycle', { pinned: true });
    const conflictingReorder = manager.reorderAgent('agent-lifecycle');
    manager.agents.get('agent-replacement').projectWorkspace = process.cwd();
    manager.agents.get('agent-replacement').projectOrder = 2;
    manager.agents.set('agent-reorder-neighbor', {
      id: 'agent-reorder-neighbor',
      command: 'codex',
      cwd: process.cwd(),
      projectWorkspace: process.cwd(),
      projectOrder: 1,
      pinned: false,
      status: 'running',
    });
    manager.agents.set('agent-reorder-target', {
      id: 'agent-reorder-target',
      command: 'codex',
      cwd: process.cwd(),
      projectWorkspace: process.cwd(),
      projectOrder: 0,
      pinned: false,
      status: 'running',
    });
    const conflictingNeighborReorder = manager.reorderAgent('agent-reorder-target', {
      beforeAgentId: 'agent-replacement',
      afterAgentId: 'agent-reorder-neighbor',
    });
    assert.strictEqual(manager.agents.has('agent-lifecycle'), true);

    assert.match(conflictingRename.error, /lifecycle change already in progress/i);
    assert.match(conflictingTaskUpdate.error, /lifecycle change already in progress/i);
    assert.match(conflictingFlagUpdate.error, /lifecycle change already in progress/i);
    assert.match(conflictingReorder.error, /lifecycle change already in progress/i);
    assert.match(conflictingNeighborReorder.error, /lifecycle change already in progress/i);
    assert.strictEqual(permissionRestartCalls, 0, 'conflicting lifecycle operation must not start');

    finishRuntimeSwitch({ restarted: true, restartedAgentId: 'agent-replacement', agentRuntimeMode: 'chat' });
    assert.deepStrictEqual(await runtimeSwitch, await duplicateRuntimeSwitch);
    assert.deepStrictEqual(await queuedPermissionRestart, { restarted: true });
    assert.strictEqual(permissionRestartCalls, 1);
    assert.strictEqual(manager.lifecycleCoordinator.has('agent-replacement'), false);

    let releaseCreateSession;
    let createSessionEntered;
    const createSessionStarted = new Promise(resolve => {
      createSessionEntered = resolve;
    });
    manager.engineBridge.resolve = () => ({
      engineName: 'local',
      engine: {
        createSession: async () => {
          createSessionEntered();
          await new Promise(resolve => {
            releaseCreateSession = resolve;
          });
        },
      },
      spec: { category: 'shell' },
    });
    const pendingStart = manager.startAgent('bash', process.cwd(), null, {
      wantsMain: false,
      runtimeAgentId: 'agent-pending-start',
    });
    await createSessionStarted;
    let pendingStartKillSettled = false;
    const pendingStartKill = manager.killAgent('agent-pending-start').then(result => {
      pendingStartKillSettled = true;
      return result;
    });
    await Promise.resolve();
    assert.strictEqual(pendingStartKillSettled, false, 'Delete must wait for Create to reach a terminal state');
    releaseCreateSession();
    assert.strictEqual(await pendingStart, 'agent-pending-start');
    assert.strictEqual((await pendingStartKill).killed, true);

    // Legacy agentRuntimeMode='json' must be rejected outright: there is no json runtime to fall back to.
    let unsupportedJsonStartError = '';
    const unsupportedJsonStart = await manager.startAgent(
      'codex',
      process.cwd(),
      (_agentId, error) => {
        unsupportedJsonStartError = error || '';
      },
      {
        wantsMain: false,
        agentRuntimeMode: 'json',
        runtimeAgentId: 'agent-json-unsupported',
      },
    );
    assert.strictEqual(unsupportedJsonStart, null);
    assert.match(unsupportedJsonStartError, /no longer supported/i);
    assert.strictEqual(manager.agents.has('agent-json-unsupported'), false);

    const ensurePersistentAgentSession = manager.ensurePersistentAgentSession;
    const originalAcpRuntime = manager.acpRuntime;
    let acpCleanupAttempts = 0;
    manager.acpRuntime = {
      async prepareAgent() {
        const error = new Error('ACP startup failed after process admission') as Error & {
          runtimeCleanupAttempted?: boolean;
        };
        error.runtimeCleanupAttempted = true;
        throw error;
      },
      getSessionRequestOptions() {
        return { additionalDirectories: [], mcpServers: [] };
      },
      async unregisterAgentAndWait() {
        acpCleanupAttempts += 1;
        throw new Error('ACP cleanup proof unavailable');
      },
      unregisterAgent() {},
    };
    let acpStartError = '';
    const failedAcpStart = await manager.startAgent('claude', process.cwd(), (agentId, error) => {
      assert.strictEqual(agentId, 'agent-acp-start-uncertain');
      acpStartError = error || '';
    }, {
      wantsMain: false,
      agentRuntimeMode: 'chat',
      runtimeAgentId: 'agent-acp-start-uncertain',
    });
    assert.strictEqual(failedAcpStart, null);
    assert.match(acpStartError, /retained for retry/i);
    assert.strictEqual(acpCleanupAttempts, 1);
    assert.strictEqual(manager.agents.get('agent-acp-start-uncertain').status, 'error');
    manager.ensurePersistentAgentSession = ensurePersistentAgentSession;
    manager.acpRuntime.unregisterAgentAndWait = async () => true;
    const uncertainCleanupRetry = await manager.killAgent('agent-acp-start-uncertain');
    assert.strictEqual(uncertainCleanupRetry.killed, true);
    assert.strictEqual(manager.agents.has('agent-acp-start-uncertain'), false);
    manager.acpRuntime = originalAcpRuntime;

  } finally {
    clearInterval(manager.heartbeatInterval);
    await manager.dispose();
  }

  let releaseDispose;
  const disposeGate = new Promise(resolve => {
    releaseDispose = resolve;
  });
  const blockingAcpRuntime = new FakeStructuredRuntime();
  blockingAcpRuntime.dispose = async () => disposeGate;
  const admissionManager = new AgentManager(configManager(), {
    skipExecutablePreflight: true,
    acpRuntime: blockingAcpRuntime,
  });
  const disposing = admissionManager.dispose();
  let rejectedStartError = '';
  const rejectedStart = await admissionManager.startAgent('bash', process.cwd(), (_agentId, error) => {
    rejectedStartError = error || '';
  }, {
    wantsMain: false,
    runtimeAgentId: 'agent-start-during-dispose',
  });
  assert.strictEqual(rejectedStart, null);
  assert.match(rejectedStartError, /shutting down/i);
  releaseDispose();
  await disposing;
  assert.strictEqual(admissionManager.disposed, true);

  let recoveryFenceRuntimeDisposed = false;
  const recoveryFenceAcpRuntime = new FakeStructuredRuntime();
  recoveryFenceAcpRuntime.dispose = async () => {
    recoveryFenceRuntimeDisposed = true;
  };
  const recoveryFenceManager = new AgentManager(configManager(), {
    skipExecutablePreflight: true,
    acpRuntime: recoveryFenceAcpRuntime,
  });
  let releaseRecovery;
  recoveryFenceManager.recoveryPromise = new Promise(resolve => {
    releaseRecovery = resolve;
  });
  const recoveryFencedDispose = recoveryFenceManager.dispose();
  await Promise.resolve();
  assert.strictEqual(
    recoveryFenceRuntimeDisposed,
    false,
    'runtime disposal must wait for lifecycle recovery to finish',
  );
  releaseRecovery();
  await recoveryFencedDispose;
  assert.strictEqual(recoveryFenceRuntimeDisposed, true);

  const retryableAcpRuntime = new FakeStructuredRuntime(['acp-retry']);
  let failAcpDispose = true;
  retryableAcpRuntime.dispose = async () => {
    if (failAcpDispose) throw new Error('ACP process tree still live');
    retryableAcpRuntime.bindings.delete('acp-retry');
  };
  const partialManager = new AgentManager(configManager(), {
    skipExecutablePreflight: true,
    acpRuntime: retryableAcpRuntime,
  });
  partialManager.agents.set('acp-retry', {
    id: 'acp-retry',
    command: 'claude',
    cwd: process.cwd(),
    status: 'running',
    runtimeBinding: { kind: 'acp', state: 'idle' },
  });

  await assert.rejects(partialManager.dispose(), /cleanup could not be verified/i);
  assert.strictEqual(partialManager.disposing, false);
  assert.strictEqual(partialManager.disposed, false);
  assert.strictEqual(partialManager.agents.has('acp-retry'), true);
  assert.strictEqual(partialManager.agents.get('acp-retry').status, 'error');
  assert.strictEqual(partialManager.agents.get('acp-retry').engineStatus, 'cleanup-uncertain');
  assert.strictEqual(retryableAcpRuntime.bindings.has('acp-retry'), true);

  failAcpDispose = false;
  await partialManager.dispose();
  assert.strictEqual(partialManager.agents.has('acp-retry'), false);
  assert.strictEqual(partialManager.disposed, true);

  const killAcpRuntime = new FakeStructuredRuntime(['acp-kill-retry']);
  killAcpRuntime.unregisterAgentAndWait = async () => {
    throw new Error('ACP descendant still live');
  };
  const killTruthManager = new AgentManager(configManager(), {
    skipExecutablePreflight: true,
    acpRuntime: killAcpRuntime,
  });
  killTruthManager.agents.set('acp-kill-retry', {
    id: 'acp-kill-retry',
    command: 'claude',
    cwd: process.cwd(),
    status: 'running',
    runtimeBinding: { kind: 'acp', state: 'idle' },
  });
  const killRetryResult = await killTruthManager.killAgent('acp-kill-retry');
  assert.strictEqual(killRetryResult.cleanupUncertain, true);
  assert.strictEqual(killRetryResult.retryable, true);
  const retainedAcp = killTruthManager.agents.get('acp-kill-retry');
  assert.strictEqual(retainedAcp.status, 'error');
  assert.strictEqual(retainedAcp.engineStatus, 'cleanup-uncertain');
  assert.strictEqual(retainedAcp.runtimeBinding.kind, 'acp');
  assert.strictEqual(retainedAcp.runtimeBinding.state, 'error');
  assert.match(retainedAcp.runtimeBinding.error, /descendant still live/i);
  killAcpRuntime.unregisterAgentAndWait = async agentId => {
    killAcpRuntime.bindings.delete(agentId);
    return true;
  };
  assert.strictEqual((await killTruthManager.killAgent('acp-kill-retry')).killed, true);
  await killTruthManager.dispose();

  const missingBindingRuntime = new FakeStructuredRuntime();
  missingBindingRuntime.unregisterAgentAndWait = async () => false;
  let persistedCleanupIdentity = null;
  const missingBindingManager = new AgentManager(configManager(), {
    skipExecutablePreflight: true,
    acpRuntime: missingBindingRuntime,
    stopPersistedAcpProcessGroup: async identity => {
      persistedCleanupIdentity = identity;
      return { stopped: true, alreadyExited: true };
    },
  });
  const persistedProcessIdentity = {
    kind: 'acp-process-group',
    pid: 1234,
    processGroupId: 1234,
    startedAt: 'persisted-start',
  };
  missingBindingManager.agents.set('acp-missing-binding', {
    id: 'acp-missing-binding',
    command: 'claude',
    cwd: process.cwd(),
    status: 'error',
    engineStatus: 'cleanup-uncertain',
    structuredRuntimeProcess: persistedProcessIdentity,
    runtimeBinding: { kind: 'acp', state: 'error' },
  });
  const missingBindingDelete = await missingBindingManager.killAgent(
    'acp-missing-binding',
    { persistDeleteOperation: false },
  );
  assert.strictEqual(missingBindingDelete.killed, true);
  assert.deepStrictEqual(persistedCleanupIdentity, persistedProcessIdentity);
  await missingBindingManager.dispose();

  const recoveryFencedRuntime = new FakeStructuredRuntime(['agent-recovery-fenced-delete']);
  let recoveryFencedCleanupCalls = 0;
  recoveryFencedRuntime.unregisterAgentAndWait = async agentId => {
    recoveryFencedCleanupCalls += 1;
    recoveryFencedRuntime.bindings.delete(agentId);
    return true;
  };
  const recoveryFencedManager = new AgentManager(configManager(), {
    skipExecutablePreflight: true,
    acpRuntime: recoveryFencedRuntime,
  });
  recoveryFencedManager.recoveryComplete = false;
  let releaseRecoveryFence;
  recoveryFencedManager.recoveryPromise = new Promise(resolve => {
    releaseRecoveryFence = resolve;
  });
  recoveryFencedManager.agents.set('agent-recovery-fenced-delete', {
    id: 'agent-recovery-fenced-delete',
    command: 'claude',
    cwd: process.cwd(),
    status: 'running',
    runtimeBinding: { kind: 'acp', state: 'idle' },
  });
  const recoveryFencedDelete = recoveryFencedManager.killAgent('agent-recovery-fenced-delete');
  await Promise.resolve();
  assert.strictEqual(
    recoveryFencedCleanupCalls,
    0,
    'external Delete must wait for startup recovery to reach a terminal state',
  );
  releaseRecoveryFence();
  assert.strictEqual((await recoveryFencedDelete).killed, true);
  assert.strictEqual(recoveryFencedCleanupCalls, 1);
  await recoveryFencedManager.dispose();

  const engineFailureAcpRuntime = new FakeStructuredRuntime();
  engineFailureAcpRuntime.dispose = async () => {};
  const engineFailureManager = new AgentManager(configManager(), {
    skipExecutablePreflight: true,
    acpRuntime: engineFailureAcpRuntime,
  });
  let providerDisposeCalls = 0;
  engineFailureManager.providerSessionService.dispose = () => {
    providerDisposeCalls += 1;
  };
  const disposeEngineBridge = engineFailureManager.engineBridge.dispose
    .bind(engineFailureManager.engineBridge);
  engineFailureManager.engineBridge.dispose = async () => {
    throw new Error('Terminal engine teardown failed');
  };
  await assert.rejects(engineFailureManager.dispose(), /Terminal engine teardown failed/);
  assert.strictEqual(engineFailureManager.disposing, true);
  assert.strictEqual(engineFailureManager.disposed, false);
  assert.strictEqual(providerDisposeCalls, 0);
  let frozenStartError = '';
  const frozenStart = await engineFailureManager.startAgent('bash', process.cwd(), (_agentId, error) => {
    frozenStartError = error || '';
  }, { wantsMain: false });
  assert.strictEqual(frozenStart, null);
  assert.match(frozenStartError, /shutting down/i);

  engineFailureManager.engineBridge.dispose = disposeEngineBridge;
  await engineFailureManager.dispose();
  assert.strictEqual(engineFailureManager.disposed, true);
  assert.strictEqual(providerDisposeCalls, 1);

  console.log('test-agent-lifecycle-isolation passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
