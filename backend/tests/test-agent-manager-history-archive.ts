const assert = require('assert');
const { encodeProviderSessionKey } = require('../../shared/provider-session-identity.js');
const { AgentManager } = require('../agent-manager.cjs');
const { createTestAgentManager } = require('./helpers/test-acp-runtime.ts');
const { activeLifecycleOperation } = require('../agent-lifecycle-journal.cjs');

async function run() {
  const appended = [];
  const codexArchiveCalls = [];
  const persistedSessionPatches = [];
  const unverifiableRuntimeIds = new Set();
  let resolveCodexArchive;
  const settings = {
    mainPageSessionKeys: [
      encodeProviderSessionKey('codex', 'archive-session', 'default'),
      encodeProviderSessionKey('codex', 'other-session', 'default'),
    ],
  };
  const manager = createTestAgentManager(AgentManager, {
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
    getSettings() {
      return settings;
    },
    updateSettings(patch) {
      Object.assign(settings, patch);
    },
    appendTaskHistory(entry) {
      appended.push(entry);
    },
    ensureAgentSessionRecord(agent, patch) {
      persistedSessionPatches.push({ agentId: agent.id, patch });
      return agent.persistentSessionId || `fsess_${agent.id}`;
    },
  }, {
    archiveCodexSession(sessionId, session) {
      codexArchiveCalls.push({ sessionId, session });
      return new Promise(resolve => {
        resolveCodexArchive = resolve;
      });
    },
  });

  manager.engineBridge.getEngine = () => ({
    killSession: async () => {},
    getSessionState: async agentId => {
      if (unverifiableRuntimeIds.has(agentId)) {
        throw new Error('runtime state unavailable');
      }
      return null;
    },
  });

  try {
    const now = Date.now();
    const zombieMs = AgentManager.ZOMBIE_IDLE_MS;

    manager.mainAgentIdentity.setCurrent('main-1');
    manager.agents.set('main-1', {
      id: 'main-1',
      command: 'bash',
      cwd: '/repo',
      output: '',
      status: 'running',
      engineName: 'local',
      source: 'ui',
      task: '',
    });
    manager.activityTracker.record('main-1', now - zombieMs - 1000);

    manager.agents.set('sub-zombie', {
      id: 'sub-zombie',
      command: 'codex',
      cwd: '/repo',
      output: '',
      status: 'running',
      engineName: 'local',
      source: 'ui',
      task: 'zombie target',
    });
    manager.activityTracker.record('sub-zombie', now - zombieMs - 1000);

    await manager.cleanupZombieAgents();

    assert.strictEqual(manager.agents.has('sub-zombie'), false, 'zombie sub agent should be killed');
    assert.strictEqual(manager.agents.has('main-1'), true, 'main agent should never be auto-killed');
    assert.strictEqual(manager.taskHistoryStore.list().length, 1, 'zombie kill should create one history entry');
    assert.strictEqual(manager.taskHistoryStore.list()[0].reason, 'zombie-cleanup');
    assert.strictEqual(appended.length, 1, 'history should be persisted through config manager');

    manager.agents.set('sub-manual', {
      id: 'sub-manual',
      command: 'claude',
      cwd: '/repo',
      output: '',
      status: 'running',
      engineName: 'local',
      source: 'ui',
      task: 'manual target',
    });
    manager.activityTracker.record('sub-manual', now);

    await manager.killAgent('sub-manual');
    assert.strictEqual(manager.taskHistoryStore.list().length, 2, 'manual kill should also be archived');
    assert.strictEqual(manager.taskHistoryStore.list()[0].reason, 'manual-kill');

    manager.agents.set('sub-archive', {
      id: 'sub-archive',
      command: 'codex',
      cwd: '/repo/deep',
      projectWorkspace: '/repo',
      output: '',
      status: 'running',
      engineName: 'local',
      source: 'codex-history:019f0000-0000-7000-8000-000000000001',
      providerSessionProvider: 'codex',
      providerSessionId: 'archive-session',
      providerSessionKey: encodeProviderSessionKey('codex', 'archive-session', 'default'),
      providerHomePath: '/home/farming/.codex',
      customTitle: 'Named archive run',
      task: 'archive target',
    });
    manager.activityTracker.record('sub-archive', now);

    let committedArchiveUpdates = 0;
    const observeCommittedArchive = () => {
      if (manager.agents.get('sub-archive')?.archived === true) committedArchiveUpdates += 1;
    };
    manager.on('update', observeCommittedArchive);
    const archivedPromise = manager.archiveAgent('sub-archive');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(codexArchiveCalls, [{
      sessionId: 'archive-session',
      session: {
        cliVersion: '',
        cwd: '/repo/deep',
        workspace: '/repo',
        providerHomePath: '/home/farming/.codex',
      },
    }], 'manual Codex archive should durably wait for provider archive');
    assert.strictEqual(
      manager.agents.get('sub-archive')?.archived,
      true,
      'the locally committed archive should be visible before the provider command settles',
    );
    assert.strictEqual(
      committedArchiveUpdates,
      1,
      'the locally committed archive should immediately publish an authoritative state update',
    );
    manager.off('update', observeCommittedArchive);
    resolveCodexArchive({ archived: true });
    const archived = await archivedPromise;
    assert.strictEqual(archived.error, undefined);
    assert.strictEqual(archived.archived, true);
    assert.strictEqual(archived.removed, true);
    assert.deepStrictEqual(archived.removedMainPageSessionKeys, [encodeProviderSessionKey('codex', 'archive-session', 'default')]);
    assert.deepStrictEqual(
      settings.mainPageSessionKeys,
      [encodeProviderSessionKey('codex', 'other-session', 'default')],
      'archiving a recoverable agent should remove its main-page membership so restart cannot resume it'
    );
    settings.mainPageSessionKeys = [
      encodeProviderSessionKey('claude', 'key-only-session', 'default'),
      ...settings.mainPageSessionKeys,
    ];
    assert.deepStrictEqual(
      manager.mainPageSessionIndex.removeAgents([
        { providerSessionKey: encodeProviderSessionKey('claude', 'key-only-session', 'default') },
      ]),
      [encodeProviderSessionKey('claude', 'key-only-session', 'default')],
      'archive cleanup should also understand legacy agents that only carry providerSessionKey'
    );
    assert.deepStrictEqual(
      manager.mainPageSessionIndex.removeAgents([
        { providerSessionKey: encodeProviderSessionKey('claude', 'not-present', 'default') },
      ]),
      [],
      'archive cleanup should only report session keys that were actually removed from settings'
    );
    assert.deepStrictEqual(settings.mainPageSessionKeys, [encodeProviderSessionKey('codex', 'other-session', 'default')]);
    assert.strictEqual(manager.agents.has('sub-archive'), false, 'archived live agents should leave live state');
    assert.strictEqual(manager.taskHistoryStore.list().length, 3, 'archive should create a history run');
    assert.strictEqual(manager.taskHistoryStore.list()[0].reason, 'manual-archive');
    assert.strictEqual(manager.taskHistoryStore.list()[0].projectWorkspace, '/repo');
    assert.strictEqual(manager.taskHistoryStore.list()[0].title, 'Named archive run');
    assert.strictEqual(manager.taskHistoryStore.list()[0].customTitle, 'Named archive run');

    const providerArchiveCallsBeforeFreshArchive = codexArchiveCalls.length;
    manager.agents.set('fresh-codex-acp', {
      id: 'fresh-codex-acp',
      command: 'codex',
      cwd: '/repo',
      projectWorkspace: '/repo',
      output: '',
      status: 'running',
      engineName: 'local',
      source: 'ui',
      providerSessionProvider: 'codex',
      providerSessionId: '019f0000-0000-7000-8000-000000000010',
      providerSessionKey: encodeProviderSessionKey('codex', '019f0000-0000-7000-8000-000000000010', 'default'),
      providerSessionMaterialized: false,
      providerSessionTemporary: false,
      task: 'fresh Codex ACP session',
    });
    const freshArchive = await manager.archiveAgent('fresh-codex-acp', { recordHistory: false });
    assert.strictEqual(freshArchive.error, undefined);
    assert.strictEqual(freshArchive.archived, true);
    assert.strictEqual(
      codexArchiveCalls.length,
      providerArchiveCallsBeforeFreshArchive,
      'a fresh Codex ACP session without a submitted message must not invoke codex archive',
    );

    const archiveCodexSession = manager.archiveCodexSession;
    manager.archiveCodexSession = async () => ({ error: 'simulated provider archive failure' });
    manager.agents.set('provider-archive-retry', {
      id: 'provider-archive-retry',
      command: 'codex',
      cwd: '/repo',
      projectWorkspace: '/repo',
      output: '',
      status: 'running',
      engineName: 'local',
      source: 'ui',
      providerSessionProvider: 'codex',
      providerSessionId: 'provider-archive-retry',
      providerSessionKey: encodeProviderSessionKey('codex', 'provider-archive-retry', 'default'),
      task: 'provider archive retry',
    });
    const historyBeforeProviderRetry = manager.taskHistoryStore.list().length;
    const failedProviderArchive = await manager.archiveAgent('provider-archive-retry', { recordHistory: false });
    assert.strictEqual(failedProviderArchive.archived, true);
    assert.strictEqual(failedProviderArchive.providerArchived, false);
    assert.match(failedProviderArchive.error, /provider archive failure/i);
    assert.strictEqual(manager.agents.has('provider-archive-retry'), true);
    assert.strictEqual(activeLifecycleOperation(manager.agents.get('provider-archive-retry')).state, 'blocked');
    manager.archiveCodexSession = async () => ({ archived: true });
    const retriedProviderArchive = await manager.archiveAgent('provider-archive-retry');
    assert.strictEqual(retriedProviderArchive.error, undefined);
    assert.strictEqual(retriedProviderArchive.archived, true);
    assert.strictEqual(manager.agents.has('provider-archive-retry'), false);
    assert.strictEqual(
      manager.taskHistoryStore.list().length,
      historyBeforeProviderRetry,
      'retrying only the provider phase must not append duplicate run history',
    );
    manager.archiveCodexSession = archiveCodexSession;
    const providerMutationOrder = [];
    let releaseQueuedArchive;
    const queuedArchive = manager.providerSessionMutationCoordinator.run({
      provider: 'codex',
      homeId: 'default',
      sessionId: 'ordered-session',
      type: 'archive',
      operation: async () => {
        providerMutationOrder.push('archive-start');
        await new Promise(resolve => { releaseQueuedArchive = resolve; });
        providerMutationOrder.push('archive-end');
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    const queuedUnarchive = manager.providerSessionMutationCoordinator.run({
      provider: 'codex',
      homeId: 'default',
      sessionId: 'ordered-session',
      type: 'unarchive',
      operation: async () => {
        providerMutationOrder.push('unarchive');
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(providerMutationOrder, ['archive-start']);
    releaseQueuedArchive();
    await Promise.all([queuedArchive, queuedUnarchive]);
    assert.deepStrictEqual(providerMutationOrder, ['archive-start', 'archive-end', 'unarchive']);

    settings.mainPageSessionKeys = [
      encodeProviderSessionKey('codex', 'rollback-session', 'default'),
      ...settings.mainPageSessionKeys,
    ];
    manager.agents.set('project-rollback', {
      id: 'project-rollback',
      command: 'codex',
      cwd: '/repo',
      projectWorkspace: '/repo',
      output: '',
      status: 'running',
      engineName: 'local',
      source: 'codex-history:rollback-session',
      providerSessionProvider: 'codex',
      providerSessionId: 'rollback-session',
      providerSessionKey: encodeProviderSessionKey('codex', 'rollback-session', 'default'),
      persistentSessionId: 'fsess_project-rollback',
      task: 'failed Project transition',
    });
    const historyBeforeRollback = manager.taskHistoryStore.list().length;
    const archiveCallsBeforeRollback = codexArchiveCalls.length;
    const rollbackArchive = await manager.archiveAgent('project-rollback', {
      reason: 'project-mount-failed',
      recordHistory: false,
      requireEngineExit: true,
      scheduleProviderArchive: false,
    });
    assert.strictEqual(rollbackArchive.error, undefined);
    assert.strictEqual(manager.agents.has('project-rollback'), false);
    assert.strictEqual(manager.taskHistoryStore.list().length, historyBeforeRollback, 'failed Project admission should not create a completed run');
    assert.strictEqual(codexArchiveCalls.length, archiveCallsBeforeRollback, 'failed Project admission should not archive the provider conversation');
    assert(!settings.mainPageSessionKeys.includes(encodeProviderSessionKey('codex', 'rollback-session', 'default')));
    assert.strictEqual(persistedSessionPatches.at(-1).agentId, 'project-rollback');
    assert.deepStrictEqual(
      {
        visibleOnMainPage: persistedSessionPatches.at(-1).patch.visibleOnMainPage,
        archived: persistedSessionPatches.at(-1).patch.archived,
        runtimeAgentId: persistedSessionPatches.at(-1).patch.runtimeAgentId,
      },
      { visibleOnMainPage: false, archived: true, runtimeAgentId: '' },
      'verified rollback should tombstone the durable Farming session so restart cannot revive it',
    );

    manager.agents.set('shell-archive', {
      id: 'shell-archive',
      command: 'bash',
      cwd: '/repo',
      output: '',
      status: 'running',
      engineName: 'local',
      source: 'ui',
      task: 'temporary shell',
    });
    manager.activityTracker.record('shell-archive', now);

    const archivedShell = await manager.archiveAgent('shell-archive');
    assert.strictEqual(archivedShell.error, undefined);
    assert.strictEqual(archivedShell.archived, true);
    assert.strictEqual(manager.agents.has('shell-archive'), false, 'archived shell agents should be destroyed');
    assert.strictEqual(manager.taskHistoryStore.list().length, 3, 'manual shell archive should not create a history run');
    assert.strictEqual(appended.length, 3, 'manual shell archive should not be persisted to task history');

    manager.agents.set('shell-kill', {
      id: 'shell-kill',
      command: 'zsh',
      cwd: '/repo',
      output: '',
      status: 'running',
      engineName: 'local',
      source: 'control-cli',
      task: 'temporary shell kill',
    });
    manager.activityTracker.record('shell-kill', now);

    await manager.killAgent('shell-kill');
    assert.strictEqual(manager.agents.has('shell-kill'), false, 'killed shell agents should be destroyed');
    assert.strictEqual(manager.taskHistoryStore.list().length, 3, 'manual shell kill should not create a history run');
    assert.strictEqual(appended.length, 3, 'manual shell kill should not be persisted to task history');

    manager.agents.set('unverifiable-kill', {
      id: 'unverifiable-kill',
      command: 'codex',
      cwd: '/repo',
      output: '',
      status: 'running',
      engineName: 'local',
      source: 'ui',
      task: 'must remain live until exit is proven',
    });
    unverifiableRuntimeIds.add('unverifiable-kill');
    const historyBeforeUnverifiableKill = manager.taskHistoryStore.list().length;
    const unverifiableKill = await manager.killAgent('unverifiable-kill');
    assert.match(unverifiableKill.error, /runtime state unavailable/);
    assert.strictEqual(
      manager.agents.has('unverifiable-kill'),
      true,
      'kill must retain the live Agent when runtime exit cannot be verified',
    );
    assert.strictEqual(
      manager.taskHistoryStore.list().length,
      historyBeforeUnverifiableKill,
      'an unverified kill must not record a completed history run',
    );

    settings.mainPageSessionKeys = [
      encodeProviderSessionKey('codex', 'unverifiable-archive', 'default'),
      ...settings.mainPageSessionKeys,
    ];
    manager.agents.set('unverifiable-archive', {
      id: 'unverifiable-archive',
      command: 'codex',
      cwd: '/repo',
      projectWorkspace: '/repo',
      output: '',
      status: 'running',
      engineName: 'local',
      source: 'codex-history:unverifiable-archive',
      providerSessionProvider: 'codex',
      providerSessionId: 'unverifiable-archive',
      providerSessionKey: encodeProviderSessionKey('codex', 'unverifiable-archive', 'default'),
      task: 'archive must wait for runtime exit proof',
    });
    unverifiableRuntimeIds.add('unverifiable-archive');
    const persistedPatchesBeforeUnverifiableArchive = persistedSessionPatches.length;
    const providerArchiveCallsBeforeUnverifiableArchive = codexArchiveCalls.length;
    const unverifiableArchive = await manager.archiveAgent('unverifiable-archive');
    assert.match(unverifiableArchive.error, /runtime state unavailable/);
    assert.strictEqual(manager.agents.has('unverifiable-archive'), true);
    assert(
      settings.mainPageSessionKeys.includes(encodeProviderSessionKey('codex', 'unverifiable-archive', 'default')),
      'failed archive must preserve main-page membership',
    );
    assert.strictEqual(
      persistedSessionPatches.length,
      persistedPatchesBeforeUnverifiableArchive + 2,
      'failed archive must persist pending then blocked WAL states',
    );
    assert.strictEqual(activeLifecycleOperation(manager.agents.get('unverifiable-archive')).state, 'blocked');
    assert.strictEqual(
      codexArchiveCalls.length,
      providerArchiveCallsBeforeUnverifiableArchive,
      'failed local archive must not schedule provider archive',
    );

    manager.agents.set('history-write-failure', {
      id: 'history-write-failure',
      command: 'codex',
      cwd: '/repo',
      output: '',
      status: 'running',
      engineName: 'local',
      source: 'ui',
      task: 'history persistence failure',
    });
    const appendTaskHistory = manager.configManager.appendTaskHistory;
    manager.configManager.appendTaskHistory = () => {
      throw new Error('history disk unavailable');
    };
    const historyWriteFailureKill = await manager.killAgent('history-write-failure');
    manager.configManager.appendTaskHistory = appendTaskHistory;
    assert.strictEqual(historyWriteFailureKill.killed, true);
    assert.match(historyWriteFailureKill.warning, /history could not be saved/i);
    assert.strictEqual(
      manager.agents.has('history-write-failure'),
      false,
      'history persistence failure must not resurrect a stopped Agent',
    );

    manager.agents.set('archive-history-write-failure', {
      id: 'archive-history-write-failure',
      command: 'codex',
      cwd: '/repo',
      output: '',
      status: 'running',
      engineName: 'local',
      source: 'ui',
      task: 'archive history persistence failure',
    });
    manager.configManager.appendTaskHistory = () => {
      throw new Error('archive history disk unavailable');
    };
    const historyWriteFailureArchive = await manager.archiveAgent('archive-history-write-failure', {
      scheduleProviderArchive: false,
    });
    manager.configManager.appendTaskHistory = appendTaskHistory;
    assert.strictEqual(historyWriteFailureArchive.archived, true);
    assert.match(historyWriteFailureArchive.warning, /history could not be saved/i);
    assert.strictEqual(manager.agents.has('archive-history-write-failure'), false);

    manager.recordTaskHistory({
      id: 'shell-process-exit',
      command: 'env TERM=xterm-256color /bin/fish',
      cwd: '/repo',
      status: 'stopped',
      source: 'ui',
    }, { reason: 'process-exit', archivedAt: now });
    assert.strictEqual(manager.taskHistoryStore.list().length, 3, 'central history recording should reject shell process exits');
    assert.strictEqual(appended.length, 3, 'shell process exits should never be persisted to task history');

    manager.recordTaskHistory({
      id: 'unsupported-process-exit',
      command: 'unknown-agent',
      cwd: '/repo',
      status: 'stopped',
      source: 'ui',
    }, { reason: 'process-exit', archivedAt: now });
    assert.strictEqual(manager.taskHistoryStore.list().length, 3, 'central history recording should reject unsupported Agents');
    assert.strictEqual(appended.length, 3, 'unsupported Agents should never be persisted to task history');

    settings.mainPageSessionKeys = [
      encodeProviderSessionKey('codex', 'archive-metadata-failure', 'default'),
      ...settings.mainPageSessionKeys,
    ];
    manager.agents.set('archive-metadata-failure', {
      id: 'archive-metadata-failure',
      command: 'codex',
      cwd: '/repo',
      output: '',
      status: 'running',
      engineName: 'local',
      source: 'ui',
      providerSessionProvider: 'codex',
      providerSessionId: 'archive-metadata-failure',
      providerSessionKey: encodeProviderSessionKey('codex', 'archive-metadata-failure', 'default'),
      task: 'archive metadata failure',
    });
    const removeMainPageProviderSessionsForAgents = manager.mainPageSessionIndex.removeAgents;
    manager.mainPageSessionIndex.removeAgents = () => {
      settings.mainPageSessionKeys = settings.mainPageSessionKeys
        .filter(key => key !== encodeProviderSessionKey('codex', 'archive-metadata-failure', 'default'));
      throw new Error('session metadata disk unavailable');
    };
    const partialArchive = await manager.archiveAgent('archive-metadata-failure', {
      scheduleProviderArchive: false,
    });
    assert.strictEqual(partialArchive.archived, true);
    assert.strictEqual(partialArchive.removed, true);
    assert.match(partialArchive.warning, /membership cleanup failed/i);
    assert.strictEqual(manager.agents.has('archive-metadata-failure'), false);
    assert(
      !settings.mainPageSessionKeys.includes(encodeProviderSessionKey('codex', 'archive-metadata-failure', 'default')),
      'durable archive tombstone makes membership cleanup a retryable index repair',
    );
    manager.mainPageSessionIndex.removeAgents = removeMainPageProviderSessionsForAgents;

    assert.strictEqual((await manager.archiveAgent('missing-agent')).error, 'Agent not found');
    const archivedMain = await manager.archiveAgent('main-1');
    assert.strictEqual(archivedMain.archived, true, 'Main Agent should support explicit Archive');
    assert.strictEqual(manager.agents.has('main-1'), false);
    assert.strictEqual(manager.mainAgentIdentity.currentId(), null);

    const state = manager.getState();
    assert.strictEqual(Array.isArray(state.taskHistory), true, 'state payload should include taskHistory');
    assert.strictEqual(state.taskHistory.length >= 3, true, 'state should expose archived entries');

    console.log('test-agent-manager-history-archive passed');
  } finally {
    manager.heartbeatScheduler.stop();
    manager.engineBridge.dispose();
    await manager.acpRuntime.dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
