const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentManager } = require('../agent-manager.cjs');
const { AcpRuntime } = require('../acp-runtime.cjs');
const { resolveFarmingOwnedExecutable } = require('../executable-discovery.cjs');
const {
  activeLifecycleOperation,
  beginLifecycleOperation,
  latestLifecycleOperation,
  lifecycleJournal,
  transitionLifecycleOperation,
} = require('../agent-lifecycle-journal.cjs');
const { FarmingSessionStore } = require('../farming-session-store.cjs');
const { canonicalProviderSessionKey } = require('../../shared/provider-session-identity.js');

const PERSISTED_CLAUDE_EXECUTABLE = resolveFarmingOwnedExecutable('claude');
assert(path.isAbsolute(PERSISTED_CLAUDE_EXECUTABLE));

function configForStore(store, workspace, ensureAgentSessionRecord?) {
  return {
    farmingDir: store.configDir,
    getWorkspace: () => workspace,
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
    getCodingAgentEngine: () => 'local',
    getDangerouslySkipAgentPermissionsByDefault: () => false,
    getMainPageSessionKeys: () => store.getMainPageSessionKeys(),
    listAgentSessionRecords: () => store.listAgentRecords(),
    getAgentSessionRecordForProviderSessionKey: key => store.getRecordForProviderSessionKey(key),
    ensureAgentSessionRecord: ensureAgentSessionRecord
      || ((agent, patch) => store.ensureRecordForAgent(agent, patch)),
    rememberAgentSessionRecord: agent => store.rememberAgent(agent),
    removeMainPageSessionKeys: keys => store.removeMainPageSessionKeys(keys),
  };
}

interface TestAcpAgent {
  id: string;
  command: string;
  forkCommand: string;
  cwd: string;
  projectWorkspace: string;
  status: string;
  engineName: string;
  category: string;
  source: string;
  providerSessionProvider: string;
  providerHomeId: string;
  providerSessionId: string;
  providerSessionKey: string;
  providerSessionTemporary: boolean;
  acpRuntimeMode: string;
  acpRuntimeExecutable: string;
  runtimeBinding: { kind: string; state: string };
  persistentSessionId?: string;
  customTitle?: string;
}

function acpAgent(id, sessionId, workspace): TestAcpAgent {
  return {
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
    providerSessionKey: `agent-session:claude:${sessionId}`,
    providerSessionTemporary: false,
    acpRuntimeMode: 'managed',
    acpRuntimeExecutable: PERSISTED_CLAUDE_EXECUTABLE,
    runtimeBinding: { kind: 'acp', state: 'idle' },
  };
}

