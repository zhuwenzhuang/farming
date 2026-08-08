const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PROJECT_ATTENTION_SCORE_MAX } = require('../../shared/browser-protocol.js');
const {
  advanceAgentStateBroadcast,
  advanceAgentStateMutation,
  agentStateClientDelivery,
  agentStateVisibleToInteractiveClients,
  agentStateDeltaForScope,
  agentStateBroadcastInventorySummary,
  agentStateBroadcastProjectSummaries,
  agentStateBroadcastSnapshot,
  agentStateBroadcastSnapshotForScope,
  agentStateScopeIncludesAgent,
  agentStateScopeTransition,
  agentStateSnapshotFrames,
  createAgentStateBroadcastTracker,
  normalizeAgentStateScope,
  projectAgentSummaries,
} = require('../agent-state-broadcast-protocol.cjs');

assert.strictEqual(agentStateVisibleToInteractiveClients({ id: 'user-agent', source: 'control-cli' }), true);
assert.strictEqual(agentStateVisibleToInteractiveClients({ id: 'smoke-agent', source: 'deployment-smoke' }), false);

const state = (agents, metadata = {}) => ({
  mainAgentId: null,
  taskHistory: [],
  ...metadata,
  agents,
});

const tracker = createAgentStateBroadcastTracker();
assert.strictEqual(
  advanceAgentStateBroadcast(tracker, state([{ id: 'a', status: 'running' }])),
  null,
  'The first state establishes the snapshot baseline without emitting a delta',
);
assert.strictEqual(tracker.sequence, 0);
assert.deepStrictEqual(agentStateBroadcastProjectSummaries(tracker), []);
assert.strictEqual(
  advanceAgentStateBroadcast(tracker, state([{ id: 'a', status: 'running' }])),
  null,
  'An unchanged state must not consume a sequence or emit a message',
);
assert.strictEqual(
  advanceAgentStateBroadcast(tracker, state([{
    id: 'a',
    status: 'running',
    output: 'new terminal output',
    outputSeq: 4,
    previewText: 'new preview',
    usageRate: { sampledAt: Date.now(), outputBytes: 20 },
  }])),
  null,
  'Fields delivered by Agent-scoped live streams must not create list deltas',
);

const updated = advanceAgentStateBroadcast(tracker, state([
  { id: 'a', status: 'waiting' },
  { id: 'b', status: 'running' },
]));
assert.deepStrictEqual(updated, {
  sequence: 1,
  upserts: [
    { id: 'a', status: 'waiting' },
    { id: 'b', status: 'running' },
  ],
  removedAgentIds: [],
});

const removedAndMetadataChanged = advanceAgentStateBroadcast(tracker, state(
  [{ id: 'b', status: 'running' }],
  { mainAgentId: 'b' },
));
assert.deepStrictEqual(removedAndMetadataChanged, {
  sequence: 2,
  upserts: [],
  removedAgentIds: ['a'],
  state: {
    mainAgentId: 'b',
    taskHistory: [],
  },
});
assert.strictEqual(tracker.currentState.agents[0].id, 'b');

const directTracker = createAgentStateBroadcastTracker();
advanceAgentStateBroadcast(directTracker, state([
  { id: 'a', status: 'running' },
  { id: 'b', status: 'running' },
], { mainAgentId: 'a' }));
const directDelta = advanceAgentStateMutation(directTracker, {
  upserts: [{ id: 'b', status: 'waiting' }],
  state: { mainAgentId: 'b' },
});
assert.deepStrictEqual(directDelta, {
  sequence: 1,
  upserts: [{ id: 'b', status: 'waiting' }],
  removedAgentIds: [],
  state: { mainAgentId: 'b' },
});
assert.deepStrictEqual(agentStateBroadcastSnapshot(directTracker), state([
  { id: 'a', status: 'running' },
  { id: 'b', status: 'waiting' },
], { mainAgentId: 'b' }));
assert.deepStrictEqual(agentStateBroadcastInventorySummary(directTracker), {
  agentInventoryRunning: 1,
  agentInventoryTotal: 2,
});

assert.strictEqual(
  advanceAgentStateMutation(directTracker, {
    upserts: [{ id: 'b', status: 'waiting', output: 'live-only change' }],
  }),
  null,
  'A direct live-only mutation must refresh the recovery snapshot without emitting a list delta',
);
assert.strictEqual(
  agentStateBroadcastSnapshot(directTracker).agents[1].output,
  'live-only change',
);
assert.strictEqual(
  agentStateBroadcastProjectSummaries(directTracker),
  null,
  'An exact mutation invalidates the full-checkpoint Project projection',
);
assert.deepStrictEqual(advanceAgentStateMutation(directTracker, {
  removedAgentIds: ['a'],
}), {
  sequence: 2,
  upserts: [],
  removedAgentIds: ['a'],
});
assert.deepStrictEqual(
  agentStateBroadcastSnapshot(directTracker).agents.map(agent => agent.id),
  ['b'],
);

