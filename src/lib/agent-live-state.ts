import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { Agent, ProjectAgentSummary } from '@/types/agent'
import {
  agentTurnActiveFromState,
  PROJECT_ATTENTION_SCORE_MAX,
  projectWorkspaceFromAgentState,
} from '../../shared/agent-state-semantics.js'
import type {
  AcpSessionRevisionMessage,
  AgentActivitySnapshotMessage,
  AgentReadMessage,
  AgentUpdateMessage,
  SessionPreviewMessage,
} from '@/types/messages'

export type AgentLiveActivity = Pick<
  Agent,
  'lastActivity' | 'activityLevel' | 'attentionScore' | 'isZombie' | 'usageRate'
>

type AgentPreviewPatch = Pick<
  Agent,
  'previewText' | 'previewCols' | 'previewRows' | 'previewSnapshot' |
  'terminalStatus' | 'runtimeObservation' | 'codexTerminalProfile'
>
type AgentLivePatch = AgentUpdateMessage['update']['patch']
  & Partial<AgentLiveActivity>
  & Partial<AgentPreviewPatch>
  & Partial<Omit<AgentReadMessage['read'], 'agentId'>>

type AgentLiveState = AgentLiveActivity
  & AgentPreviewPatch
  & AgentUpdateMessage['update']['patch']
  & Omit<AgentReadMessage['read'], 'agentId'>
type Listener = () => void
type AgentReadListener = (read: AgentReadMessage['read']) => void
type AgentRuntimeBindingListener = (agentId: string) => void
type LiveEntry = { value: AgentLiveState; signature: string | null }
type SubscriptionKind = 'all' | 'runtime'
type AgentProjectMembership = {
  included: boolean
  workspace: string
}
type AgentProjectContribution = {
  active: boolean
  attentionScore: number
  unread: boolean
  workspace: string
  zombie: boolean
}
type ProjectAggregate = {
  activeCount: number
  agentCount: number
  attentionCounts: Uint32Array
  snapshot: ProjectAgentSummary
  unreadCount: number
  zombieCount: number
}

const entries = new Map<string, LiveEntry>()
const listenersByAgentId = new Map<string, Record<SubscriptionKind, Set<Listener>>>()
const projectMembershipByAgentId = new Map<string, AgentProjectMembership>()
const projectContributionByAgentId = new Map<string, AgentProjectContribution>()
const projectAggregates = new Map<string, ProjectAggregate>()
const projectListenersByWorkspace = new Map<string, Set<Listener>>()
const dirtyProjectWorkspaces = new Set<string>()
const agentReadListeners = new Set<AgentReadListener>()
const agentRuntimeBindingListeners = new Set<AgentRuntimeBindingListener>()
let projectSummaryBatchDepth = 0
const RUNTIME_FIELDS = new Set<keyof AgentLiveState>([
  'adaptiveTitle',
  'sessionTitle',
  'runtimeBinding',
  'terminalInputReceived',
  'terminalBusy',
  'shellCwd',
  'shellLastExitCode',
  'shellLastEvent',
  'shellCommand',
  'shellLastCommand',
  'shellCommandStartedAt',
  'shellLastCommandStartedAt',
  'shellLastCommandFinishedAt',
  'shellLastCommandDurationMs',
  'terminalStatus',
  'runtimeObservation',
  'codexTerminalProfile',
  'unread',
  'attentionSeq',
  'readAttentionSeq',
  'attentionUpdatedAt',
  'readAttentionAt',
  'attentionReason',
  'attentionSummary',
  'attentionOutputEpoch',
  'attentionOutputSeq',
  'readOutputEpoch',
  'readOutputSeq',
])
const STRUCTURED_RUNTIME_FIELDS = new Set<keyof AgentLiveState>([
  'terminalStatus',
  'runtimeObservation',
  'codexTerminalProfile',
  'runtimeBinding',
])

declare global {
  interface Window {
    __FARMING_E2E__?: boolean
    __farmingAgentActivityTest?: {
      update: (agentId: string, activity: AgentLiveActivity) => void
    }
  }
}

