const assert = require('assert');
const EventEmitter = require('events');
const NativeSessionEngine = require('../native-session-engine');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
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
  const recoveredEpoch = 'farming-runtime-v1:00000000000000000007:recovered';
  recoveringClient.request = async (method, _params, options = {}) => {
    if (method !== 'recoverSessions') return null;
    recoverStartHost = options.startHost;
    return [
      { sessionId: 'session-id-result', state: { status: 'running', runtimeEpoch: recoveredEpoch } },
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
    assert.strictEqual(
      recoveringEngine.activeSessionEpochs.get('session-id-result'),
      recoveredEpoch,
      'startup recovery must retain the runtime epoch used by later disconnect errors',
    );
  } finally {
    recoveringEngine.dispose();
  }

  const epochClient = new EventEmitter();
  epochClient.disconnect = () => {};
  const epochEngine = new NativeSessionEngine({ client: epochClient });
  try {
    const oldEpoch = 'farming-runtime-v1:00000000000000000008:old';
    const newEpoch = 'farming-runtime-v1:00000000000000000009:new';
    epochClient.emit('session-started', { sessionId: 'epoch-session', runtimeEpoch: newEpoch });
    epochClient.emit('session-preview', { sessionId: 'epoch-session', runtimeEpoch: oldEpoch });
    assert.strictEqual(
      epochEngine.activeSessionEpochs.get('epoch-session'),
      newEpoch,
      'derived events from an old runtime must not regress active epoch tracking',
    );
    epochClient.emit('session-exited', { sessionId: 'epoch-session', runtimeEpoch: oldEpoch });
    assert.strictEqual(
      epochEngine.activeSessionIds.has('epoch-session'),
      true,
      'an old runtime exit must not remove the current runtime from active tracking',
    );
    assert.strictEqual(epochEngine.activeSessionEpochs.get('epoch-session'), newEpoch);
  } finally {
    epochEngine.dispose();
  }

  const repeatedClient = new EventEmitter();
  repeatedClient.disconnect = () => {};
  const firstRecovery = deferred();
  const secondRecovery = deferred();
  let recoveryCount = 0;
  repeatedClient.request = async (method) => {
    if (method !== 'recoverSessions') return null;
    recoveryCount += 1;
    return recoveryCount === 1 ? firstRecovery.promise : secondRecovery.promise;
  };
  const repeatedEngine = new NativeSessionEngine({ client: repeatedClient });
  try {
    const errors = [];
    repeatedEngine.on('session-error', event => errors.push(event));
    repeatedClient.emit('session-started', {
      sessionId: 'repeated-session',
      runtimeEpoch: 'repeated-epoch',
    });
    repeatedClient.emit('host-disconnect');
    await waitFor(() => recoveryCount === 1, 'first disconnect recovery');
    repeatedClient.emit('host-disconnect');
    firstRecovery.resolve([{ sessionId: 'repeated-session', state: { status: 'running' } }]);
    await waitFor(() => recoveryCount === 2, 'second disconnect recovery');
    secondRecovery.resolve([]);
    await waitFor(() => errors.length === 1, 'second disconnect fatal result');
    assert.strictEqual(errors[0].sessionId, 'repeated-session');
    assert.strictEqual(errors[0].runtimeEpoch, 'repeated-epoch');
  } finally {
    repeatedEngine.dispose();
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
