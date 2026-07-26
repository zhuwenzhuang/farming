const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AgentManager = require('../agent-manager');
const { AcpRuntime } = require('../acp-runtime');
const {
  activeLifecycleOperation,
  beginLifecycleOperation,
  latestLifecycleOperation,
  transitionLifecycleOperation,
} = require('../agent-lifecycle-journal');
const { FarmingSessionStore } = require('../farming-session-store');

function configForStore(store, workspace) {
  return {
    farmingDir: store.configDir,
    getWorkspace: () => workspace,
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
    getCodingAgentEngine: () => 'local',
    getMainPageSessionKeys: () => store.getMainPageSessionKeys(),
    listAgentSessionRecords: () => store.listAgentRecords(),
    getAgentSessionRecordForProviderSessionKey: key => store.getRecordForProviderSessionKey(key),
    ensureAgentSessionRecord: (agent, patch) => store.ensureRecordForAgent(agent, patch),
    rememberAgentSessionRecord: agent => store.rememberAgent(agent),
    removeMainPageSessionKeys: keys => store.removeMainPageSessionKeys(keys),
  };
}

async function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-delete-journal-'));
  const store = new FarmingSessionStore(configDir);
  store.init();
  const sessionId = '77777777-7777-4777-8777-777777777777';
  const sessionKey = `agent-session:claude:${sessionId}`;
  const agent = {
    id: 'agent-delete-recovery',
    command: 'claude',
    forkCommand: 'claude',
    cwd: configDir,
    projectWorkspace: configDir,
    status: 'running',
    engineName: 'native',
    category: 'coding',
    source: `claude-history:${sessionId}`,
    providerSessionProvider: 'claude',
    providerHomeId: 'default',
    providerSessionId: sessionId,
    providerSessionKey: sessionKey,
    providerSessionTemporary: false,
    runtimeBinding: { kind: 'acp', state: 'idle' },
  };

  const firstRuntime = new AcpRuntime();
  firstRuntime.unregisterAgentAndWait = async () => {
    throw new Error('ACP process exit proof unavailable');
  };
  const firstManager = new AgentManager(configForStore(store, configDir), {
    acpRuntime: firstRuntime,
    skipExecutablePreflight: true,
  });
  try {
    await firstManager.whenRecovered();
    agent.persistentSessionId = store.rememberAgent(agent);
    firstManager.agents.set(agent.id, agent);
    firstManager.lastActivity.set(agent.id, Date.now());

    const result = await firstManager.killAgent(agent.id);
    assert.strictEqual(result.cleanupUncertain, true);
    const persisted = store.readRecord(agent.persistentSessionId);
    const operation = activeLifecycleOperation(persisted);
    assert.strictEqual(operation.type, 'delete');
    assert.strictEqual(operation.state, 'blocked');
  } finally {
    await firstManager.dispose();
  }

  const exitedProcessAgent = {
    ...agent,
    id: 'agent-delete-exited-process',
    providerSessionId: '66666666-6666-4666-8666-666666666666',
    providerSessionKey: 'agent-session:claude:66666666-6666-4666-8666-666666666666',
    persistentSessionId: '',
    lifecycleJournal: undefined,
    structuredRuntimeProcess: {
      kind: 'acp-process-group',
      pid: 99_999_999,
      processGroupId: 99_999_999,
      startedAt: 'Thu Jan  1 00:00:00 1970',
    },
  };
  const exitedDelete = beginLifecycleOperation(
    exitedProcessAgent,
    'delete',
    'delete',
    {
      reason: 'manual-kill',
      structuredProcessProofRequired: true,
    },
  );
  transitionLifecycleOperation(
    exitedProcessAgent,
    exitedDelete.operation.id,
    'blocked',
    'server stopped before metadata commit',
  );
  exitedProcessAgent.persistentSessionId = store.rememberAgent(exitedProcessAgent);

  const legacyAcpAgent = {
    ...agent,
    id: 'agent-legacy-acp-upgrade',
    persistentSessionId: '',
    providerSessionId: '55555555-5555-4555-8555-555555555555',
    providerSessionKey: 'agent-session:claude:55555555-5555-4555-8555-555555555555',
    structuredRuntimeProcess: null,
    lifecycleJournal: undefined,
  };
  legacyAcpAgent.persistentSessionId = store.rememberAgent(legacyAcpAgent);

  const recoveredStore = new FarmingSessionStore(configDir);
  recoveredStore.init();
  const recoveredRuntime = new AcpRuntime();
  let prepareCalls = 0;
  recoveredRuntime.prepareAgent = async () => {
    prepareCalls += 1;
    throw new Error('blocked Delete must not launch ACP');
  };
  const recoveredManager = new AgentManager(configForStore(recoveredStore, configDir), {
    acpRuntime: recoveredRuntime,
    allowUnprovenLegacyAcpRecovery: false,
    skipExecutablePreflight: true,
    stopPersistedAcpProcessGroup: async identity => (
      identity
        ? { stopped: true, alreadyExited: true }
        : { stopped: false, missingProof: true }
    ),
  });
  try {
    await recoveredManager.whenRecovered();
    assert.strictEqual(prepareCalls, 0);
    const recovered = recoveredManager.agents.get(agent.id);
    assert(recovered, 'blocked Delete must remain visible for recovery');
    assert.strictEqual(recovered.status, 'error');
    assert.strictEqual(recovered.engineStatus, 'lifecycle-blocked');
    assert.match(recovered.runtimeBinding.error, /delete operation/i);
    const exitedProcessRecord = recoveredStore.readRecord(exitedProcessAgent.persistentSessionId);
    assert.strictEqual(latestLifecycleOperation(exitedProcessRecord).state, 'succeeded');
    assert.strictEqual(exitedProcessRecord.runtimeAgentId, '');
    assert.strictEqual(
      recoveredManager.agents.has(exitedProcessAgent.id),
      false,
      'a proven-exited ACP process must let Delete finish during recovery',
    );
    const recoveredLegacyAcp = recoveredManager.agents.get(legacyAcpAgent.id);
    assert(recoveredLegacyAcp, 'legacy ACP metadata must remain visible after a fail-closed upgrade');
    assert.strictEqual(recoveredLegacyAcp.engineStatus, 'cleanup-uncertain');
    assert.strictEqual(recoveredLegacyAcp.requiresProcessExitAcknowledgement, true);
    const unacknowledgedLegacyDelete = await recoveredManager.killAgent(legacyAcpAgent.id);
    assert.strictEqual(unacknowledgedLegacyDelete.cleanupUncertain, true);
    assert.strictEqual(recoveredManager.agents.has(legacyAcpAgent.id), true);

    const successfulAgent = {
      ...agent,
      id: 'agent-delete-success',
      persistentSessionId: '',
      providerSessionId: '88888888-8888-4888-8888-888888888888',
      providerSessionKey: 'agent-session:claude:88888888-8888-4888-8888-888888888888',
      runtimeBinding: { kind: 'acp', state: 'idle' },
      lifecycleJournal: undefined,
    };
    successfulAgent.persistentSessionId = recoveredStore.rememberAgent(successfulAgent);
    recoveredManager.agents.set(successfulAgent.id, successfulAgent);
    let releaseDelete;
    recoveredRuntime.unregisterAgentAndWait = async () => new Promise(resolve => {
      releaseDelete = () => resolve(true);
    });
    const requestedDelete = await recoveredManager.requestKillAgent(successfulAgent.id);
    assert.strictEqual(requestedDelete.result.accepted, true);
    assert.match(requestedDelete.result.operationId, /^aop_/);
    assert.strictEqual(
      activeLifecycleOperation(recoveredStore.readRecord(successfulAgent.persistentSessionId)).state,
      'pending',
      'Delete intent must be durable before the asynchronous cleanup completes',
    );
    releaseDelete();
    const deleted = await requestedDelete.completion;
    assert.strictEqual(deleted.killed, true);
    assert.strictEqual(recoveredManager.agents.has(successfulAgent.id), false);
    const deletedRecord = recoveredStore.readRecord(successfulAgent.persistentSessionId);
    assert.strictEqual(latestLifecycleOperation(deletedRecord).state, 'succeeded');
    assert.strictEqual(deletedRecord.visibleOnMainPage, undefined);
    assert.strictEqual(deletedRecord.runtimeAgentId, '');
    assert.strictEqual(
      recoveredStore.getMainPageSessionKeys().includes(successfulAgent.providerSessionKey),
      false,
    );
    const duplicateDelete = await recoveredManager.killAgent(successfulAgent.id);
    assert.strictEqual(duplicateDelete.killed, true);
    assert.strictEqual(duplicateDelete.missing, true);

    const pendingCreateAgent = {
      ...successfulAgent,
      id: 'agent-pending-create-delete',
      persistentSessionId: '',
      providerSessionId: '99999999-9999-4999-8999-999999999999',
      providerSessionKey: 'agent-session:claude:99999999-9999-4999-8999-999999999999',
      lifecycleJournal: undefined,
      runtimeBinding: { kind: 'acp', state: 'idle' },
    };
    const pendingCreate = beginLifecycleOperation(
      pendingCreateAgent,
      'create',
      'create-request:pending-create-delete',
      { agentId: pendingCreateAgent.id, runtimeKind: 'acp' },
    );
    pendingCreateAgent.persistentSessionId = recoveredStore.rememberAgent(pendingCreateAgent);
    recoveredManager.agents.set(pendingCreateAgent.id, pendingCreateAgent);
    recoveredRuntime.unregisterAgentAndWait = async () => true;
    const pendingCreateDelete = await recoveredManager.requestKillAgent(pendingCreateAgent.id);
    assert.strictEqual(pendingCreateDelete.result.operationType, 'delete');
    assert.notStrictEqual(
      pendingCreateDelete.result.operationId,
      pendingCreate.operation.id,
      'Delete admission must return the Delete operation, not the superseded Create operation',
    );
    const pendingCreateDeleted = await pendingCreateDelete.completion;
    assert.strictEqual(pendingCreateDeleted.killed, true);
    const pendingCreateDeletedRecord = recoveredStore.readRecord(
      pendingCreateAgent.persistentSessionId,
    );
    const pendingCreateEntries = pendingCreateDeletedRecord.lifecycleJournal.entries;
    assert.strictEqual(pendingCreateEntries.at(-2).type, 'create');
    assert.strictEqual(pendingCreateEntries.at(-2).state, 'cancelled');
    assert.strictEqual(pendingCreateEntries.at(-1).type, 'delete');
    assert.strictEqual(pendingCreateEntries.at(-1).state, 'succeeded');
  } finally {
    await recoveredManager.dispose();
  }

  const restartedStore = new FarmingSessionStore(configDir);
  restartedStore.init();
  const restartedManager = new AgentManager(configForStore(restartedStore, configDir), {
    acpRuntime: new AcpRuntime(),
    allowUnprovenLegacyAcpRecovery: false,
    skipExecutablePreflight: true,
    stopPersistedAcpProcessGroup: async identity => (
      identity
        ? { stopped: true, alreadyExited: true }
        : { stopped: false, missingProof: true }
    ),
  });
  try {
    await restartedManager.whenRecovered();
    const restartedLegacyAcp = restartedManager.agents.get(legacyAcpAgent.id);
    assert(restartedLegacyAcp, 'blocked legacy Delete must remain visible after another restart');
    assert.strictEqual(
      restartedLegacyAcp.requiresProcessExitAcknowledgement,
      true,
      'restart must re-derive the operator acknowledgement requirement from durable metadata',
    );
    const acknowledgedLegacyDelete = await restartedManager.killAgent(
      legacyAcpAgent.id,
      { acknowledgeUnprovenAcpExit: true },
    );
    assert.strictEqual(acknowledgedLegacyDelete.killed, true);
    assert.strictEqual(restartedManager.agents.has(legacyAcpAgent.id), false);
    const acknowledgedLegacyRecord = restartedStore.readRecord(legacyAcpAgent.persistentSessionId);
    assert.strictEqual(latestLifecycleOperation(acknowledgedLegacyRecord).state, 'succeeded');
    assert.strictEqual(typeof acknowledgedLegacyRecord.legacyAcpProcessExitAcknowledgedAt, 'number');
  } finally {
    await restartedManager.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  console.log('agent Delete journal blocks unsafe ACP restart');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
