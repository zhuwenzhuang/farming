const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');

async function run() {
  const {
    requestTerminalSessionCheckpoint,
    setTerminalSessionTransport,
    setTerminalSessionTransportReady,
    settleTerminalSessionCheckpoint,
  } = importTsModule('src/lib/terminal-session-client.ts');

  const sent = [];
  setTerminalSessionTransport(message => {
    sent.push(message);
    return true;
  });
  setTerminalSessionTransportReady(false);

  const controller = new AbortController();
  const checkpoint = requestTerminalSessionCheckpoint('agent-hidden', controller.signal, 500);
  assert.strictEqual(sent.length, 0, 'checkpoint waits for the negotiated WebSocket');

  setTerminalSessionTransportReady(true);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].type, 'terminal-checkpoint-request');
  assert.strictEqual(sent[0].agentId, 'agent-hidden');
  assert.strictEqual(sent[0].scrollbackLimit, 500);

  setTerminalSessionTransportReady(false);
  setTerminalSessionTransportReady(true);
  assert.strictEqual(sent.length, 2, 'a read-only checkpoint is replayed after reconnect');
  assert.strictEqual(sent[1].requestId, sent[0].requestId, 'reconnect preserves request identity');
  assert.strictEqual(sent[1].scrollbackLimit, 500, 'reconnect preserves the requested history window');

  assert.strictEqual(settleTerminalSessionCheckpoint({
    type: 'terminal-checkpoint-result',
    requestId: sent[0].requestId,
    agentId: 'different-agent',
    ok: true,
    session: {},
  }), false, 'a result for the wrong Agent cannot settle the request');

  assert.strictEqual(settleTerminalSessionCheckpoint({
    type: 'terminal-checkpoint-result',
    requestId: sent[0].requestId,
    agentId: 'agent-hidden',
    ok: true,
    session: {
      runtimeEpoch: 'runtime-1',
      outputSeq: 7,
      stateRevision: 8,
      renderOutput: 'ready',
      previewCols: 80,
      previewRows: 24,
    },
  }), true);
  assert.deepStrictEqual(await checkpoint, {
    session: {
      runtimeEpoch: 'runtime-1',
      outputSeq: 7,
      stateRevision: 8,
      renderOutput: 'ready',
      previewCols: 80,
      previewRows: 24,
    },
  });

  const timedOutController = new AbortController();
  const timedOut = requestTerminalSessionCheckpoint('agent-timeout', timedOutController.signal);
  timedOutController.abort(new DOMException('checkpoint deadline', 'TimeoutError'));
  await assert.rejects(timedOut, error => error?.name === 'TimeoutError');

  setTerminalSessionTransportReady(false);
  setTerminalSessionTransport(null);
  console.log('terminal session client assertions passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