async function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-create-update-journal-'));
  const store = new FarmingSessionStore(configDir);
  store.init();
  const updateAgent = acpAgent(
    'agent-update-recovery',
    '99999999-9999-4999-8999-999999999999',
    configDir,
  );
  updateAgent.persistentSessionId = store.rememberAgent(updateAgent);

  let updateJournalWrites = 0;
  const firstRuntime = new AcpRuntime();
  firstRuntime.prepareAgent = async options => ({
    sessionId: options.sessionId,
    historyMode: 'checkpoint',
  });
  const firstManager = new AgentManager(
    configForStore(store, configDir, (agent, patch) => {
      if (
        agent.id === updateAgent.id
        && latestLifecycleOperation(agent)?.type === 'update'
      ) {
        updateJournalWrites += 1;
        if (updateJournalWrites === 2) throw new Error('simulated crash before Update commit');
      }
      return store.ensureRecordForAgent(agent, patch);
    }),
    {
      acpRuntime: firstRuntime,
      skipExecutablePreflight: true,
      allowUnprovenLegacyAcpRecovery: true,
    },
  );
  try {
    await firstManager.recoveryGate.wait();
    const failedUpdate = firstManager.renameAgent(updateAgent.id, 'Recovered title');
    assert.strictEqual(failedUpdate.retryable, true, JSON.stringify(failedUpdate));
    assert.match(failedUpdate.error, /before Update commit/);
    const pendingRecord = store.readRecord(updateAgent.persistentSessionId);
    assert.strictEqual(activeLifecycleOperation(pendingRecord).type, 'update');
    assert.notStrictEqual(pendingRecord.customTitle, 'Recovered title');
  } finally {
    await firstManager.dispose();
  }

  const createAgent = acpAgent(
    'agent-create-recovery',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    configDir,
  );
  beginLifecycleOperation(
    createAgent,
    'create',
    `create:${createAgent.id}`,
    { command: 'claude', cwd: configDir, runtimeKind: 'acp' },
  );
  createAgent.persistentSessionId = store.rememberAgent(createAgent);

  const blockedFreshCreateAgent = {
    ...acpAgent('agent-fresh-create-cleanup-blocked', '', configDir),
    providerSessionId: '',
    providerSessionKey: '',
    providerSessionTemporary: true,
    providerSessionSource: 'claude-session-id',
    structuredRuntimeProcess: {
      kind: 'acp-process-group',
      pid: 4321,
      processGroupId: 4321,
      startedAt: 'persisted-start',
    },
  };
  beginLifecycleOperation(
    blockedFreshCreateAgent,
    'create',
    'create-request:fresh-cleanup-blocked',
    {
      agentId: blockedFreshCreateAgent.id,
      command: 'claude',
      cwd: configDir,
      runtimeKind: 'acp',
      structuredProcessProofRequired: true,
      structuredProcessStartGated: true,
    },
  );
  blockedFreshCreateAgent.persistentSessionId = store.ensureRecordForAgent(
    blockedFreshCreateAgent,
    { visibleOnMainPage: true, archived: false },
  );

  const recoveredRuntime = new AcpRuntime();
  const preparedAgentIds = [];
  let freshSessionSequence = 0;
  recoveredRuntime.prepareAgent = async options => {
    preparedAgentIds.push(options.agentId);
    freshSessionSequence += 1;
    return {
      sessionId: options.sessionId || `cccccccc-cccc-4ccc-8ccc-${String(freshSessionSequence).padStart(12, '0')}`,
      historyMode: 'checkpoint',
    };
  };
  const recoveredManager = new AgentManager(
    configForStore(store, configDir),
    {
      acpRuntime: recoveredRuntime,
      skipExecutablePreflight: true,
      allowUnprovenLegacyAcpRecovery: true,
      stopPersistedAcpProcessGroup: async identity => (
        identity?.pid === 4321
          ? { stopped: false, identityMismatch: true }
          : { stopped: true, alreadyExited: true }
      ),
    },
  );
  try {
    await recoveredManager.recoveryGate.wait();
    assert(preparedAgentIds.includes(updateAgent.id), 'reconciled Update may resume its existing ACP runtime');
    assert(!preparedAgentIds.includes(createAgent.id), 'non-terminal Create must not launch a second ACP runtime');
    assert(
      recoveredManager.agents.has(blockedFreshCreateAgent.id),
      'a fresh ACP Create with uncertain process cleanup must remain visible without a provider id',
    );
    assert.strictEqual(
      recoveredManager.agents.get(blockedFreshCreateAgent.id).engineStatus,
      'lifecycle-blocked',
    );
    assert(
      !preparedAgentIds.includes(blockedFreshCreateAgent.id),
      'an uncertain fresh ACP Create must not launch a replacement runtime',
    );

    recoveredManager.stopPersistedAcpProcessGroup = async () => ({
      stopped: true,
      alreadyExited: true,
    });
    const blockedFreshDelete = await recoveredManager.killAgent(blockedFreshCreateAgent.id);
    assert.strictEqual(blockedFreshDelete.killed, true);
    assert.strictEqual(recoveredManager.agents.has(blockedFreshCreateAgent.id), false);

    const recoveredUpdate = recoveredManager.agents.get(updateAgent.id);
    assert.strictEqual(recoveredUpdate.customTitle, 'Recovered title');
    assert.strictEqual(latestLifecycleOperation(recoveredUpdate).state, 'succeeded');
    assert.strictEqual(activeLifecycleOperation(recoveredUpdate), null);
    const originalEnsureAgentSessionRecord = recoveredManager.configManager.ensureAgentSessionRecord;
    recoveredManager.configManager.ensureAgentSessionRecord = () => {
      throw new Error('simulated read-cursor disk failure');
    };
    const failedCursorUpdate = recoveredManager.updateAgentFlags(updateAgent.id, { unread: true });
    assert.strictEqual(failedCursorUpdate.retryable, true);
    assert.match(failedCursorUpdate.error, /read-cursor disk failure/);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(failedCursorUpdate, 'operationId'),
      false,
      'non-journaled Update failures must not dereference a missing lifecycle admission',
    );
    recoveredManager.configManager.ensureAgentSessionRecord = originalEnsureAgentSessionRecord;

    assert.strictEqual(recoveredManager.agents.has(createAgent.id), false);
    const recoveredCreateRecord = store.readRecord(createAgent.persistentSessionId);
    assert.strictEqual(latestLifecycleOperation(recoveredCreateRecord).state, 'failed');
    assert.strictEqual(activeLifecycleOperation(recoveredCreateRecord), null);

    const idempotentCreate = acpAgent(
      'agent-idempotent-create',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      configDir,
    );
    const createRequest = beginLifecycleOperation(
      idempotentCreate,
      'create',
      'create-request:browser-request-1',
      { agentId: idempotentCreate.id, command: 'claude', cwd: configDir, runtimeKind: 'acp' },
    );
    transitionLifecycleOperation(idempotentCreate, createRequest.operation.id, 'succeeded');
    idempotentCreate.persistentSessionId = store.rememberAgent(idempotentCreate);
    recoveredManager.agents.set(idempotentCreate.id, idempotentCreate);
    let duplicateCallback = null;
    const duplicateAgentId = await recoveredManager.startAgent(
      'claude',
      configDir,
      (agentId, error) => {
        duplicateCallback = { agentId, error };
      },
      {
        wantsMain: false,
        createRequestId: 'browser-request-1',
      },
    );
    assert.strictEqual(duplicateAgentId, idempotentCreate.id);
    assert.deepStrictEqual(duplicateCallback, { agentId: idempotentCreate.id, error: null });
    assert.strictEqual(
      recoveredManager.agents.size,
      2,
      'replaying one Create request id must not launch another Agent',
    );

    const prepareCountBeforeConcurrentCreate = preparedAgentIds.length;
    const concurrentCallbacks = [];
    const concurrentOptions = {
      wantsMain: false,
      agentRuntimeMode: 'chat',
      createRequestId: 'simultaneous-browser-request',
    };
    const [firstConcurrentId, secondConcurrentId] = await Promise.all([
      recoveredManager.startAgent(
        'claude',
        configDir,
        (agentId, error) => concurrentCallbacks.push({ agentId, error }),
        concurrentOptions,
      ),
      recoveredManager.startAgent(
        'claude',
        configDir,
        (agentId, error) => concurrentCallbacks.push({ agentId, error }),
        concurrentOptions,
      ),
    ]);
    assert.strictEqual(firstConcurrentId, secondConcurrentId);
    assert(firstConcurrentId);
    assert.deepStrictEqual(concurrentCallbacks, [
      { agentId: firstConcurrentId, error: undefined },
      { agentId: firstConcurrentId, error: null },
    ]);
    assert.strictEqual(
      preparedAgentIds.length,
      prepareCountBeforeConcurrentCreate + 1,
      'simultaneous Create calls with one request id must share one Runtime admission',
    );
    const matchingCreateRecords = store.listAgentRecords().filter(record => (
      lifecycleJournal(record).entries.some(operation => (
        operation.requestKey === 'create-request:simultaneous-browser-request'
      ))
    ));
    assert.strictEqual(matchingCreateRecords.length, 1);

    const stableSessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const stableCommand = `claude --resume ${stableSessionId}`;
    const firstStableId = await recoveredManager.startAgent(
      stableCommand,
      configDir,
      null,
      {
        wantsMain: false,
        agentRuntimeMode: 'chat',
        createRequestId: 'stable-owner-1',
      },
    );
    assert(firstStableId);
    let duplicateStableCallback: {
      agentId: string | null;
      error: string;
    } | null = null;
    const secondStableId = await recoveredManager.startAgent(
      stableCommand,
      configDir,
      (agentId, error) => {
        duplicateStableCallback = { agentId, error };
      },
      {
        wantsMain: false,
        agentRuntimeMode: 'chat',
        createRequestId: 'stable-owner-2',
      },
    );
    assert.strictEqual(secondStableId, null);
    assert.strictEqual(duplicateStableCallback.agentId, null);
    assert.match(duplicateStableCallback.error, /owned by Runtime/);
    const stableKey = `agent-session:claude:${stableSessionId}`;
    const stableRecord = store.getRecordForProviderSessionKey(stableKey);
    assert.strictEqual(stableRecord.runtimeAgentId, firstStableId);
    assert.strictEqual(
      Array.from(recoveredManager.agents.values())
        .filter((candidate: TestAcpAgent) => (
          canonicalProviderSessionKey(candidate.providerSessionKey)
            === canonicalProviderSessionKey(stableKey)
        ))
        .length,
      1,
      'one stable provider session must have one live Runtime owner',
    );

    const staleSessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const staleOwner = acpAgent('agent-stale-owner', staleSessionId, configDir);
    staleOwner.status = 'stopped';
    const staleCreate = beginLifecycleOperation(
      staleOwner,
      'create',
      'create:agent-stale-owner',
      { agentId: staleOwner.id, runtimeKind: 'acp' },
    );
    transitionLifecycleOperation(staleOwner, staleCreate.operation.id, 'succeeded');
    staleOwner.persistentSessionId = store.rememberAgent(staleOwner);
    recoveredManager.agents.set(staleOwner.id, staleOwner);
    const claimedId = await recoveredManager.startAgent(
      `claude --resume ${staleSessionId}`,
      configDir,
      null,
      {
        wantsMain: false,
        agentRuntimeMode: 'chat',
        createRequestId: 'stale-owner-claim',
      },
    );
    assert(claimedId);
    assert.notStrictEqual(claimedId, staleOwner.id);
    assert.strictEqual(
      recoveredManager.agents.has(staleOwner.id),
      false,
      'successful stale-owner claim must remove the old stopped Runtime object',
    );
    assert.strictEqual(
      store.getRecordForProviderSessionKey(`agent-session:claude:${staleSessionId}`).runtimeAgentId,
      claimedId,
    );

    const rollbackSessionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const rollbackOwner = acpAgent('agent-rollback-owner', rollbackSessionId, configDir);
    rollbackOwner.status = 'stopped';
    rollbackOwner.customTitle = 'Keep this title';
    const rollbackOwnerCreate = beginLifecycleOperation(
      rollbackOwner,
      'create',
      'create:agent-rollback-owner',
      { agentId: rollbackOwner.id, runtimeKind: 'acp' },
    );
    transitionLifecycleOperation(rollbackOwner, rollbackOwnerCreate.operation.id, 'succeeded');
    rollbackOwner.persistentSessionId = store.rememberAgent(rollbackOwner);
    recoveredManager.agents.set(rollbackOwner.id, rollbackOwner);
    const successfulPrepare = recoveredRuntime.prepareAgent;
    recoveredRuntime.prepareAgent = async options => {
      if (options.sessionId === rollbackSessionId) {
        throw new Error('simulated stale-owner replacement failure');
      }
      return successfulPrepare(options);
    };
    let rollbackCreateError = '';
    const failedClaim = await recoveredManager.startAgent(
      `claude --resume ${rollbackSessionId}`,
      configDir,
      (_agentId, error) => {
        rollbackCreateError = error || '';
      },
      {
        wantsMain: false,
        agentRuntimeMode: 'chat',
        createRequestId: 'stale-owner-rollback',
      },
    );
    recoveredRuntime.prepareAgent = successfulPrepare;
    assert.strictEqual(failedClaim, null);
    assert.match(rollbackCreateError, /replacement failure/);
    const rolledBackRecord = store.getRecordForProviderSessionKey(
      `agent-session:claude:${rollbackSessionId}`,
    );
    assert.strictEqual(rolledBackRecord.runtimeAgentId, rollbackOwner.id);
    assert.strictEqual(rolledBackRecord.visibleOnMainPage, undefined);
    assert(
      store.getMainPageSessionKeys().includes(
        canonicalProviderSessionKey(`agent-session:claude:${rollbackSessionId}`),
      ),
      'stable provider visibility must be restored through index membership',
    );
    assert.strictEqual(rolledBackRecord.customTitle, 'Keep this title');
    assert.strictEqual(recoveredManager.agents.has(rollbackOwner.id), true);

    const scopeRollbackSessionId = '12121212-1212-4212-8212-121212121212';
    const scopeRollbackOwner = acpAgent(
      'agent-scope-rollback-owner',
      scopeRollbackSessionId,
      configDir,
    );
    scopeRollbackOwner.status = 'stopped';
    const scopeRollbackCreate = beginLifecycleOperation(
      scopeRollbackOwner,
      'create',
      'create:agent-scope-rollback-owner',
      { agentId: scopeRollbackOwner.id, runtimeKind: 'acp' },
    );
    transitionLifecycleOperation(
      scopeRollbackOwner,
      scopeRollbackCreate.operation.id,
      'succeeded',
    );
    scopeRollbackOwner.persistentSessionId = store.rememberAgent(scopeRollbackOwner);
    store.ensureRecordForAgent(scopeRollbackOwner, {
      acpAdditionalDirectories: ['/old-scope'],
      acpConfigOverrides: [{ configId: 'fast-mode', value: true }],
      acpMcpServers: [{ name: 'old', command: '/bin/old', args: [], env: [] }],
    });
    recoveredManager.agents.set(scopeRollbackOwner.id, scopeRollbackOwner);
    const durableEnsure = recoveredManager.configManager.ensureAgentSessionRecord;
    let rejectScopeSuccessCommit = true;
    recoveredManager.configManager.ensureAgentSessionRecord = (candidate, patch) => {
      const latest = latestLifecycleOperation(candidate);
      if (
        rejectScopeSuccessCommit
        && candidate.providerSessionId === scopeRollbackSessionId
        && latest?.type === 'create'
        && latest.state === 'succeeded'
      ) {
        rejectScopeSuccessCommit = false;
        throw new Error('simulated Create success commit failure');
      }
      return durableEnsure(candidate, patch);
    };
    const unregisterAgentAndWait = recoveredRuntime.unregisterAgentAndWait;
    recoveredRuntime.unregisterAgentAndWait = async () => true;
    let scopeRollbackError = '';
    const failedScopeClaim = await recoveredManager.startAgent(
      `claude --resume ${scopeRollbackSessionId}`,
      configDir,
      (_agentId, error) => {
        scopeRollbackError = error || '';
      },
      {
        wantsMain: false,
        agentRuntimeMode: 'chat',
        createRequestId: 'scope-owner-rollback',
        additionalDirectories: ['/new-scope'],
        mcpServers: [{ name: 'new', command: '/bin/new', args: [], env: [] }],
      },
    );
    recoveredManager.configManager.ensureAgentSessionRecord = durableEnsure;
    recoveredRuntime.unregisterAgentAndWait = unregisterAgentAndWait;
    assert.strictEqual(failedScopeClaim, null);
    assert.match(scopeRollbackError, /success commit failure/);
    const scopeRollbackLegacyKey = `agent-session:claude:${scopeRollbackSessionId}`;
    const scopeRollbackKey = canonicalProviderSessionKey(scopeRollbackLegacyKey);
    const scopeRolledBackRecord = store.getRecordForProviderSessionKey(scopeRollbackKey);
    assert.strictEqual(scopeRolledBackRecord.runtimeAgentId, scopeRollbackOwner.id);
    assert.deepStrictEqual(scopeRolledBackRecord.acpAdditionalDirectories, ['/old-scope']);
    assert.deepStrictEqual(scopeRolledBackRecord.acpConfigOverrides, [
      { configId: 'fast-mode', value: true },
    ]);
    assert.deepStrictEqual(scopeRolledBackRecord.acpMcpServers, [
      { name: 'old', command: '/bin/old', args: [], env: [] },
    ]);
    assert.deepStrictEqual(
      recoveredManager.acpSessionOptionsStore.get(
        scopeRollbackKey,
      ),
      {
        additionalDirectories: ['/old-scope'],
        configOverrides: [{ configId: 'fast-mode', value: true }],
        mcpServers: [{ name: 'old', command: '/bin/old', args: [], env: [] }],
      },
      'Create rollback must restore the in-memory ACP scope as well as disk metadata',
    );
    assert.strictEqual(
      recoveredManager.acpSessionOptionsStore.has(scopeRollbackLegacyKey),
      false,
      'ACP scope ownership must use only the canonical v2 Provider Session key',
    );
  } finally {
    await recoveredManager.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  console.log('Agent Create and Update journals recover without duplicate runtime start');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
