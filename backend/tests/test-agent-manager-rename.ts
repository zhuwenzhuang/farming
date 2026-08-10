const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentManager } = require('../agent-manager.cjs');
const { importTsModule } = require('./helpers/import-ts-module');

async function run() {
  const { agentTitle } = importTsModule('src/lib/format.ts');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-rename-'));
  const publicProjectWorkspace = fs.realpathSync(tmpRoot);
  const persistedAgentSnapshots = [];
  const manager = new AgentManager({
    getWorkspace() {
      return tmpRoot;
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
    getDangerouslySkipAgentPermissionsByDefault() {
      return false;
    },
    ensureAgentSessionRecord(agent, patch = {}) {
      persistedAgentSnapshots.push({ ...agent, ...patch });
      return agent.persistentSessionId || `fsess_${agent.id}`;
    },
    async persistAgentAdaptiveTitle(agent, adaptiveTitle) {
      return this.ensureAgentSessionRecord(agent, { adaptiveTitle });
    },
  }, { skipExecutablePreflight: true });

  manager.engineBridge.resolve = () => ({
    engineName: 'local',
    engine: {
      async createSession() {},
    },
    spec: { category: 'shell' },
  });

  try {
    const agentId = await startAgent(manager, 'bash', tmpRoot, { wantsMain: false });
    const persistedBeforeAdaptiveTitle = persistedAgentSnapshots.length;
    const fullUpdates = [];
    const scopedTitleUpdates = [];
    const onFullUpdate = () => fullUpdates.push(true);
    const onScopedTitleUpdate = update => scopedTitleUpdates.push(update);
    manager.on('update', onFullUpdate);
    manager.on('agent-update', onScopedTitleUpdate);
    const firstAdaptiveTitle = manager.setAgentAdaptiveTitle(
      agentId,
      'Draft cross-runtime title',
    );
    const latestAdaptiveTitle = manager.setAgentAdaptiveTitle(
      agentId,
      '  Fix cross-runtime titles  ',
    );
    assert.strictEqual(
      firstAdaptiveTitle,
      latestAdaptiveTitle,
      'updates admitted before the async flush should join one per-Agent persistence result',
    );
    assert.strictEqual(
      persistedAgentSnapshots.length,
      persistedBeforeAdaptiveTitle,
      'adaptive title persistence must leave the request stack before doing synchronous disk work',
    );
    assert.strictEqual(
      agentTitle(manager.getState().agents.find(agent => agent.id === agentId)),
      'Fix cross-runtime titles',
      'the latest title should be visible before persistence finishes',
    );
    const adaptiveTitle = await latestAdaptiveTitle;
    manager.off('update', onFullUpdate);
    manager.off('agent-update', onScopedTitleUpdate);
    assert.strictEqual(adaptiveTitle.error, undefined);
    assert.strictEqual(adaptiveTitle.adaptiveTitle, 'Fix cross-runtime titles');
    assert.strictEqual(fullUpdates.length, 0, 'an adaptive title must not invalidate the full Agent inventory');
    assert.deepStrictEqual(scopedTitleUpdates, [
      { agentId, patch: { adaptiveTitle: 'Draft cross-runtime title' } },
      { agentId, patch: { adaptiveTitle: 'Fix cross-runtime titles' } },
    ]);
    assert.strictEqual(
      persistedAgentSnapshots.length,
      persistedBeforeAdaptiveTitle + 1,
      'several titles for one Agent should persist only the latest value',
    );
    assert.strictEqual(
      agentTitle(manager.getState().agents.find(agent => agent.id === agentId)),
      'Fix cross-runtime titles',
    );
    assert.strictEqual(
      persistedAgentSnapshots.at(-1).adaptiveTitle,
      'Fix cross-runtime titles',
      'an acknowledged Agent-managed title must already be durable',
    );
    const replacementEnv = manager.buildAgentEnv(agentId, manager.agents.get(agentId));
    assert.strictEqual(replacementEnv.FARMING_AGENT_ID, agentId);
    assert.strictEqual(replacementEnv.FARMING_AGENT_TITLE_TOKEN, undefined);
    const restoredTitleAgentId = await startAgent(manager, 'bash', tmpRoot, {
      wantsMain: false,
      customTitle: `  ${'Restored title '.repeat(8)}  `,
    });
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === restoredTitleAgentId).customTitle,
      'Restored title '.repeat(8).trim().slice(0, 80),
      'a restored custom title should use the same normalization as renameAgent'
    );
    const initialOrderedAgents = manager.getState().agents.filter(
      agent => agent.projectWorkspace === publicProjectWorkspace
    );
    const firstOrder = initialOrderedAgents.find(agent => agent.id === agentId).projectOrder;
    const secondOrder = initialOrderedAgents.find(agent => agent.id === restoredTitleAgentId).projectOrder;
    assert(secondOrder > firstOrder, 'new Agents should be placed at the front of their Project');
    const reordered = manager.reorderProjectAgent(agentId, { beforeAgentId: '', afterAgentId: restoredTitleAgentId });
    assert.strictEqual(reordered.error, undefined);
    assert(
      manager.getState().agents.find(agent => agent.id === agentId).projectOrder
        > manager.getState().agents.find(agent => agent.id === restoredTitleAgentId).projectOrder,
      'manual reorder should update the persisted Project rank'
    );

    const renamed = manager.renameAgent(agentId, '  Investigate parser bug  ');
    const dangerousLaunches = [];
    const dangerousManager = new AgentManager({
      getWorkspace() { return tmpRoot; },
      getHeartbeatInterval() { return 1000; },
      getCodingAgentEngine() { return 'local'; },
      getVtBaseUrl() { return 'http://localhost:4020'; },
      getDangerouslySkipAgentPermissionsByDefault() { return true; },
      getAgentLaunchProfiles() { return { codex: { approvalMode: 'approve' }, claude: { permissionMode: 'auto' } }; },
      getCodexApprovalMode() { return 'approve'; },
      getCodexModelPreset() { return 'config:config'; },
      getCodexModel() { return 'config'; },
      getCodexReasoningEffort() { return 'config'; },
      getCodexServiceTier() { return 'default'; },
    }, { skipExecutablePreflight: true });
    dangerousManager.engineBridge.resolve = () => ({
      engineName: 'local',
      engine: {
        async createSession(options) {
          dangerousLaunches.push(options);
        },
      },
      spec: { category: 'coding' },
    });
    await startAgent(dangerousManager, 'codex', tmpRoot, { wantsMain: false });
    assert(dangerousLaunches.at(-1).args.includes('--dangerously-bypass-approvals-and-sandbox'));
    await startAgent(dangerousManager, 'claude', tmpRoot, { wantsMain: false });
    assert(dangerousLaunches.at(-1).args.includes('--dangerously-skip-permissions'));
    clearInterval(dangerousManager.heartbeatInterval);
    dangerousManager.engineBridge.dispose();

    assert.strictEqual(renamed.error, undefined);
    assert.strictEqual(renamed.customTitle, 'Investigate parser bug');
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === agentId).customTitle,
      'Investigate parser bug'
    );
    assert.strictEqual(
      persistedAgentSnapshots.at(-1).customTitle,
      'Investigate parser bug',
      'rename should persist the custom title before reporting success'
    );
    const originalEnsureAgentSessionRecord = manager.configManager.ensureAgentSessionRecord;
    const failedWriteAttempts = [];
    let failNextWrite = true;
    manager.configManager.ensureAgentSessionRecord = (agent, patch = {}) => {
      failedWriteAttempts.push({ ...agent, ...patch });
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('session storage unavailable after record write');
      }
      return agent.persistentSessionId || `fsess_${agent.id}`;
    };
    const adaptiveTitleBeforeFailedWrite = manager.agents.get(agentId).adaptiveTitle;
    const failedAdaptiveTitle = await manager.setAgentAdaptiveTitle(
      agentId,
      'Must not remain visible',
    );
    assert.match(failedAdaptiveTitle.error, /Failed to update Agent title/);
    assert.strictEqual(
      manager.agents.get(agentId).adaptiveTitle,
      adaptiveTitleBeforeFailedWrite,
      'a failed durable title write must roll the optimistic Agent-scoped projection back',
    );
    failNextWrite = true;
    const titleBeforeFailedRename = manager.agents.get(agentId).customTitle;
    const failedRename = manager.renameAgent(agentId, 'Must not commit');
    assert.match(failedRename.error, /Failed to rename Agent/);
    assert.strictEqual(manager.agents.get(agentId).customTitle, titleBeforeFailedRename);
    assert.strictEqual(failedWriteAttempts.at(-1).customTitle, titleBeforeFailedRename);
    const taskBeforeFailedUpdate = manager.agents.get(agentId).task;
    failNextWrite = true;
    const failedTaskUpdate = manager.setAgentTask(agentId, 'Must not commit');
    assert.match(failedTaskUpdate.error, /Failed to update Agent task/);
    assert.strictEqual(manager.agents.get(agentId).task, taskBeforeFailedUpdate);
    assert.strictEqual(failedWriteAttempts.at(-1).task, taskBeforeFailedUpdate);
    const pinnedBeforeFailedUpdate = manager.agents.get(agentId).pinned;
    failNextWrite = true;
    const failedFlagUpdate = manager.updateAgentFlags(agentId, { pinned: !pinnedBeforeFailedUpdate });
    assert.match(failedFlagUpdate.error, /Failed to update Agent/);
    assert.strictEqual(manager.agents.get(agentId).pinned, pinnedBeforeFailedUpdate);
    assert.strictEqual(failedWriteAttempts.at(-1).pinned, pinnedBeforeFailedUpdate);
    const ordersBeforeFailedReorder = new Map(
      [...manager.agents].map(([id, agent]) => [id, agent.projectOrder]),
    );
    failNextWrite = true;
    const failedReorder = manager.reorderProjectAgent(agentId, {
      beforeAgentId: '',
      afterAgentId: restoredTitleAgentId,
    });
    assert.match(failedReorder.error, /Failed to reorder Agents/);
    assert.deepStrictEqual(
      new Map([...manager.agents].map(([id, agent]) => [id, agent.projectOrder])),
      ordersBeforeFailedReorder,
    );
    assert.strictEqual(
      failedWriteAttempts.at(-1).projectOrder,
      ordersBeforeFailedReorder.get(failedWriteAttempts.at(-1).id),
      'the failing reorder write must also be rolled back to its old order',
    );
    manager.configManager.ensureAgentSessionRecord = originalEnsureAgentSessionRecord;
    const originalGetAgentSessionRecord = manager.configManager.getAgentSessionRecordForProviderSessionKey;
    const reboundAgent = {
      id: 'agent-rebound-session',
      persistentSessionId: 'fsess_temporary_record',
      providerSessionKey: 'agent-session:codex:resolved-session',
      customTitle: '',
      pinned: false,
      projectOrder: 0,
    };
    manager.configManager.ensureAgentSessionRecord = () => 'fsess_canonical_record';
    manager.configManager.getAgentSessionRecordForProviderSessionKey = () => ({
      id: 'fsess_canonical_record',
      customTitle: 'Canonical title',
      pinned: true,
      projectOrder: 2048,
    });
    manager.ensurePersistentAgentSession(reboundAgent);
    manager.configManager.getAgentSessionRecordForProviderSessionKey = originalGetAgentSessionRecord;
    assert.strictEqual(
      reboundAgent.persistentSessionId,
      'fsess_canonical_record',
      'provider confirmation should rebind a live Agent to the canonical Farming session record',
    );
    assert.strictEqual(reboundAgent.customTitle, 'Canonical title');
    assert.strictEqual(reboundAgent.pinned, true);
    assert.strictEqual(reboundAgent.projectOrder, 2048);

    const longTitle = 'x'.repeat(100);
    const truncated = manager.renameAgent(agentId, longTitle);
    assert.strictEqual(truncated.customTitle.length, 80);

    const cleared = manager.renameAgent(agentId, '   ');
    assert.strictEqual(cleared.customTitle, '');
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === agentId).customTitle,
      ''
    );
    assert.strictEqual(
      agentTitle(manager.getState().agents.find(agent => agent.id === agentId)),
      'Fix cross-runtime titles',
      'clearing a user rename should reveal the Agent-managed title',
    );
    manager.agents.get(agentId).adaptiveTitle = '';

    manager.engineBridge.emit('session-title', {
      sessionId: agentId,
      title: '  Terminal title sync  ',
    });
    let titledAgent = manager.getState().agents.find(agent => agent.id === agentId);
    assert.strictEqual(titledAgent.sessionTitle, 'Terminal title sync');
    assert.strictEqual(agentTitle(titledAgent), 'Terminal title sync');

    manager.engineBridge.emit('session-preview', {
      sessionId: agentId,
      previewText: 'preview',
      cols: 80,
      rows: 24,
      title: 'Preview provided title',
    });
    titledAgent = manager.getState().agents.find(agent => agent.id === agentId);
    assert.strictEqual(titledAgent.sessionTitle, 'Preview provided title');
    assert.strictEqual(agentTitle(titledAgent), 'Preview provided title');

    manager.renameAgent(agentId, 'Manual rename wins');
    manager.engineBridge.emit('session-title', {
      sessionId: agentId,
      title: 'Agent provided later title',
    });
    titledAgent = manager.getState().agents.find(agent => agent.id === agentId);
    assert.strictEqual(titledAgent.sessionTitle, 'Agent provided later title');
    assert.strictEqual(agentTitle(titledAgent), 'Manual rename wins');

    manager.renameAgent(agentId, '   ');

    const historyWorkspace = path.join(tmpRoot, 'farming');
    fs.mkdirSync(historyWorkspace, { recursive: true });
    const historyAgentId = 'agent-history-title-filter';
    manager.agents.set(historyAgentId, {
      id: historyAgentId,
      command: 'codex',
      forkCommand: 'codex',
      cwd: historyWorkspace,
      projectWorkspace: historyWorkspace,
      output: '',
      previewText: '',
      previewSnapshot: null,
      previewCols: 80,
      previewRows: 24,
      sessionTitle: '',
      status: 'running',
      engineName: 'local',
      wantsMain: false,
      mainWorkspace: '',
      category: 'coding',
      parentAgentId: '',
      task: 'Farming + Codex',
      workflowTemplate: '',
      source: 'codex-history:28274085',
      customTitle: '',
      pinned: false,
      unread: false,
      archived: false,
      archivedAt: null,
      canForkNewWorktree: false,
      validated: true,
      engineStarted: true,
      startedAt: Date.now(),
    });
    manager.lastActivity.set(historyAgentId, Date.now());

    manager.engineBridge.emit('session-title', {
      sessionId: historyAgentId,
      title: '⠿ farming',
    });
    let historyAgent = manager.getState().agents.find(agent => agent.id === historyAgentId);
    assert.strictEqual(historyAgent.sessionTitle, '');
    assert.strictEqual(agentTitle(historyAgent), 'Farming + Codex');

    manager.agents.get(historyAgentId).sessionTitle = 'farming';
    manager.engineBridge.emit('session-title', {
      sessionId: historyAgentId,
      title: '⠂ farming',
    });
    historyAgent = manager.getState().agents.find(agent => agent.id === historyAgentId);
    assert.strictEqual(historyAgent.sessionTitle, '');
    assert.strictEqual(agentTitle(historyAgent), 'Farming + Codex');

    manager.engineBridge.emit('session-title', {
      sessionId: historyAgentId,
      title: 'Review branch ready',
    });
    historyAgent = manager.getState().agents.find(agent => agent.id === historyAgentId);
    assert.strictEqual(historyAgent.sessionTitle, 'Review branch ready');
    assert.strictEqual(agentTitle(historyAgent), 'Review branch ready');

    const task = manager.setAgentTask(agentId, '  Ship Code-style composer  ');
    assert.strictEqual(task.error, undefined);
    assert.strictEqual(task.task, 'Ship Code-style composer');
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === agentId).task,
      'Ship Code-style composer'
    );

    const longTask = manager.setAgentTask(agentId, 'g'.repeat(300));
    assert.strictEqual(longTask.task.length, 240);

    const clearedTask = manager.setAgentTask(agentId, '   ');
    assert.strictEqual(clearedTask.task, '');
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === agentId).task,
      ''
    );

    const missing = manager.renameAgent('missing-agent', 'Nope');
    assert.strictEqual(missing.error, 'Agent not found');
    assert.strictEqual(manager.setAgentTask('missing-agent', 'Nope').error, 'Agent not found');

    const flags = manager.updateAgentFlags(agentId, { pinned: true, unread: true });
    assert.strictEqual(flags.pinned, true);
    assert.strictEqual(typeof flags.pinnedOrder, 'number');
    assert.strictEqual(flags.unread, true);
    const flaggedAgent = manager.getState().agents.find(agent => agent.id === agentId);
    assert.strictEqual(flaggedAgent.pinned, true);
    assert.strictEqual(flaggedAgent.unread, true);

    const directArchive = manager.updateAgentFlags(agentId, { archived: true });
    assert.strictEqual(directArchive.error, 'Use archiveAgent to archive live agents');
    const stillLiveAgent = manager.getState().agents.find(agent => agent.id === agentId);
    assert.strictEqual(stillLiveAgent.archived, false);
    assert.strictEqual(stillLiveAgent.pinned, true);

    const legacyArchivedAgent = manager.agents.get(agentId);
    legacyArchivedAgent.archived = true;
    legacyArchivedAgent.archivedAt = Date.now();
    legacyArchivedAgent.pinned = false;

    const restored = manager.updateAgentFlags(agentId, { archived: false, unread: false });
    assert.strictEqual(restored.archived, false);
    assert.strictEqual(restored.archivedAt, null);
    assert.strictEqual(restored.unread, false);

    const markedUnread = manager.setAgentUnread(agentId, true);
    assert.strictEqual(markedUnread.unread, true);
    assert.strictEqual(markedUnread.changed, true);
    assert.strictEqual(manager.getState().agents.find(agent => agent.id === agentId).unread, true);
    const duplicateUnread = manager.setAgentUnread(agentId, true);
    assert.strictEqual(duplicateUnread.changed, false);
    const markedRead = manager.setAgentUnread(agentId, false);
    assert.strictEqual(markedRead.unread, false);
    assert.strictEqual(markedRead.changed, true);

    const mainId = await startAgent(manager, 'bash', tmpRoot, { wantsMain: true });
    manager.mainAgentId = mainId;
    assert.strictEqual(
      manager.updateAgentFlags(mainId, { archived: true }).error,
      'Use archiveAgent to archive live agents'
    );
    assert.strictEqual(manager.updateAgentFlags('missing-agent', { pinned: true }).error, 'Agent not found');

    const permissionRestartStarts = [];
    const permissionRestartKills = [];
    const permissionAuthoritativeRecords = new Map();
    const previousPermissionEnsureAgentSessionRecord = manager.configManager.ensureAgentSessionRecord;
    manager.configManager.ensureAgentSessionRecord = (agent, patch = {}) => {
      const recordId = String(agent.agentRecordId || agent.persistentSessionId || '');
      assert(recordId, 'permission restart test requires a stable canonical Agent record id');
      const existing = permissionAuthoritativeRecords.get(recordId) || {};
      permissionAuthoritativeRecords.set(recordId, {
        ...existing,
        ...agent,
        runtimeAgentId: agent.id,
        composerCommands: JSON.parse(JSON.stringify(agent.composerCommands || [])),
        ...patch,
        id: recordId,
        agentRecordId: recordId,
        persistentSessionId: recordId,
      });
      return recordId;
    };
    let permissionComposerWrites = 0;
    let failNextPermissionRestartStart = false;
    const permissionEngine = {
      async createSession(options) {
        permissionRestartStarts.push(options);
        if (failNextPermissionRestartStart) {
          failNextPermissionRestartStart = false;
          throw new Error('simulated permission replacement start failure');
        }
      },
      async sendInput() {
        permissionComposerWrites += 1;
        return { sent: true };
      },
      async killSession(sessionId) {
        permissionRestartKills.push(sessionId);
        manager.engineBridge.emit('session-exited', {
          sessionId,
          code: 0,
          exitedAt: Date.now(),
        });
        return { killed: true };
      },
      async updateSessionMetadata() {},
      async getSessionState() {
        return null;
      },
    };
    manager.engineBridge.resolve = () => ({
      engineName: 'local',
      engine: permissionEngine,
      spec: { category: 'coding' },
    });
    manager.engineBridge.getEngine = () => permissionEngine;
    const codexPermissionAgentId = 'agent-codex-permissions';
    manager.agents.set(codexPermissionAgentId, {
      id: codexPermissionAgentId,
      command: 'codex',
      forkCommand: 'codex',
      cwd: tmpRoot,
      projectWorkspace: tmpRoot,
      output: '',
      previewText: '',
      previewSnapshot: null,
      previewCols: 80,
      previewRows: 24,
      sessionTitle: '',
      status: 'running',
      engineName: 'local',
      wantsMain: false,
      mainWorkspace: '',
      category: 'coding',
      parentAgentId: '',
      task: 'Codex permission chat',
      workflowTemplate: '',
      source: 'codex-history:codex-session-123',
      customTitle: 'Keep title',
      pinned: true,
      unread: false,
      archived: false,
      archivedAt: null,
      canForkNewWorktree: false,
      validated: true,
      engineStarted: true,
      startedAt: Date.now(),
      providerSessionProvider: 'codex',
      providerSessionId: 'codex-session-123',
      providerSessionTemporary: false,
      agentRecordId: 'agent_record_permission_restart',
      persistentSessionId: 'agent_record_permission_restart',
      runtimeEpoch: 'permission-runtime-before-restart',
    });
    const permissionComposerAdmission = await manager.sendPersistentComposerMessage(
      codexPermissionAgentId,
      'retain this command across permission restart',
      'permission-restart-composer-ledger',
    );
    assert.strictEqual(permissionComposerAdmission.accepted, true);
    assert.strictEqual(permissionComposerWrites, 1);
    const permissionComposerCommands = JSON.parse(JSON.stringify(
      manager.agents.get(codexPermissionAgentId).composerCommands,
    ));
    const permissionAgentRecordId = manager.agents.get(codexPermissionAgentId).agentRecordId;
    assert.strictEqual(permissionAgentRecordId, 'agent_record_permission_restart');

    const runtimePermission = await manager.syncCodexTerminalPermissionMode(codexPermissionAgentId, 'full');
    assert.strictEqual(runtimePermission.error, undefined);
    assert.strictEqual(runtimePermission.restarted, true);
    assert(runtimePermission.restartedAgentId);
    assert.strictEqual(permissionRestartKills.at(-1), codexPermissionAgentId);
    assert(permissionRestartStarts.at(-1).args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert(permissionRestartStarts.at(-1).args.includes('resume'));
    assert(permissionRestartStarts.at(-1).args.includes('codex-session-123'));
    assert.strictEqual(manager.agents.has(codexPermissionAgentId), false);
    const restartedCodex = manager.agents.get(runtimePermission.restartedAgentId);
    assert.strictEqual(restartedCodex.launchPermissionMode, 'full');
    assert.strictEqual(restartedCodex.agentRecordId, permissionAgentRecordId);
    assert.strictEqual(restartedCodex.persistentSessionId, permissionAgentRecordId);
    assert.strictEqual(restartedCodex.customTitle, 'Keep title');
    assert.strictEqual(restartedCodex.pinned, true);
    assert.deepStrictEqual(restartedCodex.composerCommands, permissionComposerCommands);
    assert.deepStrictEqual(restartedCodex.restartedFromAgentIds, [codexPermissionAgentId]);
    const permissionComposerRetry = await manager.sendPersistentComposerMessage(
      runtimePermission.restartedAgentId,
      'retain this command across permission restart',
      'permission-restart-composer-ledger',
    );
    assert.strictEqual(permissionComposerRetry.deduplicated, true);
    assert.strictEqual(
      permissionComposerWrites,
      1,
      'permission restart must not replay an already accepted Terminal Composer request',
    );

    const failedPermissionSnapshots = [];
    const permissionEnsureAgentSessionRecord = manager.configManager.ensureAgentSessionRecord;
    manager.configManager.ensureAgentSessionRecord = (agent, patch = {}) => {
      failedPermissionSnapshots.push({ ...agent, ...patch });
      return permissionEnsureAgentSessionRecord(agent, patch);
    };
    failNextPermissionRestartStart = true;
    let failedPermissionRestart;
    try {
      failedPermissionRestart = await manager.syncCodexTerminalPermissionMode(
        runtimePermission.restartedAgentId,
        'ask',
      );
    } finally {
      manager.configManager.ensureAgentSessionRecord = permissionEnsureAgentSessionRecord;
    }
    assert.match(failedPermissionRestart.error, /simulated permission replacement start failure/);
    const failedPermissionLedgerSnapshots = failedPermissionSnapshots
      .filter(snapshot => Array.isArray(snapshot.composerCommands));
    assert(failedPermissionLedgerSnapshots.length > 0, 'failed permission replacement must persist its rollback state');
    assert.deepStrictEqual(
      failedPermissionLedgerSnapshots.at(-1).composerCommands,
      permissionComposerCommands,
      'failed permission replacement rollback must not overwrite the canonical Composer ledger',
    );
    assert.strictEqual(
      failedPermissionLedgerSnapshots.at(-1).agentRecordId,
      permissionAgentRecordId,
      'failed permission replacement rollback must remain bound to the canonical Agent record',
    );
    assert.strictEqual(
      failedPermissionLedgerSnapshots.at(-1).persistentSessionId,
      permissionAgentRecordId,
    );
    const authoritativePermissionRecord = permissionAuthoritativeRecords.get(permissionAgentRecordId);
    assert(authoritativePermissionRecord, 'permission restart must retain its canonical Agent record');
    assert.deepStrictEqual(
      authoritativePermissionRecord.composerCommands,
      permissionComposerCommands,
      'failed permission replacement must leave the authoritative Composer ledger intact',
    );
    assert.strictEqual(authoritativePermissionRecord.id, permissionAgentRecordId);
    assert.strictEqual(authoritativePermissionRecord.agentRecordId, permissionAgentRecordId);
    assert.strictEqual(authoritativePermissionRecord.persistentSessionId, permissionAgentRecordId);
    assert.strictEqual(
      authoritativePermissionRecord.runtimeAgentId,
      runtimePermission.restartedAgentId,
      'failed replacement rollback must restore the prior canonical runtime owner',
    );
    assert.deepStrictEqual(
      [...permissionAuthoritativeRecords.keys()],
      [permissionAgentRecordId],
      'permission restart must not create a second empty-ledger owner record',
    );
    manager.configManager.ensureAgentSessionRecord = previousPermissionEnsureAgentSessionRecord;

    const pendingCodexSessionId = 'tmp_uuid_11111111-2222-4333-8444-555555555555';
    const pendingCodexPermissionAgentId = 'agent-codex-pending-permissions';
    manager.agents.set(pendingCodexPermissionAgentId, {
      id: pendingCodexPermissionAgentId,
      command: 'codex',
      forkCommand: 'codex',
      cwd: tmpRoot,
      projectWorkspace: tmpRoot,
      output: '',
      previewText: '',
      previewSnapshot: null,
      previewCols: 80,
      previewRows: 24,
      sessionTitle: '',
      status: 'running',
      engineName: 'local',
      wantsMain: false,
      mainWorkspace: '',
      category: 'coding',
      parentAgentId: '',
      task: 'Pending Codex permission chat',
      workflowTemplate: '',
      source: 'ui',
      customTitle: 'Keep pending title',
      pinned: true,
      unread: false,
      archived: false,
      archivedAt: null,
      canForkNewWorktree: false,
      validated: true,
      engineStarted: true,
      startedAt: Date.now(),
      providerSessionProvider: 'codex',
      providerSessionId: pendingCodexSessionId,
      providerSessionTemporary: true,
      terminalInputReceived: false,
    });

    const permissionRestartKillCount = permissionRestartKills.length;
    const permissionRestartStartCount = permissionRestartStarts.length;
    const permissionRestartStates = [];
    const capturePermissionRestartState = () => {
      permissionRestartStates.push(manager.getState().agents.map(agent => ({
        id: agent.id,
        status: agent.status,
      })));
    };
    manager.on('update', capturePermissionRestartState);
    const [pendingCodexPermission, concurrentPendingCodexPermission, conflictingPendingCodexPermission] = await Promise.all([
      manager.syncCodexTerminalPermissionMode(pendingCodexPermissionAgentId, 'ask'),
      manager.syncCodexTerminalPermissionMode(pendingCodexPermissionAgentId, 'ask'),
      manager.syncCodexTerminalPermissionMode(pendingCodexPermissionAgentId, 'full'),
    ]);
    manager.off('update', capturePermissionRestartState);
    assert.strictEqual(pendingCodexPermission.error, undefined);
    assert.strictEqual(pendingCodexPermission.restarted, true);
    assert(pendingCodexPermission.restartedAgentId);
    assert.strictEqual(concurrentPendingCodexPermission.restartedAgentId, pendingCodexPermission.restartedAgentId);
    assert.strictEqual(conflictingPendingCodexPermission.error, 'Permission change already in progress');
    assert.strictEqual(permissionRestartKills.length, permissionRestartKillCount + 1);
    assert.strictEqual(permissionRestartStarts.length, permissionRestartStartCount + 1);
    assert(permissionRestartStates.length > 0);
    assert(permissionRestartStates.every(agents => agents.some(agent => (
      agent.id === pendingCodexPermissionAgentId && agent.status === 'running'
    ) || agent.id === pendingCodexPermission.restartedAgentId)));
    assert.strictEqual(permissionRestartKills.at(-1), pendingCodexPermissionAgentId);
    assert(permissionRestartStarts.at(-1).args.includes('--ask-for-approval'));
    assert(permissionRestartStarts.at(-1).args.includes('untrusted'));
    assert.strictEqual(permissionRestartStarts.at(-1).args.includes('resume'), false);
    assert.strictEqual(permissionRestartStarts.at(-1).args.includes(pendingCodexSessionId), false);
    assert.strictEqual(manager.agents.has(pendingCodexPermissionAgentId), false);
    const restartedPendingCodex = manager.agents.get(pendingCodexPermission.restartedAgentId);
    assert.strictEqual(restartedPendingCodex.launchPermissionMode, 'ask');
    assert.strictEqual(restartedPendingCodex.providerSessionTemporary, true);
    assert.match(restartedPendingCodex.providerSessionId, /^tmp_uuid/);
    assert.strictEqual(restartedPendingCodex.providerSessionSource, 'codex-temporary');
    assert.notStrictEqual(restartedPendingCodex.providerSessionId, pendingCodexSessionId);
    assert.strictEqual(restartedPendingCodex.restartedFromAgentId, pendingCodexPermissionAgentId);
    assert.deepStrictEqual(restartedPendingCodex.restartedFromAgentIds, [pendingCodexPermissionAgentId]);
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === pendingCodexPermission.restartedAgentId).restartedFromAgentId,
      pendingCodexPermissionAgentId
    );
    assert.strictEqual(restartedPendingCodex.customTitle, 'Keep pending title');
    assert.strictEqual(restartedPendingCodex.pinned, true);

    const chainedPendingCodexPermission = await manager.syncCodexTerminalPermissionMode(
      pendingCodexPermission.restartedAgentId,
      'full'
    );
    assert.strictEqual(chainedPendingCodexPermission.error, undefined);
    const chainedPendingCodex = manager.agents.get(chainedPendingCodexPermission.restartedAgentId);
    assert.strictEqual(chainedPendingCodex.providerSessionTemporary, true);
    assert.match(chainedPendingCodex.providerSessionId, /^tmp_uuid/);
    assert.notStrictEqual(chainedPendingCodex.providerSessionId, restartedPendingCodex.providerSessionId);
    assert.strictEqual(chainedPendingCodex.restartedFromAgentId, pendingCodexPermission.restartedAgentId);
    assert.deepStrictEqual(chainedPendingCodex.restartedFromAgentIds, [
      pendingCodexPermissionAgentId,
      pendingCodexPermission.restartedAgentId,
    ]);
    assert.deepStrictEqual(
      manager.getState().agents.find(agent => agent.id === chainedPendingCodexPermission.restartedAgentId).restartedFromAgentIds,
      [pendingCodexPermissionAgentId, pendingCodexPermission.restartedAgentId]
    );
    chainedPendingCodex.terminalInputReceived = true;
    const blockedPermissionRestartStartCount = permissionRestartStarts.length;
    const blockedPermissionRestartKillCount = permissionRestartKills.length;
    const blockedPendingCodexPermission = await manager.syncCodexTerminalPermissionMode(
      chainedPendingCodexPermission.restartedAgentId,
      'ask'
    );
    assert.match(blockedPendingCodexPermission.error, /require a resumable provider session/);
    assert.strictEqual(permissionRestartStarts.length, blockedPermissionRestartStartCount);
    assert.strictEqual(permissionRestartKills.length, blockedPermissionRestartKillCount);

    const claudePermissionAgentId = 'agent-claude-permissions';
    manager.agents.set(claudePermissionAgentId, {
      id: claudePermissionAgentId,
      command: 'claude',
      forkCommand: 'claude',
      cwd: tmpRoot,
      projectWorkspace: tmpRoot,
      output: '',
      previewText: '',
      previewSnapshot: null,
      previewCols: 80,
      previewRows: 24,
      sessionTitle: '',
      status: 'running',
      engineName: 'local',
      wantsMain: false,
      mainWorkspace: '',
      category: 'coding',
      parentAgentId: '',
      task: 'Claude permission chat',
      workflowTemplate: '',
      source: 'claude-history:claude-session-123',
      customTitle: '',
      pinned: false,
      unread: false,
      archived: false,
      archivedAt: null,
      canForkNewWorktree: false,
      validated: true,
      engineStarted: true,
      startedAt: Date.now(),
      providerSessionProvider: 'claude',
      providerSessionId: 'claude-session-123',
      providerSessionTemporary: false,
    });
    const claudePermission = await manager.syncCodexTerminalPermissionMode(claudePermissionAgentId, 'dontAsk');
    assert.strictEqual(claudePermission.error, undefined);
    assert.strictEqual(claudePermission.restarted, true);
    assert.strictEqual(permissionRestartKills.at(-1), claudePermissionAgentId);
    assert.deepStrictEqual(
      permissionRestartStarts.at(-1).args.slice(0, 4),
      ['--permission-mode', 'dontAsk', '--resume', 'claude-session-123']
    );
    assert.strictEqual(manager.agents.get(claudePermission.restartedAgentId).launchPermissionMode, 'dontAsk');

    const unsupportedPermission = await manager.syncCodexTerminalPermissionMode(claudePermission.restartedAgentId, 'full');
    assert.strictEqual(unsupportedPermission.error, 'Unsupported Claude permission mode');

    console.log('✓ AgentManager updates agent display titles, task summaries, and sidebar flags');
  } finally {
    clearInterval(manager.heartbeatInterval);
    manager.engineBridge.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function startAgent(manager, command, workspace, options) {
  return new Promise((resolve, reject) => {
    manager.startAgent(command, workspace, (agentId, error) => {
      if (error) {
        reject(new Error(error));
        return;
      }
      resolve(agentId);
    }, options);
  });
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
