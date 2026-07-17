const assert = require('assert');
const TerminalGeometryCoordinator = require('../terminal-geometry-coordinator');
const {
  beginTerminalGeometryResize,
  claimTerminalGeometry,
  commitTerminalGeometryResize,
  createTerminalGeometryControl,
  releaseTerminalGeometry,
  renewTerminalGeometry,
  validateTerminalGeometryClear,
  validateTerminalGeometryInput,
  validateTerminalGeometryOutputAck,
  validateTerminalGeometryRendererReady,
} = require('../terminal-geometry-control');
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
    geometryControl: createTerminalGeometryControl(),
  };
  let checkpointReadCount = 0;
  const manager = {
    async claimAgentSessionGeometry(_agentId, options) {
      return claimTerminalGeometry(session, options);
    },
    async getAgentSessionAttachCheckpoint() {
      checkpointReadCount += 1;
      throw new Error('geometry coordination must not read display checkpoints');
    },
    async renewAgentSessionGeometry(_agentId, options) {
      return renewTerminalGeometry(session, options);
    },
    async releaseAgentSessionGeometry(_agentId, options) {
      return releaseTerminalGeometry(session, options);
    },
  };
  const coordinator = new TerminalGeometryCoordinator({
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
    geometryControl: createTerminalGeometryControl(),
  };
  const manager = {
    async claimAgentSessionGeometry(_agentId, options) {
      return claimTerminalGeometry(current, options);
    },
    async releaseAgentSessionGeometry(_agentId, options) {
      return releaseTerminalGeometry(current, options);
    },
  };
  const coordinator = new TerminalGeometryCoordinator({
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
  owner.expiresAt = Date.now() - 1;
  current.geometryControl.expiresAt = owner.expiresAt;
  await coordinator.expireOwner('agent-expiry', owner);
  assert.strictEqual(coordinator.owners.has('agent-expiry'), false);
  assert.strictEqual(current.geometryControl.ownerKey, '');
  assert.strictEqual(lastMessage(socket).status, 'expired');
  assert.strictEqual(lastMessage(socket).reason, 'lease-expired');
}

async function testLeaseExpirySchedulerRespectsRenewedDeadline() {
  const current = {
    runtimeEpoch: 'epoch-scheduler',
    geometryControl: createTerminalGeometryControl(),
  };
  const manager = {
    async claimAgentSessionGeometry(_agentId, options) {
      return claimTerminalGeometry(current, options);
    },
    async releaseAgentSessionGeometry(_agentId, options) {
      return releaseTerminalGeometry(current, options);
    },
  };
  const coordinator = new TerminalGeometryCoordinator({
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
  current.geometryControl.expiresAt = owner.expiresAt;
  coordinator.scheduleLeaseExpiryCheck();

  await delay(15);
  owner.expiresAt = Date.now() + 80;
  current.geometryControl.expiresAt = owner.expiresAt;
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

async function run() {
  const session = {
    runtimeEpoch: 'epoch-a',
    outputSeq: 4,
    stateRevision: 6,
    previewCols: 80,
    previewRows: 24,
    geometryControl: createTerminalGeometryControl(),
  };
  const inputWrites = [];
  let clearCount = 0;
  let acknowledgedChars = 0;
  const manager = {
    async claimAgentSessionGeometry(_agentId, options) {
      return claimTerminalGeometry(session, options);
    },
    async renewAgentSessionGeometry(_agentId, options) {
      return renewTerminalGeometry(session, options);
    },
    async releaseAgentSessionGeometry(_agentId, options) {
      return releaseTerminalGeometry(session, options);
    },
    async activateAgentSessionRenderer(_agentId, options) {
      const controlState = validateTerminalGeometryRendererReady(session, options);
      if (controlState.status === 'renderer-ready-accepted') {
        session.geometryControl.rendererReadyFence = options.fence;
      }
      return controlState;
    },
    async resizeAgentSession(_agentId, cols, rows, options) {
      const begun = beginTerminalGeometryResize(session, options);
      if (!begun.accepted) return begun.result;
      session.previewCols = cols;
      session.previewRows = rows;
      session.stateRevision += 1;
      return commitTerminalGeometryResize(session, begun.requestSeq);
    },
    async sendInput(_agentId, input, options) {
      const controlState = validateTerminalGeometryInput(session, options.terminalControl);
      if (controlState.status !== 'input-accepted') return controlState;
      inputWrites.push(input);
      return { sent: true };
    },
    async clearAgentSessionBuffer(_agentId, geometry) {
      const controlState = validateTerminalGeometryClear(session, geometry);
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
        expiresAt: session.geometryControl.expiresAt,
      };
    },
    async acknowledgeAgentSessionOutput(_agentId, charCount, geometry) {
      const controlState = validateTerminalGeometryOutputAck(session, geometry);
      if (controlState.status !== 'output-ack-accepted') return controlState;
      acknowledgedChars += charCount;
      return controlState;
    },
  };
  const coordinator = new TerminalGeometryCoordinator({
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
  assert.strictEqual(session.geometryControl.rendererReadyFence, secondOwner.fence);
  assert.strictEqual(
    second.messages.length,
    secondMessagesBeforeRendererReady,
    'successful renderer readiness remains an ordered transport barrier without a second ACK',
  );

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

  console.log('terminal geometry coordinator tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