const uninitializedTracker = createAgentStateBroadcastTracker();
assert.strictEqual(
  advanceAgentStateMutation(uninitializedTracker, {
    upserts: [{ id: 'a', status: 'running' }],
  }),
  null,
  'Exact mutations before the first checkpoint must wait for an authoritative baseline',
);
assert.strictEqual(agentStateBroadcastSnapshot(uninitializedTracker), null);
assert.strictEqual(agentStateBroadcastProjectSummaries(uninitializedTracker), null);

assert.strictEqual(agentStateClientDelivery(0, false, 100), 'delta');
assert.strictEqual(agentStateClientDelivery(0, true, 100), 'snapshot');
assert.strictEqual(agentStateClientDelivery(101, false, 100), 'defer');
assert.strictEqual(agentStateClientDelivery(101, true, 100), 'defer');
assert.strictEqual(normalizeAgentStateScope(undefined), 'all');
assert.strictEqual(normalizeAgentStateScope('invalid'), 'all');
assert.strictEqual(normalizeAgentStateScope('focused'), 'focused');
assert.strictEqual(agentStateScopeIncludesAgent('all', null, 'a'), true);
assert.strictEqual(agentStateScopeIncludesAgent('focused', 'a', 'a'), true);
assert.strictEqual(agentStateScopeIncludesAgent('focused', 'a', 'b'), false);
assert.strictEqual(agentStateScopeIncludesAgent('focused', null, 'a'), false);
assert.deepStrictEqual(agentStateScopeTransition('all', null, 'focused', 'a'), {
  scope: 'focused',
  snapshotRequired: false,
});
assert.deepStrictEqual(agentStateScopeTransition('focused', 'a', 'focused', 'a'), {
  scope: 'focused',
  snapshotRequired: false,
});
assert.deepStrictEqual(agentStateScopeTransition('focused', 'a', 'focused', 'b'), {
  scope: 'focused',
  snapshotRequired: true,
});
assert.deepStrictEqual(agentStateScopeTransition('focused', 'a', 'all', null), {
  scope: 'all',
  snapshotRequired: true,
});
assert.deepStrictEqual(agentStateScopeTransition('focused', 'a', 'focused', null), {
  scope: 'all',
  snapshotRequired: true,
});
const scopedDelta = {
  sequence: 9,
  upserts: [{ id: 'a', status: 'working' }, { id: 'b', status: 'waiting' }],
  removedAgentIds: ['a', 'c'],
  state: { mainAgentId: 'main' },
};
assert.strictEqual(
  agentStateDeltaForScope(scopedDelta, 'all', 'a'),
  scopedDelta,
  'All-scope delivery reuses the shared serialized delta',
);
assert.deepStrictEqual(agentStateDeltaForScope(scopedDelta, 'focused', 'a'), {
  sequence: 9,
  upserts: [{ id: 'a', status: 'working' }],
  removedAgentIds: ['a'],
  state: { mainAgentId: 'main' },
});
assert.deepStrictEqual(agentStateDeltaForScope(scopedDelta, 'focused', 'missing'), {
  sequence: 9,
  upserts: [],
  removedAgentIds: [],
  state: { mainAgentId: 'main' },
});

const scopedSnapshotTracker = createAgentStateBroadcastTracker();
advanceAgentStateBroadcast(scopedSnapshotTracker, state([
  { id: 'main', status: 'running', isMain: true },
  { id: 'target', status: 'pending' },
  { id: 'unrelated', status: 'running' },
  { id: 'stopped', status: 'stopped' },
  { id: 'archived', status: 'running', archived: true },
], { mainAgentId: 'main' }));
assert.deepStrictEqual(
  agentStateBroadcastSnapshotForScope(scopedSnapshotTracker, 'focused', 'target'),
  state([
    { id: 'main', status: 'running', isMain: true },
    { id: 'target', status: 'pending' },
  ], {
    mainAgentId: 'main',
    agentInventoryScope: 'focused',
    agentInventoryRunning: 2,
    agentInventoryTotal: 3,
  }),
  'A focused snapshot should project only the Main and exact focused Agent while retaining global counts',
);
assert.deepStrictEqual(
  agentStateBroadcastSnapshotForScope(scopedSnapshotTracker, 'focused', 'missing')?.agents,
  [{ id: 'main', status: 'running', isMain: true }],
  'A missing focused Agent should produce a bounded Main-only checkpoint for explicit client fallback',
);
assert.deepStrictEqual(
  agentStateBroadcastSnapshotForScope(scopedSnapshotTracker, 'all', null),
  state([
    { id: 'main', status: 'running', isMain: true },
    { id: 'target', status: 'pending' },
    { id: 'unrelated', status: 'running' },
    { id: 'stopped', status: 'stopped' },
    { id: 'archived', status: 'running', archived: true },
  ], {
    mainAgentId: 'main',
    agentInventoryScope: 'all',
    agentInventoryRunning: 2,
    agentInventoryTotal: 3,
  }),
);

