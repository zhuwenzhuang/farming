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
    },
  });

  try {
    const now = 1_000_000;
    const windowMs = 5 * 60 * 1000;
    manager.outputEvents.set('agent-1', [
      { timestamp: now - windowMs - 1, bytes: 400 },
      { timestamp: now - 10_000, bytes: 40 },
    ]);

    const activeRate = manager.calculateAgentUsageRate('agent-1', { now, windowMs });
    assert.strictEqual(activeRate.outputBytes, 40);
    assert.strictEqual(activeRate.estimatedOutputTokens, 10);
    assert.strictEqual(manager.outputEvents.get('agent-1').length, 1);

    const idleRate = manager.calculateAgentUsageRate('agent-1', { now: now + windowMs + 20_000, windowMs });
    assert.strictEqual(idleRate.outputBytes, 0);
    assert.strictEqual(idleRate.estimatedOutputTokens, 0);
    assert.strictEqual(idleRate.estimatedTokensPerMinute, 0);
    assert.strictEqual(manager.outputEvents.has('agent-1'), false);

    console.log('✓ agent output usage rate expires stale events');
  } finally {
    clearInterval(manager.heartbeatInterval);
    manager.engineBridge.dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
