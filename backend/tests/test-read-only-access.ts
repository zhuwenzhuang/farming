const assert = require('assert');
const { readOnlyClientMessageAllowed } = require('../read-only-access.cjs');

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
