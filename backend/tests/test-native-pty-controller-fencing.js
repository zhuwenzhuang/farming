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
  await Promise.resolve();
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
  assert.strictEqual(
    setTerminalExternalFlowControlBlocked(session.reducerFlowControl, session.process, true),
    null,
  );
  host.activeControllerClient = newClient;
  host.clients = new Set([newClient]);
  host.scheduleIdleExitIfUnused = () => {};
  host.removeClient(newClient);
  assert.strictEqual(session.controllerLease.ownerKey, '');
  assert.strictEqual(session.reducerFlowControl.externalBlocked, false);
  assert.strictEqual(session.process.resumeCount, 1, 'controller disconnect must release external PTY pause');

  console.log('native PTY controller fencing tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
