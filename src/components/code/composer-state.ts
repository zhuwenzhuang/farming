import type { Agent } from '@/types/agent'
import { agentSessionId } from './model'
import { createDefaultComposerHistoryState, type ComposerHistoryState } from './composer-history'
import type { ComposerAttachment, ComposerPromptAttachment } from './composer-message'
import type { CodeModelPickerPane, ComposerMode } from './types'
import { resumedAgentSessionIdFromSource } from './session-display'

export interface AgentComposerPendingFollowUpMessage {
  id: string
  text: string
  createdAt: number
  attachments?: ComposerPromptAttachment[]
  editableText?: string
  composerMode?: ComposerMode
}

export interface AgentComposerPendingFollowUp {
  messages: AgentComposerPendingFollowUpMessage[]
  createdAt: number
}

export interface AgentComposerSubmission extends AgentComposerPendingFollowUpMessage {
  status: 'submitting' | 'failed'
  historyRecorded?: boolean
  delivery?: 'prompt' | 'steer'
  origin?: 'draft' | 'queued'
  draftAttachmentIds?: string[]
}

export interface AgentComposerAdmission extends AgentComposerSubmission {
  composerKey: string
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
  submissions?: AgentComposerSubmission[]
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

export function createPendingFollowUpMessage(
  text: string,
  attachments: ComposerPromptAttachment[] = [],
  editableText = text,
  composerMode: ComposerMode = 'default'
): AgentComposerPendingFollowUpMessage {
  const randomId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return {
    id: `pending-${randomId}`,
    text,
    createdAt: Date.now(),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(editableText !== text ? { editableText } : {}),
    ...(composerMode !== 'default' ? { composerMode } : {}),
  }
}

export function restorePendingFollowUpMessageForEdit(
  state: AgentComposerState,
  messageId: string
): AgentComposerState {
  const message = state.pendingFollowUp?.messages.find(candidate => candidate.id === messageId)
  if (!message) return state

  const restoredText = message.editableText ?? message.text
  const draft = !restoredText
    ? state.draft
    : !state.draft.trim()
      ? restoredText
      : state.draft === restoredText || state.draft.startsWith(`${restoredText}\n`)
        ? state.draft
        : `${restoredText}\n${state.draft}`
  const restoredAttachments: ComposerAttachment[] = (message.attachments || []).map((attachment, index) => ({
    ...attachment,
    id: `restored-${message.id}-${index}`,
    status: 'ready',
  }))

  return {
    ...state,
    draft,
    attachments: [...state.attachments, ...restoredAttachments],
    mode: state.draft.trim() ? state.mode : (message.composerMode ?? 'default'),
    history: { ...state.history, cursor: null },
    pendingFollowUp: removePendingFollowUpMessage(state.pendingFollowUp, messageId),
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

export function removeComposerSubmission(
  submissions: AgentComposerSubmission[] | undefined,
  messageId: string
) {
  if (!submissions) return undefined
  const remaining = submissions.filter(message => message.id !== messageId)
  return remaining.length > 0 ? remaining : undefined
}

export function composerSubmissionOwnsDraft(
  state: AgentComposerState,
  submission: AgentComposerSubmission,
) {
  if (submission.origin !== 'draft') return false
  const draftAttachmentIds = submission.draftAttachmentIds || []
  return state.draft === (submission.editableText ?? submission.text)
    && state.attachments.length === draftAttachmentIds.length
    && state.attachments.every((attachment, index) => attachment.id === draftAttachmentIds[index])
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
  const pendingMessagesById = new Map<string, AgentComposerPendingFollowUpMessage>()
  for (const message of incoming.pendingFollowUp?.messages || []) pendingMessagesById.set(message.id, message)
  for (const message of primary.pendingFollowUp?.messages || []) pendingMessagesById.set(message.id, message)
  const pendingMessages = Array.from(pendingMessagesById.values()).sort((left, right) => (
    left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  ))
  const pendingCreatedAt = Math.min(
    primary.pendingFollowUp?.createdAt ?? Number.POSITIVE_INFINITY,
    incoming.pendingFollowUp?.createdAt ?? Number.POSITIVE_INFINITY
  )
  const submissionsById = new Map<string, AgentComposerSubmission>()
  for (const submission of [...(incoming.submissions || []), ...(primary.submissions || [])]) {
    submissionsById.set(submission.id, submission)
  }
  const submissions = Array.from(submissionsById.values()).sort((left, right) => (
    left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  ))
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
    submissions: submissions.length > 0 ? submissions : undefined,
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
