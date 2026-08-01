import type { Agent } from '@/types/agent'

export const AGENT_COMPLETION_NOTIFICATIONS_STORAGE_KEY = 'farmingAgentCompletionNotificationsEnabled'
export const AGENT_COMPLETION_NOTIFICATIONS_EVENT = 'farming:agent-completion-notifications-change'

export const AGENT_COMPLETION_NOTIFICATION_SETTLE_MS = 250
export const AGENT_COMPLETION_NOTIFICATION_COORDINATION_MS = 120

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export interface AgentCompletionNotificationEvent {
  agentId: string
  attentionSeq: number
  kind: 'acp-completion' | 'terminal-notification'
  summary: string
}

export interface AgentCompletionNotificationCandidate {
  tabId: string
  pageActive: boolean
}

export type AgentNotificationPermission = NotificationPermission | 'unsupported'

function finiteSequence(value: unknown) {
  const sequence = Number(value)
  return Number.isFinite(sequence) && sequence >= 0 ? Math.floor(sequence) : 0
}

export function readAgentCompletionNotificationsEnabled(storage?: StorageLike) {
  if (!storage && typeof window === 'undefined') return false
  try {
    return (storage ?? window.localStorage).getItem(AGENT_COMPLETION_NOTIFICATIONS_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveAgentCompletionNotificationsEnabled(
  enabled: boolean,
  storage?: StorageLike,
) {
  try {
    const target = storage ?? window.localStorage
    target.setItem(AGENT_COMPLETION_NOTIFICATIONS_STORAGE_KEY, String(enabled))
  } catch {
    return false
  }
  if (typeof window !== 'undefined' && !storage) {
    window.dispatchEvent(new CustomEvent(AGENT_COMPLETION_NOTIFICATIONS_EVENT, {
      detail: { enabled },
    }))
  }
  return true
}

export function agentNotificationPermission(): AgentNotificationPermission {
  if (
    typeof window !== 'undefined'
    && (window as Window & { farmingDesktop?: unknown }).farmingDesktop
  ) return 'granted'
  if (
    typeof window === 'undefined'
    || !window.isSecureContext
    || !('Notification' in window)
  ) return 'unsupported'
  return window.Notification.permission
}

export function observeAgentCompletionNotificationEvents(
  cursor: Map<string, number>,
  agents: Agent[],
) {
  const events: AgentCompletionNotificationEvent[] = []
  const liveAgentIds = new Set<string>()

  agents.forEach(agent => {
    liveAgentIds.add(agent.id)
    const attentionSeq = finiteSequence(agent.attentionSeq)
    const previousSeq = cursor.get(agent.id)
    cursor.set(agent.id, attentionSeq)
    if (previousSeq === undefined || attentionSeq <= previousSeq) return
    if (agent.isMain || agent.archived) return
    if (agent.attentionReason === 'terminal-notification') {
      events.push({
        agentId: agent.id,
        attentionSeq,
        kind: 'terminal-notification',
        summary: String(agent.attentionSummary || '').trim(),
      })
      return
    }
    if (agent.attentionReason === 'turn-complete' && agent.runtimeBinding?.kind === 'acp') {
      events.push({
        agentId: agent.id,
        attentionSeq,
        kind: 'acp-completion',
        summary: String(agent.attentionSummary || '').trim(),
      })
    }
  })

  Array.from(cursor.keys()).forEach(agentId => {
    if (!liveAgentIds.has(agentId)) cursor.delete(agentId)
  })

  return events
}

export function agentCompletionNotificationStillEligible(
  agent: Agent | undefined,
  event: AgentCompletionNotificationEvent,
) {
  if (!agent || agent.isMain || agent.archived) return false
  const attentionSeq = finiteSequence(agent.attentionSeq)
  if (event.kind === 'terminal-notification') return attentionSeq >= event.attentionSeq
  if (attentionSeq !== event.attentionSeq) return false
  if (agent.attentionReason !== 'turn-complete' || agent.runtimeBinding?.kind !== 'acp') return false
  return agent.runtimeObservation?.phase !== 'working'
    && agent.runtimeObservation?.phase !== 'starting'
}

export function agentCompletionNotificationOwner(
  candidates: AgentCompletionNotificationCandidate[],
) {
  if (candidates.some(candidate => candidate.pageActive)) return null
  return candidates
    .map(candidate => candidate.tabId)
    .sort((left, right) => left.localeCompare(right))[0] ?? null
}

export function agentCompletionNotificationContent(
  agent: Agent,
  language: 'en' | 'zh',
  kind: AgentCompletionNotificationEvent['kind'] = 'acp-completion',
  summary = '',
) {
  const name = String(
    agent.customTitle
    || agent.task
    || agent.providerSessionTitle
    || agent.sessionTitle
    || agent.command
    || 'Agent',
  ).trim() || 'Agent'
  const body = summary.trim()
  if (kind === 'terminal-notification') {
    return language === 'zh'
      ? {
          title: name,
          body: body || 'Agent 请求注意，点击返回 Farming。',
        }
      : {
          title: name,
          body: body || 'Agent requested attention. Click to return to Farming.',
        }
  }
  return language === 'zh'
    ? {
        title: name,
        body: body || 'Agent 有新消息，点击返回 Farming 查看。',
      }
    : {
        title: name,
        body: body || 'Agent has a new message. Click to return to Farming.',
      }
}
