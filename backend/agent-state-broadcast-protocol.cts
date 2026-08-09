import {
  agentTurnActiveFromState,
  PROJECT_ATTENTION_SCORE_MAX,
  projectWorkspaceFromAgentState,
} from '../shared/agent-state-semantics.js';
import type {
  AgentStateDeltaBody,
  AgentStatePayload,
  AgentStateRecord,
  StateMessage,
} from '../shared/browser-protocol.js';

type AgentStateBroadcastDelta = AgentStateDeltaBody;

interface AgentStateBroadcastMutation {
  removedAgentIds?: string[];
  state?: Record<string, unknown>;
  upserts?: AgentStateRecord[];
}

type AgentStateSnapshotFrame = Pick<StateMessage, 'state'> & {
  snapshot: NonNullable<StateMessage['snapshot']>;
};

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
  agentInventoryContributions: Map<string, { running: number; total: number }>;
  agentInventoryRunning: number;
  agentInventoryTotal: number;
  currentState: AgentStatePayload | null;
  initialized: boolean;
  metadata: Record<string, unknown>;
  metadataSignature: string;
  projectAgentSummaries: ProjectAgentSummary[] | null;
  sequence: number;
}

type AgentStateClientDelivery = 'defer' | 'delta' | 'snapshot';
type AgentStateClientScope = 'all' | 'focused';

interface AgentStateScopeTransition {
  scope: AgentStateClientScope;
  snapshotRequired: boolean;
}

interface AgentStateInventorySummary {
  agentInventoryRunning: number;
  agentInventoryTotal: number;
}

function agentStateVisibleToInteractiveClients(agent: AgentStateRecord | null | undefined): boolean {
  return agent?.source !== 'deployment-smoke';
}

function normalizeAgentStateScope(scope: unknown): AgentStateClientScope {
  return scope === 'focused' ? 'focused' : 'all';
}

function agentStateScopeTransition(
  previousScope: AgentStateClientScope | null | undefined,
  previousFocusedAgentId: string | null | undefined,
  requestedScope: AgentStateClientScope | null | undefined,
  nextFocusedAgentId: string | null | undefined,
): AgentStateScopeTransition {
  const normalizedPreviousScope = normalizeAgentStateScope(previousScope);
  const normalizedRequestedScope = normalizeAgentStateScope(requestedScope);
  const scope = normalizedRequestedScope === 'focused' && nextFocusedAgentId
    ? 'focused'
    : 'all';
  return {
    scope,
    snapshotRequired: normalizedPreviousScope === 'focused'
      && (scope === 'all' || previousFocusedAgentId !== nextFocusedAgentId),
  };
}

function agentStateScopeIncludesAgent(
  scope: AgentStateClientScope | null | undefined,
  focusedAgentId: string | null | undefined,
  agentId: string,
): boolean {
  return scope !== 'focused' || Boolean(focusedAgentId && focusedAgentId === agentId);
}

function agentStateDeltaForScope(
  delta: AgentStateBroadcastDelta,
  scope: AgentStateClientScope | null | undefined,
  focusedAgentId: string | null | undefined,
): AgentStateBroadcastDelta {
  if (scope !== 'focused' || !focusedAgentId) return delta;
  return {
    ...delta,
    upserts: delta.upserts.filter(agent => agentStateScopeIncludesAgent(scope, focusedAgentId, agent.id)),
    removedAgentIds: delta.removedAgentIds.filter(agentId => (
      agentStateScopeIncludesAgent(scope, focusedAgentId, agentId)
    )),
  };
}

function agentInventoryContribution(agent: AgentStateRecord | null | undefined) {
  const live = Boolean(
    agent
    && agent.archived !== true
    && agent.status !== 'dead'
    && agent.status !== 'stopped'
  );
  return {
    running: live && agent?.status === 'running' ? 1 : 0,
    total: live ? 1 : 0,
  };
}

function accumulateProjectAgentSummary(
  summaries: Map<string, ProjectAgentSummary>,
  agent: AgentStateRecord,
  maxAttentionScore: number,
): void {
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
}

function projectAgentSummaries(
  agents: AgentStateRecord[],
  maxAttentionScore = PROJECT_ATTENTION_SCORE_MAX,
): ProjectAgentSummary[] {
  const summaries = new Map<string, ProjectAgentSummary>();
  agents.forEach(agent => accumulateProjectAgentSummary(summaries, agent, maxAttentionScore));
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
    agentInventoryContributions: new Map(),
    agentInventoryRunning: 0,
    agentInventoryTotal: 0,
    currentState: null,
    initialized: false,
    metadata: {},
    metadataSignature: '',
    projectAgentSummaries: null,
    sequence: 0,
  };
}

function agentStateBroadcastInventorySummary(
  tracker: AgentStateBroadcastTracker,
): AgentStateInventorySummary | null {
  if (!tracker.initialized) return null;
  return {
    agentInventoryRunning: tracker.agentInventoryRunning,
    agentInventoryTotal: tracker.agentInventoryTotal,
  };
}

