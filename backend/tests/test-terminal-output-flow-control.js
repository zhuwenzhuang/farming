const assert = require('assert');
const NativePtyHost = require('../native-pty-host');
const LocalSessionEngine = require('../local-session-engine');
const { createTerminalGeometryControl } = require('../terminal-geometry-control');
const { createTerminalReducerFlowControl } = require('../terminal-reducer-flow-control');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

function createProcess() {
  return {
    pauseCount: 0,
    resumeCount: 0,
    killCount: 0,
    pause() {
      this.pauseCount += 1;
    },
    resume() {
      this.resumeCount += 1;
    },
    kill() {
      this.killCount += 1;
    },
  };
}

function createSession(id, commits) {
  return {
    id,
    command: 'bash',
    cwd: process.cwd(),
    process: createProcess(),
    output: '',
    outputSeq: 0,
    stateRevision: 0,
    runtimeEpoch: `epoch-${id}`,
    stateProofAvailable: true,
    reducerFlowControl: createTerminalReducerFlowControl({
      highWatermarkBytes: 10,
      lowWatermarkBytes: 4,
      rendererHighWatermarkChars: 10,
      rendererLowWatermarkChars: 4,
    }),
    reducerCommitQueue: Promise.resolve(),
    geometryControl: createTerminalGeometryControl(),
    previewCols: 80,
    previewRows: 24,
    title: '',
    status: 'running',
    terminalBusy: null,
    shellCwd: '',
    shellLastExitCode: null,
    shellLastEvent: '',
    shellCommand: '',
    shellLastCommand: '',
    shellCommandStartedAt: null,
    shellLastCommandStartedAt: null,
    shellLastCommandFinishedAt: null,
    shellLastCommandDurationMs: null,
    shellBusyMarkerPending: '',
    lastActivityAt: Date.now(),
    screenWorker: {
      append(data, stateRevision, outputSeq) {
        const commit = deferred();
        commits.push({ data, stateRevision, outputSeq, ...commit });
        return commit.promise;
      },
    },
  };
}

function createEngine(EngineClass, session) {
  const engine = Object.create(EngineClass.prototype);
  const events = [];
  engine.sessions = new Map([[session.id, session]]);
  if (EngineClass === NativePtyHost) {
    const client = { controllerId: 'test-controller' };
    engine.activeControllerClient = client;
    engine.activeControllerIdentity = { id: 'test-controller', startedAt: 1 };
    engine.emitSessionEvent = (event, payload) => events.push({ event, payload });
    return { engine, events, client };
  }
  engine.emit = (event, payload) => events.push({ event, payload });
  return { engine, events, client: null };
}

async function claim(engine, session, client) {
  const geometry = {
    ownerKey: `owner-${session.id}`,
    claimId: `claim-${session.id}`,
    expectedRuntimeEpoch: session.runtimeEpoch,
  };
  return client
    ? engine.claimSessionGeometry(session.id, geometry, client)
    : engine.claimSessionGeometry(session.id, geometry);
}

async function acknowledge(engine, session, owner, client, charCount) {
  const geometry = {
    ownerKey: owner.ownerKey,
    leaseId: owner.leaseId,
    fence: owner.fence,
    expectedRuntimeEpoch: session.runtimeEpoch,
  };
  return client
    ? engine.acknowledgeSessionOutput(session.id, charCount, geometry, client)
    : engine.acknowledgeSessionOutput(session.id, charCount, geometry);
}

async function activateRenderer(engine, session, owner, client) {
  const geometry = {
    ownerKey: owner.ownerKey,
    leaseId: owner.leaseId,
    fence: owner.fence,
    expectedRuntimeEpoch: session.runtimeEpoch,
  };
  return client
    ? engine.activateSessionRenderer(session.id, geometry, client)
    : engine.activateSessionRenderer(session.id, geometry);
}

