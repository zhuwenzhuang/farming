const assert = require('assert');
const { AgentManager } = require('../agent-manager.cjs');
const { createWebSocketTerminalHandlers } = require('../websocket-terminal-handlers.cjs');
const { createTestAgentManager } = require('./helpers/test-acp-runtime.ts');
const { importTsModule } = require('./helpers/import-ts-module');

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

function timeoutError() {
  const error = new Error('Native pty host request timed out: sendInput') as Error & {
    code?: string;
    terminalMutationUncertain?: boolean;
  };
  error.code = 'ETIMEDOUT';
  error.terminalMutationUncertain = true;
  return error;
}

function createManager() {
  const manager = createTestAgentManager(AgentManager, {
    getWorkspace() {
      return '/tmp';
    },
    getHeartbeatInterval() {
      return 1000;
    },
  });
  manager.heartbeatScheduler?.stop?.();
  return manager;
}

// The production decision helper gates reconciliation-worthy visible errors
// and stays bounded; it must not fire for unrelated errors.
async function decisionHelperGatesReconciliation() {
  // A single module entry keeps one transport/checkpoint state graph for the
  // decision helper and the checkpoint machinery it drives.
  const {
    reconcileTerminalFenceError,
    setTerminalSessionTransport,
    setTerminalSessionTransportReady,
    settleTerminalSessionCheckpoint,
  } = importTsModule('src/lib/terminal-fence-error-recovery.ts');

  const sent = [];
  setTerminalSessionTransport(message => {
    sent.push(message);
    return true;
  });
  setTerminalSessionTransportReady(true);

  assert.strictEqual(reconcileTerminalFenceError({}), false, 'no agentId, no reconciliation');
  assert.strictEqual(
    reconcileTerminalFenceError({ agentId: 'agent-x', reason: 'terminal-write-rejected' }),
    false,
    'a proven rejection is not reconciliation-worthy',
  );
  assert.strictEqual(sent.length, 0);

  assert.strictEqual(
    reconcileTerminalFenceError({ agentId: 'agent-x', reason: 'delivery-not-confirmed' }),
    true,
    'the first unconfirmed delivery is reconciliation-worthy',
  );
  // Bounded: repeated identical errors while the request is in flight stay
  // a single checkpoint request.
  assert.strictEqual(reconcileTerminalFenceError({ agentId: 'agent-x', reason: 'delivery-not-confirmed' }), true);
  assert.strictEqual(reconcileTerminalFenceError({ agentId: 'agent-x', reason: 'uncertain-input-fence' }), true);
  assert.strictEqual(sent.length, 1, 'exactly one checkpoint request while one is in flight');
  assert.strictEqual(sent[0].type, 'terminal-checkpoint-request');
  assert.strictEqual(sent[0].agentId, 'agent-x');

  // Settle the in-flight request so the timer and in-flight state clear.
  assert.strictEqual(settleTerminalSessionCheckpoint({
    type: 'terminal-checkpoint-result',
    requestId: sent[0].requestId,
    agentId: 'agent-x',
    ok: true,
    session: { runtimeEpoch: 'epoch-1' },
  }), true);
  await flush();

  // After settlement a later error may drive a fresh reconciliation; settle
  // it too so nothing leaks.
  assert.strictEqual(reconcileTerminalFenceError({ agentId: 'agent-x', reason: 'uncertain-input-fence' }), true);
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(settleTerminalSessionCheckpoint({
    type: 'terminal-checkpoint-result',
    requestId: sent[1].requestId,
    agentId: 'agent-x',
    ok: true,
    session: { runtimeEpoch: 'epoch-1' },
  }), true);
  await flush();

  setTerminalSessionTransportReady(false);
  setTerminalSessionTransport(null);
}

