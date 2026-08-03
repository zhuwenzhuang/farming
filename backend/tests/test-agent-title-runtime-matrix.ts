const assert = require('assert');
const AgentManager = require('../agent-manager.cjs');

function runtimeBinding(kind) {
  if (kind === 'terminal') return { kind: 'terminal' };
  return {
    kind: 'acp',
    state: 'idle',
    error: '',
    stopReason: '',
    supportsSteer: false,
    supportsFork: false,
    pendingPermission: null,
    pendingPermissions: [],
    pendingElicitation: null,
    pendingElicitations: [],
    activeElicitations: [],
    sessionUpdatedAt: '',
    sessionRevision: 0,
  };
}

async function run() {
  const persisted = [];
  const manager = new AgentManager({
    getWorkspace: () => process.cwd(),
    getHeartbeatInterval: () => 60_000,
    getCodingAgentEngine: () => 'local',
    getVtBaseUrl: () => 'http://localhost:4020',
    getDangerouslySkipAgentPermissionsByDefault: () => false,
    ensureAgentSessionRecord(agent, patch = {}) {
      persisted.push({ ...agent, ...patch });
      return agent.agentRecordId || `agent_record_${agent.id}`;
    },
  }, { skipExecutablePreflight: true });

  const cases = [
    ['codex', 'codex'],
    ['claude', 'claude'],
    ['opencode', 'opencode'],
    ['qoder', 'qoder'],
    ['qwen', 'qwen'],
  ].flatMap(([provider, command]) => [
    { provider, command, runtime: 'terminal' },
    { provider, command, runtime: 'acp' },
  ]).concat([{ provider: '', command: 'bash', runtime: 'terminal' }]);

  try {
    for (const [index, testCase] of cases.entries()) {
      const id = `agent-title-${testCase.provider || 'shell'}-${testCase.runtime}`;
      const token = `title-token-${index}`;
      manager.agents.set(id, {
        id,
        command: testCase.command,
        forkCommand: testCase.command,
        cwd: process.cwd(),
        projectWorkspace: process.cwd(),
        output: '',
        previewText: '',
        previewCols: 80,
        previewRows: 24,
        sessionTitle: 'First prompt fallback',
        adaptiveTitle: '',
        customTitle: '',
        status: 'running',
        engineName: 'local',
        engineStarted: false,
        wantsMain: false,
        category: testCase.provider ? 'coding' : 'other',
        task: 'First prompt fallback',
        source: 'ui',
        providerSessionProvider: testCase.provider,
        providerSessionId: testCase.provider ? `${testCase.provider}-session` : '',
        providerSessionTemporary: false,
        runtimeBinding: runtimeBinding(testCase.runtime),
        titleUpdateToken: token,
        validated: true,
        startedAt: Date.now(),
      });
      manager.lastActivity.set(id, Date.now());

      const title = `${testCase.provider || 'Shell'} ${testCase.runtime} title`;
      const result = manager.setAgentAdaptiveTitle(id, title, token);
      assert.strictEqual(result.error, undefined, `${id} should accept its own runtime title`);
      const publicAgent = manager.getState().agents.find(agent => agent.id === id);
      assert.strictEqual(publicAgent.adaptiveTitle, title);

      manager.agents.get(id).customTitle = 'User title';
      assert.strictEqual(
        manager.getState().agents.find(agent => agent.id === id).customTitle,
        'User title',
        `${id} must retain the user-rename source alongside its adaptive title`,
      );
    }

    assert.strictEqual(persisted.length, cases.length);
    assert(persisted.every(record => record.adaptiveTitle), 'every runtime title should be durable');
    console.log('✓ Agent-managed titles cover every provider in Terminal and ACP Chat');
  } finally {
    clearInterval(manager.heartbeatInterval);
    await manager.engineBridge.dispose();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
