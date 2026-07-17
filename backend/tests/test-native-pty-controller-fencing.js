const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const NativePtyHost = require('../native-pty-host');
const {
  allocateNativePtyControllerGeneration,
} = require('../native-pty-controller-generation');
const {
  claimTerminalController,
  createTerminalControllerLease,
} = require('../terminal-controller-lease');
const {
  createTerminalReducerFlowControl,
  setTerminalExternalFlowControlBlocked,
} = require('../terminal-reducer-flow-control');

function client() {
  return {};
}

async function run() {
  const testTimeout = setTimeout(() => {
    throw new Error('native PTY controller fencing test timed out');
  }, 5_000);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-controller-generation-'));
  try {
    const generations = await Promise.all([
      allocateNativePtyControllerGeneration(configDir),
      allocateNativePtyControllerGeneration(configDir),
      allocateNativePtyControllerGeneration(configDir),
    ]);
    assert.deepStrictEqual([...generations].sort((a, b) => a - b), [1, 2, 3]);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  const host = Object.create(NativePtyHost.prototype);
  host.sessions = new Map();
  host.sessionMutationQueues = new Map();
  host.activeControllerMutations = new Set();
  host.controllerRegistrationQueue = Promise.resolve();
  host.controllerHandoff = null;
  host.rotationPreparation = null;
  host.activeControllerClient = null;
  host.activeControllerIdentity = null;
  const session = {
    runtimeEpoch: 'epoch-a',
    outputSeq: 0,
    stateRevision: 0,
    previewCols: 80,
    previewRows: 24,
    controllerLease: createTerminalControllerLease(),
    reducerFlowControl: createTerminalReducerFlowControl(),
    process: {
      pauseCount: 0,
      resumeCount: 0,
      pause() { this.pauseCount += 1; },
      resume() { this.resumeCount += 1; },
    },
  };
  host.sessions.set('agent-a', session);
  const oldClient = client();
  const newClient = client();
  await host.registerController(oldClient, { id: 'controller-a', generation: 10 });
  const oldLease = claimTerminalController(session, {
    ownerKey: 'old-owner',
    claimId: 'old-claim',
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(oldLease.status, 'owner');

  await assert.rejects(
    () => host.registerController(client(), { id: 'controller-stale', generation: 9 }),
    /Stale native pty controller/,
  );
  await assert.rejects(
    () => host.registerController(client(), { id: 'controller-collision', generation: 10 }),
    /Stale native pty controller/,
  );

  await host.registerController(newClient, { id: 'controller-b', generation: 11 });
  assert.strictEqual(session.controllerLease.ownerKey, '');
  assert.throws(() => host.assertActiveController(oldClient), /active controller/);
  assert.doesNotThrow(() => host.assertActiveController(newClient));

  let inputCalls = 0;
  host.sendInput = async () => {
    inputCalls += 1;
    return { sent: true };
  };
  await assert.rejects(
    () => host.dispatch('sendInput', { sessionId: 'agent-a', input: 'old' }, oldClient),
    /active controller/,
  );
  assert.strictEqual(inputCalls, 0, 'a fenced controller must not mutate the PTY');
  await host.dispatch('sendInput', { sessionId: 'agent-a', input: 'new' }, newClient);
  assert.strictEqual(inputCalls, 1);

  let releaseOldMutation;
  let markOldMutationStarted;
  const oldMutationGate = new Promise(resolve => {
    releaseOldMutation = resolve;
  });
  const oldMutationStarted = new Promise(resolve => {
    markOldMutationStarted = resolve;
  });
  host.activeControllerClient = oldClient;
  host.activeControllerIdentity = { id: 'controller-a', generation: 12 };
  oldClient.controllerId = 'controller-a';
  oldClient.controllerGeneration = 12;
  const oldMutation = host.enqueueControllerMutation('agent-a', oldClient, async () => {
    markOldMutationStarted();
    await oldMutationGate;
    return 'old-complete';
  });
  await oldMutationStarted;
  let handoffSettled = false;
  const handoff = host.registerController(newClient, { id: 'controller-b', generation: 13 })
    .finally(() => { handoffSettled = true; });
  while (!host.controllerHandoff) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.strictEqual(handoffSettled, false, 'registration must wait for admitted old mutations');
  await assert.rejects(
    () => host.enqueueControllerMutation('agent-a', oldClient, () => 'late-old'),
    /handoff is in progress/,
  );
  releaseOldMutation();
  assert.strictEqual(await oldMutation, 'old-complete');
  await handoff;
  let newMutationRan = false;
  const newMutation = host.enqueueControllerMutation('agent-a', newClient, () => {
    newMutationRan = true;
    return 'new-complete';
  });
  assert.strictEqual(await newMutation, 'new-complete');
  assert.strictEqual(newMutationRan, true);

  const disconnectLease = claimTerminalController(session, {
    ownerKey: 'disconnect-owner',
    claimId: 'disconnect-claim',
    expectedRuntimeEpoch: session.runtimeEpoch,
  });
  assert.strictEqual(disconnectLease.status, 'owner');
  session.controllerLease.rendererReadyFence = disconnectLease.fence;
  assert.strictEqual(
    setTerminalExternalFlowControlBlocked(session.reducerFlowControl, session.process, true),
    null,
  );
  session.reducerCommitQueue = Promise.resolve();
  session.renderOutput = '';
  session.previewText = '';
  session.previewSnapshot = null;
  session.process.resize = () => {};
  let releaseResize;
  let markResizeStarted;
  let resizeDidStart = false;
  const resizeGate = new Promise(resolve => { releaseResize = resolve; });
  const resizeStarted = new Promise(resolve => { markResizeStarted = resolve; });
  session.screenWorker = {
    async resize(cols, rows, stateRevision) {
      resizeDidStart = true;
      markResizeStarted();
      await resizeGate;
      return {
        runtimeEpoch: session.runtimeEpoch,
        outputSeq: session.outputSeq,
        stateRevision,
        renderOutput: '',
        previewText: '',
        previewSnapshot: null,
        cols,
        rows,
        title: '',
      };
    },
  };
  host.emitSessionEvent = () => {};
  host.activeControllerClient = newClient;
  host.clients = new Set([newClient]);
  host.scheduleIdleExitIfUnused = () => {};
  assert.strictEqual(host.sessionMutationQueues.has('agent-a'), false, 'previous mutation queue must be drained');
  let releaseQueueHead;
  let markQueueHeadStarted;
  const queueHeadGate = new Promise(resolve => { releaseQueueHead = resolve; });
  const queueHeadStarted = new Promise(resolve => { markQueueHeadStarted = resolve; });
  const queueHead = host.enqueueControllerMutation('agent-a', newClient, async () => {
    markQueueHeadStarted();
    await queueHeadGate;
    return 'queue-head-complete';
  });
  await queueHeadStarted;
  const resize = host.dispatch('resizeSession', {
    sessionId: 'agent-a',
    cols: 100,
    rows: 30,
    controller: {
      ownerKey: 'disconnect-owner',
      leaseId: disconnectLease.leaseId,
      fence: disconnectLease.fence,
      expectedRuntimeEpoch: session.runtimeEpoch,
      requestSeq: 1,
    },
  }, newClient);
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(resizeDidStart, false, 'the second mutation must remain admitted behind the same-session queue head');
  const retirement = host.removeClient(newClient);
  const replacementClient = client();
  let replacementSettled = false;
  const replacement = host.registerController(replacementClient, {
    id: 'controller-c',
    generation: 14,
  }).finally(() => { replacementSettled = true; });
  await Promise.resolve();
  assert.strictEqual(
    session.controllerLease.ownerKey,
    'disconnect-owner',
    'disconnect must preserve the lease until an admitted resize commits',
  );
  assert.strictEqual(replacementSettled, false, 'replacement registration must wait for disconnect retirement');
  releaseQueueHead();
  assert.strictEqual(await queueHead, 'queue-head-complete');
  await resizeStarted;
  releaseResize();
  const resizeResult = await resize;
  assert.strictEqual(resizeResult.status, 'resize-committed');
  assert.strictEqual(resizeResult.resized, true);
  await retirement;
  assert.strictEqual(session.controllerLease.ownerKey, '');
  assert.strictEqual(session.reducerFlowControl.externalBlocked, false);
  assert.strictEqual(session.process.resumeCount, 1, 'controller disconnect must release external PTY pause');
  await replacement;
  assert.doesNotThrow(() => host.assertActiveController(replacementClient));

  clearTimeout(testTimeout);
  console.log('native PTY controller fencing tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
