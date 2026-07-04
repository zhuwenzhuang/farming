import type { Agent } from '@/types/agent'
import { agentTitle, formatRelativeAge } from '@/lib/format'
import { inferAgentTerminalState } from './capabilities'
import { agentSessionId, agentSessionUpdatedAt } from './model'
import type { AgentSessionHistoryItem } from './types'

export type AgentRowBacking =
  | { kind: 'agent'; agent: Agent }
  | { kind: 'history'; session: AgentSessionHistoryItem; fallbackTitle: string }

export interface AgentRowDisplayState {
  kind: AgentRowBacking['kind']
  title: string
  lifecycleStatus?: Agent['status']
  turnActive: boolean
  statusIndicatorVisible: boolean
  pinned: boolean
  unread: boolean
  forkedToNewWorktree: boolean
  requiresResume: boolean
  scheduled: boolean
  scheduleTitle: string
  ageLabel: string
  ageTitle?: string
}

export type AgentRowKeyBacking =
  | { kind: 'agent'; agent: Pick<Agent, 'id'>; claimedSessionKey?: string }
  | { kind: 'history'; session: Pick<AgentSessionHistoryItem, 'provider' | 'id'> }

export function agentRowKey(backing: AgentRowKeyBacking) {
  if (backing.kind === 'agent') return backing.claimedSessionKey || `agent:${backing.agent.id}`
  return agentSessionId(backing.session)
}

export function isNewWorktreeForkAgent(agent: Pick<Agent, 'source' | 'parentAgentId'>) {
  return Boolean(agent.parentAgentId) && agent.source === 'ui-fork-new-worktree'
}

function timestampTitle(timestamp: number | null | undefined) {
  return timestamp ? new Date(timestamp).toLocaleString() : undefined
}

function shouldShowAgentStatusIndicator(status: Agent['status'], turnActive: boolean) {
  return turnActive || status === 'pending' || status === 'stopped' || status === 'dead'
}

function agentRowStateFromAgent(agent: Agent, now: number): AgentRowDisplayState {
  const ageTimestamp = agent.lastActivity ?? agent.startedAt
  const terminalState = inferAgentTerminalState(agent)
  const turnActive = terminalState.turnActive
  return {
    kind: 'agent',
    title: agentTitle(agent),
    lifecycleStatus: agent.status,
    turnActive,
    statusIndicatorVisible: shouldShowAgentStatusIndicator(agent.status, turnActive),
    pinned: agent.pinned === true,
    unread: agent.unread === true,
    forkedToNewWorktree: isNewWorktreeForkAgent(agent),
    requiresResume: false,
    scheduled: false,
    scheduleTitle: '',
    ageLabel: formatRelativeAge(ageTimestamp, now),
    ageTitle: timestampTitle(ageTimestamp),
  }
}

function agentRowStateFromHistory(
  session: AgentSessionHistoryItem,
  fallbackTitle: string,
  now: number
): AgentRowDisplayState {
  const updatedAt = agentSessionUpdatedAt(session)
  const scheduleTitle = session.schedule?.label || session.schedule?.name || session.schedule?.rrule || ''

  return {
    kind: 'history',
    title: session.title || fallbackTitle,
    turnActive: false,
    statusIndicatorVisible: false,
    pinned: session.pinned === true,
    unread: session.unread === true,
    forkedToNewWorktree: false,
    requiresResume: true,
    scheduled: Boolean(session.schedule),
    scheduleTitle,
    ageLabel: formatRelativeAge(updatedAt, now),
    ageTitle: session.updatedAt ? new Date(session.updatedAt).toLocaleString() : undefined,
  }
}

export function buildAgentRowDisplayState(backing: AgentRowBacking, now = Date.now()): AgentRowDisplayState {
  if (backing.kind === 'agent') return agentRowStateFromAgent(backing.agent, now)
  return agentRowStateFromHistory(backing.session, backing.fallbackTitle, now)
}
