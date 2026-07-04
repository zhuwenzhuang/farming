const assert = require('assert');
const NativePtyHost = require('../native-pty-host');
const LocalSessionEngine = require('../local-session-engine');

function makeSession(id) {
  const resizeCalls = [];
  return {
    session: {
      id,
      status: 'running',
      process: {
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

  const result = await host.resizeSession(session.id, 120.8, 40.2);

  assert.deepStrictEqual(resizeCalls, [{ cols: 120, rows: 40 }]);
  assert.deepStrictEqual(result, { resized: true, cols: 120, rows: 40 });
  assert.strictEqual(session.previewCols, 120);
  assert.strictEqual(session.previewRows, 40);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].event, 'session-error');
  assert.deepStrictEqual(events[0].payload, {
    sessionId: session.id,
    error: 'Failed to resize terminal screen state: screen worker resize failed',
    fatal: false,
  });
}

async function runLocalResizeCase() {
  const engine = Object.create(LocalSessionEngine.prototype);
  const events = [];
  const { session, resizeCalls } = makeSession('local-resize');
  engine.sessions = new Map([[session.id, session]]);
  engine.emit = (event, payload) => {
    events.push({ event, payload });
  };

  const result = await engine.resizeSession(session.id, 121, 41);

  assert.deepStrictEqual(resizeCalls, [{ cols: 121, rows: 41 }]);
  assert.deepStrictEqual(result, { resized: true, cols: 121, rows: 41 });
  assert.strictEqual(session.previewCols, 121);
  assert.strictEqual(session.previewRows, 41);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].event, 'session-error');
  assert.deepStrictEqual(events[0].payload, {
    sessionId: session.id,
    error: 'Failed to resize terminal screen state: screen worker resize failed',
    fatal: false,
  });

  assert.deepStrictEqual(
    await engine.resizeSession('missing-local-resize', 100, 30),
    { resized: false }
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
