import type { Agent } from '@/types/agent'
import { agentTurnActiveFromState } from '../../shared/agent-state-semantics.js'

export const DYNAMIC_PIN_ACTIVITY_WINDOW_MS = 60 * 60 * 1000

export type DynamicPinAgentState = Partial<Pick<
  Agent,
  | 'archived'
  | 'attentionUpdatedAt'
  | 'exitedAt'
  | 'isMain'
  | 'lastActivity'
  | 'readAttentionAt'
  | 'runtimeBinding'
  | 'runtimeObservation'
  | 'startedAt'
  | 'status'
  | 'unread'
>>

function finiteTimestamp(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export function agentHasCurrentDynamicPinAttention(agent: DynamicPinAgentState) {
  return agent.unread === true
    || agent.status === 'pending'
    || agentTurnActiveFromState(agent)
}

export function dynamicPinActivityAt(
  agent: DynamicPinAgentState,
  now: number,
  viewedAt = 0,
) {
  if (agentHasCurrentDynamicPinAttention(agent)) return now
  const agentActivityAt = finiteTimestamp(agent.lastActivity)
    || finiteTimestamp(agent.startedAt)
  return Math.max(
    agentActivityAt,
    finiteTimestamp(agent.attentionUpdatedAt),
    finiteTimestamp(agent.readAttentionAt),
    finiteTimestamp(agent.exitedAt),
    finiteTimestamp(viewedAt),
  )
}

export function isAgentDynamicallyPinned(
  agent: DynamicPinAgentState,
  now: number,
  viewedAt = 0,
) {
  if (agent.archived === true || agent.isMain === true) return false
  const activityAt = dynamicPinActivityAt(agent, now, viewedAt)
  return activityAt > 0 && now - activityAt < DYNAMIC_PIN_ACTIVITY_WINDOW_MS
}
