const assert = require('assert');
const { readOnlyClientMessageAllowed, rejectReadOnlyClientMutation } = require('../read-only-access.cjs');

async function run() {
  for (const type of [
    'business-health-probe',
    'focus-agent',
    'protocol-hello',
    'state-resync',
    'terminal-checkpoint-request',
    'watch-acp-transcripts',
    'unwatch-workspace-files',
    'watch-workspace-files',
    'workspace-request',
    'workspace-cancel',
  ]) {
    assert.strictEqual(readOnlyClientMessageAllowed(type), true, `${type} should remain view-only`);
  }

  for (const type of [
    'start-agent',
    'input',
    'composer-input',
    'acp-permission-response',
    'interrupt-agent',
    'resize-agent',
    'clear-terminal',
    'archive-agent',
    'restart-main-agent',
    'language-server-request',
  ]) {
    assert.strictEqual(readOnlyClientMessageAllowed(type), false, `${type} must be rejected`);
  }

  const frames: Record<string, unknown>[] = [];
  const viewer = { accessMode: 'read-only', send: (body: string) => frames.push(JSON.parse(body)) };
  assert.strictEqual(rejectReadOnlyClientMutation(viewer, {
    type: 'language-server-request', requestId: 'language-one',
  }), true);
  assert.deepStrictEqual(frames.pop(), {
    type: 'language-server-result', requestId: 'language-one', ok: false,
    error: { code: 'FORBIDDEN', status: 403, message: 'This Farming share is read-only.' },
  }, 'denied language work must settle its own request without waiting for a timeout');
  const input = { type: 'composer-input', agentId: 'agent-one', requestId: 'request-one' };
  assert.strictEqual(rejectReadOnlyClientMutation(viewer, input), true);
  assert.deepStrictEqual(frames.pop(), {
    type: 'composer-input-result', agentId: 'agent-one', requestId: 'request-one',
    accepted: false, message: 'This Farming share is read-only.',
  }, 'denied input must settle the exact pending request as a definite zero-effect failure');
  assert.strictEqual(rejectReadOnlyClientMutation(viewer, { ...input, type: 'composer-input-status-request' }), true);
  assert.deepStrictEqual(frames.pop(), {
    type: 'composer-input-result', agentId: 'agent-one', requestId: 'request-one',
    accepted: false, uncertain: true,
    message: 'This Farming share is read-only. Delivery status cannot be checked with this access.',
  }, 'denied reconciliation must terminate without claiming a historical request had no effect');
  assert.strictEqual(rejectReadOnlyClientMutation(viewer, { type: 'input' }), true);
  assert.deepStrictEqual(frames.pop(), { type: 'error', message: 'This Farming share is read-only.' });
  assert.strictEqual(rejectReadOnlyClientMutation(viewer, { type: 'focus-agent' }), false);
  assert.strictEqual(rejectReadOnlyClientMutation({ ...viewer, accessMode: 'owner' }, input), false);
  assert.strictEqual(frames.length, 0, 'allowed reads and Owner operations remain unchanged');

  const {
    outgoingWebSocketMessageDisposition,
    replayableWebSocketMessage,
  } = await import('../../src/lib/websocket-access.ts');
  const mutation = { type: 'start-agent' } as never;
  const readOnlyProbe = { type: 'business-health-probe' } as never;
  const resize = { type: 'resize-agent' } as never;
  assert.strictEqual(outgoingWebSocketMessageDisposition('unknown', mutation), 'queue');
  assert.strictEqual(outgoingWebSocketMessageDisposition('owner', mutation), 'send');
  assert.strictEqual(outgoingWebSocketMessageDisposition('read-only', mutation), 'send');
  assert.strictEqual(outgoingWebSocketMessageDisposition('read-only', resize), 'silent');
  assert.strictEqual(replayableWebSocketMessage('read-only', readOnlyProbe), true);
  assert.strictEqual(replayableWebSocketMessage('read-only', mutation), false);
  assert.strictEqual(replayableWebSocketMessage('owner', mutation), true);

  console.log('read-only access assertions passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