const progressiveFrames = [...agentStateSnapshotFrames(
  state(Array.from({ length: 1_000 }, (_, index) => ({ id: `paged-${index}` })), {
    mainAgentId: 'paged-0',
    projectAgentSummaries: [{
      workspace: '/paged',
      agentCount: 1_000,
      activeCount: 0,
      unreadCount: 0,
      zombieCount: 0,
      maxAttentionScore: 0,
    }],
  }),
  'snapshot-1',
  64,
  256,
)];
assert.deepStrictEqual(
  progressiveFrames.map(frame => ({
    complete: frame.snapshot.complete,
    count: frame.state.agents.length,
    offset: frame.snapshot.offset,
    total: frame.snapshot.total,
  })),
  [
    { complete: false, count: 64, offset: 0, total: 1_000 },
    { complete: false, count: 256, offset: 64, total: 1_000 },
    { complete: false, count: 256, offset: 320, total: 1_000 },
    { complete: false, count: 256, offset: 576, total: 1_000 },
    { complete: true, count: 168, offset: 832, total: 1_000 },
  ],
);
const focusedSnapshotFrames = [...agentStateSnapshotFrames(
  agentStateBroadcastSnapshotForScope(scopedSnapshotTracker, 'focused', 'target'),
  'snapshot-focused',
  32,
  128,
)];
assert.strictEqual(focusedSnapshotFrames.length, 1);
assert.deepStrictEqual(focusedSnapshotFrames[0].snapshot, {
  complete: true,
  id: 'snapshot-focused',
  offset: 0,
  total: 2,
});
assert.strictEqual(focusedSnapshotFrames[0].state.agentInventoryTotal, 3);
assert.deepStrictEqual(
  focusedSnapshotFrames[0].state.agents.map(agent => agent.id),
  ['main', 'target'],
);
assert.strictEqual(progressiveFrames[0].state.mainAgentId, 'paged-0');
assert.strictEqual(progressiveFrames[1].state.mainAgentId, undefined);
assert.deepStrictEqual(progressiveFrames[0].state.projectAgentSummaries, [{
  workspace: '/paged',
  agentCount: 1_000,
  activeCount: 0,
  unreadCount: 0,
  zombieCount: 0,
  maxAttentionScore: 0,
}]);
assert(progressiveFrames.slice(1).every(frame => (
  !Object.prototype.hasOwnProperty.call(frame.state, 'projectAgentSummaries')
)));
assert.deepStrictEqual(
  progressiveFrames.flatMap(frame => frame.state.agents.map(agent => agent.id)),
  Array.from({ length: 1_000 }, (_, index) => `paged-${index}`),
);
assert.deepStrictEqual(
  [...agentStateSnapshotFrames(state([]), 'snapshot-empty', 64, 256)],
  [{
    snapshot: { complete: true, id: 'snapshot-empty', offset: 0, total: 0 },
    state: state([]),
  }],
);
const emptySummaryFrames = [...agentStateSnapshotFrames(
  state([], { projectAgentSummaries: [] }),
  'snapshot-empty-summary',
  64,
  256,
)];
assert.strictEqual(emptySummaryFrames.length, 1);
assert.strictEqual(emptySummaryFrames[0].snapshot.offset, 0);
assert.deepStrictEqual(emptySummaryFrames[0].state.projectAgentSummaries, []);
const lateMainFrames = [...agentStateSnapshotFrames(state(
  Array.from({ length: 100 }, (_, index) => ({ id: `late-main-${index}` })),
  { mainAgentId: 'late-main-99' },
), 'snapshot-late-main', 8, 32)];
assert.strictEqual(
  lateMainFrames[0].state.agents[0].id,
  'late-main-99',
  'The first progressive page must contain the Main Agent required for safe client startup',
);
assert.strictEqual(
  new Set(lateMainFrames.flatMap(frame => frame.state.agents.map(agent => agent.id))).size,
  100,
);
assert.deepStrictEqual(
  [...agentStateSnapshotFrames(
    state(Array.from({ length: 64 }, (_, index) => ({ id: `exact-${index}` }))),
    'snapshot-exact',
    32,
    32,
  )].map(frame => ({ complete: frame.snapshot.complete, count: frame.state.agents.length })),
  [{ complete: false, count: 32 }, { complete: true, count: 32 }],
  'An exact page multiple must not add an empty completion frame',
);

