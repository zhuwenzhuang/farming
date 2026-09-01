import type { ClientMessage } from '../../shared/browser-protocol.js';

const assert = require('assert');
const packageJson = require('../../package.json');
const { importTsModule } = require('./helpers/import-ts-module');
const {
  claimProtocolUpgradeReload,
  PROTOCOL_VERSION,
  protocolCompatible,
  validateClientMessage,
  validateServerMessage,
} = importTsModule('shared/browser-protocol.ts');

type ClientMessageByType = {
  [Type in ClientMessage['type']]: Extract<ClientMessage, { type: Type }>;
};

const validClientMessages = {
  'protocol-hello': { type: 'protocol-hello', protocolVersion: PROTOCOL_VERSION },
  'business-health-probe': { type: 'business-health-probe', requestId: 'health-1' },
  'terminal-checkpoint-request': {
    type: 'terminal-checkpoint-request',
    requestId: 'checkpoint-1',
    agentId: 'agent-1',
  },
  'start-agent': { type: 'start-agent', command: 'codex' },
  input: { type: 'input', agentId: 'agent-1', input: 'hello' },
  'composer-input': { type: 'composer-input', agentId: 'agent-1', message: 'hello' },
  'acp-permission-response': {
    type: 'acp-permission-response',
    agentId: 'agent-1',
    requestId: 'permission-1',
    optionId: 'allow',
  },
  'interrupt-agent': { type: 'interrupt-agent', agentId: 'agent-1' },
  'focus-agent': { type: 'focus-agent', agentId: 'agent-1' },
  'watch-acp-transcripts': { type: 'watch-acp-transcripts', agentIds: ['agent-1', 'agent-2'] },
  'resize-agent': { type: 'resize-agent', agentId: 'agent-1', cols: 80, rows: 24 },
  'clear-terminal': { type: 'clear-terminal', agentId: 'agent-1' },
  'watch-workspace-files': { type: 'watch-workspace-files', rootId: 'root-1', paths: ['src/App.tsx'] },
  'unwatch-workspace-files': { type: 'unwatch-workspace-files', rootId: 'root-1' },
  'workspace-request': {
    type: 'workspace-request',
    requestId: 'workspace-1',
    request: { operation: 'read-file', rootId: 'root-1', path: 'src/App.tsx' },
  },
  'workspace-cancel': { type: 'workspace-cancel', requestId: 'workspace-1' },
  'language-server-request': {
    type: 'language-server-request',
    requestId: 'language-server-1',
    request: { operation: 'request', rootId: 'root-1', method: 'hover', filePath: 'src/App.tsx' },
  },
  'archive-agent': { type: 'archive-agent', agentId: 'agent-1' },
  'restart-main-agent': { type: 'restart-main-agent', command: 'codex' },
  'state-resync': { type: 'state-resync' },
  'desktop-browser-adapter-register': {
    type: 'desktop-browser-adapter-register',
    adapterId: 'desktop-1',
  },
  'desktop-browser-adapter-response': {
    type: 'desktop-browser-adapter-response',
    adapterId: 'desktop-1',
    requestId: 'command-1',
    resourceId: 'browser-1',
    sessionId: 'session-1',
    generation: 1,
    ok: true,
    result: { zoomFactor: 1 },
  },
  'desktop-browser-adapter-event': {
    type: 'desktop-browser-adapter-event',
    adapterId: 'desktop-1',
    resourceId: 'browser-1',
    sessionId: 'session-1',
    generation: 1,
    kind: 'metadata',
    payload: { title: 'Browser' },
  },
} satisfies ClientMessageByType;

assert(
  packageJson.files.includes('shared/*.js'),
  'the npm package must include the shared browser protocol required by the server',
);

