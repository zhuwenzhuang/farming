const assert = require('assert');
const NativePtyHost = require('../native-pty-host');
const LocalSessionEngine = require('../local-session-engine');
const {
  claimTerminalController,
  createTerminalControllerLease,
} = require('../terminal-controller-lease');

function makeSession(id) {
  const resizeCalls = [];
  const killCalls = [];
  return {
    session: {
      id,
      status: 'running',
      stateRevision: 0,
      outputSeq: 0,
      runtimeEpoch: `${id}-epoch`,
      stateProofAvailable: true,
      reducerCommitQueue: Promise.resolve(),
      controllerLease: createTerminalControllerLease(),
      process: {
        pause() {},
        resume() {},
        resize(cols, rows) {
          resizeCalls.push({ cols, rows });
        },
        kill() {
          killCalls.push(true);
        },
      },
      screenWorker: {
        async resize() {
          throw new Error('screen worker resize failed');
        },
      },
      previewText: 'old preview',
      previewSnapshot: null,
      renderOutput: 'old render',
      previewCols: 80,
      previewRows: 30,
      title: 'old title',
    },
    resizeCalls,
    killCalls,
  };
}

async function runNativeResizeCase() {
  const host = Object.create(NativePtyHost.prototype);
  const events = [];
  const { session, resizeCalls } = makeSession('native-resize');
  host.sessions = new Map([[session.id, session]]);
  host.emitSessionEvent = (event, payload) => {
    events.push({ event, payload });
  };
  const client = {};
  host.activeControllerClient = client;
  host.activeControllerIdentity = { id: 'test-controller', startedAt: 1 };
  client.controllerId = 'test-controller';
  const lease = await host.claimSessionController(session.id, {
    ownerKey: 'test-owner',
    claimId: 'test-claim',
    expectedRuntimeEpoch: session.runtimeEpoch,
  }, client);
  session.controllerLease.rendererReadyFence = lease.fence;

  const result = await host.resizeSession(session.id, 120.8, 40.2, {
    ownerKey: 'test-owner',
    leaseId: lease.leaseId,
    fence: lease.fence,
    requestSeq: 1,
    expectedRuntimeEpoch: session.runtimeEpoch,
  }, client);

  assert.deepStrictEqual(resizeCalls, [{ cols: 120, rows: 40 }]);
  assert.strictEqual(result.status, 'resize-rejected');
  assert.strictEqual(result.reason, 'screen-reducer-failed');
  assert.strictEqual(result.resized, false);
  assert.strictEqual(session.previewCols, 120);
  assert.strictEqual(session.previewRows, 40);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].event, 'session-error');
  assert.deepStrictEqual(events[0].payload, {
    sessionId: session.id,
    error: 'Terminal state reducer failed: screen worker resize failed',
    fatal: true,
    runtimeEpoch: session.runtimeEpoch,
  });
  assert.strictEqual(session.stateProofAvailable, false);
}

async function runLocalResizeCase() {
  const engine = Object.create(LocalSessionEngine.prototype);
  const events = [];
  const { session, resizeCalls } = makeSession('local-resize');
  engine.sessions = new Map([[session.id, session]]);
  engine.emit = (event, payload) => {
    events.push({ event, payload });
  };
  const lease = await engine.claimSessionController(session.id, {
    ownerKey: 'test-owner',
    claimId: 'test-claim',
    expectedRuntimeEpoch: session.runtimeEpoch,
  });
  session.controllerLease.rendererReadyFence = lease.fence;

  const result = await engine.resizeSession(session.id, 121, 41, {
    ownerKey: 'test-owner',
    leaseId: lease.leaseId,
    fence: lease.fence,
    requestSeq: 1,
    expectedRuntimeEpoch: session.runtimeEpoch,
  });

  assert.deepStrictEqual(resizeCalls, [{ cols: 121, rows: 41 }]);
  assert.strictEqual(result.status, 'resize-rejected');
  assert.strictEqual(result.reason, 'screen-reducer-failed');
  assert.strictEqual(result.resized, false);
  assert.strictEqual(session.previewCols, 121);
  assert.strictEqual(session.previewRows, 41);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].event, 'session-error');
  assert.deepStrictEqual(events[0].payload, {
    sessionId: session.id,
    error: 'Terminal state reducer failed: screen worker resize failed',
    fatal: true,
    runtimeEpoch: session.runtimeEpoch,
  });
  assert.strictEqual(session.stateProofAvailable, false);

  assert.deepStrictEqual(
    await engine.resizeSession('missing-local-resize', 100, 30, {}),
    { status: 'resize-rejected', reason: 'session-unavailable', resized: false }
  );
}

async function runClearFailureCase(kind) {
  const target = kind === 'native'
    ? Object.create(NativePtyHost.prototype)
    : Object.create(LocalSessionEngine.prototype);
  const events = [];
  const { session, killCalls } = makeSession(`${kind}-clear`);
  session.screenWorker.clear = async () => {
    throw new Error('screen worker clear failed');
  };
  target.sessions = new Map([[session.id, session]]);
  if (kind === 'native') {
    target.emitSessionEvent = (event, payload) => events.push({ event, payload });
  } else {
    target.emit = (event, payload) => events.push({ event, payload });
  }

  const ownerKey = `${kind}-clear-owner`;
  const lease = claimTerminalController(session, {
    ownerKey,
    claimId: `${kind}-clear-claim`,
    expectedRuntimeEpoch: session.runtimeEpoch,
  });
  session.controllerLease.rendererReadyFence = lease.fence;
  const result = await target.clearBuffer(session.id, {
    ownerKey,
    leaseId: lease.leaseId,
    fence: lease.fence,
    expectedRuntimeEpoch: session.runtimeEpoch,
  });
  assert.deepStrictEqual(result, { cleared: false });
  assert.strictEqual(session.stateProofAvailable, false);
  assert.strictEqual(killCalls.length, 1, 'a failed clear reducer must stop the unprovable PTY runtime');
  assert.deepStrictEqual(events, [{
    event: 'session-error',
    payload: {
      sessionId: session.id,
      error: 'Terminal state reducer failed: screen worker clear failed',
      fatal: true,
      runtimeEpoch: session.runtimeEpoch,
    },
  }]);
}

async function run() {
  await runNativeResizeCase();
  await runLocalResizeCase();
  await runClearFailureCase('native');
  await runClearFailureCase('local');
  console.log('✓ Terminal resize and clear fail closed on screen reducer failures');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
