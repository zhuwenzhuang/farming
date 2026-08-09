import assert from 'node:assert/strict';
import {
  advanceAgentStateSnapshot,
  agentStateDeltaDisposition,
  applyAgentStateDelta,
} from '../../src/lib/agent-state-delta';
import type {
  AgentStatePayload,
  StateDeltaMessage,
  StateMessage,
} from '../../shared/browser-protocol.js';

const {
  advanceAgentStateBroadcast,
  agentStateBroadcastSnapshot,
  agentStateSnapshotFrames,
  createAgentStateBroadcastTracker,
} = require('../agent-state-broadcast-protocol.cjs');
const { validateServerMessage } = require('../../shared/browser-protocol.js');

const generation = 'server-wire-contract';
const tracker = createAgentStateBroadcastTracker();
const initialState: AgentStatePayload = {
  agents: [
    { id: 'agent-a', status: 'running', title: 'Alpha' },
    { id: 'agent-b', status: 'waiting', title: 'Beta' },
  ],
  mainAgentId: 'agent-a',
  mainPageSessionKeys: ['agent-session:codex:alpha'],
  projectWorkspaces: ['/workspace/alpha'],
};

assert.strictEqual(advanceAgentStateBroadcast(tracker, initialState), null);
const authoritativeSnapshot = agentStateBroadcastSnapshot(tracker);
assert(authoritativeSnapshot);

let browserState: AgentStatePayload = { agents: [] };
let snapshotCursor = null;
for (const frame of agentStateSnapshotFrames(authoritativeSnapshot, 'snapshot-wire-contract', 1, 1)) {
  const message: StateMessage = {
    type: 'state',
    generation,
    sequence: tracker.sequence,
    ...frame,
  };
  assert.strictEqual(validateServerMessage(message).ok, true);
  const transition = advanceAgentStateSnapshot(
    snapshotCursor,
    message.generation,
    message.sequence,
    message.snapshot!,
    message.state.agents.length,
  );
  assert.notStrictEqual(transition.disposition, 'resync');
  const agents = transition.disposition === 'replace'
    ? message.state.agents
    : [...browserState.agents, ...message.state.agents];
  browserState = {
    ...browserState,
    ...message.state,
    agents,
  };
  snapshotCursor = transition.cursor;
}
assert.strictEqual(snapshotCursor, null);
assert.deepStrictEqual(browserState, initialState);

const updatedState: AgentStatePayload = {
  agents: [
    { id: 'agent-a', status: 'waiting', title: 'Alpha' },
    { id: 'agent-c', status: 'running', title: 'Gamma' },
  ],
  mainAgentId: 'agent-c',
  mainPageSessionKeys: ['agent-session:codex:gamma'],
  projectWorkspaces: ['/workspace/alpha', '/workspace/gamma'],
};
const projectedDelta = advanceAgentStateBroadcast(tracker, updatedState);
assert(projectedDelta);
const deltaMessage: StateDeltaMessage = {
  type: 'state-delta',
  generation,
  ...projectedDelta,
};
assert.strictEqual(validateServerMessage(deltaMessage).ok, true);
assert.strictEqual(
  agentStateDeltaDisposition(
    { generation, sequence: deltaMessage.sequence - 1 },
    deltaMessage.generation,
    deltaMessage.sequence,
  ),
  'apply',
);
browserState = {
  ...browserState,
  ...deltaMessage.state,
  agents: applyAgentStateDelta(
    browserState.agents,
    deltaMessage.upserts,
    deltaMessage.removedAgentIds,
  ),
};
assert.deepStrictEqual(browserState, updatedState);

console.log('agent state wire contract keeps backend projection and browser reduction in parity');
