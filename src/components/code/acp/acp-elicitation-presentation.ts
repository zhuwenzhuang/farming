import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { Agent, AcpPendingElicitation } from '@/types/agent'
import { agentWithCurrentLiveState, subscribeAgentRuntimeBindingEvents } from '@/lib/agent-live-state'

export type ElicitationValues = Record<string, string | number | boolean | string[]>
export interface ElicitationDraft {
  values?: ElicitationValues
  detailsExpanded?: boolean
  status?: 'submitting' | 'submitted' | 'uncertain'
  error?: string
}
interface Presentation {
  collapsed: boolean
  reveal: number
  requests: Record<string, ElicitationDraft>
}
const empty: Presentation = { collapsed: false, reveal: 0, requests: {} }
const presentations = new Map<string, Presentation>()
const listeners = new Set<() => void>()
const publish = (agentId: string, value: Presentation) => {
  presentations.set(agentId, value)
  listeners.forEach(listener => listener())
}
export function pendingAgentQuestions(agent: Agent | null | undefined): AcpPendingElicitation[] {
  const runtime = agent?.runtimeBinding
  return runtime?.kind === 'acp' ? runtime.pendingElicitations : []
}
export function questionPresentation(agentId: string) {
  return presentations.get(agentId) || empty
}
export function reconcileQuestions(agentId: string, requests: AcpPendingElicitation[]) {
  const previous = questionPresentation(agentId)
  const ids = requests.map(request => request.requestId)
  if (ids.length === Object.keys(previous.requests).length && ids.every(id => previous.requests[id])) return
  if (!ids.length) {
    presentations.delete(agentId)
    listeners.forEach(listener => listener())
    return
  }
  publish(agentId, {
    ...previous,
    collapsed: previous.collapsed && ids.every(id => previous.requests[id]),
    requests: Object.fromEntries(ids.map(id => [id, previous.requests[id] || {}])),
  })
}
export function collapseQuestions(agentId: string, collapsed: boolean) {
  publish(agentId, { ...questionPresentation(agentId), collapsed })
}
export function revealQuestions(agentId: string, requests: AcpPendingElicitation[]) {
  reconcileQuestions(agentId, requests)
  const previous = questionPresentation(agentId)
  publish(agentId, { ...previous, collapsed: false, reveal: previous.reveal + 1 })
}
export function updateQuestionDraft(agentId: string, requestId: string, update: Partial<ElicitationDraft>) {
  const previous = questionPresentation(agentId)
  if (!previous.requests[requestId]) return
  publish(agentId, { ...previous, requests: { ...previous.requests, [requestId]: { ...previous.requests[requestId], ...update } } })
}
export function useQuestionPresentation(agentId: string) {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => questionPresentation(agentId),
    () => empty,
  )
}
/** Reconcile even background requests; browser presentation never owns validity. */
export function useQuestionPresentationLifetime(agents: Agent[]) {
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  useEffect(() => {
    for (const agentId of presentations.keys()) {
      const agent = agents.find(candidate => candidate.id === agentId)
      reconcileQuestions(agentId, pendingAgentQuestions(agent ? agentWithCurrentLiveState(agent) : null))
    }
  }, [agents])
  useEffect(() => subscribeAgentRuntimeBindingEvents(agentId => {
    if (!presentations.has(agentId)) return
    const agent = agentsRef.current.find(candidate => candidate.id === agentId)
    reconcileQuestions(agentId, pendingAgentQuestions(agent ? agentWithCurrentLiveState(agent) : null))
  }), [])
  useEffect(() => () => { presentations.clear(); listeners.forEach(listener => listener()) }, [])
}