function liveStateFromAgent(agent: Agent): AgentLiveState {
  return {
    adaptiveTitle: agent.adaptiveTitle,
    sessionTitle: agent.sessionTitle,
    runtimeBinding: agent.runtimeBinding,
    lastActivity: agent.lastActivity,
    activityLevel: agent.activityLevel,
    attentionScore: agent.attentionScore,
    isZombie: agent.isZombie,
    usageRate: agent.usageRate,
    previewText: agent.previewText,
    previewCols: agent.previewCols,
    previewRows: agent.previewRows,
    previewSnapshot: agent.previewSnapshot,
    terminalStatus: agent.terminalStatus,
    runtimeObservation: agent.runtimeObservation,
    codexTerminalProfile: agent.codexTerminalProfile,
    unread: agent.unread,
    attentionSeq: agent.attentionSeq,
    readAttentionSeq: agent.readAttentionSeq,
    attentionUpdatedAt: agent.attentionUpdatedAt,
    readAttentionAt: agent.readAttentionAt,
    attentionReason: agent.attentionReason,
    attentionSummary: agent.attentionSummary,
    attentionOutputEpoch: agent.attentionOutputEpoch,
    attentionOutputSeq: agent.attentionOutputSeq,
    readOutputEpoch: agent.readOutputEpoch,
    readOutputSeq: agent.readOutputSeq,
    terminalInputReceived: agent.terminalInputReceived,
    terminalBusy: agent.terminalBusy,
    shellCommand: agent.shellCommand,
    shellLastCommand: agent.shellLastCommand,
    shellCommandStartedAt: agent.shellCommandStartedAt,
    shellLastCommandStartedAt: agent.shellLastCommandStartedAt,
    shellLastCommandFinishedAt: agent.shellLastCommandFinishedAt,
    shellLastCommandDurationMs: agent.shellLastCommandDurationMs,
  }
}

function normalizedProjectAttentionScore(value: unknown) {
  const score = Number(value)
  if (!Number.isFinite(score)) return 0
  return Math.min(PROJECT_ATTENTION_SCORE_MAX, Math.max(0, Math.round(score)))
}

function agentProjectMembership(agent: Agent): AgentProjectMembership {
  return {
    included: agent.isMain !== true && agent.archived !== true,
    workspace: projectWorkspaceFromAgentState(agent),
  }
}

function agentProjectContribution(
  agentId: string,
  liveState: AgentLiveState | null | undefined,
): AgentProjectContribution | null {
  const membership = projectMembershipByAgentId.get(agentId)
  if (!membership?.included || !membership.workspace || !liveState) return null
  return {
    active: agentTurnActiveFromState(liveState),
    attentionScore: normalizedProjectAttentionScore(liveState.attentionScore),
    unread: liveState.unread === true,
    workspace: membership.workspace,
    zombie: liveState.isZombie === true,
  }
}

function emptyProjectAggregate(workspace: string): ProjectAggregate {
  return {
    activeCount: 0,
    agentCount: 0,
    attentionCounts: new Uint32Array(PROJECT_ATTENTION_SCORE_MAX + 1),
    snapshot: {
      activeCount: 0,
      agentCount: 0,
      maxAttentionScore: 0,
      unreadCount: 0,
      workspace,
      zombieCount: 0,
    },
    unreadCount: 0,
    zombieCount: 0,
  }
}

function projectMaximumAttention(aggregate: ProjectAggregate) {
  for (let score = PROJECT_ATTENTION_SCORE_MAX; score > 0; score -= 1) {
    if ((aggregate.attentionCounts[score] ?? 0) > 0) return score
  }
  return 0
}

function notifyProjectSummary(workspace: string) {
  projectListenersByWorkspace.get(workspace)?.forEach(listener => listener())
}

