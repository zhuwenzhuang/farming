const assert = require('assert');
const { encodeProviderSessionKey } = require('../../shared/provider-session-identity.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentManager } = require('../agent-manager.cjs');
const { AcpRuntime } = require('../acp-runtime.cjs');
const {
  beginLifecycleOperation,
  latestLifecycleOperation,
} = require('../agent-lifecycle-journal.cjs');
const { FarmingSessionStore } = require('../farming-session-store.cjs');
const { forkRequestSignature } = require('../fork-operation-coordinator.cjs');

function configForStore(store, workspace) {
  return {
    farmingDir: store.configDir,
    getWorkspace: () => workspace,
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
    getCodingAgentEngine: () => 'local',
    getMainPageSessionKeys: () => store.getMainPageSessionKeys(),
    listAgentSessionRecords: () => store.listAgentRecords(),
    ensureAgentSessionRecord: (agent, patch) => store.ensureRecordForAgent(agent, patch),
    rememberAgentSessionRecord: agent => store.rememberAgent(agent),
    removeMainPageSessionKeys: keys => store.removeMainPageSessionKeys(keys),
  };
}

async function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-persisted-recovery-intent-'));
  const store = new FarmingSessionStore(configDir);
  store.init();
  const sessionId = '55555555-5555-4555-8555-555555555555';
  const sessionKey = encodeProviderSessionKey('claude', sessionId, 'default');
  const agent = {
    id: 'agent-closed-claude',
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
    customTitle: '',
  };
  const firstRuntime = new AcpRuntime();
  firstRuntime.unregisterAgentAndWait = async () => true;
  const firstManager = new AgentManager(
    configForStore(store, configDir),
    { acpRuntime: firstRuntime, skipExecutablePreflight: true },
  );
  firstManager.engineBridge.getEngine = () => ({
    killSession: async () => {},
    getSessionState: async () => null,
  });

  try {
    await firstManager.recoveryGate.wait();
    store.rememberAgent(agent);
    firstManager.agents.set(agent.id, agent);
    firstManager.activityTracker.record(agent.id);
    firstManager.renameAgent(agent.id, 'Persisted Claude name');
    assert.strictEqual(
      store.listAgentRecords().find(record => record.providerSessionKey === sessionKey).customTitle,
      'Persisted Claude name',
      'rename must be written to the real Farming session store',
    );

    const archived = await firstManager.archiveAgent(agent.id);
    assert.strictEqual(archived.error, undefined);
    assert.deepStrictEqual(store.getMainPageSessionKeys(), []);
    const hiddenRecord = store.listAgentRecords().find(record => record.providerSessionKey === sessionKey);
    assert.strictEqual(hiddenRecord.visibleOnMainPage, undefined);
    assert.strictEqual(hiddenRecord.customTitle, 'Persisted Claude name');
  } finally {
    await firstManager.dispose();
  }

  const recoveredStore = new FarmingSessionStore(configDir);
  recoveredStore.init();
  assert.deepStrictEqual(recoveredStore.getMainPageSessionKeys(), []);
  assert.strictEqual(
    recoveredStore.listAgentRecords().find(record => record.providerSessionKey === sessionKey).customTitle,
    'Persisted Claude name',
    'a fresh session store must read the renamed title from disk',
  );

  const recoveredRuntime = new AcpRuntime();
  const recoveredManager = new AgentManager(
    configForStore(recoveredStore, configDir),
    { acpRuntime: recoveredRuntime, skipExecutablePreflight: true },
  );
  try {
    await recoveredManager.recoveryGate.wait();
    assert.strictEqual(
      recoveredManager.agents.has(agent.id),
      false,
      'a fresh manager must not restore a Claude session removed from persisted main-page metadata',
    );
    assert.strictEqual(recoveredRuntime.bindings.has(agent.id), false);
  } finally {
    await recoveredManager.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  console.log('✓ Persisted main-page metadata controls Claude recovery and rename survives storage');
}

function acpForkPendingFixture(id: string, sessionId: string, workspace: string, store, requestId: string) {
  const sessionKey = encodeProviderSessionKey('claude', sessionId, 'default');
  const agent = {
    id,
    command: 'claude',
    forkCommand: 'claude',
    cwd: workspace,
    projectWorkspace: workspace,
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
    persistentSessionId: '',
    lifecycleJournal: undefined,
  };
  agent.persistentSessionId = store.ensureRecordForAgent(agent, { archived: false });
  beginLifecycleOperation(agent, 'fork', `fork-request:${requestId}`, {
    signature: forkRequestSignature(
      { id: agent.id, agentRecordId: agent.persistentSessionId, runtimeBinding: { kind: 'acp' } },
      'same-worktree',
      { expectedRevision: 7, targetRuntime: 'chat' },
    ),
    mode: 'same-worktree',
    sourceRecordId: agent.persistentSessionId,
    sourceRuntimeKind: 'acp',
    targetRuntime: 'chat',
    expectedRevision: 7,
  });
  store.ensureRecordForAgent(agent, {});
  return agent;
}

function strictColdAcpRuntime() {
  const runtime = new AcpRuntime();
  runtime.prepareCalls = 0;
  runtime.prepareAgent = async () => {
    runtime.prepareCalls += 1;
    throw new Error('unexpected ACP cold start for a Fork-blocked source');
  };
  runtime.unregisterAgentAndWait = async () => true;
  return runtime;
}

function stubEngineBridge(manager) {
  manager.engineBridge.getEngine = () => ({
    killSession: async () => {},
    getSessionState: async () => null,
  });
}

async function runAcpForkRecoveryBlocks() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-fork-recovery-blocked-'));
  const store = new FarmingSessionStore(configDir);
  store.init();
  const requestId = 'restart-acp-fork-request';
  const sessionId = '77777777-7777-4777-8777-777777777777';
  const source = acpForkPendingFixture('agent-acp-fork-pending', sessionId, configDir, store, requestId);
  assert.deepStrictEqual(
    store.getMainPageSessionKeys(),
    [],
    'the ACP Fork source must stay off the main page so recovery is driven by the blocker alone',
  );

  const runtime = strictColdAcpRuntime();
  const manager = new AgentManager(configForStore(store, configDir), { acpRuntime: runtime });
  stubEngineBridge(manager);
  try {
    await manager.recoveryGate.wait();

    const persisted = store.listAgentRecords()
      .find(record => record.providerSessionKey === source.providerSessionKey);
    const persistedOperation = latestLifecycleOperation(persisted);
    assert.strictEqual(persistedOperation.type, 'fork');
    assert.strictEqual(
      persistedOperation.state,
      'blocked',
      'restart must persist a pending ACP conversation Fork as blocked',
    );
    assert.match(persistedOperation.error, /interrupted by a restart/);
    assert.strictEqual(runtime.prepareCalls, 0, 'a Fork-blocked ACP source must not cold start');
    assert.strictEqual(store.listAgentRecords().length, 1);
    assert.strictEqual(manager.agents.size, 1);

    const recovered = manager.agents.get(source.id);
    assert(recovered, 'the Fork source must be materialized for resolution');
    assert.strictEqual(recovered.status, 'error');
    assert.strictEqual(recovered.engineStatus, 'lifecycle-blocked');
    assert.strictEqual(
      recovered.runtimeBinding.state,
      'error',
      'a blocked Fork source must not present as a normally recovered ACP Agent',
    );

    const replay = await manager.forkAgent(source.id, 'same-worktree', {
      requestId,
      targetRuntime: 'chat',
      expectedRevision: 7,
    });
    assert.match(replay.error, /will not be replayed automatically/);
    assert.strictEqual(replay.uncertain, true);
    assert.strictEqual(runtime.prepareCalls, 0, 'reconcile must not auto-replay the ACP Fork');
    assert.strictEqual(store.listAgentRecords().length, 1);

    const archived = await manager.archiveAgent(source.id);
    assert.strictEqual(
      archived.error,
      undefined,
      `Archive must supersede a recovery-blocked ACP Fork: ${archived.error}`,
    );
    const archivedRecord = store.listAgentRecords()
      .find(record => record.providerSessionKey === source.providerSessionKey);
    const archiveOperation = latestLifecycleOperation(archivedRecord);
    assert.strictEqual(archiveOperation.type, 'archive');
    assert.strictEqual(archiveOperation.state, 'succeeded');
  } finally {
    await manager.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  console.log('✓ Restart blocks a pending ACP conversation Fork without cold start or replay');
}

async function runAcpForkRecoveryPersistFailure() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-fork-persist-fail-'));
  const store = new FarmingSessionStore(configDir);
  store.init();
  const requestId = 'restart-acp-fork-persist-fail';
  const sessionId = '88888888-8888-4888-8888-888888888888';
  const source = acpForkPendingFixture('agent-acp-fork-persist-fail', sessionId, configDir, store, requestId);

  const config = configForStore(store, configDir);
  const originalEnsure = config.ensureAgentSessionRecord;
  let remainingPersistFailures = 1;
  config.ensureAgentSessionRecord = (agent, patch) => {
    if (remainingPersistFailures > 0 && agent?.id === source.id) {
      remainingPersistFailures -= 1;
      throw new Error('simulated ACP fork block persistence failure');
    }
    return originalEnsure(agent, patch);
  };

  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  const runtime = strictColdAcpRuntime();
  let manager;
  try {
    manager = new AgentManager(config, { acpRuntime: runtime });
    stubEngineBridge(manager);
    await manager.recoveryGate.wait();
  } finally {
    console.warn = originalWarn;
  }
  try {
    await new Promise(resolve => setImmediate(resolve));

    const persisted = store.listAgentRecords()
      .find(record => record.providerSessionKey === source.providerSessionKey);
    const persistedOperation = latestLifecycleOperation(persisted);
    assert.strictEqual(persistedOperation.type, 'fork');
    assert.strictEqual(
      persistedOperation.state,
      'pending',
      'a failed blocked-transition persist must keep the pending journal truth',
    );
    assert.strictEqual(runtime.prepareCalls, 0, 'a pending Fork must still block ACP cold start');
    const recovered = manager.agents.get(source.id);
    assert(recovered, 'the Fork source must still be materialized');
    assert.strictEqual(recovered.status, 'error');
    assert.strictEqual(recovered.engineStatus, 'lifecycle-blocked');
    assert(
      warnings.some(entry => entry.includes('simulated ACP fork block persistence failure')),
      `the persistence failure must stay observable: ${JSON.stringify(warnings)}`,
    );

    const replay = await manager.forkAgent(source.id, 'same-worktree', {
      requestId,
      targetRuntime: 'chat',
      expectedRevision: 7,
    });
    assert.match(replay.error, /will not be replayed automatically/);
    assert.strictEqual(
      latestLifecycleOperation(
        store.listAgentRecords()
          .find(record => record.providerSessionKey === source.providerSessionKey),
      ).state,
      'blocked',
      'the next reconcile must durably block the operation once persistence recovers',
    );
    assert.deepStrictEqual(unhandledRejections, []);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    await manager?.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  console.log('✓ ACP recovery keeps pending Fork truth and fails closed when blocking cannot persist');
}

async function main() {
  await run();
  await runAcpForkRecoveryBlocks();
  await runAcpForkRecoveryPersistFailure();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
