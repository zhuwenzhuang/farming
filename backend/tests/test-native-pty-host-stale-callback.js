const assert = require('assert');
const EventEmitter = require('events');
const NativePtyHost = require('../native-pty-host');

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function run() {
  const host = Object.create(NativePtyHost.prototype);
  const snapshot = deferred();
  const events = [];
  host.emitSessionEvent = (event, payload) => events.push({ event, payload });

  const screenWorker = new EventEmitter();
  screenWorker.getState = () => snapshot.promise;
  screenWorker.dispose = async () => {};
  const oldSession = {
    id: 'reused-native-session-id',
    status: 'running',
    output: 'old output',
    renderOutput: 'old render',
    previewText: 'old preview',
    previewSnapshot: null,
    previewCols: 80,
    previewRows: 24,
    title: 'old title',
    stateProofAvailable: true,
    process: { kill() {}, pause() {}, resume() {} },
    screenWorker,
  };
  const replacement = {
    id: oldSession.id,
    status: 'running',
    output: 'replacement output',
    previewText: 'replacement preview',
    stateProofAvailable: true,
  };
  host.sessions = new Map([[oldSession.id, oldSession]]);
  host.bindScreenWorker(oldSession);

  const pendingExit = host.handleSessionExit(oldSession.id, 0, oldSession);
  host.sessions.set(oldSession.id, replacement);
  host.handleSessionData(oldSession.id, 'late old PTY data', oldSession);
  screenWorker.emit('preview', {
    previewText: 'late old preview',
    title: 'late old title',
    cols: 120,
    rows: 40,
    previewSnapshot: { rows: ['late old preview'] },
  });
  screenWorker.emit('error', new Error('late old reducer failure'));
  snapshot.resolve({ renderOutput: 'late old snapshot', previewText: 'late old preview' });
  await pendingExit;

  assert.strictEqual(replacement.status, 'running');
  assert.strictEqual(replacement.output, 'replacement output');
  assert.strictEqual(replacement.previewText, 'replacement preview');
  assert.strictEqual(replacement.stateProofAvailable, true);
  assert.deepStrictEqual(events, [], 'callbacks from an old native PTY must not mutate or exit its replacement');

  let delayedKill = null;
  let replacementKillCount = 0;
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback) => {
    delayedKill = callback;
    return { unref() {} };
  };
  try {
    const stoppingSession = {
      id: 'reused-kill-session-id',
      status: 'running',
      process: { kill() {} },
    };
    const killReplacement = {
      id: stoppingSession.id,
      status: 'running',
      process: { kill() { replacementKillCount += 1; } },
    };
    host.sessions.set(stoppingSession.id, stoppingSession);
    await host.killSession(stoppingSession.id);
    host.sessions.set(stoppingSession.id, killReplacement);
    delayedKill();
    assert.strictEqual(replacementKillCount, 0, 'an old SIGKILL timer must not kill a replacement runtime');
  } finally {
    global.setTimeout = originalSetTimeout;
  }
  console.log('✓ Native PTY callbacks are fenced by the exact session instance');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
