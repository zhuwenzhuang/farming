const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AgentManager = require('../agent-manager');
const { importTsModule } = require('./helpers/import-ts-module');

async function run() {
  const { agentTitle } = importTsModule('src/lib/format.ts');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-rename-'));
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
    const restoredTitleAgentId = await startAgent(manager, 'bash', tmpRoot, {
      wantsMain: false,
      customTitle: `  ${'Restored title '.repeat(8)}  `,
    });
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === restoredTitleAgentId).customTitle,
      'Restored title '.repeat(8).trim().slice(0, 80),
      'a restored custom title should use the same normalization as renameAgent'
    );
    const initialOrderedAgents = manager.getState().agents.filter(agent => agent.projectWorkspace === tmpRoot);
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

    const longTitle = 'x'.repeat(100);
    const truncated = manager.renameAgent(agentId, longTitle);
    assert.strictEqual(truncated.customTitle.length, 80);

    const cleared = manager.renameAgent(agentId, '   ');
    assert.strictEqual(cleared.customTitle, '');
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === agentId).customTitle,
      ''
    );

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
      'Main Agent cannot be archived'
    );
    assert.strictEqual(manager.updateAgentFlags('missing-agent', { pinned: true }).error, 'Agent not found');

    const permissionRestartStarts = [];
    const permissionRestartKills = [];
    manager.engineBridge.resolve = () => ({
      engineName: 'local',
      engine: {
        async createSession(options) {
          permissionRestartStarts.push(options);
        },
      },
      spec: { category: 'coding' },
    });
    manager.engineBridge.getEngine = () => ({
      async killSession(sessionId) {
        permissionRestartKills.push(sessionId);
        manager.engineBridge.emit('session-exited', {
          sessionId,
          code: 0,
          exitedAt: Date.now(),
        });
      },
      async updateSessionMetadata() {},
      async getSessionState() {
        return null;
      },
    });
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
    });

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
    assert.strictEqual(restartedCodex.customTitle, 'Keep title');
    assert.strictEqual(restartedCodex.pinned, true);
    assert.deepStrictEqual(restartedCodex.restartedFromAgentIds, [codexPermissionAgentId]);

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
    assert(restartedPendingCodex.providerSessionId.startsWith('tmp_uuid_'));
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
    assert.strictEqual(chainedPendingCodex.restartedFromAgentId, pendingCodexPermission.restartedAgentId);
    assert.deepStrictEqual(chainedPendingCodex.restartedFromAgentIds, [
      pendingCodexPermissionAgentId,
      pendingCodexPermission.restartedAgentId,
    ]);
    assert.deepStrictEqual(
      manager.getState().agents.find(agent => agent.id === chainedPendingCodexPermission.restartedAgentId).restartedFromAgentIds,
      [pendingCodexPermissionAgentId, pendingCodexPermission.restartedAgentId]
    );

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
