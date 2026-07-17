import type { Agent } from '@/types/agent'
import { agentDisplayName, agentRowTitle, formatRelativeAge } from '@/lib/format'
import { inferAgentTerminalState } from './capabilities'
import { agentSessionId, agentSessionUpdatedAt } from './model'
import type { AgentSessionHistoryItem } from './types'

export type AgentRowBacking =
  | { kind: 'agent'; agent: Agent }
  | { kind: 'history'; session: AgentSessionHistoryItem; fallbackTitle: string }

export interface AgentRowDisplayState {
  kind: AgentRowBacking['kind']
  title: string
  rowTitle: string
  commandTitle: string
  detailLabel: string
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
  ageVisible: boolean
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

function shouldShowAgentStatusIndicator(status: Agent['status'], turnActive: boolean) {
  return turnActive || status === 'pending' || status === 'stopped' || status === 'dead'
}

function compactCommand(command: string) {
  const text = command.replace(/\s+/g, ' ').trim()
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}

function timestampTitle(timestamp: number | null | undefined) {
  return timestamp ? new Date(timestamp).toLocaleString() : undefined
}

function compactMetadata(parts: Array<string | null | undefined>) {
  return parts
    .map(part => typeof part === 'string' ? part.trim() : '')
    .filter(Boolean)
    .join(' · ')
}

function finiteTimestamp(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function formatCommandDuration(durationMs: number | null) {
  if (durationMs === null || durationMs < 0) return ''
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function agentCommandTitle(agent: Agent, turnActive: boolean, now: number) {
  const runningCommand = compactCommand(
    agent.terminalStatus?.runningCommand || agent.shellCommand || ''
  )
  if (runningCommand && turnActive) {
    const startedAt = finiteTimestamp(agent.terminalStatus?.runningCommandStartedAt)
      ?? finiteTimestamp(agent.shellCommandStartedAt)
    const duration = startedAt !== null ? formatCommandDuration(now - startedAt) : ''
    return duration ? `Running ${duration}: ${runningCommand}` : `Running: ${runningCommand}`
  }

  const lastCommand = compactCommand(
    agent.terminalStatus?.lastCommand || agent.shellLastCommand || ''
  )
  if (!lastCommand) return ''

  const exitCode = agent.terminalStatus?.lastExitCode
  const duration = formatCommandDuration(
    finiteTimestamp(agent.terminalStatus?.lastCommandDurationMs)
      ?? finiteTimestamp(agent.shellLastCommandDurationMs)
  )
  const details = [
    duration,
    typeof exitCode === 'number' ? `exit ${exitCode}` : '',
  ].filter(Boolean).join(', ')
  return details ? `Last command: ${lastCommand} (${details})` : `Last command: ${lastCommand}`
}

function agentRowStateFromAgent(agent: Agent, now: number): AgentRowDisplayState {
  const ageTimestamp = agent.lastActivity ?? agent.startedAt
  const terminalState = inferAgentTerminalState(agent)
  const turnActive = terminalState.turnActive
  const title = agentRowTitle(agent)
  const commandTitle = agentCommandTitle(agent, turnActive, now)
  const providerLabel = agentDisplayName(agent.providerSessionProvider || agent.command)
  const profileLabel = compactMetadata([
    providerLabel,
    agent.codexTerminalProfile?.model,
    agent.codexTerminalProfile?.reasoningEffort,
  ])
  const detailLabel = commandTitle || (profileLabel.toLowerCase() === title.toLowerCase() ? '' : profileLabel)
  const ageLabel = formatRelativeAge(ageTimestamp, now)
  return {
    kind: 'agent',
    title,
    rowTitle: [title, commandTitle, agent.cwd].filter(Boolean).join(' · '),
    commandTitle,
    detailLabel,
    lifecycleStatus: agent.status,
    turnActive,
    statusIndicatorVisible: shouldShowAgentStatusIndicator(agent.status, turnActive),
    pinned: agent.pinned === true,
    unread: agent.unread === true,
    forkedToNewWorktree: isNewWorktreeForkAgent(agent),
    requiresResume: false,
    scheduled: false,
    scheduleTitle: '',
    ageLabel,
    ageVisible: !turnActive && Boolean(ageLabel),
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
  const detailLabel = compactMetadata([
    session.providerName || agentDisplayName(session.provider),
    session.model,
    session.effort,
  ])
  const ageLabel = formatRelativeAge(updatedAt, now)

  return {
    kind: 'history',
    title: session.title || fallbackTitle,
    rowTitle: [session.title || fallbackTitle, session.cwd || session.workspace].filter(Boolean).join(' · '),
    commandTitle: '',
    detailLabel,
    turnActive: false,
    statusIndicatorVisible: false,
    pinned: session.pinned === true,
    unread: session.unread === true,
    forkedToNewWorktree: false,
    requiresResume: true,
    scheduled: Boolean(session.schedule),
    scheduleTitle,
    ageLabel,
    ageVisible: Boolean(ageLabel),
    ageTitle: timestampTitle(updatedAt),
  }
}

export function buildAgentRowDisplayState(backing: AgentRowBacking, now = Date.now()): AgentRowDisplayState {
  if (backing.kind === 'agent') return agentRowStateFromAgent(backing.agent, now)
  return agentRowStateFromHistory(backing.session, backing.fallbackTitle, now)
}
