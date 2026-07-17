const assert = require('assert');
const NativePtyHost = require('../native-pty-host');
const LocalSessionEngine = require('../local-session-engine');
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

function createSession(id, commits) {
  return {
    id,
    command: 'bash',
    cwd: process.cwd(),
    process: {
      pauseCount: 0,
      resumeCount: 0,
      killCount: 0,
      pause() { this.pauseCount += 1; },
      resume() { this.resumeCount += 1; },
      kill() { this.killCount += 1; },
    },
    output: '',
    outputSeq: 0,
    stateRevision: 0,
    runtimeEpoch: `epoch-${id}`,
    stateProofAvailable: true,
    reducerFlowControl: createTerminalReducerFlowControl({
      highWatermarkBytes: 10,
      lowWatermarkBytes: 4,
    }),
    reducerCommitQueue: Promise.resolve(),
    previewCols: 80,
    previewRows: 24,
    title: '',
    status: 'running',
    terminalBusy: null,
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
    engine.emitSessionEvent = (event, payload) => events.push({ event, payload });
  } else {
    engine.emit = (event, payload) => events.push({ event, payload });
  }
  return { engine, events };
}

async function runOrderedFlowCase(label, EngineClass) {
  const commits = [];
  const session = createSession(`flow-${label}`, commits);
  const { engine, events } = createEngine(EngineClass, session);

  engine.handleSessionData(session.id, '123456');
  engine.handleSessionData(session.id, 'abcdef');
  assert.strictEqual(commits.length, 2);
  assert.strictEqual(session.process.pauseCount, 1, `${label}: reducer backlog should pause the PTY`);
  assert.strictEqual(events.filter(event => event.event === 'session-output').length, 0);

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
  assert.deepStrictEqual(outputEvents.map(event => ({
    data: event.payload.data,
    outputSeq: event.payload.outputSeq,
    stateRevision: event.payload.stateRevision,
  })), [
    { data: '123456', outputSeq: 1, stateRevision: 1 },
    { data: 'abcdef', outputSeq: 2, stateRevision: 2 },
  ]);
  assert.strictEqual(session.reducerFlowControl.pendingBytes, 0);
  assert.strictEqual(session.process.resumeCount, 1, `${label}: reducer catch-up should resume the PTY`);
}

async function runReducerFailureCase(label, EngineClass) {
  const commits = [];
  const session = createSession(`failure-${label}`, commits);
  const { engine, events } = createEngine(EngineClass, session);
  engine.handleSessionData(session.id, 'broken');
  commits[0].reject(new Error('reducer rejected transition'));
  await tick();
  await tick();
  assert.strictEqual(session.stateProofAvailable, false);
  assert.strictEqual(session.process.killCount, 1);
  assert.strictEqual(events.filter(event => event.event === 'session-output').length, 0);
  const error = events.find(event => event.event === 'session-error');
  assert.match(error.payload.error, /reducer rejected transition/);
  assert.strictEqual(error.payload.fatal, true);
}

async function run() {
  for (const [label, EngineClass] of [
    ['native', NativePtyHost],
    ['local', LocalSessionEngine],
  ]) {
    await runOrderedFlowCase(label, EngineClass);
    await runReducerFailureCase(label, EngineClass);
  }
  console.log('terminal output flow-control integration tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
