import type { Agent } from '@/types/agent'

type AgentSelectionCandidate = Pick<
  Agent,
  'id' | 'archived' | 'status' | 'isMain' | 'lastActivity' | 'startedAt'
>

export function isOpenableAgent(agent: Pick<Agent, 'archived' | 'status'>) {
  return !agent.archived && agent.status !== 'dead' && agent.status !== 'stopped'
}

function agentUpdatedAt(agent: AgentSelectionCandidate) {
  return Math.max(agent.lastActivity || 0, agent.startedAt || 0)
}

export function mostRecentlyUpdatedAgent<T extends AgentSelectionCandidate>(agents: readonly T[]) {
  let selected: T | null = null

  for (const agent of agents) {
    if (agent.isMain || !isOpenableAgent(agent)) continue
    if (!selected) {
      selected = agent
      continue
    }

    const updatedAtDifference = agentUpdatedAt(agent) - agentUpdatedAt(selected)
    const startedAtDifference = (agent.startedAt || 0) - (selected.startedAt || 0)
    if (
      updatedAtDifference > 0
      || (updatedAtDifference === 0 && startedAtDifference > 0)
      || (
        updatedAtDifference === 0
        && startedAtDifference === 0
        && agent.id.localeCompare(selected.id) < 0
      )
    ) {
      selected = agent
    }
  }

  return selected
}

export function resolveActiveAgentId<T extends AgentSelectionCandidate>(
  agents: readonly T[],
  currentAgentId: string | null,
  transientAgentId: string | null = null,
) {
  if (
    currentAgentId
    && (
      currentAgentId === transientAgentId
      || agents.some(agent => agent.id === currentAgentId && isOpenableAgent(agent))
    )
  ) {
    return currentAgentId
  }

  return mostRecentlyUpdatedAgent(agents)?.id ?? null
}
