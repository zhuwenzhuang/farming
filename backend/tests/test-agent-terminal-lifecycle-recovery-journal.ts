const assert = require('assert');
const { encodeProviderSessionKey } = require('../../shared/provider-session-identity.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentManager } = require('../agent-manager.cjs');
const { createTestAgentManager } = require('./helpers/test-acp-runtime.ts');
const {
  activeLifecycleOperation,
  beginLifecycleOperation,
  latestLifecycleOperation,
  transitionLifecycleOperation,
} = require('../agent-lifecycle-journal.cjs');
const { FarmingSessionStore } = require('../farming-session-store.cjs');
const { forkRequestSignature } = require('../fork-operation-coordinator.cjs');

function configForStore(store, workspace) {
  return {
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

type TerminalAgentFixture = {
  id: string;
  command: string;
  forkCommand: string;
  forkRequestId?: string;
  forkRequestSignature?: string;
  cwd: string;
  projectWorkspace: string;
  status: string;
  engineName: string;
  category: string;
  source: string;
  runtimeBinding: { kind: string };
  providerSessionProvider?: string;
  providerHomeId?: string;
  providerSessionId?: string;
  providerSessionKey?: string;
  providerSessionTemporary?: boolean;
  persistentSessionId?: string;
  customTitle?: string;
  lifecycleJournal?: {
    entries: Array<{ request: Record<string, unknown> }>;
  };
};

function terminalAgent(id: string, workspace: string, operationType: string): TerminalAgentFixture {
  const agent: TerminalAgentFixture = {
    id,
    command: 'bash',
    forkCommand: 'bash',
    cwd: workspace,
    projectWorkspace: workspace,
    status: 'running',
    engineName: 'native',
    category: 'shell',
    source: 'ui',
    runtimeBinding: { kind: 'terminal' },
  };
  beginLifecycleOperation(
    agent,
    operationType,
    operationType,
    { command: 'bash', cwd: workspace, runtimeKind: 'terminal' },
  );
  return agent;
}

async function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-terminal-lifecycle-recovery-'));
  const store = new FarmingSessionStore(configDir);
  store.init();
  const liveCreate = terminalAgent('agent-live-create', configDir, 'create');
  const liveDelete = terminalAgent('agent-live-delete', configDir, 'delete');
  const committedCreate = terminalAgent('agent-committed-create', configDir, 'create');
  committedCreate.providerSessionProvider = 'claude';
  committedCreate.providerHomeId = 'default';
  committedCreate.providerSessionId = '66666666-6666-4666-8666-666666666666';
  committedCreate.providerSessionKey = encodeProviderSessionKey('claude', committedCreate.providerSessionId, 'default');
  committedCreate.providerSessionTemporary = false;
  committedCreate.forkRequestId = 'persisted-fork-request';
  committedCreate.forkRequestSignature = 'a'.repeat(64);
  transitionLifecycleOperation(
    committedCreate,
    activeLifecycleOperation(committedCreate).id,
    'membership-pending',
  );
  const missingCreate = terminalAgent('agent-missing-create', configDir, 'create');
  const missingDelete = terminalAgent('agent-missing-delete', configDir, 'delete');
  const missingUpdate = {
    ...terminalAgent('agent-missing-update', configDir, 'update'),
    customTitle: 'Old title',
  };
  missingUpdate.lifecycleJournal.entries.at(-1).request = { customTitle: 'Recovered title' };
  for (const agent of [
    liveCreate,
    liveDelete,
    committedCreate,
    missingCreate,
    missingDelete,
    missingUpdate,
  ]) {
    agent.persistentSessionId = store.ensureRecordForAgent(agent, {
      visibleOnMainPage: true,
      archived: false,
    });
  }

  const manager = createTestAgentManager(AgentManager, configForStore(store, configDir), {
    skipExecutablePreflight: true,
  });
  const originalEngineBridge = manager.engineBridge;
  await originalEngineBridge.dispose();
  const liveRuntimeIds = new Set([liveCreate.id, liveDelete.id, committedCreate.id]);
  const killed = [];
  const metadataUpdates = [];
  const engine = {
    async killSession(agentId) {
      killed.push(agentId);
      liveRuntimeIds.delete(agentId);
    },
    async getSessionState(agentId) {
      return liveRuntimeIds.has(agentId) ? { status: 'running' } : null;
    },
    async updateSessionMetadata(_agentId, patch) {
      metadataUpdates.push(patch);
    },
  };
  manager.engineBridge = {
    async recoverSessions() {
      return [liveCreate, liveDelete, committedCreate].map(agent => ({
        engineName: 'native',
        agentId: agent.id,
        metadata: {
          agentId: agent.id,
          command: agent.command,
          cwd: agent.cwd,
          category: agent.category,
          source: agent.source,
          forkRequestId: 'stale-host-request',
          forkRequestSignature: 'b'.repeat(64),
        },
        state: { status: 'running', startedAt: 1000 },
      }));
    },
    consumeRuntimeRotations: () => [],
    getEngine: () => engine,
    killSession: async (_engineName, agentId) => engine.killSession(agentId),
    dispose: async () => {},
  };

  try {
    await manager.recoverEngineSessions();

    const recoveredCreate = manager.agents.get(liveCreate.id);
    assert(recoveredCreate, 'a live pending Create must recover as the same Agent');
    assert.strictEqual(activeLifecycleOperation(recoveredCreate), null);
    assert.strictEqual(latestLifecycleOperation(recoveredCreate).state, 'succeeded');

    assert(
      manager.agents.has(committedCreate.id),
      'a runtime-confirmed Create must survive the membership-index crash window',
    );
    const recoveredCommittedCreate = manager.agents.get(committedCreate.id);
    assert.strictEqual(recoveredCommittedCreate.forkRequestId, 'persisted-fork-request');
    assert.strictEqual(recoveredCommittedCreate.forkRequestSignature, 'a'.repeat(64));
    manager.updateEngineProviderSessionMetadata(recoveredCommittedCreate);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(metadataUpdates.at(-1).forkRequestId, 'persisted-fork-request');
    assert.strictEqual(metadataUpdates.at(-1).forkRequestSignature, 'a'.repeat(64));
    assert(
      store.getMainPageSessionKeys().includes(committedCreate.providerSessionKey),
      'recovery must repair provider membership from committed Create metadata',
    );

    assert.strictEqual(manager.agents.has(liveDelete.id), false);
    assert(killed.includes(liveDelete.id), 'a live pending Delete must resume runtime cleanup');
    const liveDeleteRecord = store.readRecord(liveDelete.persistentSessionId);
    assert.strictEqual(latestLifecycleOperation(liveDeleteRecord).state, 'succeeded');
    assert.strictEqual(liveDeleteRecord.runtimeAgentId, '');

    const missingCreateRecord = store.readRecord(missingCreate.persistentSessionId);
    assert.strictEqual(latestLifecycleOperation(missingCreateRecord).state, 'failed');
    assert.strictEqual(missingCreateRecord.runtimeAgentId, '');

    const missingDeleteRecord = store.readRecord(missingDelete.persistentSessionId);
    assert.strictEqual(latestLifecycleOperation(missingDeleteRecord).state, 'succeeded');
    assert.strictEqual(missingDeleteRecord.runtimeAgentId, '');
    assert.strictEqual(missingDeleteRecord.archived, true);

    const missingUpdateRecord = store.readRecord(missingUpdate.persistentSessionId);
    assert.strictEqual(latestLifecycleOperation(missingUpdateRecord).state, 'succeeded');
    assert.strictEqual(missingUpdateRecord.customTitle, 'Recovered title');
    const missingUpdateAgent = manager.agents.get(missingUpdate.id);
    assert(missingUpdateAgent, 'a detached Update must retain one stopped inventory row');
    assert.strictEqual(missingUpdateAgent.status, 'stopped');
    assert.strictEqual(missingUpdateAgent.engineStatus, 'recovery-failed');
    assert.strictEqual(activeLifecycleOperation(missingUpdateAgent), null);
  } finally {
    await manager.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  console.log('native Terminal lifecycle journal reconciles live and missing runtimes');
}

function forkPendingFixture(
  id: string,
  workspace: string,
  store,
  requestId: string,
  sessionId: string,
) {
  const agent: TerminalAgentFixture = {
    id,
    command: 'bash',
    forkCommand: 'bash',
    cwd: workspace,
    projectWorkspace: workspace,
    status: 'running',
    engineName: 'native',
    category: 'shell',
    source: 'ui',
    runtimeBinding: { kind: 'terminal' },
    providerSessionProvider: 'claude',
    providerHomeId: 'default',
    providerSessionId: sessionId,
    providerSessionKey: encodeProviderSessionKey('claude', sessionId, 'default'),
    providerSessionTemporary: false,
  };
  agent.persistentSessionId = store.ensureRecordForAgent(agent, {
    visibleOnMainPage: false,
    archived: false,
  });
  beginLifecycleOperation(agent, 'fork', `fork-request:${requestId}`, {
    signature: forkRequestSignature(
      { id: agent.id, agentRecordId: agent.persistentSessionId, runtimeBinding: { kind: 'terminal' } },
      'same-worktree',
      {},
    ),
    mode: 'same-worktree',
    sourceRecordId: agent.persistentSessionId,
    sourceRuntimeKind: 'terminal',
    targetRuntime: '',
    expectedRevision: null,
  });
  store.ensureRecordForAgent(agent, {});
  return agent;
}

function engineBridgeForFixture(agents, liveRuntimeIds: Set<string>, killed: string[] = []) {
  const engine = {
    async killSession(agentId) {
      killed.push(agentId);
      liveRuntimeIds.delete(agentId);
    },
    async getSessionState(agentId) {
      return liveRuntimeIds.has(agentId) ? { status: 'running' } : null;
    },
    async updateSessionMetadata() {},
  };
  return {
    async recoverSessions() {
      return agents
        .filter(agent => liveRuntimeIds.has(agent.id))
        .map(agent => ({
          engineName: 'native',
          agentId: agent.id,
          metadata: {
            agentId: agent.id,
            command: agent.command,
            cwd: agent.cwd,
            category: agent.category,
            source: agent.source,
          },
          state: { status: 'running', startedAt: 1000 },
        }));
    },
    consumeRuntimeRotations: () => [],
    getEngine: () => engine,
    killSession: async (_engineName, agentId) => engine.killSession(agentId),
    dispose: async () => {},
  };
}

function assertHiddenForkRecord(store, fixture, expectedState: string) {
  const record = store.readRecord(fixture.persistentSessionId);
  const operation = latestLifecycleOperation(record);
  assert.strictEqual(operation.type, 'fork');
  assert.strictEqual(
    operation.state,
    expectedState,
    `hidden Fork of ${fixture.id} must be durably ${expectedState}`,
  );
  assert.notStrictEqual(
    record.visibleOnMainPage,
    true,
    `hidden Fork source ${fixture.id} must not be promoted to the main page`,
  );
  return operation;
}

async function runHiddenForkRecovery() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-fork-recovery-hidden-'));
  const store = new FarmingSessionStore(configDir);
  store.init();
  const requestId = 'hidden-live-fork-request';
  const hiddenLive = forkPendingFixture(
    'agent-hidden-live-fork', configDir, store, requestId,
    '11111111-1111-4111-8111-111111111111',
  );
  const hiddenMissing = forkPendingFixture(
    'agent-hidden-missing-fork', configDir, store, 'hidden-missing-fork-request',
    '22222222-2222-4222-8222-222222222222',
  );
  assert.deepStrictEqual(store.getMainPageSessionKeys(), []);

  const manager = createTestAgentManager(AgentManager, configForStore(store, configDir), {});
  await manager.engineBridge.dispose();
  const liveRuntimeIds = new Set([hiddenLive.id]);
  const killed: string[] = [];
  manager.engineBridge = engineBridgeForFixture([hiddenLive, hiddenMissing], liveRuntimeIds, killed);
  let startAgentCalls = 0;
  const originalStartAgent = manager.startAgent.bind(manager);
  manager.startAgent = (...args) => {
    startAgentCalls += 1;
    return originalStartAgent(...args);
  };
  let worktreeEffects = 0;
  const originalAllocate = manager.worktreeGitService.allocateTemporaryWorktree
    .bind(manager.worktreeGitService);
  manager.worktreeGitService.allocateTemporaryWorktree = (...args) => {
    worktreeEffects += 1;
    return originalAllocate(...args);
  };

  try {
    await manager.recoverEngineSessions();

    for (const fixture of [hiddenLive, hiddenMissing]) {
      const operation = assertHiddenForkRecord(store, fixture, 'blocked');
      assert.match(operation.error, /interrupted by a restart/);
      const recovered = manager.agents.get(fixture.id);
      assert(recovered, `hidden Fork source ${fixture.id} must be materialized for resolution`);
      assert.strictEqual(recovered.status, 'error');
      assert.strictEqual(recovered.engineStatus, 'lifecycle-blocked');
    }
    assert(
      !killed.includes(hiddenLive.id),
      'a live hidden Fork source PTY must be kept for resolution, not killed',
    );
    assert.deepStrictEqual(
      store.getMainPageSessionKeys(),
      [],
      'recovery must not add hidden Fork sources to the main page membership',
    );
    assert.strictEqual(startAgentCalls, 0, 'hidden Fork recovery must not execute any Fork effect');
    assert.strictEqual(worktreeEffects, 0, 'hidden Fork recovery must not create a Fork worktree');
    assert.strictEqual(store.listAgentRecords().length, 2);

    const replay = await manager.forkAgent(hiddenLive.id, 'same-worktree', { requestId });
    assert.match(replay.error, /will not be replayed automatically/);
    assert.strictEqual(replay.uncertain, true);
    assert.strictEqual(startAgentCalls, 0, 'reconcile of a blocked Fork must not auto-replay');
    assert.strictEqual(store.listAgentRecords().length, 2);
    assertHiddenForkRecord(store, hiddenLive, 'blocked');
    assert.deepStrictEqual(store.getMainPageSessionKeys(), []);

    const archived = await manager.archiveAgent(hiddenLive.id);
    assert.strictEqual(
      archived.error,
      undefined,
      `Archive must supersede the hidden live Fork source: ${archived.error}`,
    );
    const archiveOperation = latestLifecycleOperation(store.readRecord(hiddenLive.persistentSessionId));
    assert.strictEqual(archiveOperation.type, 'archive');
    assert.strictEqual(archiveOperation.state, 'succeeded');

    const deleted = await manager.killAgent(hiddenMissing.id);
    assert.strictEqual(
      deleted.error,
      undefined,
      `Delete must supersede the hidden missing-runtime Fork source: ${deleted.error}`,
    );
    const deletedRecord = store.readRecord(hiddenMissing.persistentSessionId);
    const deleteOperation = latestLifecycleOperation(deletedRecord);
    assert.strictEqual(deleteOperation.type, 'delete');
    assert.strictEqual(deleteOperation.state, 'succeeded');
    assert.strictEqual(deletedRecord.runtimeAgentId, '');
    assert.strictEqual(startAgentCalls, 0);
  } finally {
    await manager.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  console.log('hidden Terminal Fork sources recover as blocked and stay resolvable');
}

async function runMissingCreatePersistFailure() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-terminal-create-recovery-fail-'));
  const store = new FarmingSessionStore(configDir);
  store.init();
  const missingCreate = terminalAgent('agent-missing-create-persist-fail', configDir, 'create');
  missingCreate.persistentSessionId = store.ensureRecordForAgent(missingCreate, {
    visibleOnMainPage: true,
    archived: false,
  });
  const config = configForStore(store, configDir);
  const originalEnsure = config.ensureAgentSessionRecord;
  config.ensureAgentSessionRecord = (agent, patch) => {
    if (agent?.id === missingCreate.id) {
      throw new Error('simulated missing Create recovery persistence failure');
    }
    return originalEnsure(agent, patch);
  };
  const manager = createTestAgentManager(AgentManager, config, {});
  await manager.engineBridge.dispose();
  manager.engineBridge = engineBridgeForFixture([missingCreate], new Set());

  try {
    await manager.recoverEngineSessions();
    const failed = manager.agents.get(missingCreate.id);
    assert(failed, 'a missing Create persistence failure must retain a resolvable Agent row');
    assert.strictEqual(failed.status, 'error');
    assert.strictEqual(failed.engineStatus, 'lifecycle-blocked');
    assert.match(failed.output || '', /persistence failure/);
    assert.strictEqual(
      activeLifecycleOperation(store.readRecord(missingCreate.persistentSessionId)).state,
      'pending',
      'failed durable reconciliation must not claim that the Create outcome was committed',
    );
  } finally {
    await manager.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  console.log('missing Terminal Create persistence failure leaves an explicit blocked row');
}

async function runHiddenForkPersistFailure() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-fork-hidden-persist-fail-'));
  const store = new FarmingSessionStore(configDir);
  store.init();
  const requestId = 'hidden-fork-persist-fail';
  const hiddenMissing = forkPendingFixture(
    'agent-hidden-fork-persist-fail', configDir, store, requestId,
    '33333333-3333-4333-8333-333333333333',
  );

  const config = configForStore(store, configDir);
  const originalEnsure = config.ensureAgentSessionRecord;
  let remainingPersistFailures = 1;
  config.ensureAgentSessionRecord = (agent, patch) => {
    if (remainingPersistFailures > 0 && agent?.id === hiddenMissing.id) {
      remainingPersistFailures -= 1;
      throw new Error('simulated hidden fork block persistence failure');
    }
    return originalEnsure(agent, patch);
  };

  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);
  const manager = createTestAgentManager(AgentManager, config, {});
  await manager.engineBridge.dispose();
  manager.engineBridge = engineBridgeForFixture([hiddenMissing], new Set());
  let startAgentCalls = 0;
  const originalStartAgent = manager.startAgent.bind(manager);
  manager.startAgent = (...args) => {
    startAgentCalls += 1;
    return originalStartAgent(...args);
  };

  const warnings: string[] = [];
  const originalWarn = console.warn;
  try {
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      await manager.recoverEngineSessions();
    } finally {
      console.warn = originalWarn;
    }
    await new Promise(resolve => setImmediate(resolve));

    assertHiddenForkRecord(store, hiddenMissing, 'pending');
    assert.deepStrictEqual(store.getMainPageSessionKeys(), []);
    const recovered = manager.agents.get(hiddenMissing.id);
    assert(recovered, 'the hidden Fork source must still be materialized fail closed');
    assert.strictEqual(recovered.status, 'error');
    assert.strictEqual(recovered.engineStatus, 'lifecycle-blocked');
    assert.strictEqual(startAgentCalls, 0);
    assert(
      warnings.some(entry => entry.includes('simulated hidden fork block persistence failure')),
      `the persistence failure must stay observable: ${JSON.stringify(warnings)}`,
    );

    const replay = await manager.forkAgent(hiddenMissing.id, 'same-worktree', { requestId });
    assert.match(replay.error, /will not be replayed automatically/);
    assertHiddenForkRecord(store, hiddenMissing, 'blocked');
    const deleted = await manager.killAgent(hiddenMissing.id);
    assert.strictEqual(deleted.error, undefined);
    assert.strictEqual(
      latestLifecycleOperation(store.readRecord(hiddenMissing.persistentSessionId)).state,
      'succeeded',
    );
    assert.deepStrictEqual(unhandledRejections, []);
  } finally {
    console.warn = originalWarn;
    process.off('unhandledRejection', onUnhandledRejection);
    await manager.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  console.log('hidden Fork persistence failure stays fail closed and heals on reconcile');
}

async function main() {
  await run();
  await runMissingCreatePersistFailure();
  await runHiddenForkRecovery();
  await runHiddenForkPersistFailure();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
