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
assert.strictEqual(protocolCompatible(PROTOCOL_VERSION - 1), false);
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
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: 'a', activityScope: 'focused' }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: null, activityScope: 'none' }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: 'a', activityScope: 'project' }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: 'a', stateScope: 'focused' }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: null, stateScope: 'all' }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: null, stateScope: 'focused' }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: '', stateScope: 'focused' }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: 'a', stateScope: 'project' }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'state-resync', generation: 'server-1', afterSequence: 4 }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'state-resync', afterSequence: -1 }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'unknown' }).ok, false);
assert.strictEqual(validateClientMessage(null).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'state',
  generation: 'server-1',
  sequence: 0,
  state: { agents: [] },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'state',
  generation: 'server-1',
  sequence: 0,
  snapshot: { complete: true, id: 'snapshot-projects', offset: 0, total: 1 },
  state: {
    agents: [{ id: 'a' }],
    projectAgentSummaries: [{
      workspace: '/alpha',
      agentCount: 9,
      activeCount: 3,
      unreadCount: 2,
      zombieCount: 1,
      maxAttentionScore: 81,
    }],
  },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'state',
  generation: 'server-1',
  sequence: 0,
  snapshot: { complete: true, id: 'snapshot-projects-invalid', offset: 0, total: 1 },
  state: {
    agents: [{ id: 'a' }],
    projectAgentSummaries: [{
      workspace: '/alpha',
      agentCount: 1,
      activeCount: 2,
      unreadCount: 0,
      zombieCount: 0,
      maxAttentionScore: 0,
    }],
  },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'state',
  generation: 'server-1',
  sequence: 0,
  snapshot: { complete: true, id: 'snapshot-projects-late', offset: 1, total: 2 },
  state: {
    agents: [{ id: 'b' }],
    projectAgentSummaries: [{
      workspace: '/alpha',
      agentCount: 2,
      activeCount: 0,
      unreadCount: 0,
      zombieCount: 0,
      maxAttentionScore: 0,
    }],
  },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'state',
  generation: 'server-1',
  sequence: 0,
  snapshot: { complete: false, id: 'snapshot-1', offset: 0, total: 3 },
  state: { agents: [{ id: 'a' }, { id: 'b' }] },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'state',
  generation: 'server-1',
  sequence: 0,
  snapshot: { complete: true, id: 'snapshot-1', offset: 0, total: 3 },
  state: { agents: [{ id: 'a' }, { id: 'b' }] },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'state',
  generation: 'server-1',
  sequence: 0,
  snapshot: { complete: true, id: 'snapshot-1', offset: 2, total: 3 },
  state: { agents: [{ id: 'c' }] },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'state',
  generation: 'server-1',
  sequence: 0,
  snapshot: { complete: true, id: 'snapshot-1', offset: 0, total: 2 },
  state: { agents: [{ id: 'a' }, { id: 'a' }] },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'state',
  generation: 'server-1',
  sequence: 0,
  snapshot: { complete: false, id: 'snapshot-1', offset: 3, total: 2 },
  state: { agents: [] },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'state',
  generation: 'server-1',
  sequence: 0,
  snapshot: { complete: true, id: 'snapshot-1', offset: 2, total: 2 },
  state: { agents: [{ id: 'c' }] },
}).ok, false);
assert.strictEqual(validateServerMessage({ type: 'state', generation: 'server-1', sequence: 0, state: {} }).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'state-delta',
  generation: 'server-1',
  sequence: 1,
  upserts: [{ id: 'a', status: 'running' }],
  removedAgentIds: [],
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'state-delta',
  generation: 'server-1',
  sequence: 2,
  upserts: [{}],
  removedAgentIds: [],
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'state-delta',
  generation: 'server-1',
  sequence: 2,
  upserts: [],
  removedAgentIds: [],
  state: { agents: [] },
}).ok, false);
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
  type: 'agent-activity-snapshot',
  activities: [{ agentId: 'a', activityLevel: 'warm' }],
}).ok, true);
assert.strictEqual(validateServerMessage({ type: 'agent-activity-snapshot', activities: [{}] }).ok, false);
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
  update: { agentId: 'a', patch: { adaptiveTitle: 'Inspect persistence' } },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'agent-update',
  update: { agentId: 'a', patch: { sessionTitle: 'Working tree review' } },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'agent-update',
  update: {
    agentId: 'a',
    patch: {
      runtimeBinding: {
        kind: 'acp',
        state: 'working',
        error: '',
        stopReason: '',
        supportsSteer: true,
        supportsFork: false,
        pendingPermissions: [],
        pendingElicitations: [],
        activeElicitations: [],
        sessionUpdatedAt: '2026-08-04T00:00:00.000Z',
        sessionRevision: 7,
      },
    },
  },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'agent-update',
  update: {
    agentId: 'a',
    patch: {
      runtimeBinding: {
        kind: 'acp',
        state: 'working',
        error: '',
        stopReason: '',
        supportsSteer: true,
        supportsFork: false,
        pendingPermissions: [],
        pendingElicitations: [],
        activeElicitations: [],
        sessionUpdatedAt: '2026-08-04T00:00:00.000Z',
        sessionRevision: -1,
      },
    },
  },
}).ok, false);
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
  type: 'agent-read',
  read: {
    agentId: 'a',
    unread: true,
    attentionSeq: 2,
    readAttentionSeq: 1,
    attentionUpdatedAt: 1_786_000_000_000,
    readAttentionAt: null,
    attentionReason: 'turn-complete',
    attentionSummary: 'Finished the requested change',
    attentionOutputEpoch: '',
    attentionOutputSeq: null,
    readOutputEpoch: '',
    readOutputSeq: null,
  },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'agent-read',
  read: {
    agentId: 'a',
    unread: false,
    attentionSeq: 2,
    readAttentionSeq: 2,
    readOutputEpoch: '',
    readOutputSeq: null,
  },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'agent-read',
  read: { agentId: 'a', unread: true, attentionSeq: 2, readAttentionSeq: 1 },
}).ok, false);
console.log('browser protocol schema tests passed');
