import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { Agent } from '@/types/agent'
import type {
  AcpSessionRevisionMessage,
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

const entries = new Map<string, LiveEntry>()
const listenersByAgentId = new Map<string, Record<SubscriptionKind, Set<Listener>>>()
const agentReadListeners = new Set<AgentReadListener>()
const agentRuntimeBindingListeners = new Set<AgentRuntimeBindingListener>()
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
  entries.set(agentId, {
    value: { ...previous.value, ...patch },
    signature: null,
  })
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
  agents.forEach(agent => {
    activeAgentIds.add(agent.id)
    replaceAgentLiveState(agent.id, liveStateFromAgent(agent))
  })
  for (const agentId of entries.keys()) {
    if (activeAgentIds.has(agentId)) continue
    entries.delete(agentId)
    notify(agentId, true)
  }
}

export function resetAgentLiveStates() {
  const agentIds = [...entries.keys()]
  entries.clear()
  agentIds.forEach(agentId => notify(agentId, true))
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