function flushProjectSummaries() {
  if (projectSummaryBatchDepth > 0 || dirtyProjectWorkspaces.size === 0) return
  const workspaces = [...dirtyProjectWorkspaces]
  dirtyProjectWorkspaces.clear()
  workspaces.forEach(workspace => {
    const aggregate = projectAggregates.get(workspace)
    if (!aggregate || aggregate.agentCount <= 0) {
      if (aggregate) projectAggregates.delete(workspace)
      notifyProjectSummary(workspace)
      return
    }
    const nextSnapshot: ProjectAgentSummary = {
      activeCount: aggregate.activeCount,
      agentCount: aggregate.agentCount,
      maxAttentionScore: projectMaximumAttention(aggregate),
      unreadCount: aggregate.unreadCount,
      workspace,
      zombieCount: aggregate.zombieCount,
    }
    const previous = aggregate.snapshot
    if (
      previous.activeCount === nextSnapshot.activeCount
      && previous.agentCount === nextSnapshot.agentCount
      && previous.maxAttentionScore === nextSnapshot.maxAttentionScore
      && previous.unreadCount === nextSnapshot.unreadCount
      && previous.zombieCount === nextSnapshot.zombieCount
    ) return
    aggregate.snapshot = nextSnapshot
    notifyProjectSummary(workspace)
  })
}

function markProjectSummaryDirty(workspace: string) {
  if (!workspace) return
  dirtyProjectWorkspaces.add(workspace)
  flushProjectSummaries()
}

function withProjectSummaryBatch(operation: () => void) {
  projectSummaryBatchDepth += 1
  try {
    operation()
  } finally {
    projectSummaryBatchDepth -= 1
    flushProjectSummaries()
  }
}

function removeProjectContribution(contribution: AgentProjectContribution) {
  const aggregate = projectAggregates.get(contribution.workspace)
  if (!aggregate) return
  aggregate.agentCount = Math.max(0, aggregate.agentCount - 1)
  if (contribution.active) aggregate.activeCount = Math.max(0, aggregate.activeCount - 1)
  if (contribution.unread) aggregate.unreadCount = Math.max(0, aggregate.unreadCount - 1)
  if (contribution.zombie) aggregate.zombieCount = Math.max(0, aggregate.zombieCount - 1)
  aggregate.attentionCounts[contribution.attentionScore] = Math.max(
    0,
    (aggregate.attentionCounts[contribution.attentionScore] ?? 0) - 1,
  )
  markProjectSummaryDirty(contribution.workspace)
}

function addProjectContribution(contribution: AgentProjectContribution) {
  const aggregate = projectAggregates.get(contribution.workspace)
    ?? emptyProjectAggregate(contribution.workspace)
  projectAggregates.set(contribution.workspace, aggregate)
  aggregate.agentCount += 1
  if (contribution.active) aggregate.activeCount += 1
  if (contribution.unread) aggregate.unreadCount += 1
  if (contribution.zombie) aggregate.zombieCount += 1
  aggregate.attentionCounts[contribution.attentionScore] = (
    aggregate.attentionCounts[contribution.attentionScore] ?? 0
  ) + 1
  markProjectSummaryDirty(contribution.workspace)
}

function sameProjectContribution(
  left: AgentProjectContribution | null | undefined,
  right: AgentProjectContribution | null | undefined,
) {
  return left === right || Boolean(
    left
    && right
    && left.active === right.active
    && left.attentionScore === right.attentionScore
    && left.unread === right.unread
    && left.workspace === right.workspace
    && left.zombie === right.zombie
  )
}

function updateProjectContribution(agentId: string, liveState: AgentLiveState | null | undefined) {
  const previous = projectContributionByAgentId.get(agentId)
  const next = agentProjectContribution(agentId, liveState)
  if (sameProjectContribution(previous, next)) return
  withProjectSummaryBatch(() => {
    if (previous) removeProjectContribution(previous)
    if (next) {
      projectContributionByAgentId.set(agentId, next)
      addProjectContribution(next)
    } else {
      projectContributionByAgentId.delete(agentId)
    }
  })
}

function updateAgentProjectMembership(agent: Agent) {
  projectMembershipByAgentId.set(agent.id, agentProjectMembership(agent))
  updateProjectContribution(agent.id, entries.get(agent.id)?.value)
}

function removeAgentProjectState(agentId: string) {
  updateProjectContribution(agentId, null)
  projectMembershipByAgentId.delete(agentId)
}

function notify(agentId: string, includeRuntime: boolean) {
  const listeners = listenersByAgentId.get(agentId)
  listeners?.all.forEach(listener => listener())
  if (includeRuntime) listeners?.runtime.forEach(listener => listener())
}

