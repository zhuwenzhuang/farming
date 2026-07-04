const assert = require('assert');
const SessionEngineBridge = require('../session-engine-bridge');

async function run() {
  const bridge = new SessionEngineBridge({});

  try {
    const claudeResolution = bridge.resolve('claude');
    assert.strictEqual(claudeResolution.engineName, 'native');
    assert.strictEqual(claudeResolution.spec.name, 'claude');

    const bashResolution = bridge.resolve('bash');
    assert.strictEqual(bashResolution.engineName, 'native');
    assert.strictEqual(bashResolution.spec.category, 'other');

    const events = [];
    const busyEvents = [];
    bridge.on('session-output', ({ sessionId, data }) => {
      events.push({ sessionId, data });
    });
    bridge.on('session-busy-state', ({ sessionId, terminalBusy }) => {
      busyEvents.push({ sessionId, terminalBusy });
    });

    bridge.emit('session-output', {
      engineName: 'local',
      sessionId: 'agent-1',
      data: 'hello'
    });

    assert.deepStrictEqual(events, [{ sessionId: 'agent-1', data: 'hello' }]);

    bridge.router.engines.local.emit('session-busy-state', {
      sessionId: 'agent-1',
      terminalBusy: true
    });
    assert.deepStrictEqual(busyEvents, [{ sessionId: 'agent-1', terminalBusy: true }]);

    console.log('✓ Session engine bridge resolves and relays engine events');
  } finally {
    bridge.dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
