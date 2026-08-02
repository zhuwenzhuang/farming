import type { Agent } from '@/types/agent'
import { appPath } from '@/lib/base-path'
import { addComposerHistoryEntry } from '../composer-history'
import {
  createPendingFollowUpMessage,
  removePendingFollowUpMessage,
  removeComposerSubmission,
} from '../composer-state'
import type {
  AgentComposerPendingFollowUpMessage,
  AgentComposerState,
} from '../composer-state'
import {
  composerMessageForNativeAttachments,
  composerPromptAttachments,
  formatComposerMessage,
  revokeComposerAttachmentPreview,
  type ComposerAttachment,
  type ComposerPromptAttachment,
} from '../composer-message'
import type { ComposerMode } from '../types'
import type { ComposerFollowUpBehavior } from '@/lib/ui-preferences'

interface SubmitAcpDraftInput {
  agent: Agent | null
  composerKey: string
  draft: string
  attachments: ComposerAttachment[]
  composerMode: ComposerMode
  turnActive: boolean
  followUpBehavior?: ComposerFollowUpBehavior
  sendMessage: (
    agent: Agent,
    message: string,
    attachments?: ComposerPromptAttachment[],
    requestId?: string,
    delivery?: 'prompt' | 'steer',
  ) => boolean | Promise<boolean>
  updateComposerState: (
    key: string,
    updater: (state: AgentComposerState) => AgentComposerState,
  ) => void
  prepareComposerStateForTransport: (
    key: string,
    updater: (state: AgentComposerState) => AgentComposerState,
  ) => boolean
}

interface SubmitQueuedAcpFollowUpInput {
  agent: Agent
  composerKey: string
  message: AgentComposerPendingFollowUpMessage
  delivery: 'prompt' | 'steer'
  sendMessage: SubmitAcpDraftInput['sendMessage']
  updateComposerState: SubmitAcpDraftInput['updateComposerState']
  prepareComposerStateForTransport: SubmitAcpDraftInput['prepareComposerStateForTransport']
}

export function isAcpComposerAvailable(agent: Agent | null) {
  return Boolean(
    agent
    && agent.runtimeBinding.kind === 'acp'
    && agent.status === 'running'
    && agent.requiresProcessExitAcknowledgement !== true
  )
}

export function resolveAcpFollowUpBehavior(
  configured: ComposerFollowUpBehavior,
  oppositeForMessage: boolean,
  canSteer: boolean,
): ComposerFollowUpBehavior {
  const requested = oppositeForMessage
    ? configured === 'queue' ? 'steer' : 'queue'
    : configured
  return requested === 'steer' && canSteer ? 'steer' : 'queue'
}

/**
 * ACP chat submits one user message through the structured runtime path. Files
 * and uploaded image paths use the existing composer message representation;
 * Terminal-only modes, pending follow-ups, and PTY framing remain isolated.
 */
