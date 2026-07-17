const assert = require('assert');
const {
  acknowledgeTerminalReducerData,
  acknowledgeTerminalRendererData,
  createTerminalReducerFlowControl,
  enqueueTerminalReducerData,
  enqueueTerminalRendererData,
  resetTerminalReducerFlowControl,
  resetTerminalRendererFlowControl,
  setTerminalExternalFlowControlBlocked,
} = require('../terminal-reducer-flow-control');

function fakeProcess() {
  return {
    pauseCount: 0,
    resumeCount: 0,
    pause() {
      this.pauseCount += 1;
    },
    resume() {
      this.resumeCount += 1;
    },
  };
}

function run() {
  const process = fakeProcess();
  const control = createTerminalReducerFlowControl({
    highWatermarkBytes: 10,
    lowWatermarkBytes: 4,
    rendererHighWatermarkChars: 10,
    rendererLowWatermarkChars: 4,
  });

  const first = enqueueTerminalReducerData(control, process, '123456');
  assert.strictEqual(first.bytes, 6);
  assert.strictEqual(process.pauseCount, 0);

  const second = enqueueTerminalReducerData(control, process, 'abcdef');
  assert.strictEqual(second.bytes, 6);
  assert.strictEqual(control.pendingBytes, 12);
  assert.strictEqual(control.paused, true);
  assert.strictEqual(process.pauseCount, 1, 'crossing the high watermark should pause once');

  enqueueTerminalReducerData(control, process, 'zz');
  assert.strictEqual(process.pauseCount, 1, 'additional queued data must not pause repeatedly');

  assert.strictEqual(acknowledgeTerminalReducerData(control, process, 6), null);
  assert.strictEqual(control.pendingBytes, 8);
  assert.strictEqual(process.resumeCount, 0);

  assert.strictEqual(acknowledgeTerminalReducerData(control, process, 6), null);
  assert.strictEqual(control.pendingBytes, 2);
  assert.strictEqual(control.paused, false);
  assert.strictEqual(process.resumeCount, 1, 'falling below the low watermark should resume once');

  assert.strictEqual(enqueueTerminalRendererData(control, process, 12), null);
  assert.strictEqual(control.unacknowledgedRendererChars, 12);
  assert.strictEqual(control.paused, true);
  assert.strictEqual(process.pauseCount, 2, 'renderer lag should share the same PTY pause');

  enqueueTerminalReducerData(control, process, '12345678901');
  assert.strictEqual(process.pauseCount, 2, 'a second blocking reason must not pause twice');
  assert.strictEqual(acknowledgeTerminalRendererData(control, process, 12), null);
  assert.strictEqual(control.paused, true, 'clearing renderer lag must not resume while reducer lag remains');
  assert.strictEqual(process.resumeCount, 1);
  assert.strictEqual(acknowledgeTerminalReducerData(control, process, 11), null);
  assert.strictEqual(control.paused, false);
  assert.strictEqual(process.resumeCount, 2);

  acknowledgeTerminalReducerData(control, process, 1000);
  assert.strictEqual(control.pendingBytes, 0, 'duplicate or oversized acknowledgements must not underflow');

  enqueueTerminalRendererData(control, process, 11);
  assert.strictEqual(control.paused, true);
  assert.strictEqual(resetTerminalRendererFlowControl(control, process), null);
  assert.strictEqual(control.unacknowledgedRendererChars, 0);
  assert.strictEqual(control.paused, false);

  enqueueTerminalReducerData(control, process, '12345678901');
  assert.strictEqual(resetTerminalReducerFlowControl(control, process), null);
  assert.strictEqual(control.pendingBytes, 0);
  assert.strictEqual(control.unacknowledgedRendererChars, 0);
  assert.strictEqual(control.paused, false);
  assert.strictEqual(process.resumeCount, 4);

  assert.strictEqual(setTerminalExternalFlowControlBlocked(control, process, true), null);
  assert.strictEqual(control.paused, true);
  assert.strictEqual(process.pauseCount, 5, 'a runtime freeze should add an independent PTY pause reason');
  enqueueTerminalReducerData(control, process, '12345678901');
  assert.strictEqual(resetTerminalReducerFlowControl(control, process), null);
  assert.strictEqual(control.paused, true, 'resetting reducer and renderer lag must preserve a runtime freeze');
  assert.strictEqual(process.resumeCount, 4);
  assert.strictEqual(setTerminalExternalFlowControlBlocked(control, process, false), null);
  assert.strictEqual(control.paused, false);
  assert.strictEqual(process.resumeCount, 5);

  const unsupported = createTerminalReducerFlowControl({
    highWatermarkBytes: 1,
    lowWatermarkBytes: 1,
  });
  const unsupportedResult = enqueueTerminalReducerData(unsupported, {}, '12');
  assert.match(unsupportedResult.error.message, /does not support.*pause/);

  console.log('terminal reducer flow control tests passed');
}

run();
