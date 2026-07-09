const assert = require('assert');
const EventEmitter = require('events');
const NativeSessionEngine = require('../native-session-engine');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(fn, label, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function run() {
  const recoveringClient = new EventEmitter();
  recoveringClient.canConnectWithoutStartingHost = () => true;
  recoveringClient.disconnect = () => {};

  let recoverStartHost = null;
  recoveringClient.request = async (method, _params, options = {}) => {
    if (method !== 'recoverSessions') return null;
    recoverStartHost = options.startHost;
    return [
      { sessionId: 'session-id-result', state: { status: 'running' } },
      { agentId: 'agent-id-result', state: { status: 'running' } },
      { metadata: { agentId: 'metadata-id-result' }, state: { status: 'running' } },
    ];
  };

  const recoveringEngine = new NativeSessionEngine({ client: recoveringClient });
  try {
    const errors = [];
    recoveringEngine.on('session-error', event => errors.push(event));
    recoveringClient.emit('session-started', { sessionId: 'session-id-result' });
    recoveringClient.emit('session-started', { sessionId: 'agent-id-result' });
    recoveringClient.emit('session-started', { sessionId: 'metadata-id-result' });
    recoveringClient.emit('host-disconnect');

    await waitFor(() => recoverStartHost === true, 'host-disconnect recovery request');
    assert.deepStrictEqual(errors, [], 'recoverable native sessions should not be marked fatal');
  } finally {
    recoveringEngine.dispose();
  }

  const createClient = new EventEmitter();
  createClient.disconnect = () => {};
  let createOptions = null;
  createClient.request = async (method, params) => {
    if (method === 'createSession') createOptions = params.options;
    if (method === 'createSession') return { sessionId: 'created-session-id' };
    return null;
  };

  const createEngine = new NativeSessionEngine({ client: createClient });
  try {
    const errors = [];
    createEngine.on('session-error', event => errors.push(event));
    await createEngine.createSession({ agentId: 'fallback-agent-id' });
    assert.strictEqual(createOptions.shellIntegrationPrepared, true, 'the server should prepare shell startup before a persistent host receives it');
    createClient.emit('host-exit', { code: 9, signal: null });
    assert.strictEqual(errors.length, 1, 'created native session should be tracked by returned sessionId');
    assert.strictEqual(errors[0].sessionId, 'created-session-id');
  } finally {
    createEngine.dispose();
  }

  console.log('✓ Native session engine lifecycle ids are normalized');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
