import type { Agent } from '@/types/agent'
import { appPath } from '@/lib/base-path'
import { addComposerHistoryEntry } from '../composer-history'
import { createPendingFollowUpMessage } from '../composer-state'
import type { AgentComposerState } from '../composer-state'
import {
  composerAttachmentsCanSubmit,
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
}: SubmitAcpDraftInput) {
  if (!composerAttachmentsCanSubmit(attachments)) return false
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

  const settlePrompt = (accepted: boolean) => {
    if (!accepted) return false
    updateComposerState(composerKey, state => {
      const cleared = clearOwnedDraft(state)
      if (cleared !== state) {
        attachments.forEach(revokeComposerAttachmentPreview)
      }
      return {
        ...cleared,
        history: addComposerHistoryEntry(cleared.history, draft),
      }
    })
    return true
  }

  let submitted: boolean | Promise<boolean>
  try {
    submitted = sendMessage(
      agent,
      text,
      promptAttachments,
      undefined,
      turnActive ? 'steer' : 'prompt',
    )
  } catch {
    return false
  }
  if (typeof submitted === 'boolean') return settlePrompt(submitted)
  return submitted.then(settlePrompt, () => false)
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
