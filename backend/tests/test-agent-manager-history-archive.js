const assert = require('assert');
const AgentManager = require('../agent-manager');

async function run() {
  const appended = [];
  const settings = {
    mainPageSessionKeys: [
      'agent-session:codex:archive-session',
      'agent-session:codex:other-session',
    ],
  };
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
    getSettings() {
      return settings;
    },
    updateSettings(patch) {
      Object.assign(settings, patch);
    },
    appendTaskHistory(entry) {
      appended.push(entry);
    },
  });

  manager.engineBridge.getEngine = () => ({
    killSession: async () => {},
  });

  try {
    const now = Date.now();
    const zombieMs = AgentManager.ZOMBIE_IDLE_MS;

    manager.mainAgentId = 'main-1';
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
    manager.lastActivity.set('main-1', now - zombieMs - 1000);

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
    manager.lastActivity.set('sub-zombie', now - zombieMs - 1000);

    await manager.cleanupZombieAgents();

    assert.strictEqual(manager.agents.has('sub-zombie'), false, 'zombie sub agent should be killed');
    assert.strictEqual(manager.agents.has('main-1'), true, 'main agent should never be auto-killed');
    assert.strictEqual(manager.taskHistory.length, 1, 'zombie kill should create one history entry');
    assert.strictEqual(manager.taskHistory[0].reason, 'zombie-cleanup');
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
    manager.lastActivity.set('sub-manual', now);

    await manager.killAgent('sub-manual');
    assert.strictEqual(manager.taskHistory.length, 2, 'manual kill should also be archived');
    assert.strictEqual(manager.taskHistory[0].reason, 'manual-kill');

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
      providerSessionKey: 'agent-session:codex:archive-session',
      customTitle: 'Named archive run',
      task: 'archive target',
    });
    manager.lastActivity.set('sub-archive', now);

    const archived = await manager.archiveAgent('sub-archive');
    assert.strictEqual(archived.error, undefined);
    assert.strictEqual(archived.archived, true);
    assert.strictEqual(archived.removed, true);
    assert.deepStrictEqual(archived.removedMainPageSessionKeys, ['agent-session:codex:archive-session']);
    assert.deepStrictEqual(
      settings.mainPageSessionKeys,
      ['agent-session:codex:other-session'],
      'archiving a recoverable agent should remove its main-page membership so restart cannot resume it'
    );
    settings.mainPageSessionKeys = [
      'agent-session:claude:key-only-session',
      ...settings.mainPageSessionKeys,
    ];
    assert.deepStrictEqual(
      manager.removeMainPageProviderSessionsForAgents([
        { providerSessionKey: 'agent-session:claude:key-only-session' },
      ]),
      ['agent-session:claude:key-only-session'],
      'archive cleanup should also understand legacy agents that only carry providerSessionKey'
    );
    assert.deepStrictEqual(
      manager.removeMainPageProviderSessionsForAgents([
        { providerSessionKey: 'agent-session:claude:not-present' },
      ]),
      [],
      'archive cleanup should only report session keys that were actually removed from settings'
    );
    assert.deepStrictEqual(settings.mainPageSessionKeys, ['agent-session:codex:other-session']);
    assert.strictEqual(manager.agents.has('sub-archive'), false, 'archived live agents should leave live state');
    assert.strictEqual(manager.taskHistory.length, 3, 'archive should create a history run');
    assert.strictEqual(manager.taskHistory[0].reason, 'manual-archive');
    assert.strictEqual(manager.taskHistory[0].projectWorkspace, '/repo');
    assert.strictEqual(manager.taskHistory[0].title, 'Named archive run');
    assert.strictEqual(manager.taskHistory[0].customTitle, 'Named archive run');

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
    manager.lastActivity.set('shell-archive', now);

    const archivedShell = await manager.archiveAgent('shell-archive');
    assert.strictEqual(archivedShell.error, undefined);
    assert.strictEqual(archivedShell.archived, true);
    assert.strictEqual(manager.agents.has('shell-archive'), false, 'archived shell agents should be destroyed');
    assert.strictEqual(manager.taskHistory.length, 3, 'manual shell archive should not create a history run');
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
    manager.lastActivity.set('shell-kill', now);

    await manager.killAgent('shell-kill');
    assert.strictEqual(manager.agents.has('shell-kill'), false, 'killed shell agents should be destroyed');
    assert.strictEqual(manager.taskHistory.length, 3, 'manual shell kill should not create a history run');
    assert.strictEqual(appended.length, 3, 'manual shell kill should not be persisted to task history');

    manager.recordTaskHistory({
      id: 'shell-process-exit',
      command: 'env TERM=xterm-256color /bin/fish',
      cwd: '/repo',
      status: 'stopped',
      source: 'ui',
    }, { reason: 'process-exit', archivedAt: now });
    assert.strictEqual(manager.taskHistory.length, 3, 'central history recording should reject shell process exits');
    assert.strictEqual(appended.length, 3, 'shell process exits should never be persisted to task history');

    manager.recordTaskHistory({
      id: 'unsupported-process-exit',
      command: 'unknown-agent',
      cwd: '/repo',
      status: 'stopped',
      source: 'ui',
    }, { reason: 'process-exit', archivedAt: now });
    assert.strictEqual(manager.taskHistory.length, 3, 'central history recording should reject unsupported Agents');
    assert.strictEqual(appended.length, 3, 'unsupported Agents should never be persisted to task history');

    assert.strictEqual((await manager.archiveAgent('missing-agent')).error, 'Agent not found');
    assert.strictEqual((await manager.archiveAgent('main-1')).error, 'Main Agent cannot be archived');

    const state = manager.getState();
    assert.strictEqual(Array.isArray(state.taskHistory), true, 'state payload should include taskHistory');
    assert.strictEqual(state.taskHistory.length >= 3, true, 'state should expose archived entries');

    console.log('test-agent-manager-history-archive passed');
  } finally {
    clearInterval(manager.heartbeatInterval);
    manager.engineBridge.dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
