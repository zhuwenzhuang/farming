import type { Agent } from '@/types/agent'
import { appPath } from '@/lib/base-path'
import { addComposerHistoryEntry } from '../composer-history'
import { createPendingFollowUpMessage, removeComposerSubmission } from '../composer-state'
import type { AgentComposerState } from '../composer-state'
import {
  composerMessageForNativeAttachments,
  composerPromptAttachments,
  formatComposerMessage,
  revokeComposerAttachmentPreview,
  type ComposerAttachment,
  type ComposerPromptAttachment,
} from '../composer-message'
import type { ComposerMode } from '../types'

interface SubmitAcpDraftInput {
  agent: Agent | null
  composerKey: string
  draft: string
  attachments: ComposerAttachment[]
  composerMode: ComposerMode
  turnActive: boolean
  sendMessage: (
    agent: Agent,
    message: string,
    attachments?: ComposerPromptAttachment[],
    requestId?: string,
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
  sendMessage,
  updateComposerState,
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
      mode: 'default' as const,
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
            createPendingFollowUpMessage(text, promptAttachments),
          ],
          createdAt: cleared.pendingFollowUp?.createdAt || Date.now(),
        },
      }
    })
    return true
  }
  if (turnActive) return queueFollowUp()

  const submission = {
    ...createPendingFollowUpMessage(text, promptAttachments),
    status: 'submitting' as const,
    delivery: 'prompt' as const,
  }
  updateComposerState(composerKey, state => {
    const cleared = clearOwnedDraft(state)
    if (cleared === state) return state
    return {
      ...cleared,
      submissions: [...(cleared.submissions || []), submission],
    }
  })

  const settleSubmission = (accepted: boolean) => {
    updateComposerState(composerKey, state => {
      if (accepted) {
        return {
          ...state,
          history: addComposerHistoryEntry(state.history, draft),
          submissions: removeComposerSubmission(state.submissions, submission.id),
        }
      }
      return {
        ...state,
        submissions: state.submissions?.map(candidate => (
          candidate.id === submission.id
            ? { ...candidate, status: 'failed' as const }
            : candidate
        )),
      }
    })
    attachments.forEach(revokeComposerAttachmentPreview)
    return accepted
  }

  let submitted: boolean | Promise<boolean>
  try {
    submitted = sendMessage(agent, text, promptAttachments, submission.id)
  } catch {
    return settleSubmission(false)
  }
  if (typeof submitted === 'boolean') return settleSubmission(submitted)
  return submitted.then(settleSubmission, () => settleSubmission(false))
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