assert.strictEqual(protocolCompatible(PROTOCOL_VERSION), true);
assert.strictEqual(protocolCompatible(PROTOCOL_VERSION - 1), false);
assert.strictEqual(protocolCompatible(PROTOCOL_VERSION + 1), false);
const protocolReloadValues = new Map<string, string>();
const protocolReloadStorage = {
  getItem: (key: string) => protocolReloadValues.get(key) || null,
  setItem: (key: string, value: string) => protocolReloadValues.set(key, value),
};
const claimReload = (
  backendVersion: number,
  scope = 'code:ws://farming.test/ws',
  storage = protocolReloadStorage,
) => claimProtocolUpgradeReload(PROTOCOL_VERSION, backendVersion, storage, scope);
assert.strictEqual(claimReload(PROTOCOL_VERSION + 1), true);
assert.strictEqual(claimReload(PROTOCOL_VERSION + 1), false);
assert.strictEqual(claimReload(PROTOCOL_VERSION + 1, 'crt:ws://farming.test/ws'), true);
assert.strictEqual(claimReload(PROTOCOL_VERSION), false);
assert.strictEqual(claimReload(PROTOCOL_VERSION - 1), false);
assert.strictEqual(claimProtocolUpgradeReload(
  PROTOCOL_VERSION,
  PROTOCOL_VERSION + 2,
  {
    getItem: () => null,
    setItem: () => { throw new Error('storage unavailable'); },
  },
  'code:ws://farming.test/ws',
), false);
for (const message of Object.values(validClientMessages)) {
  assert.strictEqual(
    validateClientMessage(message).ok,
    true,
    `${message.type} must have a working client-message validator`,
  );
}
assert.strictEqual(validateClientMessage({ type: 'protocol-hello', protocolVersion: PROTOCOL_VERSION }).ok, true);
assert.strictEqual(validateClientMessage({
  type: 'protocol-hello',
  protocolVersion: PROTOCOL_VERSION,
  initialStateScope: 'focused',
  initialFocusedAgentId: 'agent-a',
}).ok, true);
assert.strictEqual(validateClientMessage({
  type: 'protocol-hello',
  protocolVersion: PROTOCOL_VERSION,
  initialStateScope: 'focused',
}).ok, false);
assert.strictEqual(validateClientMessage({
  type: 'protocol-hello',
  protocolVersion: PROTOCOL_VERSION,
  initialStateScope: 'all',
  initialFocusedAgentId: 'agent-a',
}).ok, false);
assert.strictEqual(validateClientMessage({ type: 'resize-agent', agentId: 'a', cols: 80, rows: 24 }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'watch-acp-transcripts', agentIds: [] }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'watch-acp-transcripts', agentIds: ['a', 'a'] }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'watch-acp-transcripts', agentIds: Array.from({ length: 21 }, (_, index) => `a-${index}`) }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'resize-agent', agentId: 'a', cols: '80', rows: 24 }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'watch-workspace-files', rootId: 'a', paths: ['src/App.tsx'] }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'watch-workspace-files', rootId: 'a' }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'watch-workspace-files', rootId: 'a', paths: [] }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'watch-workspace-files', rootId: 'a', paths: ['same.ts', 'same.ts'] }).ok, false);
assert.strictEqual(validateClientMessage({
  type: 'workspace-request',
  requestId: 'workspace-1',
  request: { operation: 'tree', rootId: 'root-1' },
}).ok, true);
assert.strictEqual(validateClientMessage({
  type: 'workspace-request',
  requestId: 'workspace-search-path',
  request: { operation: 'search', rootId: 'root-1', query: 'src/App.tsx', scope: 'file-path' },
}).ok, true);
assert.strictEqual(validateClientMessage({
  type: 'workspace-request',
  requestId: 'workspace-search-invalid',
  request: { operation: 'search', rootId: 'root-1', query: 'src/App.tsx', scope: 'content' },
}).ok, false);
assert.strictEqual(validateClientMessage({
  type: 'workspace-request',
  requestId: 'workspace-decorations-1',
  request: { operation: 'tree-decorations', rootId: 'root-1', path: 'src', entryPaths: ['src/App.tsx'] },
}).ok, true);
assert.strictEqual(validateClientMessage({
  type: 'workspace-request',
  requestId: 'workspace-decorations-2',
  request: { operation: 'tree-decorations', rootId: 'root-1', entryPaths: 'src/App.tsx' },
}).ok, false);
assert.strictEqual(validateClientMessage({
  type: 'workspace-request',
  requestId: 'workspace-1',
  request: { operation: 'unknown', rootId: 'root-1' },
}).ok, false);
assert.strictEqual(validateClientMessage({
  type: 'language-server-request',
  requestId: 'language-server-1',
  request: { operation: 'request', rootId: 'root-1', method: 'semanticTokens', priority: 'background' },
}).ok, true);
assert.strictEqual(validateClientMessage({
  type: 'language-server-request',
  requestId: 'language-server-1',
  request: { operation: 'request', rootId: 'root-1', method: 'semanticTokens', priority: 'urgent' },
}).ok, false);
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
  type: 'desktop-browser-adapter-response',
  adapterId: 'desktop-1',
  requestId: 'command-1',
  resourceId: 'browser-1',
  sessionId: 'session-1',
  generation: 1,
  ok: true,
  status: -1,
}).ok, false);
assert.strictEqual(validateClientMessage({
  type: 'desktop-browser-adapter-response',
  adapterId: 'desktop-1',
  requestId: 'command-1',
  resourceId: 'browser-1',
  sessionId: 'session-1',
  ok: true,
}).ok, false);
assert.strictEqual(validateClientMessage({
  type: 'desktop-browser-adapter-event',
  adapterId: 'desktop-1',
  resourceId: 'browser-1',
  sessionId: 'session-1',
  generation: 1,
  kind: 'metadata',
  payload: [],
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
assert.strictEqual(validateClientMessage({
  type: 'terminal-checkpoint-request',
  requestId: 'checkpoint-1',
  agentId: 'agent-1',
}).ok, true);
assert.strictEqual(validateClientMessage({
  type: 'terminal-checkpoint-request',
  requestId: 'checkpoint-1',
}).ok, false);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: 'a', activityScope: 'focused' }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: null, activityScope: 'none' }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: 'a', activityScope: 'project' }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: 'a', previewScope: 'none' }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: null, previewScope: 'focused' }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: 'a', previewScope: 'project' }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: 'a', stateScope: 'focused' }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: null, stateScope: 'all' }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: null, stateScope: 'focused' }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: '', stateScope: 'focused' }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'focus-agent', agentId: 'a', stateScope: 'project' }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'state-resync', generation: 'server-1', afterSequence: 4 }).ok, true);
assert.strictEqual(validateClientMessage({ type: 'state-resync', afterSequence: -1 }).ok, false);
assert.strictEqual(validateClientMessage({ type: 'unknown' }).ok, false);
assert.strictEqual(validateClientMessage(null).ok, false);

