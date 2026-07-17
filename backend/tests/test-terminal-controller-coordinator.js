const assert = require('assert');
const TerminalControllerCoordinator = require('../terminal-controller-coordinator');
const {
  beginTerminalControllerResize,
  claimTerminalController,
  commitTerminalControllerResize,
  createTerminalControllerLease,
  releaseTerminalController,
  renewTerminalController,
  validateTerminalControllerClear,
  validateTerminalControllerInput,
  validateTerminalControllerOutputAck,
  validateTerminalControllerRendererReady,
} = require('../terminal-controller-lease');
function createSocket(connectionId) {
  return {
    connectionId,
    readyState: 1,
    messages: [],
  };
}

function lastMessage(ws) {
  return ws.messages.at(-1);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testControllerDoesNotReadDisplayCheckpoint() {
  const session = {
    runtimeEpoch: 'epoch-race-a',
    outputSeq: 2,
    stateRevision: 3,
    previewCols: 80,
    previewRows: 24,
    controllerLease: createTerminalControllerLease(),
  };
  let checkpointReadCount = 0;
  const manager = {
    agentRequiresTerminalController() {
      return true;
    },
    async claimAgentSessionController(_agentId, options) {
      return claimTerminalController(session, options);
    },
    async getAgentSessionAttachCheckpoint() {
      checkpointReadCount += 1;
      throw new Error('controller coordination must not read display checkpoints');
    },
    async renewAgentSessionController(_agentId, options) {
      return renewTerminalController(session, options);
    },
    async releaseAgentSessionController(_agentId, options) {
      return releaseTerminalController(session, options);
    },
  };
  const coordinator = new TerminalControllerCoordinator({
    agentManager: manager,
    serverInstanceId: 'server-race',
    leaseTtlMs: 30000,
    send(ws, message) {
      ws.messages.push(message);
    },
  });
  const first = createSocket('socket-race-a');
  const second = createSocket('socket-race-b');

  await coordinator.claim(first, {
    agentId: 'agent-race',
    attachmentId: 'attachment-race-a',
    claimId: 'claim-race-a',
    mode: 'passive',
    expectedRuntimeEpoch: session.runtimeEpoch,
  });
  const firstOwner = lastMessage(first);
  assert.strictEqual(firstOwner.status, 'owner');

  await coordinator.claim(second, {
    agentId: 'agent-race',
    attachmentId: 'attachment-race-b',
    claimId: 'claim-race-b',
    mode: 'interactive',
    expectedRuntimeEpoch: session.runtimeEpoch,
  });
  const secondOwner = lastMessage(second);
  assert.strictEqual(secondOwner.status, 'owner');
  assert.ok(secondOwner.fence > firstOwner.fence);
  assert.strictEqual(lastMessage(first).status, 'revoked');
  await coordinator.claim(second, {
    agentId: 'agent-race',
    attachmentId: 'attachment-race-b',
    claimId: 'claim-race-b',
    mode: 'interactive',
    expectedRuntimeEpoch: session.runtimeEpoch,
  });
  const messagesBeforeEpochRotation = second.messages.length;

  session.runtimeEpoch = 'epoch-race-b';
  await coordinator.renew(second, {
    agentId: 'agent-race',
    attachmentId: 'attachment-race-b',
    leaseId: secondOwner.leaseId,
    fence: secondOwner.fence,
  });
  assert.strictEqual(lastMessage(second).status, 'expired');
  assert.strictEqual(lastMessage(second).reason, 'runtime-epoch-mismatch');
  assert.strictEqual('runtimeEpoch' in lastMessage(second), false);
  assert.strictEqual(coordinator.owners.has('agent-race'), false);
  assert.ok(second.messages.length > messagesBeforeEpochRotation);
  assert.strictEqual(checkpointReadCount, 0, 'controller lease transitions must be independent from display replay');
}

async function testLeaseExpiryReleasesController() {
  const current = {
    runtimeEpoch: 'epoch-expiry',
    outputSeq: 0,
    stateRevision: 0,
    previewCols: 80,
    previewRows: 24,
    controllerLease: createTerminalControllerLease(),
  };
  const manager = {
    async claimAgentSessionController(_agentId, options) {
      return claimTerminalController(current, options);
    },
    async releaseAgentSessionController(_agentId, options) {
      return releaseTerminalController(current, options);
    },
  };
  const coordinator = new TerminalControllerCoordinator({
    agentManager: manager,
    serverInstanceId: 'server-expiry',
    send(ws, message) {
      ws.messages.push(message);
    },
  });
  const socket = createSocket('socket-expiry');
  await coordinator.claim(socket, {
    agentId: 'agent-expiry',
    attachmentId: 'attachment-expiry',
    claimId: 'claim-expiry',
    mode: 'passive',
    expectedRuntimeEpoch: current.runtimeEpoch,
  });
  const owner = coordinator.owners.get('agent-expiry');
  const displayCutBeforeExpiry = {
    runtimeEpoch: current.runtimeEpoch,
    outputSeq: current.outputSeq,
    stateRevision: current.stateRevision,
    previewCols: current.previewCols,
    previewRows: current.previewRows,
  };
  owner.expiresAt = Date.now() - 1;
  current.controllerLease.expiresAt = owner.expiresAt;
  await coordinator.expireOwner('agent-expiry', owner);
  assert.strictEqual(coordinator.owners.has('agent-expiry'), false);
  assert.strictEqual(current.controllerLease.ownerKey, '');
  assert.strictEqual(lastMessage(socket).status, 'expired');
  assert.strictEqual(lastMessage(socket).reason, 'lease-expired');
  assert.deepStrictEqual({
    runtimeEpoch: current.runtimeEpoch,
    outputSeq: current.outputSeq,
    stateRevision: current.stateRevision,
    previewCols: current.previewCols,
    previewRows: current.previewRows,
  }, displayCutBeforeExpiry, 'lease expiry timers must never create or commit display state');
}

async function testLeaseExpirySchedulerRespectsRenewedDeadline() {
  const current = {
    runtimeEpoch: 'epoch-scheduler',
    controllerLease: createTerminalControllerLease(),
  };
  const manager = {
    async claimAgentSessionController(_agentId, options) {
      return claimTerminalController(current, options);
    },
    async releaseAgentSessionController(_agentId, options) {
      return releaseTerminalController(current, options);
    },
  };
  const coordinator = new TerminalControllerCoordinator({
    agentManager: manager,
    serverInstanceId: 'server-scheduler',
    send(ws, message) {
      ws.messages.push(message);
    },
  });
  const socket = createSocket('socket-scheduler');
  await coordinator.claim(socket, {
    agentId: 'agent-scheduler',
    attachmentId: 'attachment-scheduler',
    claimId: 'claim-scheduler',
    mode: 'passive',
    expectedRuntimeEpoch: current.runtimeEpoch,
  });
  const owner = coordinator.owners.get('agent-scheduler');
  owner.expiresAt = Date.now() + 30;
  current.controllerLease.expiresAt = owner.expiresAt;
  coordinator.scheduleLeaseExpiryCheck();

  await delay(15);
  owner.expiresAt = Date.now() + 80;
  current.controllerLease.expiresAt = owner.expiresAt;
  coordinator.scheduleLeaseExpiryCheck();
  await delay(35);
  assert.strictEqual(
    coordinator.owners.get('agent-scheduler'),
    owner,
    'a canceled earlier expiry timer must not revoke the renewed owner',
  );
  await delay(70);
  assert.strictEqual(coordinator.owners.has('agent-scheduler'), false);
  assert.strictEqual(lastMessage(socket).reason, 'lease-expired');
}

async function testOwnedMutationSerializesInteractiveTakeover() {
  const session = {
    runtimeEpoch: 'epoch-owned-operation',
    controllerLease: createTerminalControllerLease(),
  };
  const manager = {
    async claimAgentSessionController(_agentId, options) {
      return claimTerminalController(session, options);
    },
    async renewAgentSessionController(_agentId, options) {
      return renewTerminalController(session, options);
    },
    async releaseAgentSessionController(_agentId, options) {
      return releaseTerminalController(session, options);
    },
  };
  const coordinator = new TerminalControllerCoordinator({
    agentManager: manager,
    serverInstanceId: 'server-owned-operation',
    send(ws, message) {
      ws.messages.push(message);
    },
  });
  const first = createSocket('socket-owned-first');
  const second = createSocket('socket-owned-second');
  await coordinator.claim(first, {
    agentId: 'agent-owned-operation',
    attachmentId: 'attachment-owned-first',
    claimId: 'claim-owned-first',
    mode: 'interactive',
    expectedRuntimeEpoch: session.runtimeEpoch,
  });
  const firstOwner = lastMessage(first);
  let finishOperation;
  const operationGate = new Promise(resolve => { finishOperation = resolve; });
  let operationControl = null;
  const operation = coordinator.runOwnedMutation(
    'agent-owned-operation',
    {
      attachmentId: firstOwner.attachmentId,
      leaseId: firstOwner.leaseId,
      fence: firstOwner.fence,
      expectedRuntimeEpoch: session.runtimeEpoch,
    },
    async ({ terminalControl }) => {
      operationControl = terminalControl;
      await operationGate;
      return 'profile-applied';
    },
  );
  await delay(0);
  let takeoverSettled = false;
  const takeover = coordinator.claim(second, {
    agentId: 'agent-owned-operation',
    attachmentId: 'attachment-owned-second',
    claimId: 'claim-owned-second',
    mode: 'interactive',
    expectedRuntimeEpoch: session.runtimeEpoch,
  }).finally(() => { takeoverSettled = true; });
  await delay(0);
  assert.strictEqual(takeoverSettled, false, 'takeover must wait for the whole owned mutation');
  assert.strictEqual(coordinator.owners.get('agent-owned-operation').ws, first);
  assert.deepStrictEqual(operationControl, {
    ownerKey: session.controllerLease.ownerKey,
    leaseId: firstOwner.leaseId,
    fence: firstOwner.fence,
    expectedRuntimeEpoch: session.runtimeEpoch,
    ttlMs: 60000,
  });
  finishOperation();
  assert.deepStrictEqual(await operation, { status: 'committed', value: 'profile-applied' });
  await takeover;
  assert.strictEqual(lastMessage(first).status, 'revoked');
  assert.strictEqual(lastMessage(second).status, 'owner');
}

async function run() {
  const session = {
    runtimeEpoch: 'epoch-a',
    outputSeq: 4,
    stateRevision: 6,
    previewCols: 80,
    previewRows: 24,
    controllerLease: createTerminalControllerLease(),
  };
  const inputWrites = [];
  let interruptCount = 0;
  let clearCount = 0;
  let acknowledgedChars = 0;
  let acknowledgedCheckpoint = null;
  const manager = {
    agentRequiresTerminalController() {
      return true;
    },
    async claimAgentSessionController(_agentId, options) {
      return claimTerminalController(session, options);
    },
    async renewAgentSessionController(_agentId, options) {
      return renewTerminalController(session, options);
    },
    async releaseAgentSessionController(_agentId, options) {
      return releaseTerminalController(session, options);
    },
    async activateAgentSessionRenderer(_agentId, options) {
      const controlState = validateTerminalControllerRendererReady(session, options);
      if (controlState.status === 'renderer-ready-accepted') {
        session.controllerLease.rendererReadyFence = options.fence;
      }
      return controlState;
    },
    async resizeAgentSession(_agentId, cols, rows, options) {
      const begun = beginTerminalControllerResize(session, options);
      if (!begun.accepted) return begun.result;
      session.previewCols = cols;
      session.previewRows = rows;
      session.stateRevision += 1;
      return commitTerminalControllerResize(session, begun.requestSeq);
    },
    async sendInput(_agentId, input, options) {
      const controlState = validateTerminalControllerInput(session, options.terminalControl);
      if (controlState.status !== 'input-accepted') return controlState;
      inputWrites.push(input);
      return { sent: true };
    },
    async interruptAgent(_agentId, options = {}) {
      const controlState = validateTerminalControllerInput(session, options.terminalControl);
      if (controlState.status !== 'input-accepted') return controlState;
      interruptCount += 1;
      return { sent: true };
    },
    async clearAgentSessionBuffer(_agentId, controller) {
      const controlState = validateTerminalControllerClear(session, controller);
      if (controlState.status !== 'clear-accepted') {
        return { cleared: false, ...controlState };
      }
      clearCount += 1;
      session.stateRevision += 1;
      return {
        cleared: true,
        runtimeEpoch: session.runtimeEpoch,
        outputSeq: session.outputSeq,
        stateRevision: session.stateRevision,
        cols: session.previewCols,
        rows: session.previewRows,
        expiresAt: session.controllerLease.expiresAt,
      };
    },
    async acknowledgeAgentSessionOutput(_agentId, charCount, controller) {
      const controlState = validateTerminalControllerOutputAck(session, controller);
      if (controlState.status !== 'output-ack-accepted') return controlState;
      acknowledgedChars += charCount;
      return controlState;
    },
    async acknowledgeAgentSessionCheckpoint(_agentId, outputSeq, stateRevision, controller) {
      const controlState = validateTerminalControllerOutputAck(session, controller);
      if (controlState.status !== 'output-ack-accepted') {
        return { ...controlState, status: 'checkpoint-applied-rejected' };
      }
      acknowledgedCheckpoint = { outputSeq, stateRevision };
      return { ...controlState, status: 'checkpoint-applied-accepted' };
    },
  };
  const coordinator = new TerminalControllerCoordinator({
    agentManager: manager,
    serverInstanceId: 'server-a',
    leaseTtlMs: 30000,
    send(ws, message) {
      ws.messages.push(message);
    },
  });
  const first = createSocket('socket-a');
  const second = createSocket('socket-b');

  await coordinator.claim(first, {
    agentId: 'agent-a',
    attachmentId: 'attachment-a',
    claimId: 'claim-a',
    mode: 'passive',
    expectedRuntimeEpoch: 'epoch-a',
  });
  const firstOwner = lastMessage(first);
  assert.strictEqual(firstOwner.status, 'owner');
  assert.strictEqual('runtimeEpoch' in firstOwner, false);
  assert.ok(firstOwner.leaseId);

  await coordinator.claim(second, {
    agentId: 'agent-a',
    attachmentId: 'attachment-b',
    claimId: 'claim-b',
    mode: 'passive',
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.deepStrictEqual(lastMessage(second), {
    type: 'terminal-controller',
    agentId: 'agent-a',
    attachmentId: 'attachment-b',
    claimId: 'claim-b',
    status: 'observer',
    leaseId: undefined,
    fence: undefined,
    expiresAt: firstOwner.expiresAt,
  });

  await coordinator.claim(second, {
    agentId: 'agent-a',
    attachmentId: 'attachment-b',
    claimId: 'claim-b-interactive',
    mode: 'interactive',
    expectedRuntimeEpoch: 'epoch-a',
  });
  let secondOwner = lastMessage(second);
  assert.strictEqual(secondOwner.status, 'owner');
  assert.ok(secondOwner.fence > firstOwner.fence);
  assert.strictEqual(lastMessage(first).status, 'revoked');
  assert.strictEqual(lastMessage(first).reason, 'interactive-takeover');
  assert.strictEqual(
    coordinator.authorizeHttpMutation('agent-a', null).allowed,
    false,
    'HTTP Terminal mutations must not bypass the browser owner',
  );
  assert.strictEqual(
    coordinator.authorizeHttpMutation('agent-a', {
      attachmentId: 'attachment-b',
      leaseId: secondOwner.leaseId,
      fence: secondOwner.fence,
      expectedRuntimeEpoch: 'epoch-a',
    }).allowed,
    true,
  );
  let rejectedSystemMutationRan = false;
  const rejectedSystemMutation = await coordinator.runSystemMutation('agent-a', async () => {
    rejectedSystemMutationRan = true;
    return { sent: true };
  }, { expectedRuntimeEpoch: 'epoch-a' });
  assert.strictEqual(rejectedSystemMutation.status, 'rejected');
  assert.strictEqual(rejectedSystemMutation.reason, 'terminal-controlled-by-browser');
  assert.strictEqual(rejectedSystemMutationRan, false);

  await coordinator.claim(first, {
    agentId: 'agent-a',
    attachmentId: 'attachment-a',
    claimId: 'claim-a',
    mode: 'interactive',
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(lastMessage(first).status, 'observer');
  assert.strictEqual(lastMessage(first).reason, 'superseded-claim');
  assert.strictEqual(coordinator.owners.get('agent-a').ws, second);

  await coordinator.resize(first, {
    agentId: 'agent-a',
    attachmentId: 'attachment-a',
    leaseId: firstOwner.leaseId,
    fence: firstOwner.fence,
    requestSeq: 1,
    expectedRuntimeEpoch: 'epoch-a',
    cols: 100,
    rows: 30,
  });
  assert.strictEqual(lastMessage(first).status, 'observer');
  assert.strictEqual(lastMessage(first).reason, 'stale-lease');
  assert.strictEqual(session.previewCols, 80, 'a revoked browser must not resize the PTY');

  await coordinator.input(first, {
    agentId: 'agent-a',
    attachmentId: 'attachment-a',
    leaseId: firstOwner.leaseId,
    fence: firstOwner.fence,
    expectedRuntimeEpoch: 'epoch-a',
  }, ['echo stale\r']);
  assert.strictEqual(lastMessage(first).status, 'observer');
  assert.strictEqual(lastMessage(first).reason, 'stale-lease');
  assert.strictEqual(inputWrites.length, 0, 'a revoked browser must not write to the PTY');

  await coordinator.input(second, {
    agentId: 'agent-a',
    attachmentId: 'attachment-b',
    leaseId: secondOwner.leaseId,
    fence: secondOwner.fence,
    expectedRuntimeEpoch: 'epoch-a',
  }, ['echo before renderer ready\r']);
  assert.strictEqual(lastMessage(second).status, 'rejected');
  assert.strictEqual(lastMessage(second).reason, 'renderer-not-ready');
  assert.strictEqual(inputWrites.length, 0, 'input must wait for the replay commit boundary');
  assert.strictEqual(coordinator.owners.has('agent-a'), false);
  assert.deepStrictEqual(
    coordinator.authorizeHttpMutation('agent-a', null),
    { allowed: false, reason: 'unowned' },
    'an unowned Terminal must be claimed before an HTTP mutation',
  );

  await coordinator.claim(second, {
    agentId: 'agent-a',
    attachmentId: 'attachment-b',
    claimId: 'claim-b-recovered',
    mode: 'interactive',
    expectedRuntimeEpoch: 'epoch-a',
  });
  secondOwner = lastMessage(second);
  assert.strictEqual(secondOwner.status, 'owner');

  const secondMessagesBeforeRendererReady = second.messages.length;
  await coordinator.rendererReady(second, {
    agentId: 'agent-a',
    attachmentId: 'attachment-b',
    leaseId: secondOwner.leaseId,
    fence: secondOwner.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(session.controllerLease.rendererReadyFence, secondOwner.fence);
  assert.strictEqual(
    second.messages.length,
    secondMessagesBeforeRendererReady,
    'successful renderer readiness remains an ordered transport barrier without a second ACK',
  );

  await coordinator.checkpointApplied(second, {
    agentId: 'agent-a',
    attachmentId: 'attachment-b',
    leaseId: secondOwner.leaseId,
    fence: secondOwner.fence,
    expectedRuntimeEpoch: 'epoch-a',
    outputSeq: session.outputSeq,
    stateRevision: session.stateRevision,
  });
  assert.deepStrictEqual(acknowledgedCheckpoint, {
    outputSeq: session.outputSeq,
    stateRevision: session.stateRevision,
  });

  await coordinator.interrupt(first, {
    agentId: 'agent-a',
    attachmentId: 'attachment-a',
    leaseId: firstOwner.leaseId,
    fence: firstOwner.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(lastMessage(first).status, 'observer');
  assert.strictEqual(interruptCount, 0, 'a revoked browser must not interrupt the PTY');

  await coordinator.interrupt(second, {
    agentId: 'agent-a',
    attachmentId: 'attachment-b',
    leaseId: secondOwner.leaseId,
    fence: secondOwner.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(interruptCount, 1, 'only the current controller may interrupt the PTY');

  const secondMessagesBeforeInput = second.messages.length;
  await coordinator.input(second, {
    agentId: 'agent-a',
    attachmentId: 'attachment-b',
    leaseId: secondOwner.leaseId,
    fence: secondOwner.fence,
    expectedRuntimeEpoch: 'epoch-a',
  }, ['echo committed\r']);
  assert.strictEqual(inputWrites.length, 1);
  assert.strictEqual(
    second.messages.length,
    secondMessagesBeforeInput,
    'successful raw terminal input should not create a per-input ACK',
  );

  await coordinator.input(second, {
    agentId: 'agent-a',
    attachmentId: 'attachment-b',
    leaseId: secondOwner.leaseId,
    fence: secondOwner.fence,
    expectedRuntimeEpoch: 'epoch-a',
  }, ['echo committed\r']);
  assert.strictEqual(
    inputWrites.length,
    2,
    'raw terminal input is an ordered byte stream and must not invent request deduplication',
  );

  await coordinator.acknowledgeOutput(first, {
    agentId: 'agent-a',
    attachmentId: 'attachment-a',
    leaseId: firstOwner.leaseId,
    fence: firstOwner.fence,
    expectedRuntimeEpoch: 'epoch-a',
    charCount: 5000,
  });
  assert.strictEqual(lastMessage(first).status, 'observer');
  assert.strictEqual(acknowledgedChars, 0, 'a revoked browser must not acknowledge renderer output');

  const secondMessagesBeforeOutputAck = second.messages.length;
  await coordinator.acknowledgeOutput(second, {
    agentId: 'agent-a',
    attachmentId: 'attachment-b',
    leaseId: secondOwner.leaseId,
    fence: secondOwner.fence,
    expectedRuntimeEpoch: 'epoch-a',
    charCount: 5000,
  });
  assert.strictEqual(acknowledgedChars, 5000);
  assert.strictEqual(
    second.messages.length,
    secondMessagesBeforeOutputAck,
    'successful renderer flow-control ACKs should remain transport-internal',
  );

  await coordinator.clear(first, {
    agentId: 'agent-a',
    attachmentId: 'attachment-a',
    leaseId: firstOwner.leaseId,
    fence: firstOwner.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(lastMessage(first).status, 'observer');
  assert.strictEqual(lastMessage(first).reason, 'stale-lease');
  assert.strictEqual(clearCount, 0, 'a revoked browser must not clear the PTY');

  const secondMessagesBeforeClear = second.messages.length;
  await coordinator.clear(second, {
    agentId: 'agent-a',
    attachmentId: 'attachment-b',
    leaseId: secondOwner.leaseId,
    fence: secondOwner.fence,
    expectedRuntimeEpoch: 'epoch-a',
  });
  assert.strictEqual(clearCount, 1);
  assert.strictEqual(
    second.messages.length,
    secondMessagesBeforeClear,
    'successful clear is observed through the authoritative session sync, not a second ACK protocol',
  );

  await coordinator.resize(second, {
    agentId: 'agent-a',
    attachmentId: 'attachment-b',
    leaseId: secondOwner.leaseId,
    fence: secondOwner.fence,
    requestSeq: 1,
    expectedRuntimeEpoch: 'epoch-a',
    cols: 120,
    rows: 40,
  });
  const committed = lastMessage(second);
  assert.strictEqual(committed.status, 'resize-committed');
  assert.strictEqual(committed.requestSeq, 1);
  assert.strictEqual('cols' in committed, false);
  assert.strictEqual('rows' in committed, false);
  assert.strictEqual('stateRevision' in committed, false);
  assert.strictEqual('outputSeq' in committed, false);
  assert.strictEqual('checkpoint' in committed, false);
  assert.strictEqual('checkpointPending' in committed, false);

  await coordinator.resize(second, {
    agentId: 'agent-a',
    attachmentId: 'attachment-b',
    leaseId: secondOwner.leaseId,
    fence: secondOwner.fence,
    requestSeq: 1,
    expectedRuntimeEpoch: 'epoch-a',
    cols: 120,
    rows: 40,
  });
  assert.strictEqual(lastMessage(second).status, 'resize-committed');
  assert.strictEqual(lastMessage(second).duplicate, true);

  await coordinator.releaseAllForSocket(second);
  assert.strictEqual(lastMessage(second).status, 'unowned');
  assert.strictEqual(lastMessage(second).reason, 'socket-closed');
  assert.strictEqual(coordinator.owners.has('agent-a'), false);
  let systemControl = null;
  const systemMutation = await coordinator.runSystemMutation('agent-a', async (context) => {
    systemControl = context.terminalControl;
    return { sent: true };
  }, { expectedRuntimeEpoch: 'epoch-a' });
  assert.deepStrictEqual(systemMutation, { sent: true });
  assert.deepStrictEqual(systemControl, {
    kind: 'system',
    expectedRuntimeEpoch: 'epoch-a',
  });

  await coordinator.resize(second, {
    agentId: 'agent-a',
    attachmentId: 'attachment-b',
    leaseId: secondOwner.leaseId,
    fence: secondOwner.fence,
    requestSeq: 2,
    expectedRuntimeEpoch: 'epoch-a',
    cols: 140,
    rows: 50,
  });
  assert.strictEqual(lastMessage(second).status, 'resize-rejected');
  assert.strictEqual(lastMessage(second).reason, 'unowned');
  assert.strictEqual(session.previewCols, 120);

  await testControllerDoesNotReadDisplayCheckpoint();
  await testLeaseExpiryReleasesController();
  await testLeaseExpirySchedulerRespectsRenewedDeadline();
  await testOwnedMutationSerializesInteractiveTakeover();

  console.log('terminal controller coordinator tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
