const assert = require('assert');
const packageJson = require('../../package.json');
const { importTsModule } = require('./helpers/import-ts-module');
const {
  PROTOCOL_VERSION,
  protocolCompatible,
  validateClientMessage,
  validateServerMessage,
} = importTsModule('shared/browser-protocol.ts');

assert(
  packageJson.files.includes('shared/*.js'),
  'the npm package must include the shared browser protocol required by the server',
);

assert.strictEqual(protocolCompatible(PROTOCOL_VERSION), true);
assert.strictEqual(protocolCompatible(PROTOCOL_VERSION + 1), false);
assert.strictEqual(validateClientMessage({ type: 'resize-agent', agentId: 'a', cols: 80, rows: 24 }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'resize-agent', agentId: 'a', cols: '80', rows: 24 }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'composer-input', agentId: 'a', message: 'steer', requestId: 'request-1' }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'composer-input', agentId: 'a', message: 'steer', requestId: 'request-1', delivery: 'steer' }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'composer-input', agentId: 'a', message: 'steer', requestId: 'request-1', delivery: 'next' }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'composer-input', agentId: 'a', message: 'steer', requestId: 1 }).ok, false);
assert.strictEqual(validateClientMessage({
  type: 'acp-permission-response',
  agentId: 'a',
  requestId: 'permission-1',
  optionId: 'allow',
  cancelled: false,
}).ok, true);
assert.strictEqual(validateClientMessage({
  type: 'acp-permission-response',
  agentId: 'a',
  requestId: 'permission-1',
}).ok, false);
assert.strictEqual(validateClientMessage({
  type: 'acp-permission-response',
  agentId: 'a',
  requestId: 'permission-1',
  optionId: 'allow',
  cancelled: 'false',
}).ok, false);
assert.strictEqual(validateClientMessage({ type: 'business-health-probe', requestId: 'health-1' }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'business-health-probe', requestId: 1 }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'unknown' }).ok, false);
assert.strictEqual(validateClientMessage(null).ok, false);
assert.strictEqual(validateServerMessage({ type: 'state', state: { agents: [] } }).ok, true);
assert.strictEqual(validateServerMessage({ type: 'state', state: {} }).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'browser-resource-snapshot',
  snapshot: { collectionRevision: 3, resources: [] },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'browser-resource-snapshot',
  snapshot: { collectionRevision: 3, resources: [{ id: '', revision: 1, collectionRevision: 3 }] },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'browser-resource-updated',
  resource: { id: 'browser-1', revision: 2, collectionRevision: 3 },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'browser-resource-deleted',
  deletion: { id: 'browser-1', collectionRevision: 4 },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'computer-resource-snapshot',
  snapshot: { collectionRevision: 5, resources: [] },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'computer-resource-updated',
  resource: { id: 'computer-1', revision: 1, collectionRevision: 6 },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'computer-resource-deleted',
  deletion: { id: 'computer-1', collectionRevision: -1 },
}).ok, false);
assert.strictEqual(validateServerMessage({ type: 'composer-input-result', requestId: 'request-1', agentId: 'a', accepted: true }).ok, true);
assert.strictEqual(validateServerMessage({ type: 'composer-input-result', requestId: 'request-1', agentId: 'a', accepted: false, uncertain: true }).ok, true);
assert.strictEqual(validateServerMessage({ type: 'composer-input-result', requestId: 'request-1', agentId: 'a', accepted: false, uncertain: 'true' }).ok, false);
assert.strictEqual(validateServerMessage({ type: 'composer-input-result', requestId: 'request-1', agentId: 'a', accepted: 'true' }).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'business-health-result',
  requestId: 'health-1',
  serverEpoch: 'server-1',
  protocolVersion: PROTOCOL_VERSION,
  status: 'ready',
  agentCount: 1,
  mainAgentId: 'agent-1',
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'business-health-result',
  requestId: 'health-1',
  serverEpoch: 'server-1',
  protocolVersion: PROTOCOL_VERSION,
  status: 'unknown',
  agentCount: 1,
  mainAgentId: null,
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'agent-update',
  update: { agentId: 'a', patch: { terminalInputReceived: true } },
}).ok, true);
assert.strictEqual(validateServerMessage({ type: 'agent-update', update: { agentId: 'a' } }).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'agent-update',
  update: { agentId: 'a', patch: { terminalInputReceived: true, status: 'dead' } },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'agent-update',
  update: { agentId: 'a', patch: {} },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'acp-session-revision',
  session: { agentId: 'a', revision: 12, updatedAt: '2026-07-29T03:00:00.000Z' },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'acp-session-revision',
  session: { agentId: 'a', revision: '12', updatedAt: '2026-07-29T03:00:00.000Z' },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'acp-realtime',
  event: {
    agentId: 'a',
    sessionId: 'session-1',
    operationId: 'voice-op-1',
    method: 'thread/realtime/sdp',
    params: { sdp: 'v=0' },
  },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'acp-realtime',
  event: { agentId: 'a', sessionId: 'session-1', method: 'thread/realtime/sdp', params: { sdp: 'v=0' } },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'acp-realtime',
  event: {
    agentId: 'a',
    sessionId: 'session-1',
    operationId: '',
    method: 'thread/realtime/sdp',
    params: { sdp: 'v=0' },
  },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'acp-realtime',
  event: {
    agentId: 'a',
    sessionId: 'session-1',
    operationId: 1,
    method: 'thread/realtime/sdp',
    params: { sdp: 'v=0' },
  },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'acp-realtime',
  event: { agentId: 'a', method: 'thread/realtime/sdp', params: 'v=0' },
}).ok, false);
console.log('browser protocol schema tests passed');