async function runOrderedFlowCase(label, EngineClass) {
  const commits = [];
  const session = createSession(`flow-${label}`, commits);
  const { engine, events, client } = createEngine(EngineClass, session);
  const owner = await claim(engine, session, client);
  assert.strictEqual(owner.status, 'owner');
  const ready = await activateRenderer(engine, session, owner, client);
  assert.strictEqual(ready.status, 'renderer-ready-accepted');
  session.process.pauseCount = 0;
  session.process.resumeCount = 0;

  engine.handleSessionData(session.id, '123456');
  engine.handleSessionData(session.id, 'abcdef');
  assert.strictEqual(commits.length, 2);
  assert.strictEqual(session.process.pauseCount, 1, `${label}: reducer lag should pause the PTY once`);
  assert.strictEqual(
    events.filter(event => event.event === 'session-output').length,
    0,
    `${label}: uncommitted reducer output must not be published`,
  );

  commits[1].resolve();
  await tick();
  assert.strictEqual(
    events.filter(event => event.event === 'session-output').length,
    0,
    `${label}: a later reducer completion must not overtake the earlier transition`,
  );

  commits[0].resolve();
  await tick();
  await tick();
  const outputEvents = events.filter(event => event.event === 'session-output');
  assert.deepStrictEqual(
    outputEvents.map(event => ({
      data: event.payload.data,
      outputSeq: event.payload.outputSeq,
      stateRevision: event.payload.stateRevision,
    })),
    [
      { data: '123456', outputSeq: 1, stateRevision: 1 },
      { data: 'abcdef', outputSeq: 2, stateRevision: 2 },
    ],
    `${label}: reducer commits must publish in state-machine order`,
  );
  assert.strictEqual(session.reducerFlowControl.pendingBytes, 0);
  assert.strictEqual(session.reducerFlowControl.unacknowledgedRendererChars, 12);
  const duplicateReady = await activateRenderer(engine, session, owner, client);
  assert.strictEqual(duplicateReady.status, 'renderer-ready-accepted');
  assert.strictEqual(duplicateReady.duplicate, true);
  assert.strictEqual(
    session.reducerFlowControl.unacknowledgedRendererChars,
    12,
    `${label}: duplicate renderer readiness must not erase outstanding renderer debt`,
  );
  assert.strictEqual(
    session.process.resumeCount,
    0,
    `${label}: renderer lag must keep the shared PTY paused after reducer catch-up`,
  );

  const ack = await acknowledge(engine, session, owner, client, 12);
  assert.strictEqual(ack.status, 'output-ack-accepted');
  assert.strictEqual(session.reducerFlowControl.unacknowledgedRendererChars, 0);
  assert.strictEqual(session.process.resumeCount, 1, `${label}: renderer ACK should resume the PTY`);
}

async function runReducerFailureCase(label, EngineClass) {
  const commits = [];
  const session = createSession(`failure-${label}`, commits);
  const { engine, events } = createEngine(EngineClass, session);
  engine.handleSessionData(session.id, 'broken');
  commits[0].reject(new Error('reducer rejected transition'));
  await tick();
  assert.strictEqual(session.stateProofAvailable, false);
  assert.strictEqual(session.process.killCount, 1);
  assert.strictEqual(
    events.filter(event => event.event === 'session-output').length,
    0,
    `${label}: failed reducer output must never be published`,
  );
  const error = events.find(event => event.event === 'session-error');
  assert.match(error.payload.error, /reducer rejected transition/);
  assert.strictEqual(error.payload.fatal, true);
}

async function runTakeoverRecoveryCase(label, EngineClass) {
  const commits = [];
  const session = createSession(`takeover-${label}`, commits);
  const { engine, client } = createEngine(EngineClass, session);
  const firstOwner = await claim(engine, session, client);
  assert.strictEqual(firstOwner.status, 'owner');
  const firstReady = await activateRenderer(engine, session, firstOwner, client);
  assert.strictEqual(firstReady.status, 'renderer-ready-accepted');
  session.process.pauseCount = 0;
  session.process.resumeCount = 0;

  engine.handleSessionData(session.id, '123456');
  engine.handleSessionData(session.id, 'abcdef');
  commits[0].resolve();
  commits[1].resolve();
  await tick();
  await tick();
  assert.strictEqual(session.reducerFlowControl.rendererBlocked, true);
  assert.strictEqual(session.process.pauseCount, 1);

  const secondGeometry = {
    ownerKey: `replacement-${session.id}`,
    claimId: `replacement-claim-${session.id}`,
    expectedRuntimeEpoch: session.runtimeEpoch,
  };
  const secondOwner = await (client
    ? engine.claimSessionGeometry(session.id, secondGeometry, client)
    : engine.claimSessionGeometry(session.id, secondGeometry));
  assert.strictEqual(secondOwner.status, 'owner');
  assert(secondOwner.fence > firstOwner.fence);
  assert.strictEqual(
    session.reducerFlowControl.unacknowledgedRendererChars,
    12,
    `${label}: takeover must retain stale renderer debt until the new renderer commits replay`,
  );
  assert.strictEqual(session.reducerFlowControl.rendererBlocked, true);
  assert.strictEqual(
    session.process.resumeCount,
    0,
    `${label}: owner assignment alone must not resume PTY output`,
  );

  const secondReady = await activateRenderer(engine, session, secondOwner, client);
  assert.strictEqual(secondReady.status, 'renderer-ready-accepted');
  assert.strictEqual(session.reducerFlowControl.unacknowledgedRendererChars, 0);
  assert.strictEqual(session.reducerFlowControl.rendererBlocked, false);
  assert.strictEqual(
    session.process.resumeCount,
    1,
    `${label}: a healthy takeover must release renderer backpressure from the stale owner`,
  );

  const staleAck = await acknowledge(engine, session, firstOwner, client, 12);
  assert.strictEqual(staleAck.status, 'output-ack-rejected');
  assert.strictEqual(staleAck.reason, 'stale-lease');
}

async function run() {
  for (const [label, EngineClass] of [
    ['native', NativePtyHost],
    ['local', LocalSessionEngine],
  ]) {
    await runOrderedFlowCase(label, EngineClass);
    await runTakeoverRecoveryCase(label, EngineClass);
    await runReducerFailureCase(label, EngineClass);
  }
  console.log('terminal output flow-control integration tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
