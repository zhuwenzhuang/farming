const assert = require('assert');
const NativePtyHost = require('../native-pty-host');
const NativePtyHostClient = require('../native-pty-host-client');
const { createTerminalGeometryControl } = require('../terminal-geometry-control');
const {
  createTerminalReducerFlowControl,
} = require('../terminal-reducer-flow-control');
const { deserializeTerminalState } = require('../terminal-state-serialization');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function controlledProcess() {
  return {
    pauseCalls: 0,
    resumeCalls: 0,
    pause() {
      this.pauseCalls += 1;
    },
    resume() {
      this.resumeCalls += 1;
    },
  };
}

function session(id, overrides = {}) {
  return {
    id,
    command: 'bash',
    args: [],
    cwd: '/tmp',
    metadata: { agentId: id, category: 'other' },
    process: controlledProcess(),
    output: `${id}\r\n`,
    outputSeq: 1,
    stateRevision: 1,
    runtimeEpoch: `epoch-${id}`,
    stateProofAvailable: true,
    reducerFlowControl: createTerminalReducerFlowControl(),
    reducerCommitQueue: Promise.resolve(),
    geometryControl: createTerminalGeometryControl(),
    renderOutput: `${id}\r\n`,
    previewText: id,
    previewCols: 80,
    previewRows: 24,
    title: '',
    status: 'running',
    rotationFrozen: false,
    ...overrides,
  };
}

function hostHarness() {
  const host = Object.create(NativePtyHost.prototype);
  host.sessions = new Map();
  host.clients = new Set();
  host.sessionMutationQueues = new Map();
  host.activeControllerMutations = new Set();
  host.activeControllerClient = null;
  host.activeControllerIdentity = null;
  host.rotationPreparation = null;
  host.getSessionState = async (sessionId) => {
    const current = host.sessions.get(sessionId);
    if (!current) return null;
    return {
      sessionId,
      status: current.status,
      runtimeEpoch: current.runtimeEpoch,
      output: current.output,
      outputSeq: current.outputSeq,
      stateRevision: current.stateRevision,
      renderOutput: current.renderOutput,
      previewText: current.previewText,
      previewCols: current.previewCols,
      previewRows: current.previewRows,
      title: current.title,
    };
  };
  host.failSessionScreenState = (current, error) => {
    throw error || new Error(`screen state failed for ${current?.id || 'unknown'}`);
  };
  return host;
}

function registerController(host, id = 'controller-test', generation = 1) {
  const client = {};
  host.registerController(client, { id, generation });
  return client;
}

async function testSerializeFailureFailsClosedAndResumesOldHost() {
  const host = hostHarness();
  const current = session('serialize-failure');
  host.sessions.set(current.id, current);
  host.getSessionState = async () => ({
    sessionId: current.id,
    status: current.status,
    runtimeEpoch: current.runtimeEpoch,
    output: current.output,
    outputSeq: null,
    stateRevision: null,
    renderOutput: current.renderOutput,
    previewText: current.previewText,
    previewCols: current.previewCols,
    previewRows: current.previewRows,
    title: current.title,
  });

  const controllerIdentity = { id: 'controller-fail-closed', generation: 7 };
  const controllerClient = {};
  const rotationClient = new NativePtyHostClient({
    configDir: '/tmp/farming-rotation-transaction-test',
    controllerIdentity,
    hostRotationTimeoutMs: 100,
  });
  rotationClient.socket = {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };

  const methods = [];
  rotationClient.requestOnce = async (method, params = {}) => {
    methods.push(method);
    return host.dispatch(method, params, controllerClient);
  };
  let spawnCalls = 0;
  rotationClient.spawnHost = () => {
    spawnCalls += 1;
  };

  await assert.rejects(
    () => rotationClient.rotateMismatchedHost({
      pid: 1234,
      runtimeIdentity: null,
    }),
    error => (
      error?.code === 'FARMING_NATIVE_HOST_RUNTIME_MISMATCH' &&
      /without a committed terminal checkpoint/.test(error.message)
    ),
  );

  assert(methods.includes('serializeTerminalState'));
  assert(methods.includes('resumeTerminalState'));
  assert.strictEqual(methods.includes('shutdownHost'), false);
  assert.strictEqual(spawnCalls, 0);
  assert.strictEqual(host.rotationPreparation, null);
  assert.strictEqual(current.rotationFrozen, false);
  assert.strictEqual(current.process.pauseCalls, 1);
  assert.strictEqual(current.process.resumeCalls, 1);
}

async function testConcurrentCreateIsIncludedOrRejectedByBarrier() {
  const host = hostHarness();
  const controller = registerController(host, 'controller-create', 8);
  const createGate = deferred();
  const createStarted = deferred();
  const created = session('created-before-cut');

  const inFlightCreate = host.enqueueControllerMutation(created.id, controller, async () => {
    createStarted.resolve();
    await createGate.promise;
    host.sessions.set(created.id, created);
    return { sessionId: created.id, status: created.status };
  });
  await createStarted.promise;

  const preparationPromise = host.serializeTerminalState(controller);
  let lateCreateRan = false;
  const lateCreate = host.enqueueControllerMutation('created-after-cut', controller, () => {
    lateCreateRan = true;
    host.sessions.set('created-after-cut', session('created-after-cut'));
  });

  createGate.resolve();
  await inFlightCreate;
  await assert.rejects(lateCreate, /frozen for runtime rotation/);
  assert.strictEqual(lateCreateRan, false);

  const preparation = await preparationPromise;
  const serialized = deserializeTerminalState(preparation.serializedTerminalState);
  assert.deepStrictEqual(serialized.map(entry => entry.id), [created.id]);
  assert.strictEqual(created.rotationFrozen, true);

  assert.deepStrictEqual(
    host.resumeTerminalState(controller, preparation.preparationToken),
    { resumed: 1 },
  );
  assert.strictEqual(created.rotationFrozen, false);
}

async function testExitDuringCutIsNotSerialized() {
  const host = hostHarness();
  const controller = registerController(host, 'controller-exit', 9);
  const reducerGate = deferred();
  const current = session('exited-during-cut', {
    reducerCommitQueue: reducerGate.promise,
  });
  host.sessions.set(current.id, current);

  const preparationPromise = host.serializeTerminalState(controller);
  while (current.process.pauseCalls === 0) {
    await Promise.resolve();
  }
  current.status = 'exited';
  reducerGate.resolve();

  const preparation = await preparationPromise;
  const serialized = deserializeTerminalState(preparation.serializedTerminalState);
  assert.deepStrictEqual(serialized, []);

  assert.deepStrictEqual(
    host.resumeTerminalState(controller, preparation.preparationToken),
    { resumed: 1 },
  );
}

function testWrongPreparationTokenCannotShutdown() {
  const host = hostHarness();
  const controller = registerController(host, 'controller-token', 10);
  host.sessions.set('token-session', session('token-session'));
  host.rotationPreparation = {
    token: 'correct-token',
    controllerClient: controller,
    phase: 'prepared',
    promise: Promise.resolve(),
    serializedTerminalState: '',
  };

  assert.throws(
    () => host.shutdownHost(
      controller,
      { id: 'controller-token', generation: 10 },
      'wrong-token',
    ),
    /prepared rotation token/,
  );
  assert.strictEqual(host.rotationPreparation.phase, 'prepared');
}

async function run() {
  await testSerializeFailureFailsClosedAndResumesOldHost();
  await testConcurrentCreateIsIncludedOrRejectedByBarrier();
  await testExitDuringCutIsNotSerialized();
  testWrongPreparationTokenCannotShutdown();
  console.log('native PTY rotation transaction tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
