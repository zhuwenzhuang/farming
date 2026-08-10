const assert = require('assert');

const { settleForkChildStart } = require('../fork-operation-coordinator.cjs');

async function run() {
  const callbackSuccess = await settleForkChildStart(callback => {
    callback('agent-callback');
    return Promise.resolve('agent-promise');
  }, 'start failed');
  assert.deepStrictEqual(callbackSuccess, {
    agentId: 'agent-callback',
    error: '',
    uncertain: false,
  });

  const promiseSuccess = await settleForkChildStart(
    () => Promise.resolve('agent-promise'),
    'start failed',
  );
  assert.deepStrictEqual(promiseSuccess, {
    agentId: 'agent-promise',
    error: '',
    uncertain: false,
  });

  const definitiveFailure = await settleForkChildStart(callback => {
    callback(null, 'provider rejected start');
    return Promise.resolve(null);
  }, 'start failed');
  assert.deepStrictEqual(definitiveFailure, {
    agentId: null,
    error: 'provider rejected start',
    uncertain: false,
  });

  const retainedAgent = await settleForkChildStart(callback => {
    callback('agent-retained', 'start commit failed');
    return Promise.resolve('agent-retained');
  }, 'start failed');
  assert.deepStrictEqual(retainedAgent, {
    agentId: 'agent-retained',
    error: 'start commit failed',
    uncertain: false,
  });

  const rejectedStart = await settleForkChildStart(
    () => Promise.reject(new Error('start transport failed')),
    'start failed',
  );
  assert.deepStrictEqual(rejectedStart, {
    agentId: null,
    error: 'start transport failed',
    uncertain: true,
  });

  const thrownStart = await settleForkChildStart(() => {
    throw new Error('start threw');
  }, 'start failed');
  assert.deepStrictEqual(thrownStart, {
    agentId: null,
    error: 'start threw',
    uncertain: true,
  });
}

run().then(() => {
  console.log('fork child start tests passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
