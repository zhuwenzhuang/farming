const assert = require('assert');
const { createWebSocketTerminalHandlers } = require('../websocket-terminal-handlers.cjs');
const { validateServerMessage } = require('../../shared/browser-protocol.js');

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

function createClient() {
  const sent = [];
  return {
    sent,
    protocolVersion: 1,
    readyState: 1,
    send(data) {
      sent.push(JSON.parse(data));
    },
  };
}

async function run() {
  const inputResults = [];
  let sendInputShouldThrow = false;
  const reconciled = [];
  const ports = {
    openState: 1,
    getAgentSessionView: async () => ({ runtimeEpoch: 'epoch-1', previewText: 'x' }),
    checkpointReconciled: (agentId, session) => {
      reconciled.push({ agentId, session });
    },
    sendInput: async () => {
      if (sendInputShouldThrow) throw new Error('boom');
      return inputResults.shift();
    },
    requestResize: () => {},
    clearBuffer: async () => {},
    checkpointErrorMessage: caught => String(caught?.message || caught),
  };
  const handlers = createWebSocketTerminalHandlers(ports);
  const client = createClient();
  const errors = () => client.sent.filter(message => message.type === 'error');

  // 1. Unknown first outcome (undefined result) becomes a visible,
  // protocol-validated delivery-not-confirmed error.
  inputResults.push(undefined);
  handlers.input(client, { agentId: 'agent-a', input: 'x' });
  await flush();
  assert.strictEqual(errors().length, 1, 'an unconfirmed write must be visible');
  assert.strictEqual(errors()[0].reason, 'delivery-not-confirmed');
  assert.strictEqual(errors()[0].agentId, 'agent-a');
  assert.ok(!/boom|ETIMEDOUT|stack/.test(errors()[0].message), 'no internals in the visible message');
  assert.strictEqual(validateServerMessage(errors()[0]).ok, true,
    'the visible error must be a protocol-validated server message');

  // 2. Repeated identical unconfirmed outcomes are deduped (bounded).
  inputResults.push(undefined);
  handlers.input(client, { agentId: 'agent-a', input: 'x' });
  await flush();
  assert.strictEqual(errors().length, 1, 'identical consecutive errors are deduped');

  // 3. A changed reason (fence rejection) becomes visible again.
  inputResults.push({ status: 'input-rejected', reason: 'uncertain-input-fence' });
  handlers.input(client, { agentId: 'agent-a', input: 'x' });
  await flush();
  assert.strictEqual(errors().length, 2);
  assert.strictEqual(errors()[1].reason, 'uncertain-input-fence');
  assert.strictEqual(validateServerMessage(errors()[1]).ok, true);

  // 4. Repeated identical rejections are deduped.
  inputResults.push({ status: 'input-rejected', reason: 'uncertain-input-fence' });
  handlers.input(client, { agentId: 'agent-a', input: 'x' });
  await flush();
  assert.strictEqual(errors().length, 2, 'identical consecutive rejections are deduped');

  // 5. A successful explicit checkpoint reconciliation clears the dedupe.
  handlers.terminalCheckpointRequest(client, { requestId: 'r1', agentId: 'agent-a' });
  await flush();
  assert.strictEqual(reconciled.length, 1, 'the checkpoint notifies the fence owner');
  assert.strictEqual(reconciled[0].agentId, 'agent-a');

  // 6. The same rejection after the checkpoint is visible again.
  inputResults.push({ status: 'input-rejected', reason: 'uncertain-input-fence' });
  handlers.input(client, { agentId: 'agent-a', input: 'x' });
  await flush();
  assert.strictEqual(errors().length, 3, 'a new fence after reconciliation is visible again');

  // 7. A successful input clears the error state.
  inputResults.push({ sent: true });
  handlers.input(client, { agentId: 'agent-a', input: 'x' });
  await flush();
  assert.strictEqual(errors().length, 3);

  // 8. The next unconfirmed outcome is visible again after the success.
  inputResults.push(undefined);
  handlers.input(client, { agentId: 'agent-a', input: 'x' });
  await flush();
  assert.strictEqual(errors().length, 4);

  // 9. A rejected sendInput promise has no other response path: it is
  // surfaced visibly through the same generic validated error.
  inputResults.push({ sent: true });
  handlers.input(client, { agentId: 'agent-a', input: 'x' });
  await flush();
  sendInputShouldThrow = true;
  handlers.input(client, { agentId: 'agent-a', input: 'x' });
  await flush();
  assert.strictEqual(errors().length, 5, 'a thrown delivery failure must be visible');
  assert.strictEqual(errors()[4].reason, 'delivery-not-confirmed');

  // 10. A definitive write rejection is visible with its own message:
  // 'input was not sent', never 'delivery unconfirmed'.
  sendInputShouldThrow = false;
  inputResults.push({ sent: true });
  handlers.input(client, { agentId: 'agent-a', input: 'x' });
  await flush();
  inputResults.push({ status: 'input-rejected', reason: 'terminal-write-rejected' });
  handlers.input(client, { agentId: 'agent-a', input: 'x' });
  await flush();
  assert.strictEqual(errors().length, 6);
  assert.strictEqual(errors()[5].reason, 'terminal-write-rejected');
  assert.match(errors()[5].message, /was not sent/);
  assert.strictEqual(validateServerMessage(errors()[5]).ok, true);
}

run().then(() => {
  console.log('websocket terminal input rejection tests passed');
  process.exit(0);
}).catch(error => {
  console.error(error);
  process.exit(1);
});
