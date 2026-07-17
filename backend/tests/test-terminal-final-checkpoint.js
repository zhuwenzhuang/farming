const assert = require('assert');
const LocalSessionEngine = require('../local-session-engine');
const NativePtyHost = require('../native-pty-host');
const { createTerminalControllerLease } = require('../terminal-controller-lease');
const { createTerminalReducerFlowControl } = require('../terminal-reducer-flow-control');

function createSession(id) {
  const checkpoint = {
    runtimeEpoch: `epoch-${id}`,
    outputSeq: 2,
    stateRevision: 3,
    renderOutput: 'final rendered screen',
    previewText: 'final preview',
    previewSnapshot: { rows: ['final preview'] },
    cols: 91,
    rows: 27,
    title: 'final title',
  };
  return {
    id,
    command: 'bash',
    cwd: process.cwd(),
    status: 'running',
    output: 'raw final output',
    outputSeq: checkpoint.outputSeq,
    stateRevision: checkpoint.stateRevision,
    runtimeEpoch: checkpoint.runtimeEpoch,
    stateProofAvailable: true,
    renderOutput: '',
    previewText: '',
    previewSnapshot: null,
    previewCols: 80,
    previewRows: 24,
    title: '',
    terminalBusy: false,
    controllerLease: createTerminalControllerLease(),
    reducerFlowControl: createTerminalReducerFlowControl(),
    reducerCommitQueue: Promise.resolve(),
    process: { kill() {}, pause() {}, resume() {}, write() {} },
    screenWorker: {
      async getState() { return { ...checkpoint }; },
      async dispose() {},
    },
  };
}

async function runCase(label, EngineClass) {
  const session = createSession(`final-${label}`);
  const engine = Object.create(EngineClass.prototype);
  engine.sessions = new Map([[session.id, session]]);
  engine.terminalExitDataFlushMs = 5;
  let client = null;
  if (EngineClass === NativePtyHost) {
    client = { controllerId: 'final-checkpoint-controller' };
    engine.activeControllerClient = client;
    engine.activeControllerIdentity = { id: client.controllerId, startedAt: 1 };
    engine.emitSessionEvent = () => {};
    engine.scheduleIdleExitIfUnused = () => {};
    await engine.handleSessionExit(session.id, 0, session);
  } else {
    engine.emit = () => {};
    await engine.handleSessionExit(session, 0);
  }

  assert.strictEqual(session.status, 'exited');
  assert(Object.isFrozen(session.finalCheckpoint));
  const attach = client
    ? await engine.getSessionAttachCheckpoint(session.id, client)
    : await engine.getSessionAttachCheckpoint(session.id);
  assert.deepStrictEqual(attach, {
    runtimeEpoch: session.runtimeEpoch,
    outputSeq: 2,
    stateRevision: 3,
    renderOutput: 'final rendered screen',
    previewText: 'final preview',
    previewSnapshot: { rows: ['final preview'] },
    cols: 91,
    rows: 27,
    title: 'final title',
  });
  const state = client
    ? await engine.getSessionState(session.id, client)
    : await engine.getSessionState(session.id);
  assert.strictEqual(state.outputSeq, 2);
  assert.strictEqual(state.stateRevision, 3);
  assert.strictEqual(state.renderOutput, 'final rendered screen');
  const clear = client
    ? await engine.clearBuffer(session.id, null, client)
    : await engine.clearBuffer(session.id);
  assert.strictEqual(clear.cleared, false);
}

function createEngineHarness(EngineClass, session, events) {
  const engine = Object.create(EngineClass.prototype);
  engine.sessions = new Map([[session.id, session]]);
  engine.terminalExitDataFlushMs = 5;
  if (EngineClass === NativePtyHost) {
    const client = { controllerId: `controller-${session.id}`, controllerGeneration: 1 };
    engine.activeControllerClient = client;
    engine.activeControllerIdentity = { id: client.controllerId, generation: 1 };
    engine.emitSessionEvent = (event, payload) => events.push({ event, payload });
    engine.scheduleIdleExitIfUnused = () => {};
    return { engine, client };
  }
  engine.emit = (event, payload) => events.push({ event, payload });
  return { engine, client: null };
}

async function runTrailingDataCase(label, EngineClass) {
  const session = createSession(`trailing-${label}`);
  let workerState = {
    runtimeEpoch: session.runtimeEpoch,
    outputSeq: session.outputSeq,
    stateRevision: session.stateRevision,
    renderOutput: 'before exit',
    previewText: 'before exit',
    previewSnapshot: { rows: ['before exit'] },
    cols: 80,
    rows: 24,
    title: '',
  };
  session.screenWorker = {
    append(data, stateRevision, outputSeq) {
      workerState = {
        ...workerState,
        outputSeq,
        stateRevision,
        renderOutput: `${workerState.renderOutput}${data}`,
        previewText: `${workerState.previewText}${data}`,
      };
      return Promise.resolve({ ...workerState });
    },
    async getState() { return { ...workerState }; },
    async dispose() {},
  };
  const events = [];
  const { engine } = createEngineHarness(EngineClass, session, events);
  const exit = EngineClass === NativePtyHost
    ? engine.handleSessionExit(session.id, 0, session)
    : engine.handleSessionExit(session, 0);
  await new Promise(resolve => setTimeout(resolve, 1));
  engine.handleSessionData(session.id, 'TRAILING_DATA', session);
  await exit;
  assert.strictEqual(session.finalCheckpoint.outputSeq, 3);
  assert.strictEqual(session.finalCheckpoint.stateRevision, 4);
  assert.match(session.finalCheckpoint.renderOutput, /TRAILING_DATA/);
  assert.strictEqual(events.filter(item => item.event === 'session-output').length, 1);
}

async function runCaptureFailureCase(label, EngineClass) {
  const session = createSession(`capture-failure-${label}`);
  session.screenWorker = {
    async getState() { return null; },
    async dispose() {},
  };
  const events = [];
  const { engine, client } = createEngineHarness(EngineClass, session, events);
  if (EngineClass === NativePtyHost) await engine.handleSessionExit(session.id, 1, session);
  else await engine.handleSessionExit(session, 1);
  assert.strictEqual(session.status, 'exited');
  assert.strictEqual(session.stateProofAvailable, false);
  assert.strictEqual(session.finalCheckpoint, undefined);
  assert(events.some(item => item.event === 'session-error' && item.payload.fatal === true));
  assert(events.some(item => (
    item.event === 'session-exited' && item.payload.stateProofAvailable === false
  )));
  assert.strictEqual(events.some(item => item.event === 'session-preview'), false);
  const checkpoint = client
    ? await engine.getSessionAttachCheckpoint(session.id, client)
    : await engine.getSessionAttachCheckpoint(session.id);
  assert.strictEqual(checkpoint, null);
  const state = client
    ? await engine.getSessionState(session.id, client)
    : await engine.getSessionState(session.id);
  assert.strictEqual(state.stateProofAvailable, false);
  assert.strictEqual(state.outputSeq, null);
  assert.strictEqual(state.stateRevision, null);
  assert.strictEqual(state.renderOutput, '');
}

async function run() {
  await runCase('local', LocalSessionEngine);
  await runCase('native', NativePtyHost);
  await runTrailingDataCase('local', LocalSessionEngine);
  await runTrailingDataCase('native', NativePtyHost);
  await runCaptureFailureCase('local', LocalSessionEngine);
  await runCaptureFailureCase('native', NativePtyHost);
  console.log('terminal final checkpoint tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
