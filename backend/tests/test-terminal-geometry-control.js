const assert = require('assert');
const {
  beginTerminalGeometryResize,
  claimTerminalGeometry,
  commitTerminalGeometryResize,
  createTerminalGeometryControl,
  invalidateTerminalGeometry,
  rejectTerminalGeometryResize,
  releaseTerminalGeometry,
  renewTerminalGeometry,
  validateTerminalGeometryClear,
  validateTerminalGeometryInput,
  validateTerminalGeometryOutputAck,
  validateTerminalGeometryRendererReady,
} = require('../terminal-geometry-control');

function session() {
  return {
    runtimeEpoch: 'epoch-a',
    stateRevision: 7,
    outputSeq: 5,
    previewCols: 80,
    previewRows: 24,
    geometryControl: createTerminalGeometryControl(),
  };
}

function run() {
  const current = session();
  const first = claimTerminalGeometry(current, {
    ownerKey: 'server-a:socket-a:attachment-a',
    claimId: 'claim-a',
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(first.status, 'owner');
  assert.strictEqual(first.fence, 1);
  assert.ok(first.leaseId);

  const renewed = renewTerminalGeometry(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(renewed.status, 'owner');
  assert.strictEqual(renewed.fence, first.fence);

  const inputBeforeRendererReady = validateTerminalGeometryInput(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(inputBeforeRendererReady.status, 'input-rejected');
  assert.strictEqual(inputBeforeRendererReady.reason, 'renderer-not-ready');

  const resizeBeforeRendererReady = beginTerminalGeometryResize(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
    requestSeq: 1,
  });
  assert.strictEqual(resizeBeforeRendererReady.accepted, false);
  assert.strictEqual(resizeBeforeRendererReady.result.reason, 'renderer-not-ready');

  const rendererReady = validateTerminalGeometryRendererReady(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(rendererReady.status, 'renderer-ready-accepted');
  current.geometryControl.rendererReadyFence = first.fence;

  const staleResize = beginTerminalGeometryResize(current, {
    ownerKey: 'stale-owner',
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
    requestSeq: 1,
  });
  assert.strictEqual(staleResize.accepted, false);
  assert.strictEqual(staleResize.result.reason, 'stale-lease');

  const resize = beginTerminalGeometryResize(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
    requestSeq: 1,
  });
  assert.strictEqual(resize.accepted, true);
  current.previewCols = 120;
  current.previewRows = 40;
  current.stateRevision += 1;
  const ack = commitTerminalGeometryResize(current, resize.requestSeq, { resized: true });
  assert.strictEqual(ack.status, 'resize-committed');
  assert.strictEqual('stateRevision' in ack, false);
  assert.strictEqual('outputSeq' in ack, false);
  assert.strictEqual('cols' in ack, false);
  assert.strictEqual('rows' in ack, false);

  const duplicate = beginTerminalGeometryResize(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
    requestSeq: 1,
  });
  assert.strictEqual(duplicate.duplicate, true);
  assert.strictEqual('stateRevision' in duplicate.result, false);

  const gap = beginTerminalGeometryResize(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
    requestSeq: 3,
  });
  assert.strictEqual(gap.accepted, false);
  assert.strictEqual(gap.result.reason, 'request-sequence-gap');

  const failed = beginTerminalGeometryResize(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
    requestSeq: 2,
  });
  assert.strictEqual(failed.accepted, true);
  const failedAck = rejectTerminalGeometryResize(current, 2, 'pty-resize-failed');
  assert.strictEqual(failedAck.status, 'resize-rejected');
  const failedRetry = beginTerminalGeometryResize(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
    requestSeq: 2,
  });
  assert.strictEqual(failedRetry.duplicate, true);
  assert.strictEqual(failedRetry.result.reason, 'pty-resize-failed');

  const firstInput = validateTerminalGeometryInput(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(firstInput.status, 'input-accepted');

  const staleInput = validateTerminalGeometryInput(current, {
    ownerKey: 'stale-owner',
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(staleInput.status, 'input-rejected');
  assert.strictEqual(staleInput.reason, 'stale-lease');

  const clear = validateTerminalGeometryClear(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(clear.status, 'clear-accepted');
  const outputAck = validateTerminalGeometryOutputAck(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(outputAck.status, 'output-ack-accepted');

  const staleClear = validateTerminalGeometryClear(current, {
    ownerKey: 'stale-owner',
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(staleClear.status, 'clear-rejected');
  assert.strictEqual(staleClear.reason, 'stale-lease');

  const secondOwner = claimTerminalGeometry(current, {
    ownerKey: 'server-a:socket-b:attachment-b',
    claimId: 'claim-b',
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(secondOwner.fence, 2);
  assert.notStrictEqual(secondOwner.leaseId, first.leaseId);
  current.geometryControl.rendererReadyFence = secondOwner.fence;

  const secondInput = validateTerminalGeometryInput(current, {
    ownerKey: secondOwner.ownerKey,
    leaseId: secondOwner.leaseId,
    fence: secondOwner.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(secondInput.status, 'input-accepted');

  const oldFence = beginTerminalGeometryResize(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
    requestSeq: 2,
  });
  assert.strictEqual(oldFence.accepted, false);
  assert.strictEqual(oldFence.result.reason, 'stale-lease');

  const secondResize = beginTerminalGeometryResize(current, {
    ownerKey: secondOwner.ownerKey,
    leaseId: secondOwner.leaseId,
    fence: secondOwner.fence,
    expectedRuntimeEpoch: 'epoch-a',
    requestSeq: 1,
  });
  assert.strictEqual(secondResize.accepted, true);
  const thirdOwner = claimTerminalGeometry(current, {
    ownerKey: 'server-b:socket-c:attachment-c',
    claimId: 'claim-c',
    expectedRuntimeEpoch: 'epoch-a',
  });
  const lateCommit = commitTerminalGeometryResize(
    current,
    secondResize.requestSeq,
    { resized: true },
    secondResize.token,
  );
  assert.strictEqual(lateCommit.status, 'resize-rejected');
  assert.strictEqual(lateCommit.reason, 'controller-replaced');
  assert.strictEqual(current.geometryControl.ownerKey, thirdOwner.ownerKey);
  assert.strictEqual(current.geometryControl.lastResizeAck, null);

  const wrongEpoch = beginTerminalGeometryResize(current, {
    ownerKey: thirdOwner.ownerKey,
    leaseId: thirdOwner.leaseId,
    fence: thirdOwner.fence,
    expectedRuntimeEpoch: 'epoch-old',
    requestSeq: 1,
  });
  assert.strictEqual(wrongEpoch.accepted, false);
  assert.strictEqual(wrongEpoch.result.reason, 'runtime-epoch-mismatch');

  const wrongInputEpoch = validateTerminalGeometryInput(current, {
    ownerKey: thirdOwner.ownerKey,
    leaseId: thirdOwner.leaseId,
    fence: thirdOwner.fence,
    expectedRuntimeEpoch: 'epoch-old',
  });
  assert.strictEqual(wrongInputEpoch.status, 'input-rejected');
  assert.strictEqual(wrongInputEpoch.reason, 'runtime-epoch-mismatch');

  const wrongClearEpoch = validateTerminalGeometryClear(current, {
    ownerKey: thirdOwner.ownerKey,
    leaseId: thirdOwner.leaseId,
    fence: thirdOwner.fence,
    expectedRuntimeEpoch: 'epoch-old',
  });
  assert.strictEqual(wrongClearEpoch.status, 'clear-rejected');
  assert.strictEqual(wrongClearEpoch.reason, 'runtime-epoch-mismatch');

  const released = releaseTerminalGeometry(current, {
    ownerKey: thirdOwner.ownerKey,
    leaseId: thirdOwner.leaseId,
    fence: thirdOwner.fence,
  });
  assert.strictEqual(released.status, 'unowned');

  const invalidated = invalidateTerminalGeometry(current, 'controller-replaced');
  assert.strictEqual(invalidated.fence, 5);
  assert.strictEqual(invalidated.reason, 'controller-replaced');

  console.log('terminal geometry control tests passed');
}

run();
