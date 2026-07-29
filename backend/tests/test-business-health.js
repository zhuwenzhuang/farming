const assert = require('assert');
const {
  probeAgentManagerBusinessHealth,
} = require('../business-health.cjs');

async function run() {
  const ready = await probeAgentManagerBusinessHealth({
    whenRecovered: async () => {},
    getState: () => ({ agents: [{ id: 'agent-1' }], mainAgentId: 'agent-1' }),
  });
  assert.deepStrictEqual(ready, {
    status: 'ready',
    agentCount: 1,
    mainAgentId: 'agent-1',
  });

  const recovering = await probeAgentManagerBusinessHealth({
    whenRecovered: () => new Promise(() => {}),
    getState: () => {
      throw new Error('state must not be read before recovery');
    },
  }, { timeoutMs: 5 });
  assert.deepStrictEqual(recovering, {
    status: 'recovering',
    agentCount: 0,
    mainAgentId: null,
  });

  const failed = await probeAgentManagerBusinessHealth({
    whenRecovered: async () => {
      throw new Error('recovery failed');
    },
    getState: () => ({ agents: [] }),
  });
  assert.deepStrictEqual(failed, {
    status: 'failed',
    agentCount: 0,
    mainAgentId: null,
  });

  const stopping = await probeAgentManagerBusinessHealth({
    disposed: true,
    whenRecovered: async () => {},
    getState: () => ({ agents: [] }),
  });
  assert.deepStrictEqual(stopping, {
    status: 'stopping',
    agentCount: 0,
    mainAgentId: null,
  });

  console.log('business health tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
