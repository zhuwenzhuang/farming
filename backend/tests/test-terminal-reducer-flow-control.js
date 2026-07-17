const assert = require('assert');
const {
  acknowledgeTerminalReducerData,
  createTerminalReducerFlowControl,
  enqueueTerminalReducerData,
  resetTerminalReducerFlowControl,
  setTerminalExternalFlowControlBlocked,
} = require('../terminal-reducer-flow-control');

function fakeProcess() {
  return {
    pauseCount: 0,
    resumeCount: 0,
    pause() { this.pauseCount += 1; },
    resume() { this.resumeCount += 1; },
  };
}

function run() {
  const process = fakeProcess();
  const control = createTerminalReducerFlowControl({
    highWatermarkBytes: 10,
    lowWatermarkBytes: 4,
  });

  assert.strictEqual(enqueueTerminalReducerData(control, process, '123456').bytes, 6);
  assert.strictEqual(process.pauseCount, 0);
  assert.strictEqual(enqueueTerminalReducerData(control, process, 'abcdef').bytes, 6);
  assert.strictEqual(control.pendingBytes, 12);
  assert.strictEqual(control.paused, true);
  assert.strictEqual(process.pauseCount, 1, 'reducer backlog should pause once');

  enqueueTerminalReducerData(control, process, 'zz');
  assert.strictEqual(process.pauseCount, 1, 'queued data must not pause repeatedly');
  assert.strictEqual(acknowledgeTerminalReducerData(control, process, 6), null);
  assert.strictEqual(control.pendingBytes, 8);
  assert.strictEqual(process.resumeCount, 0);
  assert.strictEqual(acknowledgeTerminalReducerData(control, process, 6), null);
  assert.strictEqual(control.pendingBytes, 2);
  assert.strictEqual(control.paused, false);
  assert.strictEqual(process.resumeCount, 1, 'reducer catch-up should resume below low watermark');

  acknowledgeTerminalReducerData(control, process, 1000);
  assert.strictEqual(control.pendingBytes, 0, 'oversized acknowledgements must not underflow');

  enqueueTerminalReducerData(control, process, '12345678901');
  assert.strictEqual(control.paused, true);
  assert.strictEqual(setTerminalExternalFlowControlBlocked(control, process, true), null);
  assert.strictEqual(process.pauseCount, 2, 'a second blocking reason must not pause twice');
  assert.strictEqual(resetTerminalReducerFlowControl(control, process), null);
  assert.strictEqual(control.pendingBytes, 0);
  assert.strictEqual(control.paused, true, 'runtime rotation freeze must survive reducer reset');
  assert.strictEqual(setTerminalExternalFlowControlBlocked(control, process, false), null);
  assert.strictEqual(control.paused, false);
  assert.strictEqual(process.resumeCount, 2);

  const unsupported = createTerminalReducerFlowControl({ highWatermarkBytes: 1, lowWatermarkBytes: 1 });
  const unsupportedResult = enqueueTerminalReducerData(unsupported, {}, '12');
  assert.match(unsupportedResult.error.message, /does not support.*pause/);

  console.log('terminal reducer flow control tests passed');
}

run();
