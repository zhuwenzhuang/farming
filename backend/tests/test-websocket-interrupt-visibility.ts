const assert = require('assert');
const { createWebSocketAgentLifecycleHandlers } = require('../websocket-agent-lifecycle-handlers.cjs');
const { validateServerMessage } = require('../../shared/browser-protocol.js');

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

async function run() {
  const sent = [];
  const client = {
    agentId: undefined,
    protocolVersion: 1,
    readyState: 1,
    send(data) {
      sent.push(JSON.parse(data));
    },
  };
  let interruptResult: Promise<unknown> = Promise.resolve();
  const ports = {
    openState: 1,
    canonicalProjectWorkspace: async workspace => String(workspace || ''),
    startAgent: async () => {},
    mountProjectWorkspace: () => {},
    archiveAgent: async () => ({ ok: true }),
    interruptAgent: () => interruptResult,
    getAgentState: () => ({ agents: [], mainAgentId: null }),
    killAgent: async () => ({ ok: true }),
    publishAgentState: () => {},
    revealAgentState: () => {},
    warnStartCompletionFailure: () => {},
  };
  const handlers = createWebSocketAgentLifecycleHandlers(ports);
  const errors = () => sent.filter(message => message.type === 'error');

  // 1. A fence rejection thrown by the interrupt action is surfaced visibly.
  interruptResult = Promise.reject(Object.assign(
    new Error('Terminal interrupt was not sent: an earlier write has an uncertain outcome until the terminal checkpoint recovers'),
    { code: 'TERMINAL_INPUT_UNCERTAIN_FENCE', composerZeroEffect: true },
  ));
  handlers.interruptAgent(client, { type: 'interrupt-agent', agentId: 'agent-a' });
  await flush();
  assert.strictEqual(errors().length, 1, 'a fenced interrupt must be visibly reported');
  assert.match(errors()[0].message, /uncertain outcome until the terminal checkpoint recovers/);
  assert.strictEqual(validateServerMessage(errors()[0]).ok, true,
    'the visible interrupt rejection must be a protocol-validated server message');

  // 2. An uncertain interrupt failure is also surfaced, distinctly worded.
  interruptResult = Promise.reject(Object.assign(
    new Error('Terminal interrupt delivery could not be confirmed. Check the terminal state and retry.'),
    { code: 'TERMINAL_INPUT_UNCONFIRMED', uncertain: true },
  ));
  handlers.interruptAgent(client, { type: 'interrupt-agent', agentId: 'agent-a' });
  await flush();
  assert.strictEqual(errors().length, 2, 'an uncertain interrupt must be visibly reported');
  assert.match(errors()[1].message, /could not be confirmed/);

  // 3. A successful interrupt stays silent (no spurious error).
  interruptResult = Promise.resolve({ sent: true });
  handlers.interruptAgent(client, { type: 'interrupt-agent', agentId: 'agent-a' });
  await flush();
  assert.strictEqual(errors().length, 2);
}

run().then(() => {
  console.log('websocket interrupt visibility tests passed');
  process.exit(0);
}).catch(error => {
  console.error(error);
  process.exit(1);
});