export function submitAcpDraft({
  agent,
  composerKey,
  draft,
  attachments,
  composerMode,
  turnActive,
  followUpBehavior = 'queue',
  sendMessage,
  updateComposerState,
  prepareComposerStateForTransport,
}: SubmitAcpDraftInput) {
  const promptAttachments = composerPromptAttachments(attachments)
  const text = formatComposerMessage(composerMode, composerMessageForNativeAttachments(draft, attachments).trim())
  if ((!text && promptAttachments.length === 0) || !agent || !isAcpComposerAvailable(agent) || !composerKey) return false
  const clearOwnedDraft = (state: AgentComposerState) => {
    const ownsDraft = state.draft === draft
      && state.attachments.length === attachments.length
      && state.attachments.every((attachment, index) => attachment.id === attachments[index]?.id)
    if (!ownsDraft) return state
    return {
      ...state,
      draft: '',
      attachments: [],
      mode: state.mode === composerMode ? 'default' as const : state.mode,
    }
  }
  const queueFollowUp = () => {
    updateComposerState(composerKey, state => {
      const cleared = clearOwnedDraft(state)
      if (cleared === state) return state
      attachments.forEach(revokeComposerAttachmentPreview)
      return {
        ...cleared,
        history: addComposerHistoryEntry(cleared.history, draft),
        pendingFollowUp: {
          messages: [
            ...(cleared.pendingFollowUp?.messages || []),
            createPendingFollowUpMessage(text, promptAttachments, draft, composerMode),
          ],
          createdAt: cleared.pendingFollowUp?.createdAt || Date.now(),
        },
      }
    })
    return true
  }
  if (turnActive && followUpBehavior === 'queue') return queueFollowUp()

  const delivery = turnActive ? 'steer' as const : 'prompt' as const
  const pendingMessage = createPendingFollowUpMessage(text, promptAttachments, draft, composerMode)
  const submission = {
    ...pendingMessage,
    editableText: draft,
    composerMode,
    status: 'submitting' as const,
    delivery,
    origin: 'draft' as const,
    draftAttachmentIds: attachments.map(attachment => attachment.id),
  }
  const prepared = prepareComposerStateForTransport(composerKey, state => {
    const duplicate = state.submissions?.some(candidate => (
      candidate.origin === 'draft'
      && candidate.text === submission.text
      && candidate.editableText === submission.editableText
      && candidate.delivery === submission.delivery
      && JSON.stringify(candidate.attachments || []) === JSON.stringify(submission.attachments || [])
      && JSON.stringify(candidate.draftAttachmentIds || []) === JSON.stringify(submission.draftAttachmentIds)
    ))
    if (duplicate) return state
    return { ...state, submissions: [...(state.submissions || []), submission] }
  })
  if (!prepared) return false

  const settlePrompt = (accepted: boolean) => {
    updateComposerState(composerKey, state => {
      const currentSubmission = state.submissions?.find(candidate => candidate.id === submission.id)
      if (!currentSubmission) return state
      if (!accepted) {
        return {
          ...state,
          submissions: state.submissions?.map(candidate => (
            candidate.id === submission.id
              ? { ...candidate, status: 'failed' as const }
              : candidate
          )),
        }
      }
      const cleared = clearOwnedDraft(state)
      if (cleared !== state) {
        attachments.forEach(revokeComposerAttachmentPreview)
      }
      return {
        ...cleared,
        history: addComposerHistoryEntry(cleared.history, currentSubmission.editableText ?? currentSubmission.text),
        submissions: removeComposerSubmission(cleared.submissions, submission.id),
      }
    })
    return accepted
  }

  let submitted: boolean | Promise<boolean>
  try {
    submitted = sendMessage(
      agent,
      text,
      promptAttachments,
      submission.id,
      delivery,
    )
  } catch {
    settlePrompt(false)
    return false
  }
  if (typeof submitted === 'boolean') return settlePrompt(submitted)
  return submitted.then(settlePrompt, () => settlePrompt(false))
}

export function submitQueuedAcpFollowUp({
  agent,
  composerKey,
  message,
  delivery,
  sendMessage,
  updateComposerState,
  prepareComposerStateForTransport,
}: SubmitQueuedAcpFollowUpInput): boolean | Promise<boolean> {
  const prepared = prepareComposerStateForTransport(composerKey, state => {
    if (!state.pendingFollowUp?.messages.some(candidate => candidate.id === message.id)) return state
    return {
      ...state,
      pendingFollowUp: removePendingFollowUpMessage(state.pendingFollowUp, message.id),
      submissions: [
        ...(state.submissions || []),
        {
          ...message,
          status: 'submitting' as const,
          historyRecorded: true,
          delivery,
          origin: 'queued' as const,
        },
      ],
    }
  })
  if (!prepared) return false

  const settle = (accepted: boolean) => {
    updateComposerState(composerKey, state => {
      if (!state.submissions?.some(candidate => candidate.id === message.id)) return state
      return {
        ...state,
        submissions: accepted
          ? removeComposerSubmission(state.submissions, message.id)
          : state.submissions.map(candidate => (
            candidate.id === message.id ? { ...candidate, status: 'failed' as const } : candidate
          )),
      }
    })
    return accepted
  }

  let submitted: boolean | Promise<boolean>
  try {
    submitted = sendMessage(agent, message.text, message.attachments, message.id, delivery)
  } catch {
    return settle(false)
  }
  if (typeof submitted === 'boolean') return settle(submitted)
  return submitted.then(settle, () => settle(false))
}

export function respondToAcpPermission(
  agentId: string,
  requestId: string,
  optionId?: string,
  cancelled = false,
) {
  return fetch(appPath(`/api/agents/${encodeURIComponent(agentId)}/acp-permission`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, optionId, cancelled }),
  })
}

export function respondToAcpElicitation(
  agentId: string,
  requestId: string,
  action: 'accept' | 'decline' | 'cancel',
  content?: Record<string, string | number | boolean | string[]>,
) {
  return fetch(appPath(`/api/agents/${encodeURIComponent(agentId)}/acp-elicitation`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, action, content }),
  })
}