function replaceAgentLiveState(agentId: string, value: AgentLiveState) {
  const signature = JSON.stringify(value)
  const previous = entries.get(agentId)
  const previousSignature = previous?.signature ?? (previous ? JSON.stringify(previous.value) : '')
  if (previousSignature === signature) return
  entries.set(agentId, { value, signature })
  updateProjectContribution(agentId, value)
  notify(agentId, true)
}

export function updateAgentLiveState(agentId: string, patch: AgentLivePatch) {
  const previous = entries.get(agentId)
  if (!previous) return
  const changedFields = Object.entries(patch).filter(([key, value]) => {
    const field = key as keyof AgentLiveState
    const previousValue = previous.value[field]
    if (Object.is(previousValue, value)) return false
    if (STRUCTURED_RUNTIME_FIELDS.has(field) && previousValue && value) {
      return JSON.stringify(previousValue) !== JSON.stringify(value)
    }
    return true
  }).map(([key]) => key as keyof AgentLiveState)
  if (changedFields.length === 0) return
  const value = { ...previous.value, ...patch }
  entries.set(agentId, {
    value,
    signature: null,
  })
  updateProjectContribution(agentId, value)
  notify(agentId, changedFields.some(field => RUNTIME_FIELDS.has(field)))
  if (changedFields.includes('runtimeBinding')) {
    agentRuntimeBindingListeners.forEach(listener => listener(agentId))
  }
}

export function updateAgentLiveActivity(
  activity: AgentLiveActivity & { agentId: string },
) {
  const { agentId, ...patch } = activity
  updateAgentLiveState(agentId, patch)
}

export function updateAgentLiveActivities(
  activities: AgentActivitySnapshotMessage['activities'],
) {
  withProjectSummaryBatch(() => activities.forEach(updateAgentLiveActivity))
}

export function updateAgentReadState(read: AgentReadMessage['read']) {
  const { agentId, ...patch } = read
  updateAgentLiveState(agentId, patch)
  agentReadListeners.forEach(listener => listener(read))
}

export function subscribeAgentReadEvents(listener: AgentReadListener) {
  agentReadListeners.add(listener)
  return () => {
    agentReadListeners.delete(listener)
  }
}

export function subscribeAgentRuntimeBindingEvents(listener: AgentRuntimeBindingListener) {
  agentRuntimeBindingListeners.add(listener)
  return () => {
    agentRuntimeBindingListeners.delete(listener)
  }
}

export function updateAgentAcpSessionRevision(
  session: AcpSessionRevisionMessage['session'],
) {
  const previous = entries.get(session.agentId)
  const runtimeBinding = previous?.value.runtimeBinding
  if (
    !previous
    || runtimeBinding?.kind !== 'acp'
    || session.revision <= runtimeBinding.sessionRevision
  ) return
  updateAgentLiveState(session.agentId, {
    runtimeBinding: {
      ...runtimeBinding,
      sessionRevision: session.revision,
      sessionUpdatedAt: session.updatedAt,
    },
  })
}

export function updateAgentLivePreview(preview: SessionPreviewMessage['preview']) {
  updateAgentLiveState(preview.agentId, {
    previewText: preview.previewText,
    previewCols: preview.cols,
    previewRows: preview.rows,
    previewSnapshot: preview.previewSnapshot ?? null,
    ...(preview.terminalStatus ? { terminalStatus: preview.terminalStatus } : {}),
    ...(preview.runtimeObservation ? { runtimeObservation: preview.runtimeObservation } : {}),
    ...(preview.codexTerminalProfile ? { codexTerminalProfile: preview.codexTerminalProfile } : {}),
  })
}

export function reconcileAgentLiveStates(agents: Agent[]) {
  const activeAgentIds = new Set<string>()
  withProjectSummaryBatch(() => {
    agents.forEach(agent => {
      activeAgentIds.add(agent.id)
      updateAgentProjectMembership(agent)
      replaceAgentLiveState(agent.id, liveStateFromAgent(agent))
    })
    for (const agentId of entries.keys()) {
      if (activeAgentIds.has(agentId)) continue
      removeAgentProjectState(agentId)
      entries.delete(agentId)
      notify(agentId, true)
    }
  })
}