assert.deepStrictEqual(projectAgentSummaries([
  {
    id: 'main',
    isMain: true,
    cwd: '/main',
    runtimeBinding: { kind: 'terminal' },
    runtimeObservation: { phase: 'working' },
  },
  {
    id: 'alpha-working',
    cwd: '/alpha',
    runtimeBinding: { kind: 'acp' },
    runtimeObservation: { phase: 'working' },
    unread: true,
    attentionScore: 173.4,
  },
  {
    id: 'alpha-zombie',
    projectWorkspace: '/alpha',
    runtimeBinding: { kind: 'terminal' },
    runtimeObservation: { phase: 'idle' },
    isZombie: true,
    attentionScore: 12,
  },
  {
    id: 'worktree-waiting',
    cwd: '/ignored',
    projectWorkspace: '/base',
    gitWorktree: { workspace: '/base/.worktrees/feature' },
    runtimeBinding: { kind: 'acp' },
    runtimeObservation: { phase: 'waiting' },
  },
  { id: 'archived', cwd: '/alpha', archived: true, unread: true },
], PROJECT_ATTENTION_SCORE_MAX), [
  {
    activeCount: 1,
    agentCount: 2,
    maxAttentionScore: PROJECT_ATTENTION_SCORE_MAX,
    unreadCount: 1,
    workspace: '/alpha',
    zombieCount: 1,
  },
  {
    activeCount: 1,
    agentCount: 1,
    maxAttentionScore: 0,
    unreadCount: 0,
    workspace: '/base/.worktrees/feature',
    zombieCount: 0,
  },
]);

const summaryTracker = createAgentStateBroadcastTracker();
const initialSummaryState = state([{
  id: 'summary-agent',
  cwd: '/summary',
  runtimeBinding: { kind: 'acp' },
  runtimeObservation: { phase: 'idle' },
  attentionScore: 1,
}]);
assert.strictEqual(advanceAgentStateBroadcast(summaryTracker, initialSummaryState), null);
assert.deepStrictEqual(agentStateBroadcastProjectSummaries(summaryTracker), [{
  activeCount: 0,
  agentCount: 1,
  maxAttentionScore: 1,
  unreadCount: 0,
  workspace: '/summary',
  zombieCount: 0,
}]);
const refreshedSummaryState = state([{
  ...initialSummaryState.agents[0],
  runtimeObservation: { phase: 'waiting' },
  attentionScore: 90,
}]);
assert.strictEqual(
  advanceAgentStateBroadcast(summaryTracker, refreshedSummaryState),
  null,
  'Live-only summary changes must refresh the projection without consuming a list sequence',
);
assert.strictEqual(summaryTracker.sequence, 0);
assert.deepStrictEqual(agentStateBroadcastProjectSummaries(summaryTracker), [{
  activeCount: 1,
  agentCount: 1,
  maxAttentionScore: 90,
  unreadCount: 0,
  workspace: '/summary',
  zombieCount: 0,
}]);
const mutatedSummaryAgent = {
  ...refreshedSummaryState.agents[0],
  customTitle: 'updated',
};
assert.deepStrictEqual(advanceAgentStateMutation(summaryTracker, {
  upserts: [mutatedSummaryAgent],
}), {
  sequence: 1,
  upserts: [mutatedSummaryAgent],
  removedAgentIds: [],
});
assert.strictEqual(agentStateBroadcastProjectSummaries(summaryTracker), null);
assert.strictEqual(
  advanceAgentStateBroadcast(summaryTracker, state([mutatedSummaryAgent])),
  null,
  'The authoritative refresh after a mutation must restore the Project projection without a duplicate delta',
);
assert.strictEqual(summaryTracker.sequence, 1);
assert.deepStrictEqual(
  agentStateBroadcastProjectSummaries(summaryTracker),
  projectAgentSummaries([mutatedSummaryAgent]),
);

