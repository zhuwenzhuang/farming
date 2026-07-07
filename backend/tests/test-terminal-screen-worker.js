const assert = require('assert');
const EventEmitter = require('events');
const TerminalScreenWorker = require('../terminal-screen-worker');

class FakeWorker extends EventEmitter {
  constructor(_workerFile, options = {}) {
    super();
    this.workerData = options.workerData || {};
    this.messages = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
    if (this.workerData.mode === 'throw') {
      throw new Error('fake worker postMessage failed');
    }
    if (this.workerData.mode !== 'respond') return;

    setImmediate(() => {
      this.emit('message', {
        type: 'response',
        requestId: message.requestId,
        payload: { ok: true, type: message.type },
      });
    });
  }

  async terminate() {
    this.terminated = true;
  }
}

FakeWorker.instances = [];

async function withKeepAlive(promise) {
  const timer = setInterval(() => {}, 20);
  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
}

async function run() {
  const worker = new TerminalScreenWorker({ cols: 12, rows: 4 });

  try {
    const previousPackagedRuntime = process.env.FARMING_PACKAGED_RUNTIME;
    try {
      process.env.FARMING_PACKAGED_RUNTIME = '1';
      assert.strictEqual(TerminalScreenWorker.resolveWorkerFile(), 'terminal-screen-worker-thread.js');
    } finally {
      if (previousPackagedRuntime === undefined) {
        delete process.env.FARMING_PACKAGED_RUNTIME;
      } else {
        process.env.FARMING_PACKAGED_RUNTIME = previousPackagedRuntime;
      }
    }

    worker.append('\x1b]0;Claude Code\x07\x1b[1;31mA\x1b[0m \x1b[3;4;38;2;1;2;3;48;5;25mB\x1b[0m\r\none\r\ntwo\r\nthree\r\nfour\r\nfive');
    const state = await worker.getState();

    assert.strictEqual(state.title, 'Claude Code');
    assert.strictEqual(state.previewText, 'two\nthree\nfour\nfive');
    assert.strictEqual(state.cols, 12);
    assert.strictEqual(state.rows, 4);
    assert.ok(state.renderOutput.includes('five'));
    assert.strictEqual(state.previewSnapshot.cells.length, 4);
    assert.deepStrictEqual(state.previewSnapshot.cells[0].slice(0, 3), [
      { char: 't', width: 1 },
      { char: 'w', width: 1 },
      { char: 'o', width: 1 },
    ]);

    const resized = await worker.resize(12, 3);
    assert.strictEqual(resized.previewText, 'three\nfour\nfive');
    assert.strictEqual(resized.rows, 3);
    assert.strictEqual(resized.previewSnapshot.rows, 3);

    const cleared = await worker.clear();
    assert.strictEqual(cleared.previewText, '');
    assert.ok(!cleared.renderOutput.includes('five'), 'cleared worker state should not replay old scrollback');
    assert.strictEqual(cleared.rows, 3);
  } finally {
    await worker.dispose();
  }

  const largeWorker = new TerminalScreenWorker({ cols: 80, rows: 8 });

  try {
    largeWorker.append(`\x1b]0;Large Output Title\x07${'x'.repeat(140 * 1024)}\r\nlarge-output-tail`);
    const largeState = await largeWorker.getState();

    assert.strictEqual(largeState.title, 'Large Output Title');
    assert.ok(largeState.renderOutput.includes('large-output-tail'));
  } finally {
    await largeWorker.dispose();
  }

  const responsive = new TerminalScreenWorker({
    WorkerClass: FakeWorker,
    requestTimeoutMs: 50,
    mode: 'respond',
  });
  const state = await responsive.getState();
  assert.deepStrictEqual(state, { ok: true, type: 'get-state' });
  assert.strictEqual(responsive.pendingRequests.size, 0, 'resolved requests should leave no pending worker state');
  await responsive.dispose();
  assert.strictEqual(responsive.worker.terminated, true, 'dispose should terminate a responsive worker');

  const hanging = new TerminalScreenWorker({
    WorkerClass: FakeWorker,
    requestTimeoutMs: 5,
    mode: 'hang',
  });
  await assert.rejects(
    () => withKeepAlive(hanging.getState()),
    error => error && error.code === 'ETIMEDOUT' && /get-state/.test(error.message),
    'hung terminal screen worker requests should fail with a bounded timeout'
  );
  assert.strictEqual(hanging.pendingRequests.size, 0, 'timed out requests should be removed from pending state');
  hanging.worker.emit('message', {
    type: 'response',
    requestId: 1,
    payload: { ok: false, late: true },
  });
  assert.strictEqual(hanging.pendingRequests.size, 0, 'late worker responses should not recreate pending state');
  await withKeepAlive(hanging.dispose());

  const exiting = new TerminalScreenWorker({
    WorkerClass: FakeWorker,
    requestTimeoutMs: 50,
    mode: 'hang',
  });
  exiting.on('error', () => {});
  const pending = exiting.getState();
  exiting.worker.emit('exit', 1);
  await assert.rejects(
    () => pending,
    /exited unexpectedly/,
    'worker exit should reject outstanding terminal screen requests'
  );
  assert.strictEqual(exiting.pendingRequests.size, 0, 'worker exit should clear pending requests');
  await withKeepAlive(exiting.dispose());

  const throwing = new TerminalScreenWorker({
    WorkerClass: FakeWorker,
    requestTimeoutMs: 50,
    mode: 'throw',
  });
  await assert.rejects(
    () => throwing.getState(),
    /postMessage failed/,
    'postMessage failures should reject the request immediately'
  );
  assert.strictEqual(throwing.pendingRequests.size, 0, 'postMessage failures should not leak pending requests');
  await throwing.dispose();

  const throwingAppend = new TerminalScreenWorker({
    WorkerClass: FakeWorker,
    requestTimeoutMs: 50,
    mode: 'throw',
  });
  const appendErrors = [];
  throwingAppend.on('error', error => appendErrors.push(error));
  assert.doesNotThrow(
    () => throwingAppend.append('append should not escape into the PTY output path'),
    'append postMessage failures must not throw into terminal data handlers'
  );
  assert.strictEqual(appendErrors.length, 0, 'small appends should only post when flushed');
  await assert.rejects(
    () => throwingAppend.getState(),
    /not available/,
    'flushing a failed append should make future screen worker requests unavailable'
  );
  assert.strictEqual(appendErrors.length, 1, 'append flush failures should be reported as non-request worker errors');
  assert.strictEqual(throwingAppend.pendingAppendData, '', 'failed append flushes should drop pending append data');
  assert.doesNotThrow(
    () => throwingAppend.append('later output is dropped after worker failure'),
    'appends after worker failure should be ignored without throwing'
  );
  await throwingAppend.dispose();

  console.log('✓ Terminal screen worker keeps snapshots and fails fast on worker failures');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
