const assert = require('assert');
const NativePtyHost = require('../native-pty-host');
const LocalSessionEngine = require('../local-session-engine');
const { coalesceSessionStream } = require('../session-stream-protocol');
const {
  claimTerminalGeometry,
  createTerminalGeometryControl,
} = require('../terminal-geometry-control');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeSession(id, screenWorker) {
  const resizeCalls = [];
  return {
    id,
    status: 'running',
    runtimeEpoch: `${id}-epoch`,
    output: 'D1',
    renderOutput: 'R1',
    outputSeq: 1,
    stateRevision: 1,
    previewText: 'D1',
    previewSnapshot: null,
    previewCols: 80,
    previewRows: 24,
    title: 'terminal',
    lastActivityAt: Date.now(),
    stateProofAvailable: true,
    reducerCommitQueue: Promise.resolve(),
    geometryControl: createTerminalGeometryControl(),
    process: {
      resize(cols, rows) {
        resizeCalls.push({ cols, rows });
      },
      kill() {},
    },
    screenWorker,
    resizeCalls,
  };
}

function createNativeHarness(session) {
  const harness = Object.create(NativePtyHost.prototype);
  const events = [];
  const client = {
    controllerId: 'controller-a',
    controllerGeneration: 1,
  };
  harness.sessions = new Map([[session.id, session]]);
  harness.activeControllerClient = client;
  harness.activeControllerIdentity = { id: 'controller-a', generation: 1 };
  harness.emitSessionEvent = (event, payload) => events.push({ event, payload });
  return { harness, events, client };
}

function createLocalHarness(session) {
  const harness = Object.create(LocalSessionEngine.prototype);
  const events = [];
  harness.sessions = new Map([[session.id, session]]);
  harness.emit = (event, payload) => events.push({ event, payload });
  return { harness, events };
}

function outputAfterMutation(session) {
  session.output += 'D2';
  session.outputSeq += 1;
  session.stateRevision += 1;
}

async function verifyResizeExactCut(kind) {
  const resizeResult = deferred();
  const session = makeSession(`${kind}-resize-cut`, {
    resize() {
      return resizeResult.promise;
    },
  });
  const { harness, events, client } = kind === 'native'
    ? createNativeHarness(session)
    : createLocalHarness(session);
  const ownerKey = 'owner-a';
  const lease = await (kind === 'native'
    ? harness.claimSessionGeometry(session.id, {
        ownerKey,
        claimId: 'claim-a',
        expectedRuntimeEpoch: session.runtimeEpoch,
      }, client)
    : claimTerminalGeometry(session, {
        ownerKey,
        claimId: 'claim-a',
        expectedRuntimeEpoch: session.runtimeEpoch,
      }));
  session.geometryControl.rendererReadyFence = lease.fence;

  const pending = kind === 'native'
    ? harness.resizeSession(session.id, 120, 40, {
        ownerKey,
        leaseId: lease.leaseId,
        fence: lease.fence,
        requestSeq: 1,
        expectedRuntimeEpoch: session.runtimeEpoch,
      }, client)
    : harness.resizeSession(session.id, 120, 40, {
        ownerKey,
        leaseId: lease.leaseId,
        fence: lease.fence,
        requestSeq: 1,
        expectedRuntimeEpoch: session.runtimeEpoch,
      });

  outputAfterMutation(session);
  resizeResult.resolve({
    runtimeEpoch: session.runtimeEpoch,
    outputSeq: 1,
    stateRevision: 2,
    renderOutput: 'R1-at-resize',
    previewText: 'D1',
    previewSnapshot: null,
    cols: 120,
    rows: 40,
    title: 'terminal',
  });
  const result = await pending;
  const transition = events.find(event => event.event === 'session-transition')?.payload;
  assert.deepStrictEqual(transition, {
    sessionId: session.id,
    kind: 'resize',
    data: '',
    runtimeEpoch: session.runtimeEpoch,
    outputSeq: 1,
    stateRevision: 2,
    cols: 120,
    rows: 40,
  });
  assert.strictEqual(result.status, 'resize-committed');
  assert.strictEqual(result.outputSeq, 1);
  assert.strictEqual(result.stateRevision, 2);
}

async function verifyClearExactCut(kind) {
  const clearResult = deferred();
  const session = makeSession(`${kind}-clear-cut`, {
    clear() {
      return clearResult.promise;
    },
  });
  const { harness, events } = kind === 'native'
    ? createNativeHarness(session)
    : createLocalHarness(session);

  const pending = harness.clearBuffer(session.id);
  outputAfterMutation(session);
  clearResult.resolve({
    runtimeEpoch: session.runtimeEpoch,
    outputSeq: 1,
    stateRevision: 2,
    renderOutput: '',
    previewText: '',
    previewSnapshot: null,
    cols: 80,
    rows: 24,
    title: 'terminal',
  });
  const result = await pending;
  const transition = events.find(event => event.event === 'session-transition')?.payload;
  assert.deepStrictEqual(transition, {
    sessionId: session.id,
    kind: 'clear',
    data: '\x1b[2J\x1b[3J\x1b[H',
    runtimeEpoch: session.runtimeEpoch,
    outputSeq: 1,
    stateRevision: 2,
    cols: 80,
    rows: 24,
  });
  assert.deepStrictEqual(result, {
    cleared: true,
    runtimeEpoch: session.runtimeEpoch,
    outputSeq: 1,
    stateRevision: 2,
    cols: 80,
    rows: 24,
    expiresAt: 0,
  });

  const coalesced = coalesceSessionStream(
    {
      agentId: session.id,
      ...transition,
    },
    {
      agentId: session.id,
      data: 'D2',
      runtimeEpoch: session.runtimeEpoch,
      outputSeq: 2,
      stateRevision: 3,
    },
  );
  assert.strictEqual(coalesced.data, '\x1b[2J\x1b[3J\x1b[H' + 'D2');
  assert.strictEqual(coalesced.outputSeq, 2);
  assert.strictEqual(coalesced.stateRevision, 3);
  assert.deepStrictEqual(coalesced.chunks.map(chunk => chunk.kind), ['clear', 'output']);
}

async function run() {
  await verifyResizeExactCut('native');
  await verifyResizeExactCut('local');
  await verifyClearExactCut('native');
  await verifyClearExactCut('local');
  console.log('terminal mutation exact-cut tests passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
