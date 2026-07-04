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
  });

  manager.engineBridge.resolve = () => ({
    engineName: 'local',
    engine: {
      async createSession() {},
    },
    spec: { category: 'shell' },
  });

  try {
    const agentId = await startAgent(manager, 'bash', tmpRoot, { wantsMain: false });

    const renamed = manager.renameAgent(agentId, '  Investigate parser bug  ');
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
