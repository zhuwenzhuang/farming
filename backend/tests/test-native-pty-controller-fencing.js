const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const NativePtyHost = require('../native-pty-host');
const {
  allocateNativePtyControllerGeneration,
} = require('../native-pty-controller-generation');

function client() {
  return {};
}

function createHost() {
  const host = Object.create(NativePtyHost.prototype);
  host.sessions = new Map();
  host.clients = new Set();
  host.sessionMutationQueues = new Map();
  host.activeControllerMutations = new Set();
  host.controllerRegistrationQueue = Promise.resolve();
  host.controllerHandoff = null;
  host.rotationPreparation = null;
  host.activeControllerClient = null;
  host.activeControllerIdentity = null;
  host.scheduleIdleExitIfUnused = () => {};
  return host;
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

  const host = createHost();
  const oldClient = client();
  const newClient = client();
  await host.registerController(oldClient, { id: 'server-a', generation: 10 });

  await assert.rejects(
    () => host.registerController(client(), { id: 'server-stale', generation: 9 }),
    /Stale native pty controller/,
  );
  await assert.rejects(
    () => host.registerController(client(), { id: 'server-collision', generation: 10 }),
    /Stale native pty controller/,
  );

  let releaseOldMutation;
  let markOldMutationStarted;
  const oldMutationGate = new Promise(resolve => { releaseOldMutation = resolve; });
  const oldMutationStarted = new Promise(resolve => { markOldMutationStarted = resolve; });
  const oldMutation = host.enqueueControllerMutation('agent-a', oldClient, async () => {
    markOldMutationStarted();
    await oldMutationGate;
    return 'old-complete';
  });
  await oldMutationStarted;

  let handoffSettled = false;
  const handoff = host.registerController(newClient, { id: 'server-b', generation: 11 })
    .finally(() => { handoffSettled = true; });
  while (!host.controllerHandoff) await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(handoffSettled, false, 'handoff must drain already-admitted mutations');
  await assert.rejects(
    () => host.enqueueControllerMutation('agent-a', oldClient, () => 'late-old'),
    /handoff is in progress/,
  );
  releaseOldMutation();
  assert.strictEqual(await oldMutation, 'old-complete');
  await handoff;
  assert.throws(() => host.assertActiveController(oldClient), /active controller/);
  assert.doesNotThrow(() => host.assertActiveController(newClient));

  let releaseDisconnectMutation;
  let markDisconnectMutationStarted;
  const disconnectGate = new Promise(resolve => { releaseDisconnectMutation = resolve; });
  const disconnectStarted = new Promise(resolve => { markDisconnectMutationStarted = resolve; });
  const admittedBeforeDisconnect = host.enqueueControllerMutation('agent-b', newClient, async () => {
    markDisconnectMutationStarted();
    await disconnectGate;
    return 'disconnect-complete';
  });
  await disconnectStarted;
  const retirement = host.removeClient(newClient);
  const replacementClient = client();
  let replacementSettled = false;
  const replacement = host.registerController(replacementClient, { id: 'server-c', generation: 12 })
    .finally(() => { replacementSettled = true; });
  await Promise.resolve();
  assert.strictEqual(replacementSettled, false, 'replacement must wait for disconnect retirement');
  releaseDisconnectMutation();
  assert.strictEqual(await admittedBeforeDisconnect, 'disconnect-complete');
  await retirement;
  await replacement;
  assert.doesNotThrow(() => host.assertActiveController(replacementClient));

  console.log('native PTY server-generation fencing tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
