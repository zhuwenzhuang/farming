const assert = require('assert');
const {
  PROTOCOL_VERSION,
  protocolCompatible,
  validateClientMessage,
  validateServerMessage,
} = require('../../shared/browser-protocol');

assert.strictEqual(protocolCompatible(PROTOCOL_VERSION), true);
assert.strictEqual(protocolCompatible(PROTOCOL_VERSION + 1), false);
assert.strictEqual(validateClientMessage({ type: 'resize-agent', agentId: 'a', cols: 80, rows: 24 }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'resize-agent', agentId: 'a', cols: '80', rows: 24 }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'unknown' }).ok, false);
assert.strictEqual(validateServerMessage({ type: 'state', state: { agents: [] } }).ok, true);
assert.strictEqual(validateServerMessage({ type: 'state', state: {} }).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'agent-update',
  update: { agentId: 'a', patch: { terminalInputReceived: true } },
}).ok, true);
assert.strictEqual(validateServerMessage({ type: 'agent-update', update: { agentId: 'a' } }).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'agent-update',
  update: { agentId: 'a', patch: { terminalInputReceived: true, status: 'dead' } },
}).ok, false);
console.log('browser protocol schema tests passed');
