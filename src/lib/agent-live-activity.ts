import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { Agent } from '@/types/agent'

export type AgentLiveActivity = Pick<
  Agent,
  'lastActivity' | 'activityLevel' | 'attentionScore' | 'isZombie' | 'usageRate'
>

type Listener = () => void
type ActivityEntry = { value: AgentLiveActivity; signature: string }

const entries = new Map<string, ActivityEntry>()
const listenersByAgentId = new Map<string, Set<Listener>>()

declare global {
  interface Window {
    __farmingAgentActivityTest?: {
      update: (agentId: string, activity: AgentLiveActivity) => void
    }
  }
}

function activityFromAgent(agent: Agent): AgentLiveActivity {
  return {
    lastActivity: agent.lastActivity,
    activityLevel: agent.activityLevel,
    attentionScore: agent.attentionScore,
    isZombie: agent.isZombie,
    usageRate: agent.usageRate,
  }
}

function notify(agentId: string) {
  listenersByAgentId.get(agentId)?.forEach(listener => listener())
}

function setAgentLiveActivity(agentId: string, activity: AgentLiveActivity) {
  const signature = JSON.stringify(activity)
  if (entries.get(agentId)?.signature === signature) return
  entries.set(agentId, { value: activity, signature })
  notify(agentId)
}

export function updateAgentLiveActivity(
  activity: AgentLiveActivity & { agentId: string },
) {
  const { agentId, ...value } = activity
  setAgentLiveActivity(agentId, value)
}

export function reconcileAgentLiveActivities(agents: Agent[]) {
  const activeAgentIds = new Set<string>()
  agents.forEach(agent => {
    activeAgentIds.add(agent.id)
    setAgentLiveActivity(agent.id, activityFromAgent(agent))
  })
  for (const agentId of entries.keys()) {
    if (activeAgentIds.has(agentId)) continue
    entries.delete(agentId)
    notify(agentId)
  }
}

export function resetAgentLiveActivities() {
  const agentIds = [...entries.keys()]
  entries.clear()
  agentIds.forEach(notify)
}

function subscribe(agentId: string, listener: Listener) {
  const listeners = listenersByAgentId.get(agentId) ?? new Set<Listener>()
  listeners.add(listener)
  listenersByAgentId.set(agentId, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) listenersByAgentId.delete(agentId)
  }
}

function snapshot(agentId: string) {
  return entries.get(agentId)?.value ?? null
}

export function useAgentWithLiveActivity(agent: Agent): Agent
export function useAgentWithLiveActivity(agent: null | undefined): null
export function useAgentWithLiveActivity(agent: Agent | null | undefined): Agent | null
export function useAgentWithLiveActivity(agent: Agent | null | undefined): Agent | null {
  const agentId = agent?.id ?? ''
  const subscribeToAgent = useCallback(
    (listener: Listener) => agentId ? subscribe(agentId, listener) : () => {},
    [agentId],
  )
  const getSnapshot = useCallback(
    () => agentId ? snapshot(agentId) : null,
    [agentId],
  )
  const activity = useSyncExternalStore(
    subscribeToAgent,
    getSnapshot,
    getSnapshot,
  )
  return useMemo(
    () => activity && agent ? { ...agent, ...activity } : agent ?? null,
    [activity, agent],
  )
}

if (typeof window !== 'undefined' && window.__FARMING_E2E__) {
  window.__farmingAgentActivityTest = {
    update(agentId, activity) {
      setAgentLiveActivity(agentId, activity)
    },
  }
}
