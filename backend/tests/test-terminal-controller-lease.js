const assert = require('assert');
const {
  beginTerminalControllerResize,
  claimTerminalController,
  commitTerminalControllerResize,
  createTerminalControllerLease,
  invalidateTerminalController,
  rejectTerminalControllerResize,
  releaseTerminalController,
  renewTerminalController,
  validateTerminalControllerClear,
  validateTerminalControllerInput,
  validateTerminalControllerOutputAck,
  validateTerminalControllerRendererReady,
} = require('../terminal-controller-lease');

function session() {
  return {
    runtimeEpoch: 'epoch-a',
    stateRevision: 7,
    outputSeq: 5,
    previewCols: 80,
    previewRows: 24,
    controllerLease: createTerminalControllerLease(),
  };
}

function run() {
  const systemSession = session();
  const systemInput = validateTerminalControllerInput(systemSession, {
    kind: 'system',
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(systemInput.status, 'input-accepted');
  assert.strictEqual(systemInput.system, true);
  const wrongSystemEpoch = validateTerminalControllerClear(systemSession, {
    kind: 'system',
    expectedRuntimeEpoch: 'epoch-old',
  });
  assert.strictEqual(wrongSystemEpoch.status, 'clear-rejected');
  assert.strictEqual(wrongSystemEpoch.reason, 'runtime-epoch-mismatch');
  claimTerminalController(systemSession, {
    ownerKey: 'server-system-test:socket:attachment',
    claimId: 'browser-owner',
    expectedRuntimeEpoch: 'epoch-a',
  });
  const controlledSystemInput = validateTerminalControllerInput(systemSession, {
    kind: 'system',
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(controlledSystemInput.status, 'input-rejected');
  assert.strictEqual(controlledSystemInput.reason, 'terminal-controlled-by-browser');

  const current = session();
  const first = claimTerminalController(current, {
    ownerKey: 'server-a:socket-a:attachment-a',
    claimId: 'claim-a',
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(first.status, 'owner');
  assert.strictEqual(first.fence, 1);
  assert.ok(first.leaseId);

  const renewed = renewTerminalController(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(renewed.status, 'owner');
  assert.strictEqual(renewed.fence, first.fence);

  const inputBeforeRendererReady = validateTerminalControllerInput(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(inputBeforeRendererReady.status, 'input-rejected');
  assert.strictEqual(inputBeforeRendererReady.reason, 'renderer-not-ready');

  const resizeBeforeRendererReady = beginTerminalControllerResize(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
    requestSeq: 1,
  });
  assert.strictEqual(resizeBeforeRendererReady.accepted, false);
  assert.strictEqual(resizeBeforeRendererReady.result.reason, 'renderer-not-ready');

  const rendererReady = validateTerminalControllerRendererReady(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(rendererReady.status, 'renderer-ready-accepted');
  current.controllerLease.rendererReadyFence = first.fence;

  const staleResize = beginTerminalControllerResize(current, {
    ownerKey: 'stale-owner',
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
    requestSeq: 1,
  });
  assert.strictEqual(staleResize.accepted, false);
  assert.strictEqual(staleResize.result.reason, 'stale-lease');

  const resize = beginTerminalControllerResize(current, {
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
  const ack = commitTerminalControllerResize(current, resize.requestSeq, { resized: true });
  assert.strictEqual(ack.status, 'resize-committed');
  assert.strictEqual('stateRevision' in ack, false);
  assert.strictEqual('outputSeq' in ack, false);
  assert.strictEqual('cols' in ack, false);
  assert.strictEqual('rows' in ack, false);

  const duplicate = beginTerminalControllerResize(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
    requestSeq: 1,
  });
  assert.strictEqual(duplicate.duplicate, true);
  assert.strictEqual('stateRevision' in duplicate.result, false);

  const gap = beginTerminalControllerResize(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
    requestSeq: 3,
  });
  assert.strictEqual(gap.accepted, false);
  assert.strictEqual(gap.result.reason, 'request-sequence-gap');

  const failed = beginTerminalControllerResize(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
    requestSeq: 2,
  });
  assert.strictEqual(failed.accepted, true);
  const failedAck = rejectTerminalControllerResize(current, 2, 'pty-resize-failed');
  assert.strictEqual(failedAck.status, 'resize-rejected');
  const failedRetry = beginTerminalControllerResize(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
    requestSeq: 2,
  });
  assert.strictEqual(failedRetry.duplicate, true);
  assert.strictEqual(failedRetry.result.reason, 'pty-resize-failed');

  const firstInput = validateTerminalControllerInput(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(firstInput.status, 'input-accepted');

  const staleInput = validateTerminalControllerInput(current, {
    ownerKey: 'stale-owner',
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(staleInput.status, 'input-rejected');
  assert.strictEqual(staleInput.reason, 'stale-lease');

  const clear = validateTerminalControllerClear(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(clear.status, 'clear-accepted');
  const outputAck = validateTerminalControllerOutputAck(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(outputAck.status, 'output-ack-accepted');

  const staleClear = validateTerminalControllerClear(current, {
    ownerKey: 'stale-owner',
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(staleClear.status, 'clear-rejected');
  assert.strictEqual(staleClear.reason, 'stale-lease');

  const secondOwner = claimTerminalController(current, {
    ownerKey: 'server-a:socket-b:attachment-b',
    claimId: 'claim-b',
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(secondOwner.fence, 2);
  assert.notStrictEqual(secondOwner.leaseId, first.leaseId);
  current.controllerLease.rendererReadyFence = secondOwner.fence;

  const secondInput = validateTerminalControllerInput(current, {
    ownerKey: secondOwner.ownerKey,
    leaseId: secondOwner.leaseId,
    fence: secondOwner.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(secondInput.status, 'input-accepted');

  const oldFence = beginTerminalControllerResize(current, {
    ownerKey: first.ownerKey,
    leaseId: first.leaseId,
    fence: first.fence,
    expectedRuntimeEpoch: 'epoch-a',
    requestSeq: 2,
  });
  assert.strictEqual(oldFence.accepted, false);
  assert.strictEqual(oldFence.result.reason, 'stale-lease');

  const secondResize = beginTerminalControllerResize(current, {
    ownerKey: secondOwner.ownerKey,
    leaseId: secondOwner.leaseId,
    fence: secondOwner.fence,
    expectedRuntimeEpoch: 'epoch-a',
    requestSeq: 1,
  });
  assert.strictEqual(secondResize.accepted, true);
  const thirdOwner = claimTerminalController(current, {
    ownerKey: 'server-b:socket-c:attachment-c',
    claimId: 'claim-c',
    expectedRuntimeEpoch: 'epoch-a',
  });
  const lateCommit = commitTerminalControllerResize(
    current,
    secondResize.requestSeq,
    { resized: true },
    secondResize.token,
  );
  assert.strictEqual(lateCommit.status, 'resize-rejected');
  assert.strictEqual(lateCommit.reason, 'controller-replaced');
  assert.strictEqual(current.controllerLease.ownerKey, thirdOwner.ownerKey);
  assert.strictEqual(current.controllerLease.lastResizeAck, null);

  const wrongEpoch = beginTerminalControllerResize(current, {
    ownerKey: thirdOwner.ownerKey,
    leaseId: thirdOwner.leaseId,
    fence: thirdOwner.fence,
    expectedRuntimeEpoch: 'epoch-old',
    requestSeq: 1,
  });
  assert.strictEqual(wrongEpoch.accepted, false);
  assert.strictEqual(wrongEpoch.result.reason, 'runtime-epoch-mismatch');

  const wrongInputEpoch = validateTerminalControllerInput(current, {
    ownerKey: thirdOwner.ownerKey,
    leaseId: thirdOwner.leaseId,
    fence: thirdOwner.fence,
    expectedRuntimeEpoch: 'epoch-old',
  });
  assert.strictEqual(wrongInputEpoch.status, 'input-rejected');
  assert.strictEqual(wrongInputEpoch.reason, 'runtime-epoch-mismatch');

  const wrongClearEpoch = validateTerminalControllerClear(current, {
    ownerKey: thirdOwner.ownerKey,
    leaseId: thirdOwner.leaseId,
    fence: thirdOwner.fence,
    expectedRuntimeEpoch: 'epoch-old',
  });
  assert.strictEqual(wrongClearEpoch.status, 'clear-rejected');
  assert.strictEqual(wrongClearEpoch.reason, 'runtime-epoch-mismatch');

  const released = releaseTerminalController(current, {
    ownerKey: thirdOwner.ownerKey,
    leaseId: thirdOwner.leaseId,
    fence: thirdOwner.fence,
  });
  assert.strictEqual(released.status, 'unowned');

  const invalidated = invalidateTerminalController(current, 'controller-replaced');
  assert.strictEqual(invalidated.fence, 5);
  assert.strictEqual(invalidated.reason, 'controller-replaced');

  console.log('terminal controller lease tests passed');
}

run();
