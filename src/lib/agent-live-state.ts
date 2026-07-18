import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { Agent } from '@/types/agent'
import type { AgentUpdateMessage, SessionPreviewMessage } from '@/types/messages'

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

type AgentLiveState = AgentLiveActivity & AgentPreviewPatch & AgentUpdateMessage['update']['patch']
type Listener = () => void
type LiveEntry = { value: AgentLiveState; signature: string | null }
type SubscriptionKind = 'all' | 'runtime'

const entries = new Map<string, LiveEntry>()
const listenersByAgentId = new Map<string, Record<SubscriptionKind, Set<Listener>>>()
const RUNTIME_FIELDS = new Set<keyof AgentLiveState>([
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
])
const STRUCTURED_RUNTIME_FIELDS = new Set<keyof AgentLiveState>([
  'terminalStatus',
  'runtimeObservation',
  'codexTerminalProfile',
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
}

export function updateAgentLiveActivity(
  activity: AgentLiveActivity & { agentId: string },
) {
  const { agentId, ...patch } = activity
  updateAgentLiveState(agentId, patch)
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
