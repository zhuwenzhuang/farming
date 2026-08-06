const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readOnlyClientMessageAllowed } = require('../read-only-access.cjs');

function run() {
  for (const type of [
    'business-health-probe',
    'focus-agent',
    'protocol-hello',
    'state-resync',
    'unwatch-workspace-files',
    'watch-workspace-files',
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
  ]) {
    assert.strictEqual(readOnlyClientMessageAllowed(type), false, `${type} must be rejected`);
  }

  const webSocketSource = fs.readFileSync(path.join(__dirname, '../../src/hooks/useWebSocket.ts'), 'utf8');
  assert(webSocketSource.includes("type WebSocketAccessMode = 'unknown' | 'owner' | 'read-only'"));
  assert(webSocketSource.includes("accessMode: 'unknown'"));
  assert(webSocketSource.includes('pendingAccessMessagesRef.current.push(msg)'));
  assert(webSocketSource.includes("READ_ONLY_SILENT_MESSAGE_TYPES = new Set<ClientMessage['type']>(['resize-agent'])"));
  assert(webSocketSource.includes('READ_ONLY_SILENT_MESSAGE_TYPES.has(msg.type)'));
  assert(webSocketSource.includes("accessMode === 'owner' || READ_ONLY_CLIENT_MESSAGE_TYPES.has(message.type)"));

  console.log('read-only access assertions passed');
}

run();
