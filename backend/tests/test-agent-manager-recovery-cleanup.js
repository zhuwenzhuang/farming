const assert = require('assert');
const EventEmitter = require('events');
const sessionEngineBridgePath = require.resolve('../session-engine-bridge');

class FakeSessionEngineBridge extends EventEmitter {
  async recoverSessions() {
    return [];
  }

  async killSession() {}

  dispose() {}
}

require.cache[sessionEngineBridgePath] = {
  id: sessionEngineBridgePath,
  filename: sessionEngineBridgePath,
  loaded: true,
  exports: FakeSessionEngineBridge,
};

const AgentManager = require('../agent-manager');

function configManager() {
  return {
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
  };
}

async function run() {
  const killed = [];
  const manager = new AgentManager(configManager());
  manager.engineBridge = {
    async recoverSessions() {
      return [
        {
          engineName: 'native',
          agentId: 'recovered-codex',
          metadata: {
            agentId: 'recovered-codex',
            command: 'codex',
            cwd: '/repo',
            category: 'coding',
            source: 'ui',
            launchPermissionMode: 'full',
          },
          state: { status: 'running', startedAt: 1234 },
        },
        {
          engineName: 'native',
          agentId: 'untracked-bash',
          metadata: {
            agentId: 'untracked-bash',
            command: 'bash',
            cwd: '/repo',
            category: 'other',
            source: 'ui',
          },
          state: { status: 'running', startedAt: 2345 },
        },
        {
          engineName: 'native',
          agentId: 'untracked-shell-category',
          metadata: {
            agentId: 'untracked-shell-category',
            command: 'codex',
            cwd: '/repo',
            category: 'shell',
            source: 'ui',
          },
          state: { status: 'running', startedAt: 3456 },
        },
      ];
    },
    async killSession(engineName, sessionId) {
      killed.push({ engineName, sessionId });
    },
    getEngine() {
      return null;
    },
    dispose() {},
  };

  try {
    await manager.recoverEngineSessions();

    assert(manager.agents.has('recovered-codex'), 'recoverable coding sessions should be restored');
    assert.strictEqual(manager.agents.get('recovered-codex').launchPermissionMode, 'full');
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === 'recovered-codex').launchPermissionMode,
      'full'
    );
    assert.strictEqual(manager.agents.has('untracked-bash'), false, 'shell sessions should not be restored');
    assert.strictEqual(manager.agents.has('untracked-shell-category'), false, 'shell-category sessions should not be restored');
    assert.deepStrictEqual(
      killed,
      [
        { engineName: 'native', sessionId: 'untracked-bash' },
        { engineName: 'native', sessionId: 'untracked-shell-category' },
      ],
      'unrecovered shell sessions should be killed so the native pty host cannot accumulate invisible PTYs'
    );
  } finally {
    await manager.dispose({ preserveTerminalHost: true });
  }

  console.log('✓ Agent manager kills unrecovered shell sessions during native recovery');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
