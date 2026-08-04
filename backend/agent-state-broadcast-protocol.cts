import {
  agentTurnActiveFromState,
  projectWorkspaceFromAgentState,
} from '../shared/agent-state-semantics.js';

type AgentStateRecord = Record<string, unknown> & { id: string };
type AgentStatePayload = Record<string, unknown> & { agents: AgentStateRecord[] };

interface AgentStateBroadcastDelta {
  removedAgentIds: string[];
  sequence: number;
  state?: Record<string, unknown>;
  upserts: AgentStateRecord[];
}

interface AgentStateBroadcastMutation {
  removedAgentIds?: string[];
  state?: Record<string, unknown>;
  upserts?: AgentStateRecord[];
}

interface AgentStateSnapshotFrame {
  snapshot: {
    complete: boolean;
    id: string;
    offset: number;
    total: number;
  };
  state: AgentStatePayload;
}

interface ProjectAgentSummary {
  activeCount: number;
  agentCount: number;
  maxAttentionScore: number;
  unreadCount: number;
  workspace: string;
  zombieCount: number;
}

interface AgentStateBroadcastTracker {
  agents: Map<string, AgentStateRecord>;
  agentSignatures: Map<string, string>;
  currentState: AgentStatePayload | null;
  initialized: boolean;
  metadata: Record<string, unknown>;
  metadataSignature: string;
  sequence: number;
}

type AgentStateClientDelivery = 'defer' | 'delta' | 'snapshot';

function projectAgentSummaries(
  agents: AgentStateRecord[],
  maxAttentionScore = 100,
): ProjectAgentSummary[] {
  const summaries = new Map<string, ProjectAgentSummary>();
  agents.forEach(agent => {
    if (agent.isMain === true || agent.archived === true) return;
    const workspace = projectWorkspaceFromAgentState(agent);
    if (!workspace) return;
    const summary = summaries.get(workspace) || {
      activeCount: 0,
      agentCount: 0,
      maxAttentionScore: 0,
      unreadCount: 0,
      workspace,
      zombieCount: 0,
    };
    summary.agentCount += 1;
    if (agentTurnActiveFromState(agent)) summary.activeCount += 1;
    if (agent.unread === true) summary.unreadCount += 1;
    if (agent.isZombie === true) summary.zombieCount += 1;
    const attentionScore = Number(agent.attentionScore);
    if (Number.isFinite(attentionScore)) {
      summary.maxAttentionScore = Math.max(
        summary.maxAttentionScore,
        Math.min(maxAttentionScore, Math.max(0, Math.round(attentionScore))),
      );
    }
    summaries.set(workspace, summary);
  });
  return [...summaries.values()];
}

function* agentStateSnapshotFrames(
  state: AgentStatePayload,
  snapshotId: string,
  initialPageSize: number,
  pageSize: number,
): Iterable<AgentStateSnapshotFrame> {
  const firstLimit = Math.max(1, Math.floor(initialPageSize));
  const nextLimit = Math.max(1, Math.floor(pageSize));
  const { agents, ...metadata } = state;
  const mainAgentId = typeof metadata.mainAgentId === 'string' ? metadata.mainAgentId : '';
  const mainAgentIndex = mainAgentId ? agents.findIndex(agent => agent.id === mainAgentId) : -1;
  const orderedAgents = mainAgentIndex >= firstLimit
    ? [agents[mainAgentIndex], ...agents.slice(0, mainAgentIndex), ...agents.slice(mainAgentIndex + 1)]
    : agents;
  const total = orderedAgents.length;
  let offset = 0;

  do {
    const limit = offset === 0 ? firstLimit : nextLimit;
    const page = orderedAgents.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const complete = nextOffset >= total;
    yield {
      snapshot: {
        complete,
        id: snapshotId,
        offset,
        total,
      },
      state: {
        ...(offset === 0 ? metadata : {}),
        agents: page,
      },
    };
    offset = nextOffset;
  } while (offset < total);
}

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
    agents: new Map(),
    agentSignatures: new Map(),
    currentState: null,
    initialized: false,
    metadata: {},
    metadataSignature: '',
    sequence: 0,
  };
}

function agentStateBroadcastSnapshot(
  tracker: AgentStateBroadcastTracker,
): AgentStatePayload | null {
  if (!tracker.initialized) return null;
  if (!tracker.currentState) {
    tracker.currentState = {
      ...tracker.metadata,
      agents: [...tracker.agents.values()],
    };
  }
  return tracker.currentState;
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
  tracker.agents = new Map(state.agents.map(agent => [agent.id, agent]));
  tracker.metadata = metadata;
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

function advanceAgentStateMutation(
  tracker: AgentStateBroadcastTracker,
  mutation: AgentStateBroadcastMutation,
): AgentStateBroadcastDelta | null {
  if (!tracker.initialized) return null;

  const upserts: AgentStateRecord[] = [];
  for (const agent of mutation.upserts || []) {
    const signature = agentStateSignature(agent);
    if (tracker.agentSignatures.get(agent.id) !== signature) upserts.push(agent);
    tracker.agents.set(agent.id, agent);
    tracker.agentSignatures.set(agent.id, signature);
  }

  const removedAgentIds: string[] = [];
  for (const agentId of mutation.removedAgentIds || []) {
    if (!tracker.agents.delete(agentId)) continue;
    tracker.agentSignatures.delete(agentId);
    removedAgentIds.push(agentId);
  }

  let metadataChanged = false;
  if (mutation.state) {
    const nextMetadata = { ...tracker.metadata, ...mutation.state };
    const nextMetadataSignature = JSON.stringify(nextMetadata);
    metadataChanged = tracker.metadataSignature !== nextMetadataSignature;
    tracker.metadata = nextMetadata;
    tracker.metadataSignature = nextMetadataSignature;
  }

  tracker.currentState = null;
  if (upserts.length === 0 && removedAgentIds.length === 0 && !metadataChanged) return null;

  tracker.sequence += 1;
  return {
    sequence: tracker.sequence,
    upserts,
    removedAgentIds,
    ...(metadataChanged ? { state: mutation.state } : {}),
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
  advanceAgentStateMutation,
  agentStateClientDelivery,
  agentStateBroadcastSnapshot,
  agentStateSnapshotFrames,
  createAgentStateBroadcastTracker,
  projectAgentSummaries,
};

export type {
  AgentStateBroadcastDelta,
  AgentStateBroadcastMutation,
  AgentStateBroadcastTracker,
  AgentStatePayload,
  AgentStateSnapshotFrame,
  ProjectAgentSummary,
};
