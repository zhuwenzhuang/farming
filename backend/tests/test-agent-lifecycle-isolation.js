const assert = require('assert');
const AgentManager = require('../agent-manager');

async function run() {
  const manager = new AgentManager({
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
  }, { skipExecutablePreflight: true });

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
    const conflictingPermissionRestart = await manager.restartAgentWithPermissionMode('agent-lifecycle', 'approve');
    const conflictingArchive = await manager.archiveAgent('agent-lifecycle');
    const conflictingKill = await manager.killAgent('agent-lifecycle');
    const replacementKill = await manager.killAgent('agent-replacement');
    assert.strictEqual(manager.agents.has('agent-lifecycle'), true);
    manager.agents.delete('agent-lifecycle');
    const missingOldIdKill = await manager.killAgent('agent-lifecycle');
    const missingOldIdArchive = await manager.archiveAgent('agent-lifecycle');

    assert.match(conflictingPermissionRestart.error, /lifecycle change already in progress/i);
    assert.match(conflictingArchive.error, /lifecycle change already in progress/i);
    assert.match(conflictingKill.error, /lifecycle change already in progress/i);
    assert.match(replacementKill.error, /lifecycle change already in progress/i);
    assert.match(missingOldIdKill.error, /lifecycle change already in progress/i);
    assert.match(missingOldIdArchive.error, /lifecycle change already in progress/i);
    assert.strictEqual(permissionRestartCalls, 0, 'conflicting lifecycle operation must not start');
    assert.strictEqual(manager.agents.has('agent-lifecycle'), false);

    finishRuntimeSwitch({ restarted: true, restartedAgentId: 'agent-replacement', agentRuntimeMode: 'chat' });
    assert.deepStrictEqual(await runtimeSwitch, await duplicateRuntimeSwitch);
    assert.strictEqual(manager.agentLifecycleOperations.has('agent-replacement'), false);

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
    const pendingStartKill = await manager.killAgent('agent-pending-start');
    const pendingStartArchive = await manager.archiveAgent('agent-pending-start');
    assert.match(pendingStartKill.error, /lifecycle change already in progress/i);
    assert.match(pendingStartArchive.error, /lifecycle change already in progress/i);
    releaseCreateSession();
    assert.strictEqual(await pendingStart, 'agent-pending-start');

    const ensurePersistentAgentSession = manager.ensurePersistentAgentSession;
    manager.ensurePersistentAgentSession = () => {
      throw new Error('session store unavailable');
    };
    let jsonStartError = '';
    const failedJsonStart = await manager.startAgent('codex', process.cwd(), (_agentId, error) => {
      jsonStartError = error || '';
    }, {
      wantsMain: false,
      agentRuntimeMode: 'json',
      runtimeAgentId: 'agent-json-start-failure',
    });
    assert.strictEqual(failedJsonStart, null);
    assert.match(jsonStartError, /session store unavailable/);
    assert.strictEqual(manager.jsonCliRuntime.bindings.has('agent-json-start-failure'), false);
    assert.strictEqual(manager.agents.has('agent-json-start-failure'), false);

    const originalAcpRuntime = manager.acpRuntime;
    let acpCleanupAttempts = 0;
    manager.acpRuntime = {
      async prepareAgent() {
        return { sessionId: 'acp-start-failure-session', historyMode: 'new' };
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
    manager.acpRuntime.unregisterAgentAndWait = async () => true;
    const uncertainCleanupRetry = await manager.killAgent('agent-acp-start-uncertain');
    assert.strictEqual(uncertainCleanupRetry.killed, true);
    assert.strictEqual(manager.agents.has('agent-acp-start-uncertain'), false);
    manager.acpRuntime = originalAcpRuntime;
    manager.ensurePersistentAgentSession = ensurePersistentAgentSession;

    console.log('test-agent-lifecycle-isolation passed');
  } finally {
    clearInterval(manager.heartbeatInterval);
    await manager.dispose();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
