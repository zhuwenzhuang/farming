type AgentStateRecord = Record<string, unknown> & { id: string };
type AgentStatePayload = Record<string, unknown> & { agents: AgentStateRecord[] };

interface AgentStateBroadcastDelta {
  removedAgentIds: string[];
  sequence: number;
  state?: Record<string, unknown>;
  upserts: AgentStateRecord[];
}

interface AgentStateBroadcastTracker {
  agentSignatures: Map<string, string>;
  currentState: AgentStatePayload | null;
  initialized: boolean;
  metadataSignature: string;
  sequence: number;
}

type AgentStateClientDelivery = 'defer' | 'delta' | 'snapshot';

const AGENT_LIVE_STATE_FIELDS = [
  'activityLevel',
  'attentionScore',
  'codexTerminalProfile',
  'isZombie',
  'lastActivity',
  'output',
  'outputSeq',
  'previewCols',
  'previewRows',
  'previewSnapshot',
  'previewText',
  'runtimeEpoch',
  'runtimeObservation',
  'shellCommand',
  'shellCommandStartedAt',
  'shellLastCommand',
  'shellLastCommandDurationMs',
  'shellLastCommandFinishedAt',
  'shellLastCommandStartedAt',
  'stateRevision',
  'terminalBusy',
  'terminalStatus',
  'usageRate',
] as const;

function stateMetadata(state: AgentStatePayload): Record<string, unknown> {
  const { agents: _agents, ...metadata } = state;
  return metadata;
}

function agentStateSignature(agent: AgentStateRecord): string {
  const listState = { ...agent };
  AGENT_LIVE_STATE_FIELDS.forEach(field => delete listState[field]);
  return JSON.stringify(listState);
}

function createAgentStateBroadcastTracker(): AgentStateBroadcastTracker {
  return {
    agentSignatures: new Map(),
    currentState: null,
    initialized: false,
    metadataSignature: '',
    sequence: 0,
  };
}

function advanceAgentStateBroadcast(
  tracker: AgentStateBroadcastTracker,
  state: AgentStatePayload,
): AgentStateBroadcastDelta | null {
  const nextAgentSignatures = new Map<string, string>();
  const upserts: AgentStateRecord[] = [];
  for (const agent of state.agents) {
    const signature = agentStateSignature(agent);
    nextAgentSignatures.set(agent.id, signature);
    if (tracker.agentSignatures.get(agent.id) !== signature) upserts.push(agent);
  }

  const removedAgentIds = [...tracker.agentSignatures.keys()]
    .filter(agentId => !nextAgentSignatures.has(agentId));
  const metadata = stateMetadata(state);
  const metadataSignature = JSON.stringify(metadata);
  const metadataChanged = tracker.metadataSignature !== metadataSignature;

  tracker.agentSignatures = nextAgentSignatures;
  tracker.metadataSignature = metadataSignature;
  tracker.currentState = state;

  if (!tracker.initialized) {
    tracker.initialized = true;
    return null;
  }
  if (upserts.length === 0 && removedAgentIds.length === 0 && !metadataChanged) return null;

  tracker.sequence += 1;
  return {
    sequence: tracker.sequence,
    upserts,
    removedAgentIds,
    ...(metadataChanged ? { state: metadata } : {}),
  };
}

function agentStateClientDelivery(
  bufferedAmount: number,
  snapshotPending: boolean,
  maxBufferedAmount: number,
): AgentStateClientDelivery {
  if (bufferedAmount > maxBufferedAmount) return 'defer';
  return snapshotPending ? 'snapshot' : 'delta';
}

export {
  advanceAgentStateBroadcast,
  agentStateClientDelivery,
  createAgentStateBroadcastTracker,
};

export type {
  AgentStateBroadcastDelta,
  AgentStateBroadcastTracker,
  AgentStatePayload,
};