function wireAgent(id: string) {
  return {
    id,
    command: 'codex',
    cwd: '/workspace',
    output: '',
    status: 'running',
    isMain: false,
    activityLevel: 'warm',
    lastActivity: 1,
    attentionScore: 0,
    isZombie: false,
    providerCapabilities: {
      supportedRuntimes: ['terminal', 'acp'],
      runtimeSwitch: true,
      terminalProfile: true,
      terminalComposerInput: 'bracketed-paste',
      slashCommandDiscovery: true,
      goals: false,
      goalSubmission: { terminal: { kind: 'prompt' }, acp: { kind: 'prompt' } },
      terminalSessionFork: true,
      sessionFork: true,
      chatRuntime: 'acp',
      supportsChat: true,
      supportsSteer: false,
    },
    runtimeBinding: { kind: 'terminal' },
    runtimeObservation: {
      kind: 'codex',
      phase: 'idle',
      confidence: 'high',
      source: 'terminal-observer',
      observerVersion: 'test',
      observedAt: 1,
    },
  };
}

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
    agents: [wireAgent('a')],
    agentInventoryScope: 'focused',
    agentInventoryRunning: 8,
    agentInventoryTotal: 10,
    projectAgentSummaries: [{
      workspace: '/alpha',
      agentCount: 9,
      activeCount: 3,
      followUpCount: 4,
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
  snapshot: { complete: true, id: 'snapshot-inventory-invalid', offset: 0, total: 1 },
  state: {
    agents: [wireAgent('a')],
    agentInventoryScope: 'focused',
    agentInventoryRunning: 11,
    agentInventoryTotal: 10,
  },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'state',
  generation: 'server-1',
  sequence: 0,
  snapshot: { complete: true, id: 'snapshot-follow-up-invalid', offset: 0, total: 1 },
  state: {
    agents: [wireAgent('a')],
    projectAgentSummaries: [{
      workspace: '/alpha',
      agentCount: 1,
      activeCount: 0,
      followUpCount: 2,
      unreadCount: 0,
      zombieCount: 0,
      maxAttentionScore: 0,
    }],
  },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'state-delta',
  generation: 'server-1',
  sequence: 1,
  upserts: [],
  removedAgentIds: [],
  state: {
    agentInventoryScope: 'focused',
    agentInventoryRunning: 8,
    agentInventoryTotal: 10,
  },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'state-delta',
  generation: 'server-1',
  sequence: 1,
  upserts: [],
  removedAgentIds: [],
  state: {
    agentInventoryRunning: 8,
    agentInventoryTotal: 10,
  },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'state',
  generation: 'server-1',
  sequence: 0,
  state: { agents: [{ ...wireAgent('invalid-follow-up'), followUp: 'yes' }] },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'state',
  generation: 'server-1',
  sequence: 0,
  snapshot: { complete: true, id: 'snapshot-projects-invalid', offset: 0, total: 1 },
  state: {
    agents: [wireAgent('a')],
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
    agents: [wireAgent('b')],
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
  state: { agents: [wireAgent('a'), wireAgent('b')] },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'state',
  generation: 'server-1',
  sequence: 0,
  snapshot: { complete: true, id: 'snapshot-1', offset: 0, total: 3 },
  state: { agents: [wireAgent('a'), wireAgent('b')] },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'state',
  generation: 'server-1',
  sequence: 0,
  snapshot: { complete: true, id: 'snapshot-1', offset: 2, total: 3 },
  state: { agents: [wireAgent('c')] },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'state',
  generation: 'server-1',
  sequence: 0,
  snapshot: { complete: true, id: 'snapshot-1', offset: 0, total: 2 },
  state: { agents: [wireAgent('a'), wireAgent('a')] },
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
  state: { agents: [wireAgent('c')] },
}).ok, false);
assert.strictEqual(validateServerMessage({ type: 'state', generation: 'server-1', sequence: 0, state: {} }).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'state-delta',
  generation: 'server-1',
  sequence: 1,
  upserts: [wireAgent('a')],
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
  type: 'language-server-refresh',
  serverEpoch: 'server-1',
  rootId: 'wroot-a',
  workspace: '/workspace-a',
  kind: 'semanticTokens',
  revision: 1,
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'language-server-refresh',
  serverEpoch: 'server-1',
  rootId: 'wroot-a',
  workspace: '/workspace-a',
  kind: 'documentHighlights',
  revision: 1,
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'language-server-refresh',
  serverEpoch: 'server-1',
  rootId: 'wroot-a',
  workspace: '/workspace-a',
  kind: 'inlayHints',
  revision: 0,
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'workspace-result',
  requestId: 'workspace-1',
  ok: true,
  result: { content: 'ready' },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'workspace-result',
  requestId: 'workspace-1',
  ok: false,
  error: { code: 'NOT_FOUND', message: 'file not found', status: 404 },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'workspace-result',
  requestId: 'workspace-1',
  ok: false,
  result: null,
  error: { code: 'NOT_FOUND', message: 'file not found' },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'language-server-result',
  requestId: 'language-1',
  ok: true,
  supported: false,
  result: null,
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
assert.strictEqual(validateServerMessage({
  type: 'desktop-browser-adapter-registered',
  adapterId: 'desktop-1',
  serverEpoch: 'server-1',
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'desktop-browser-adapter-registered',
  adapterId: 'desktop-1',
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'desktop-browser-command',
  command: {
    adapterId: 'desktop-1',
    requestId: 'command-1',
    resourceId: 'browser-1',
    sessionId: 'session-1',
    generation: 1,
    operation: 'navigate',
    input: { url: 'https://example.test/' },
  },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'desktop-browser-command',
  command: {
    adapterId: 'desktop-1',
    requestId: 'command-1',
    resourceId: 'browser-1',
    sessionId: 'session-1',
    generation: 1,
    operation: 'navigate',
    input: [],
  },
}).ok, false);
assert.strictEqual(validateServerMessage({ type: 'composer-input-result', requestId: 'request-1', agentId: 'a', accepted: true }).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'terminal-checkpoint-result',
  requestId: 'checkpoint-1',
  agentId: 'agent-1',
  ok: true,
  session: {
    runtimeEpoch: 'runtime-1',
    outputSeq: 4,
    stateRevision: 5,
    renderOutput: 'ready',
    previewCols: 80,
    previewRows: 24,
  },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'terminal-checkpoint-result',
  requestId: 'checkpoint-1',
  agentId: 'agent-1',
  ok: false,
  error: 'Agent not found',
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'terminal-checkpoint-result',
  requestId: 'checkpoint-1',
  agentId: 'agent-1',
  ok: true,
  error: 'not allowed with success',
}).ok, false);
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
  update: {
    agentId: 'a',
    patch: {
      codexTerminalProfile: {
        model: 'gpt-5.6-sol',
        reasoningEffort: 'xhigh',
        serviceTier: 'priority',
        source: 'terminal-footer',
      },
    },
  },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'agent-update',
  update: { agentId: 'a', patch: { codexTerminalProfile: 'gpt-5.6-sol' } },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'agent-update',
  update: { agentId: 'a', patch: { codexTerminalProfile: null } },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'agent-update',
  update: { agentId: 'a', patch: { codexTerminalProfile: { model: 'gpt-5.6-sol' } } },
}).ok, false);
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
  session: {
    agentId: 'a',
    sessionId: 'session-a',
    runtimeEpoch: 'epoch-a',
    revision: 12,
    updatedAt: '2026-07-29T03:00:00.000Z',
  },
}).ok, true);
assert.strictEqual(validateServerMessage({
  type: 'acp-session-revision',
  session: {
    agentId: 'a',
    sessionId: 'session-a',
    runtimeEpoch: 'epoch-a',
    revision: '12',
    updatedAt: '2026-07-29T03:00:00.000Z',
  },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'acp-session-revision',
  session: { agentId: 'a', revision: 12, updatedAt: '2026-07-29T03:00:00.000Z' },
}).ok, false);
assert.strictEqual(validateServerMessage({
  type: 'acp-session-revision',
  session: {
    agentId: 'a',
    sessionId: '',
    runtimeEpoch: 'epoch-a',
    revision: 12,
    updatedAt: '2026-07-29T03:00:00.000Z',
  },
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
