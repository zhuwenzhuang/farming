import type { Agent } from '@/types/agent'
import type { AgentSessionHistoryItem } from './types'
import {
  agentSessionId,
  compareAgentSessions,
} from './model'
import { resumedAgentSessionIdFromSource } from './session-display'

export interface AgentListState {
  liveAgents: Agent[]
  archivedAgents: Agent[]
  mainPageAgentSessions: AgentSessionHistoryItem[]
  sidebarAgentSessions: AgentSessionHistoryItem[]
  searchableAgentSessions: AgentSessionHistoryItem[]
  historyAgentSessions: AgentSessionHistoryItem[]
  claimedAgentSessionKeys: Set<string>
  claimedAgentSessionKeyByAgentId: Map<string, string>
}

export interface AgentListStateInput {
  allAgents: Agent[]
  liveAgents: Agent[]
  sessions: AgentSessionHistoryItem[]
  mainPageSessionKeys: ReadonlySet<string>
}

export function isAgentListLiveAgent(agent: Agent) {
  return !agent.isMain
    && agent.archived !== true
    && agent.status !== 'dead'
    && agent.status !== 'stopped'
}

export function isAgentListArchivedAgent(agent: Agent) {
  return !agent.isMain && agent.archived === true
}

export function claimedAgentSessionKeyByAgentIdForAgents(
  agents: Agent[],
  _sessions: AgentSessionHistoryItem[] = []
) {
  const claimedByAgentId = new Map<string, string>()

  agents.forEach(agent => {
    if (!isAgentListLiveAgent(agent)) return
    const sessionHandle = agent.providerSessionKey || resumedAgentSessionIdFromSource(agent.source)
    if (sessionHandle) {
      claimedByAgentId.set(agent.id, sessionHandle)
    }
  })

  return claimedByAgentId
}

export function claimedAgentSessionKeysForAgents(
  agents: Agent[],
  sessions: AgentSessionHistoryItem[] = []
) {
  return new Set(claimedAgentSessionKeyByAgentIdForAgents(agents, sessions).values())
}

export function agentListRowIdentity(agent: Pick<Agent, 'id'>, claimedAgentSessionKeyByAgentId: ReadonlyMap<string, string>) {
  return claimedAgentSessionKeyByAgentId.get(agent.id) || `agent:${agent.id}`
}

function exactResumeSourceScore(agent: Agent) {
  if (agent.providerSessionKey && agent.providerSessionTemporary !== true) return 120
  if (resumedAgentSessionIdFromSource(agent.source)) return 100
  if (agent.providerSessionKey) return 40
  return 0
}

function lifecycleScore(agent: Agent) {
  if (agent.status === 'running') return 30
  if (agent.status === 'pending') return 20
  return 0
}

function agentRowSelectionScore(agent: Agent, claimedAgentSessionKeyByAgentId: ReadonlyMap<string, string>) {
  return exactResumeSourceScore(agent)
    + (claimedAgentSessionKeyByAgentId.has(agent.id) ? 50 : 0)
    + lifecycleScore(agent)
}

export function dedupeLiveAgentsByRowIdentity(
  agents: Agent[],
  claimedAgentSessionKeyByAgentId: ReadonlyMap<string, string>
) {
  const selected = new Map<string, Agent>()

  agents.forEach(agent => {
    const identity = agentListRowIdentity(agent, claimedAgentSessionKeyByAgentId)
    const current = selected.get(identity)
    if (!current) {
      selected.set(identity, agent)
      return
    }

    const candidateScore = agentRowSelectionScore(agent, claimedAgentSessionKeyByAgentId)
    const currentScore = agentRowSelectionScore(current, claimedAgentSessionKeyByAgentId)
    const candidateStartedAt = Number(agent.startedAt) || 0
    const currentStartedAt = Number(current.startedAt) || 0
    if (
      candidateScore > currentScore
      || (candidateScore === currentScore && candidateStartedAt > currentStartedAt)
    ) {
      selected.set(identity, agent)
    }
  })

  return agents.filter(agent => selected.get(agentListRowIdentity(agent, claimedAgentSessionKeyByAgentId)) === agent)
}

export function unclaimedAgentSessions(
  sessions: AgentSessionHistoryItem[],
  claimedKeys: ReadonlySet<string>
) {
  return sessions.filter(session => !claimedKeys.has(agentSessionId(session)))
}

export function historyAgentSessionsForSessions(
  sessions: AgentSessionHistoryItem[],
  mainPageSessionKeys: ReadonlySet<string>,
  claimedKeys: ReadonlySet<string>
) {
  return sessions.filter(session => {
    const sessionId = agentSessionId(session)
    return !mainPageSessionKeys.has(sessionId) && !claimedKeys.has(sessionId)
  })
}

export function buildAgentListState({
  allAgents,
  liveAgents,
  sessions,
  mainPageSessionKeys,
}: AgentListStateInput): AgentListState {
  const normalizedLiveAgents = liveAgents.filter(isAgentListLiveAgent)
  const claimedAgentSessionKeyByAgentId = claimedAgentSessionKeyByAgentIdForAgents(normalizedLiveAgents, sessions)
  const claimedAgentSessionKeys = new Set(claimedAgentSessionKeyByAgentId.values())
  const visibleLiveAgents = dedupeLiveAgentsByRowIdentity(normalizedLiveAgents, claimedAgentSessionKeyByAgentId)
  const mainPageAgentSessions = sessions
    .filter(session => mainPageSessionKeys.has(agentSessionId(session)))
    .sort(compareAgentSessions)
  const sidebarAgentSessions = unclaimedAgentSessions(mainPageAgentSessions, claimedAgentSessionKeys)
  const searchableAgentSessions = unclaimedAgentSessions(sessions, claimedAgentSessionKeys).sort(compareAgentSessions)
  const historyAgentSessions = historyAgentSessionsForSessions(sessions, mainPageSessionKeys, claimedAgentSessionKeys)
    .sort(compareAgentSessions)

  return {
    liveAgents: visibleLiveAgents,
    archivedAgents: allAgents
      .filter(isAgentListArchivedAgent)
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    mainPageAgentSessions,
    sidebarAgentSessions,
    searchableAgentSessions,
    historyAgentSessions,
    claimedAgentSessionKeys,
    claimedAgentSessionKeyByAgentId,
  }
}
