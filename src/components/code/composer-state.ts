import type { Agent } from '@/types/agent'
import { agentSessionId } from './model'
import { createDefaultComposerHistoryState, type ComposerHistoryState } from './composer-history'
import type { ComposerAttachment } from './composer-message'
import type { CodeModelPickerPane, ComposerMode } from './types'
import { resumedAgentSessionIdFromSource } from './session-display'

export interface AgentComposerPendingFollowUpMessage {
  id: string
  text: string
  createdAt: number
}

export interface AgentComposerPendingFollowUp {
  messages: AgentComposerPendingFollowUpMessage[]
  createdAt: number
}

export interface AgentComposerUiState {
  plusMenuOpen: boolean
  approvalMenuOpen: boolean
  modelMenuOpen: boolean
  modelPickerPane: CodeModelPickerPane
}

export interface AgentComposerState {
  draft: string
  attachments: ComposerAttachment[]
  mode: ComposerMode
  history: ComposerHistoryState
  pendingFollowUp?: AgentComposerPendingFollowUp
  ui: AgentComposerUiState
}

export const DEFAULT_AGENT_COMPOSER_UI_STATE: AgentComposerUiState = {
  plusMenuOpen: false,
  approvalMenuOpen: false,
  modelMenuOpen: false,
  modelPickerPane: null,
}

export const DEFAULT_AGENT_COMPOSER_STATE: AgentComposerState = createDefaultAgentComposerState()

export function createDefaultAgentComposerState(): AgentComposerState {
  return {
    draft: '',
    attachments: [],
    mode: 'default',
    history: createDefaultComposerHistoryState(),
    ui: { ...DEFAULT_AGENT_COMPOSER_UI_STATE },
  }
}

export function createPendingFollowUpMessage(text: string): AgentComposerPendingFollowUpMessage {
  const randomId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return {
    id: `pending-${randomId}`,
    text,
    createdAt: Date.now(),
  }
}

export function removePendingFollowUpMessage(
  pendingFollowUp: AgentComposerPendingFollowUp | undefined,
  messageId: string
): AgentComposerPendingFollowUp | undefined {
  if (!pendingFollowUp) return undefined
  const messages = pendingFollowUp.messages.filter(message => message.id !== messageId)
  return messages.length > 0
    ? { ...pendingFollowUp, messages }
    : undefined
}

export function closeComposerMenusForState(state: AgentComposerState): AgentComposerState {
  if (
    !state.ui.plusMenuOpen
    && !state.ui.approvalMenuOpen
    && !state.ui.modelMenuOpen
    && state.ui.modelPickerPane === null
  ) {
    return state
  }
  return { ...state, ui: { ...DEFAULT_AGENT_COMPOSER_UI_STATE } }
}

function isDefaultAgentComposerUiState(ui: AgentComposerUiState) {
  return (
    !ui.plusMenuOpen
    && !ui.approvalMenuOpen
    && !ui.modelMenuOpen
    && ui.modelPickerPane === null
  )
}

export function mergeAgentComposerStates(primary: AgentComposerState, incoming: AgentComposerState): AgentComposerState {
  const pendingMessages = [
    ...(primary.pendingFollowUp?.messages || []),
    ...(incoming.pendingFollowUp?.messages || []),
  ]
  const pendingCreatedAt = Math.min(
    primary.pendingFollowUp?.createdAt ?? Number.POSITIVE_INFINITY,
    incoming.pendingFollowUp?.createdAt ?? Number.POSITIVE_INFINITY
  )
  return {
    ...primary,
    draft: primary.draft || incoming.draft,
    attachments: [...incoming.attachments, ...primary.attachments],
    mode: primary.mode !== 'default' ? primary.mode : incoming.mode,
    history: {
      entries: [...incoming.history.entries, ...primary.history.entries].slice(-100),
      cursor: null,
    },
    pendingFollowUp: pendingMessages.length > 0
      ? {
        messages: pendingMessages,
        createdAt: Number.isFinite(pendingCreatedAt) ? pendingCreatedAt : Date.now(),
      }
      : undefined,
    ui: isDefaultAgentComposerUiState(primary.ui) ? incoming.ui : primary.ui,
  }
}

export function providerComposerStateKey(agent: Agent | null | undefined) {
  if (!agent || agent.providerSessionTemporary === true) return ''
  if (agent.providerSessionKey) return agent.providerSessionKey
  if (agent.providerSessionProvider && agent.providerSessionId) {
    return agentSessionId({
      provider: agent.providerSessionProvider,
      id: agent.providerSessionId,
      providerHomeId: agent.providerHomeId,
    })
  }
  return resumedAgentSessionIdFromSource(agent.source)
}

export function composerStateKeyForAgent(agent: Agent | null | undefined) {
  if (!agent) return ''
  return providerComposerStateKey(agent) || agent.restartedFromAgentIds?.[0] || agent.id
}

export function composerStateAliasKeysForAgent(agent: Agent) {
  const keys = new Set<string>()
  if (agent.id) keys.add(agent.id)
  agent.restartedFromAgentIds?.forEach(agentId => keys.add(agentId))
  if (agent.providerSessionKey) keys.add(agent.providerSessionKey)
  if (agent.providerSessionProvider && agent.providerSessionId) {
    keys.add(agentSessionId({
      provider: agent.providerSessionProvider,
      id: agent.providerSessionId,
      providerHomeId: agent.providerHomeId,
    }))
  }
  const sourceKey = resumedAgentSessionIdFromSource(agent.source)
  if (sourceKey) keys.add(sourceKey)
  return Array.from(keys)
}