let projectedWorkspaceReads = 0;
const projectedTracker = createAgentStateBroadcastTracker();
const projectedAgent = { id: 'projected-agent' };
Object.defineProperty(projectedAgent, 'cwd', {
  enumerable: true,
  get() {
    projectedWorkspaceReads += 1;
    return '/projected';
  },
});
advanceAgentStateBroadcast(projectedTracker, state([projectedAgent]));
projectedWorkspaceReads = 0;
assert.deepStrictEqual(agentStateBroadcastProjectSummaries(projectedTracker), [{
  activeCount: 0,
  agentCount: 1,
  maxAttentionScore: 0,
  unreadCount: 0,
  workspace: '/projected',
  zombieCount: 0,
}]);
assert.strictEqual(
  projectedWorkspaceReads,
  0,
  'Reading a snapshot Project projection must not rescan Agent records',
);

const scaleTracker = createAgentStateBroadcastTracker();
let unchangedAgentReads = 0;
const scaleAgents = Array.from({ length: 10_000 }, (_, index) => {
  const agent = {
    id: `agent-${index}`,
    usageRate: { sampledAt: 1 },
  };
  Object.defineProperty(agent, 'status', {
    enumerable: true,
    get() {
      unchangedAgentReads += 1;
      return 'running';
    },
  });
  return agent;
});
advanceAgentStateBroadcast(scaleTracker, state(scaleAgents));
unchangedAgentReads = 0;
const scaleDelta = advanceAgentStateMutation(scaleTracker, {
  upserts: [{ id: 'agent-42', status: 'stopped', usageRate: { sampledAt: 2 } }],
});
assert.deepStrictEqual(scaleDelta?.upserts.map(agent => agent.id), ['agent-42']);
assert.strictEqual(
  unchangedAgentReads,
  0,
  'A one-Agent mutation must not inspect unchanged Agents in a large inventory',
);

const inventoryInvariantTracker = createAgentStateBroadcastTracker();
advanceAgentStateBroadcast(inventoryInvariantTracker, state([
  { id: 'a', status: 'running' },
  { id: 'b', status: 'waiting' },
]));
const assertInventoryInvariant = () => {
  const liveAgents = [...inventoryInvariantTracker.agents.values()].filter(agent => (
    agent.archived !== true && agent.status !== 'dead' && agent.status !== 'stopped'
  ));
  assert.deepStrictEqual(agentStateBroadcastInventorySummary(inventoryInvariantTracker), {
    agentInventoryRunning: liveAgents.filter(agent => agent.status === 'running').length,
    agentInventoryTotal: liveAgents.length,
  });
};
assertInventoryInvariant();
advanceAgentStateMutation(inventoryInvariantTracker, { upserts: [{ id: 'a', status: 'waiting' }] });
assertInventoryInvariant();
advanceAgentStateMutation(inventoryInvariantTracker, { upserts: [{ id: 'a', status: 'stopped' }] });
assertInventoryInvariant();
advanceAgentStateMutation(inventoryInvariantTracker, {
  upserts: [{ id: 'a', status: 'running', archived: true }],
});
assertInventoryInvariant();
advanceAgentStateMutation(inventoryInvariantTracker, {
  upserts: [{ id: 'a', status: 'running', archived: false }],
});
assertInventoryInvariant();
assert.strictEqual(
  advanceAgentStateMutation(inventoryInvariantTracker, { removedAgentIds: ['missing'] }),
  null,
);
assertInventoryInvariant();
inventoryInvariantTracker.agents.delete('b');
assert.deepStrictEqual(
  advanceAgentStateMutation(inventoryInvariantTracker, { removedAgentIds: ['b'] })?.removedAgentIds,
  ['b'],
  'Removal should reconcile a stale signature or contribution even if the Agent Map already lost the record',
);
assertInventoryInvariant();
advanceAgentStateMutation(inventoryInvariantTracker, { upserts: [{ id: 'b', status: 'pending' }] });
assertInventoryInvariant();

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.cts'), 'utf8');
assert(
  serverSource.includes('.filter(agent => agentStateVisibleToInteractiveClients(agent as ServerRecord & { id: string }))')
    && serverSource.includes('if (agent && agentStateVisibleToInteractiveClients(agent)) upserts.push(projectAgentState(agent));'),
  'Deployment smoke Agents must stay out of both authoritative snapshots and incremental browser state',
);
assert.strictEqual(
  (serverSource.match(/buildStatePayload\(\)/g) || []).length,
  2,
  'The complete Agent payload must only be defined and used by authoritative checkpoint construction',
);
const managerSource = fs.readFileSync(path.join(__dirname, '..', 'agent-manager.cts'), 'utf8');
assert.strictEqual(
  (managerSource.match(/this\.emit\('update'/g) || []).length,
  1,
  'AgentManager state changes must go through exact mutation events',
);

console.log('agent state broadcast protocol tests passed');
