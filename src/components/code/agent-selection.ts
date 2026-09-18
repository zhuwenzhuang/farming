import type { Agent } from '@/types/agent'
import { projectWorkspaceFromAgentState } from '../../../shared/agent-state-semantics.js'

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

// Shared with the Project sidebar; activity does not reorder this collection.
export function compareProjectAgents(a: Pick<Agent, 'isMain' | 'projectOrder' | 'startedAt'>, b: Pick<Agent, 'isMain' | 'projectOrder' | 'startedAt'>) {
  if (a.isMain !== b.isMain) return a.isMain ? -1 : 1
  return (b.projectOrder ?? 0) - (a.projectOrder ?? 0)
    || (b.startedAt ?? 0) - (a.startedAt ?? 0)
}

export function agentAfterRemoval(
  agents: readonly Agent[],
  current: Agent | null | undefined,
  excludedIds: ReadonlySet<string>,
): string | null {
  if (!current || current.isMain) return null
  const workspace = projectWorkspaceFromAgentState(current)
  const peers = agents.filter(agent => !agent.isMain
    && projectWorkspaceFromAgentState(agent) === workspace)
  if (!peers.some(agent => agent.id === current.id)) peers.push(current)
  peers.sort(compareProjectAgents)
  const index = peers.findIndex(agent => agent.id === current.id)
  const candidates = [...peers.slice(index + 1), ...peers.slice(0, index).reverse()]
  return candidates.find(agent => !excludedIds.has(agent.id) && isOpenableAgent(agent))?.id ?? null
}
