const assert = require('assert');
const {
  advanceAgentStateBroadcast,
  agentStateClientDelivery,
  createAgentStateBroadcastTracker,
} = require('../agent-state-broadcast-protocol.cjs');

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

assert.strictEqual(agentStateClientDelivery(0, false, 100), 'delta');
assert.strictEqual(agentStateClientDelivery(0, true, 100), 'snapshot');
assert.strictEqual(agentStateClientDelivery(101, false, 100), 'defer');
assert.strictEqual(agentStateClientDelivery(101, true, 100), 'defer');

const scaleTracker = createAgentStateBroadcastTracker();
const scaleAgents = Array.from({ length: 100 }, (_, index) => ({
  id: `agent-${index}`,
  status: 'running',
  usageRate: { sampledAt: 1 },
}));
advanceAgentStateBroadcast(scaleTracker, state(scaleAgents));
const scaleDelta = advanceAgentStateBroadcast(scaleTracker, state(scaleAgents.map((agent, index) => ({
  ...agent,
  status: index === 42 ? 'stopped' : agent.status,
  usageRate: { sampledAt: 2 },
}))));
assert.deepStrictEqual(scaleDelta?.upserts.map(agent => agent.id), ['agent-42']);

console.log('agent state broadcast protocol tests passed');