function agentStateBroadcastProjectSummaries(
  tracker: AgentStateBroadcastTracker,
): ProjectAgentSummary[] | null {
  return tracker.projectAgentSummaries;
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

function agentStateBroadcastSnapshotForScope(
  tracker: AgentStateBroadcastTracker,
  scope: AgentStateClientScope | null | undefined,
  focusedAgentId: string | null | undefined,
): AgentStatePayload | null {
  if (!tracker.initialized) return null;
  const normalizedScope = normalizeAgentStateScope(scope);
  const inventory = agentStateBroadcastInventorySummary(tracker);
  if (!inventory) return null;
  if (normalizedScope !== 'focused' || !focusedAgentId) {
    const snapshot = agentStateBroadcastSnapshot(tracker);
    return snapshot ? {
      ...snapshot,
      agentInventoryScope: 'all',
      ...inventory,
    } : null;
  }

  const mainAgentId = typeof tracker.metadata.mainAgentId === 'string'
    ? tracker.metadata.mainAgentId
    : '';
  const agents: AgentStateRecord[] = [];
  const mainAgent = mainAgentId ? tracker.agents.get(mainAgentId) : null;
  if (mainAgent) agents.push(mainAgent);
  const focusedAgent = tracker.agents.get(focusedAgentId);
  if (focusedAgent && focusedAgent.id !== mainAgent?.id) agents.push(focusedAgent);
  return {
    ...tracker.metadata,
    agentInventoryScope: 'focused',
    ...inventory,
    agents,
  };
}

function advanceAgentStateBroadcast(
  tracker: AgentStateBroadcastTracker,
  state: AgentStatePayload,
): AgentStateBroadcastDelta | null {
  const nextAgentSignatures = new Map<string, string>();
  const nextAgentInventoryContributions = new Map<string, { running: number; total: number }>();
  const nextProjectAgentSummaries = new Map<string, ProjectAgentSummary>();
  let nextAgentInventoryRunning = 0;
  let nextAgentInventoryTotal = 0;
  const upserts: AgentStateRecord[] = [];
  for (const agent of state.agents) {
    const inventoryContribution = agentInventoryContribution(agent);
    nextAgentInventoryContributions.set(agent.id, inventoryContribution);
    nextAgentInventoryRunning += inventoryContribution.running;
    nextAgentInventoryTotal += inventoryContribution.total;
    accumulateProjectAgentSummary(
      nextProjectAgentSummaries,
      agent,
      PROJECT_ATTENTION_SCORE_MAX,
    );
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
  tracker.agentInventoryContributions = nextAgentInventoryContributions;
  tracker.agentInventoryRunning = nextAgentInventoryRunning;
  tracker.agentInventoryTotal = nextAgentInventoryTotal;
  tracker.metadata = metadata;
  tracker.metadataSignature = metadataSignature;
  tracker.projectAgentSummaries = [...nextProjectAgentSummaries.values()];
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
    const previousContribution = tracker.agentInventoryContributions.get(agent.id) || { running: 0, total: 0 };
    const nextContribution = agentInventoryContribution(agent);
    tracker.agentInventoryRunning += nextContribution.running - previousContribution.running;
    tracker.agentInventoryTotal += nextContribution.total - previousContribution.total;
    const signature = agentStateSignature(agent);
    if (tracker.agentSignatures.get(agent.id) !== signature) upserts.push(agent);
    tracker.agents.set(agent.id, agent);
    tracker.agentSignatures.set(agent.id, signature);
    tracker.agentInventoryContributions.set(agent.id, nextContribution);
  }

  const removedAgentIds: string[] = [];
  for (const agentId of mutation.removedAgentIds || []) {
    const previousContribution = tracker.agentInventoryContributions.get(agentId);
    const removedAgent = tracker.agents.delete(agentId);
    const removedSignature = tracker.agentSignatures.delete(agentId);
    if (!removedAgent && !removedSignature && !previousContribution) continue;
    const contribution = previousContribution || { running: 0, total: 0 };
    tracker.agentInventoryRunning -= contribution.running;
    tracker.agentInventoryTotal -= contribution.total;
    tracker.agentInventoryContributions.delete(agentId);
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
  tracker.projectAgentSummaries = null;
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
  agentStateVisibleToInteractiveClients,
  agentStateDeltaForScope,
  agentStateBroadcastInventorySummary,
  agentStateBroadcastProjectSummaries,
  agentStateScopeIncludesAgent,
  agentStateScopeTransition,
  agentStateBroadcastSnapshot,
  agentStateBroadcastSnapshotForScope,
  agentStateSnapshotFrames,
  createAgentStateBroadcastTracker,
  normalizeAgentStateScope,
  projectAgentSummaries,
};

export type {
  AgentStateBroadcastDelta,
  AgentStateBroadcastMutation,
  AgentStateBroadcastTracker,
  AgentStateClientScope,
  AgentStateScopeTransition,
  AgentStatePayload,
  AgentStateInventorySummary,
  AgentStateSnapshotFrame,
  ProjectAgentSummary,
};
