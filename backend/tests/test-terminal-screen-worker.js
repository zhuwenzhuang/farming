const assert = require('assert');
const EventEmitter = require('events');
const TerminalScreenWorker = require('../terminal-screen-worker');

class FakeWorker extends EventEmitter {
  constructor(workerFile, options = {}) {
    super();
    this.workerFile = workerFile;
    this.eval = options.eval === true;
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

    await worker.setRuntimeEpoch('runtime-epoch-7', 12, 4);
    await worker.append(
      '\x1b]0;Claude Code\x07\x1b[1;31mA\x1b[0m \x1b[3;4;38;2;1;2;3;48;5;25mB\x1b[0m\r\none\r\ntwo\r\nthree\r\nfour\r\nfive',
      1,
      1,
    );
    const state = await worker.getState();
    assert.strictEqual(state.runtimeEpoch, 'runtime-epoch-7');
    assert.strictEqual(state.outputSeq, 1);
    assert.strictEqual(state.stateRevision, 1);

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

    const resized = await worker.resize(12, 3, 2);
    assert.strictEqual(resized.previewText, 'three\nfour\nfive');
    assert.strictEqual(resized.rows, 3);
    assert.strictEqual(resized.previewSnapshot.rows, 3);

    const cleared = await worker.clear(3, 1);
    assert.strictEqual(cleared.previewText, '');
    assert.ok(!cleared.renderOutput.includes('five'), 'cleared worker state should not replay old scrollback');
    assert.strictEqual(cleared.rows, 3);
  } finally {
    await worker.dispose();
  }

  const largeWorker = new TerminalScreenWorker({ cols: 80, rows: 8 });

  try {
    await largeWorker.setRuntimeEpoch('large-runtime', 80, 8);
    await largeWorker.append(
      `\x1b]0;Large Output Title\x07${'x'.repeat(140 * 1024)}\r\nlarge-output-tail`,
      1,
      1,
    );
    const largeState = await largeWorker.getState();

    assert.strictEqual(largeState.title, 'Large Output Title');
    assert.ok(largeState.renderOutput.includes('large-output-tail'));
  } finally {
    await largeWorker.dispose();
  }

  const discontinuous = new TerminalScreenWorker({ cols: 80, rows: 8 });
  try {
    await discontinuous.setRuntimeEpoch('discontinuous-runtime', 80, 8);
    await discontinuous.append('revision one\r\n', 1, 1);
    await assert.rejects(
      () => discontinuous.append('revision three without two\r\n', 3, 2),
      /revision gap/,
      'the authoritative reducer must reject a missing state revision'
    );
    const stateAfterGap = await discontinuous.getState();
    assert.strictEqual(stateAfterGap.stateRevision, 1);
    assert.strictEqual(stateAfterGap.outputSeq, 1);
    assert.ok(!stateAfterGap.renderOutput.includes('revision three without two'));
  } finally {
    await discontinuous.dispose();
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
    requestTimeoutMs: 1000,
    stateRequestHardTimeoutMs: 25,
    mode: 'hang',
  });
  const hangingErrors = [];
  hanging.on('error', error => hangingErrors.push(error));
  await assert.rejects(
    () => withKeepAlive(hanging.getState({ timeoutMs: 5 })),
    error => error && error.code === 'ETIMEDOUT' && /get-state/.test(error.message),
    'checkpoint callers should stop waiting at their soft deadline'
  );
  assert.strictEqual(hanging.pendingRequests.size, 1, 'a soft caller timeout must not duplicate the shared worker request');
  assert.strictEqual(hanging.stateRequestInFlight !== null, true, 'the shared request remains owned until its hard deadline');
  await assert.rejects(
    () => withKeepAlive(hanging.stateRequestInFlight),
    error => error && error.code === 'ETIMEDOUT' && /get-state/.test(error.message),
    'the authoritative reducer request should fail at its bounded hard deadline'
  );
  assert.strictEqual(hanging.pendingRequests.size, 0, 'the hard deadline should remove the pending worker request');
  assert.strictEqual(hanging.stateRequestInFlight, null, 'the hard deadline should clear the poisoned single-flight');
  assert.strictEqual(hanging.failed, true, 'a reducer that misses its hard deadline must fail closed');
  assert.strictEqual(hangingErrors.length, 1, 'the hard deadline should report one reducer liveness failure');
  hanging.worker.emit('message', {
    type: 'response',
    requestId: 1,
    payload: { ok: false, late: true },
  });
  assert.strictEqual(hanging.pendingRequests.size, 0, 'late worker responses should not recreate pending state');
  await withKeepAlive(hanging.dispose());

  const unobservedFailure = new TerminalScreenWorker({
    WorkerClass: FakeWorker,
    requestTimeoutMs: 50,
    mode: 'hang',
  });
  const unobservedPending = unobservedFailure.getState();
  assert.doesNotThrow(
    () => unobservedFailure.worker.emit('exit', 1),
    'an idle pool worker failure must reject its pending readiness check without an unhandled EventEmitter error',
  );
  await assert.rejects(() => unobservedPending, /exited unexpectedly/);
  await withKeepAlive(unobservedFailure.dispose());

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

  const exitingWithPendingAppend = new TerminalScreenWorker({
    WorkerClass: FakeWorker,
    requestTimeoutMs: 50,
    mode: 'hang',
  });
  exitingWithPendingAppend.on('error', () => {});
  const pendingAppend = exitingWithPendingAppend.append('pending append\r\n', 1, 1);
  assert.strictEqual(exitingWithPendingAppend.pendingAppendWaiters.length, 1);
  exitingWithPendingAppend.worker.emit('exit', 1);
  await assert.rejects(
    () => pendingAppend,
    /exited unexpectedly/,
    'worker exit should reject appends that have not reached the worker yet'
  );
  assert.strictEqual(exitingWithPendingAppend.appendFlushTimer, null);
  assert.deepStrictEqual(exitingWithPendingAppend.pendingAppendEntries, []);
  assert.strictEqual(exitingWithPendingAppend.pendingAppendWaiters.length, 0);
  await withKeepAlive(exitingWithPendingAppend.dispose());

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
    () => { void throwingAppend.append('append should not escape into the PTY output path', 1, 1).catch(() => {}); },
    'append postMessage failures must not throw into terminal data handlers'
  );
  assert.strictEqual(appendErrors.length, 0, 'small appends should only post when flushed');
  await assert.rejects(
    () => throwingAppend.getState(),
    /not available/,
    'flushing a failed append should make future screen worker requests unavailable'
  );
  assert.strictEqual(appendErrors.length, 1, 'append flush failures should be reported as non-request worker errors');
  assert.deepStrictEqual(throwingAppend.pendingAppendEntries, [], 'failed append flushes should drop pending append data');
  assert.doesNotThrow(
    () => { void throwingAppend.append('later output is dropped after worker failure', 2, 2).catch(() => {}); },
    'appends after worker failure should be ignored without throwing'
  );
  await throwingAppend.dispose();

  console.log('✓ Terminal screen worker keeps snapshots and fails fast on worker failures');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
