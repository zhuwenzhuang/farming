const assert = require('assert');
const AgentManager = require('../agent-manager');

async function run() {
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
    }
  });

  const zombieMs = AgentManager.ZOMBIE_IDLE_MS;
  const now = Date.now();

  try {
    manager.mainAgentId = 'main-1';
    manager.agents.set('main-1', {
      id: 'main-1',
      command: 'bash',
      cwd: '/',
      output: '',
      status: 'running',
      engineName: 'local'
    });
    manager.lastActivity.set('main-1', now - zombieMs - 60_000);

    const mainFromState = manager.getState().agents.find((a) => a.id === 'main-1');
    assert.strictEqual(mainFromState.isZombie, false, 'main never zombie');
    assert.strictEqual(mainFromState.activityLevel, 'warm', 'main fixed warm');
    assert.strictEqual(mainFromState.attentionScore, 0, 'main no attention score');

    manager.agents.set('sub-1', {
      id: 'sub-1',
      command: 'claude',
      cwd: '/',
      output: '',
      status: 'running',
      engineName: 'local'
    });
    manager.lastActivity.set('sub-1', now - zombieMs);
    assert.strictEqual(
      manager.isZombie('sub-1', now),
      false,
      'sub at exactly zombie idle boundary is not zombie (strict > threshold)'
    );

    manager.lastActivity.set('sub-1', now - zombieMs - 1);
    assert.strictEqual(
      manager.isZombie('sub-1', now),
      true,
      'sub beyond zombie idle threshold is zombie'
    );

    console.log('✓ zombie threshold and main exemption behave as expected');
  } finally {
    clearInterval(manager.heartbeatInterval);
    manager.engineBridge.dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