// End-to-end chain: timed-out write -> visible delivery-not-confirmed error ->
// the exact emitted error drives the production helper -> exactly one explicit
// checkpoint request for the exact Agent -> server releases only on the exact
// epoch response -> stale pre-boundary input stays rejected -> fresh input
// succeeds. No sacrificial second input, no reconnect.
async function firstUnconfirmedWriteRecoversThroughOneCheckpoint() {
  const manager = createManager();
  const {
    reconcileTerminalFenceError,
    setTerminalSessionTransport,
    setTerminalSessionTransportReady,
    settleTerminalSessionCheckpoint,
  } = importTsModule('src/lib/terminal-fence-error-recovery.ts');

  const writes = [];
  const heldStarted = deferred();
  const releaseHeld = deferred();
  let holdFirst = true;
  manager.engineBridge.getEngine = () => ({
    async sendInput(agentId, input) {
      if (holdFirst) {
        holdFirst = false;
        heldStarted.resolve();
        await releaseHeld.promise;
        throw timeoutError();
      }
      writes.push({ agentId, input });
      return { sent: true };
    },
    async getSessionState() {
      return {
        status: 'running',
        runtimeEpoch: 'epoch-1',
        previewText: 'ready',
        output: 'ready',
        renderOutput: 'ready',
      };
    },
  });
  manager.agents.set('agent-live', {
    id: 'agent-live',
    command: 'codex',
    cwd: '/tmp',
    engineName: 'local',
    status: 'running',
    agentRuntimeMode: 'terminal',
    runtimeEpoch: 'epoch-1',
  });

  const client = {
    protocolVersion: 1,
    readyState: 1,
    sent: [],
    send(data) {
      const message = JSON.parse(data);
      this.sent.push(message);
      if (message.type === 'terminal-checkpoint-result') {
        // The attached client settles the checkpoint result exactly like
        // the production terminal session client.
        settleTerminalSessionCheckpoint(message);
      }
    },
  };

  const handlers = createWebSocketTerminalHandlers({
    openState: 1,
    getAgentSessionView: agentId => manager.getAgentSessionView(agentId),
    checkpointReconciled: (agentId, session) => {
      manager.releaseTerminalInputFence(agentId, session || {});
    },
    sendInput: (agentId, inputParts) => manager.sendInput(agentId, inputParts),
    requestResize: () => {},
    clearBuffer: async () => {},
    checkpointErrorMessage: caught => String(caught?.message || caught),
  });

  // The client transport loops checkpoint requests straight back into this
  // connection's handlers, mirroring the shared WebSocket session.
  const checkpointRequests = [];
  setTerminalSessionTransport(message => {
    if (message.type === 'terminal-checkpoint-request') {
      checkpointRequests.push(message);
      handlers.terminalCheckpointRequest(client, message);
      return true;
    }
    return false;
  });
  setTerminalSessionTransportReady(true);

  const errors = () => client.sent.filter(message => message.type === 'error');

  // Hold the first write in flight and admit a pre-boundary input behind it.
  handlers.input(client, { agentId: 'agent-live', input: 'held' });
  await heldStarted.promise;
  const preBoundary = manager.sendInput('agent-live', [{ type: 'paste', text: 'queued' }, '\r']);

  // The in-flight write fails uncertain: the fence activates and the first
  // unconfirmed delivery becomes exactly one visible error.
  releaseHeld.resolve();
  await flush();
  await flush();
  assert.strictEqual(errors().length, 1, 'the first uncertain write is visibly reported');
  assert.strictEqual(errors()[0].reason, 'delivery-not-confirmed');
  assert.strictEqual(errors()[0].agentId, 'agent-live');
  assert.match(errors()[0].message, /could not be confirmed/);
  assert.ok(!/was not sent|rejected/.test(errors()[0].message),
    'an uncertain write is never labeled a proven rejection');
  assert.strictEqual(manager.terminalInputFences.get('agent-live')?.active, true,
    'the first uncertain write activates the fence');

  // The exact emitted error drives the production reconciliation decision.
  assert.strictEqual(reconcileTerminalFenceError(errors()[0]), true);
  await flush();
  await flush();

  // Exactly one explicit checkpoint request, for the exact Agent.
  assert.strictEqual(checkpointRequests.length, 1, 'exactly one checkpoint request is driven');
  assert.strictEqual(checkpointRequests[0].agentId, 'agent-live');
  const checkpointResults = client.sent.filter(message => message.type === 'terminal-checkpoint-result');
  assert.strictEqual(checkpointResults.length, 1);
  assert.strictEqual(checkpointResults[0].ok, true);
  assert.strictEqual(checkpointResults[0].session.runtimeEpoch, 'epoch-1',
    'the checkpoint responds with the exact live epoch');
  assert.strictEqual(manager.terminalInputFences.get('agent-live')?.active, false,
    'the exact-epoch checkpoint releases the fence');

  // The pre-boundary queued input stays rejected.
  assert.deepStrictEqual(
    await preBoundary,
    { status: 'input-rejected', reason: 'uncertain-input-fence' },
    'stale pre-boundary queued input must stay rejected',
  );
  // A stale pre-boundary admission cannot cross after the release either.
  assert.deepStrictEqual(
    await manager.sendInputNow('agent-live', 'stale', { admissionPhase: 0, expectedRuntimeEpoch: 'epoch-1' }),
    { status: 'input-rejected', reason: 'uncertain-input-fence' },
    'stale pre-boundary admission stays rejected after release',
  );

  // A fresh input after the checkpoint succeeds with no further visible error.
  handlers.input(client, { agentId: 'agent-live', input: 'fresh' });
  await flush();
  await flush();
  assert.strictEqual(errors().length, 1, 'no further visible error after recovery');
  assert.strictEqual(writes.length, 1);
  assert.deepStrictEqual(writes[0].input, ['fresh']);
  assert.strictEqual(checkpointRequests.length, 1, 'recovery needed no second checkpoint');

  // Exact cleanup: no transport, no in-flight reconciliation state.
  setTerminalSessionTransportReady(false);
  setTerminalSessionTransport(null);
}

async function run() {
  await decisionHelperGatesReconciliation();
  await firstUnconfirmedWriteRecoversThroughOneCheckpoint();
}

run().then(() => {
  console.log('terminal fence liveness tests passed');
  process.exit(0);
}).catch(error => {
  console.error(error);
  process.exit(1);
});
