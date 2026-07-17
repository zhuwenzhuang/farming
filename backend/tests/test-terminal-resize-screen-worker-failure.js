const assert = require('assert');
const NativePtyHost = require('../native-pty-host');
const LocalSessionEngine = require('../local-session-engine');
const { createTerminalGeometryControl } = require('../terminal-geometry-control');

function makeSession(id) {
  const resizeCalls = [];
  return {
    session: {
      id,
      status: 'running',
      stateRevision: 0,
      outputSeq: 0,
      runtimeEpoch: `${id}-epoch`,
      stateProofAvailable: true,
      reducerCommitQueue: Promise.resolve(),
      geometryControl: createTerminalGeometryControl(),
      process: {
        pause() {},
        resume() {},
        resize(cols, rows) {
          resizeCalls.push({ cols, rows });
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
  const lease = await host.claimSessionGeometry(session.id, {
    ownerKey: 'test-owner',
    claimId: 'test-claim',
    expectedRuntimeEpoch: session.runtimeEpoch,
  }, client);
  session.geometryControl.rendererReadyFence = lease.fence;

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
  const lease = await engine.claimSessionGeometry(session.id, {
    ownerKey: 'test-owner',
    claimId: 'test-claim',
    expectedRuntimeEpoch: session.runtimeEpoch,
  });
  session.geometryControl.rendererReadyFence = lease.fence;

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
  });
  assert.strictEqual(session.stateProofAvailable, false);

  assert.deepStrictEqual(
    await engine.resizeSession('missing-local-resize', 100, 30, {}),
    { status: 'resize-rejected', reason: 'session-unavailable', resized: false }
  );
}

async function run() {
  await runNativeResizeCase();
  await runLocalResizeCase();
  console.log('✓ Terminal resize survives screen worker resize failures');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
