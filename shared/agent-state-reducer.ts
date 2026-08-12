import type {
  AgentStateCursor,
  AgentStateSnapshotPage,
} from './browser-protocol.js'

export type {
  AgentStateCursor,
  AgentStateSnapshotPage,
} from './browser-protocol.js'

export interface AgentStateSnapshotCursor extends AgentStateCursor {
  id: string
  nextOffset: number
  total: number
}

export type AgentStateSnapshotDisposition = 'append' | 'replace' | 'resync'

export function advanceAgentStateSnapshot(
  cursor: AgentStateSnapshotCursor | null,
  generation: string,
  sequence: number,
  page: AgentStateSnapshotPage,
  receivedAgentCount: number,
): { cursor: AgentStateSnapshotCursor | null; disposition: AgentStateSnapshotDisposition } {
  const nextOffset = page.offset + receivedAgentCount
  const validPage = Boolean(page.id)
    && Number.isInteger(page.offset)
    && page.offset >= 0
    && Number.isInteger(page.total)
    && page.total >= 0
    && Number.isInteger(receivedAgentCount)
    && receivedAgentCount >= 0
    && nextOffset <= page.total
    && page.complete === (nextOffset === page.total)
  if (!validPage) return { cursor, disposition: 'resync' }

  if (page.offset === 0) {
    return {
      disposition: 'replace',
      cursor: page.complete ? null : {
        generation,
        sequence,
        id: page.id,
        nextOffset,
        total: page.total,
      },
    }
  }

  if (
    !cursor
    || cursor.generation !== generation
    || cursor.sequence !== sequence
    || cursor.id !== page.id
    || cursor.nextOffset !== page.offset
    || cursor.total !== page.total
  ) {
    return { cursor, disposition: 'resync' }
  }

  return {
    disposition: 'append',
    cursor: page.complete ? null : { ...cursor, nextOffset },
  }
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

  for (const agent of replacements.values()) {
    if (removals.has(agent.id) || retainedIds.has(agent.id)) continue
    nextAgents.push(agent)
    retainedIds.add(agent.id)
    changed = true
  }

  return changed ? nextAgents : agents
}
