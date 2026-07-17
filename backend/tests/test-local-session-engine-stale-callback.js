const assert = require('assert');
const LocalSessionEngine = require('../local-session-engine');

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function run() {
  const engine = Object.create(LocalSessionEngine.prototype);
  const snapshot = deferred();
  const events = [];
  engine.emit = (event, payload) => events.push({ event, payload });

  const oldSession = {
    id: 'reused-session-id',
    status: 'running',
    output: 'old output',
    renderOutput: 'old render',
    previewText: 'old preview',
    previewSnapshot: null,
    previewCols: 80,
    previewRows: 24,
    title: 'old title',
    stateProofAvailable: true,
    process: { pause() {}, resume() {} },
    screenWorker: {
      getState: () => snapshot.promise,
      dispose: async () => {},
    },
  };
  const replacement = {
    id: oldSession.id,
    status: 'running',
    output: 'replacement output',
    stateProofAvailable: true,
  };
  engine.sessions = new Map([[oldSession.id, oldSession]]);

  const pendingExit = engine.handleSessionExit(oldSession, 0);
  engine.sessions.set(oldSession.id, replacement);
  engine.handleSessionData(oldSession.id, 'late old PTY data', oldSession);
  snapshot.resolve({ renderOutput: 'late old snapshot', previewText: 'late old preview' });
  await pendingExit;

  assert.strictEqual(replacement.status, 'running');
  assert.strictEqual(replacement.output, 'replacement output');
  assert.deepStrictEqual(events, [], 'callbacks from an old PTY instance must not mutate or exit its replacement');
  console.log('✓ Local PTY callbacks are fenced by the exact session instance');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