export function reconcileAgentLiveStateDelta(agents: Agent[], removedAgentIds: string[]) {
  withProjectSummaryBatch(() => {
    agents.forEach(agent => {
      updateAgentProjectMembership(agent)
      replaceAgentLiveState(agent.id, liveStateFromAgent(agent))
    })
    removedAgentIds.forEach(agentId => {
      removeAgentProjectState(agentId)
      if (!entries.delete(agentId)) return
      notify(agentId, true)
    })
  })
}

export function resetAgentLiveStates() {
  const agentIds = [...entries.keys()]
  const projectWorkspaces = [...projectAggregates.keys()]
  entries.clear()
  projectMembershipByAgentId.clear()
  projectContributionByAgentId.clear()
  projectAggregates.clear()
  dirtyProjectWorkspaces.clear()
  agentIds.forEach(agentId => notify(agentId, true))
  projectWorkspaces.forEach(notifyProjectSummary)
}

function subscribe(agentId: string, kind: SubscriptionKind, listener: Listener) {
  const listeners = listenersByAgentId.get(agentId) ?? {
    all: new Set<Listener>(),
    runtime: new Set<Listener>(),
  }
  listeners[kind].add(listener)
  listenersByAgentId.set(agentId, listeners)
  return () => {
    listeners[kind].delete(listener)
    if (listeners.all.size === 0 && listeners.runtime.size === 0) listenersByAgentId.delete(agentId)
  }
}

function snapshot(agentId: string) {
  return entries.get(agentId)?.value ?? null
}

function subscribeProjectSummary(workspace: string, listener: Listener) {
  if (!workspace) return () => {}
  const listeners = projectListenersByWorkspace.get(workspace) ?? new Set<Listener>()
  listeners.add(listener)
  projectListenersByWorkspace.set(workspace, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) projectListenersByWorkspace.delete(workspace)
  }
}

export function projectAgentLiveSummary(workspace: string): ProjectAgentSummary | null {
  return projectAggregates.get(workspace)?.snapshot ?? null
}

export function useProjectAgentLiveSummary(workspace: string): ProjectAgentSummary | null {
  const subscribeToProject = useCallback(
    (listener: Listener) => subscribeProjectSummary(workspace, listener),
    [workspace],
  )
  const getSnapshot = useCallback(
    () => projectAgentLiveSummary(workspace),
    [workspace],
  )
  return useSyncExternalStore(subscribeToProject, getSnapshot, getSnapshot)
}

export function agentWithCurrentLiveState(agent: Agent): Agent {
  const liveState = snapshot(agent.id)
  return liveState ? { ...agent, ...liveState } : agent
}

function useAgentLiveSubscription(agent: Agent | null | undefined, kind: SubscriptionKind): Agent | null {
  const agentId = agent?.id ?? ''
  const subscribeToAgent = useCallback(
    (listener: Listener) => agentId ? subscribe(agentId, kind, listener) : () => {},
    [agentId, kind],
  )
  const getSnapshot = useCallback(
    () => agentId ? snapshot(agentId) : null,
    [agentId],
  )
  const liveState = useSyncExternalStore(subscribeToAgent, getSnapshot, getSnapshot)
  return useMemo(
    () => liveState && agent ? { ...agent, ...liveState } : agent ?? null,
    [agent, liveState],
  )
}

export function useAgentWithLiveState(agent: Agent): Agent
export function useAgentWithLiveState(agent: null | undefined): null
export function useAgentWithLiveState(agent: Agent | null | undefined): Agent | null
export function useAgentWithLiveState(agent: Agent | null | undefined): Agent | null {
  return useAgentLiveSubscription(agent, 'all')
}

export function useAgentWithLiveRuntimeState(agent: Agent): Agent
export function useAgentWithLiveRuntimeState(agent: null | undefined): null
export function useAgentWithLiveRuntimeState(agent: Agent | null | undefined): Agent | null
export function useAgentWithLiveRuntimeState(agent: Agent | null | undefined): Agent | null {
  return useAgentLiveSubscription(agent, 'runtime')
}

if (typeof window !== 'undefined' && window.__FARMING_E2E__) {
  window.__farmingAgentActivityTest = {
    update(agentId, activity) {
      updateAgentLiveState(agentId, activity)
    },
  }
}
