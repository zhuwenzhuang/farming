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

function wireAgent(id: string, status: 'running' | 'stopped', title: string) {
  return {
    id,
    command: 'codex',
    cwd: '/workspace/alpha',
    output: '',
    status,
    isMain: id === 'agent-a',
    activityLevel: 'warm' as const,
    lastActivity: 1,
    attentionScore: 0,
    isZombie: false,
    providerCapabilities: {
      supportedRuntimes: ['terminal', 'acp'] as Array<'terminal' | 'acp'>,
      runtimeSwitch: true,
      contextWindow: true,
      terminalProfile: true,
      terminalComposerInput: 'bracketed-paste' as const,
      slashCommandDiscovery: true,
      goals: false,
      goalSubmission: { terminal: { kind: 'prompt' as const }, acp: { kind: 'prompt' as const } },
      terminalSessionFork: true,
      sessionFork: true,
      chatRuntime: 'acp' as const,
      supportsChat: true,
      supportsSteer: false,
    },
    runtimeBinding: { kind: 'terminal' as const },
    runtimeObservation: {
      kind: 'codex' as const,
      phase: 'idle' as const,
      confidence: 'high' as const,
      source: 'terminal-observer' as const,
      observerVersion: 'test',
      observedAt: 1,
    },
    title,
  };
}

const initialState: AgentStatePayload = {
  agents: [
    wireAgent('agent-a', 'running', 'Alpha'),
    wireAgent('agent-b', 'stopped', 'Beta'),
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
    wireAgent('agent-a', 'stopped', 'Alpha'),
    wireAgent('agent-c', 'running', 'Gamma'),
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
