export interface AgentStateCursor {
  generation: string
  sequence: number
}

export type AgentStateDeltaDisposition = 'apply' | 'ignore' | 'resync'

export function agentStateDeltaDisposition(
  cursor: AgentStateCursor | null,
  generation: string,
  sequence: number,
): AgentStateDeltaDisposition {
  if (!cursor || cursor.generation !== generation) return 'resync'
  if (sequence <= cursor.sequence) return 'ignore'
  return sequence === cursor.sequence + 1 ? 'apply' : 'resync'
}

export function applyAgentStateDelta<Agent extends { id: string }>(
  agents: Agent[],
  upserts: Agent[],
  removedAgentIds: string[],
): Agent[] {
  if (upserts.length === 0 && removedAgentIds.length === 0) return agents
  const removals = new Set(removedAgentIds)
  const replacements = new Map(upserts.map(agent => [agent.id, agent]))
  const retainedIds = new Set<string>()
  let changed = false
  const nextAgents: Agent[] = []

  for (const agent of agents) {
    if (removals.has(agent.id)) {
      changed = true
      continue
    }
    const replacement = replacements.get(agent.id)
    if (replacement) {
      nextAgents.push(replacement)
      retainedIds.add(agent.id)
      if (replacement !== agent) changed = true
      continue
    }
    nextAgents.push(agent)
    retainedIds.add(agent.id)
  }

  for (const agent of upserts) {
    if (removals.has(agent.id) || retainedIds.has(agent.id)) continue
    nextAgents.push(agent)
    retainedIds.add(agent.id)
    changed = true
  }

  return changed ? nextAgents : agents
}
