import type { Agent } from '@/types/agent'
import { appPath } from '@/lib/base-path'
import { addComposerHistoryEntry } from '../composer-history'
import { createPendingFollowUpMessage } from '../composer-state'
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
  supportsSteer: boolean
  sendMessage: (agent: Agent, message: string, attachments?: ComposerPromptAttachment[]) => boolean
  updateComposerState: (
    key: string,
    updater: (state: AgentComposerState) => AgentComposerState,
  ) => void
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
  supportsSteer,
  sendMessage,
  updateComposerState,
}: SubmitAcpDraftInput) {
  const promptAttachments = composerPromptAttachments(attachments)
  const text = formatComposerMessage(composerMode, composerMessageForNativeAttachments(draft, attachments).trim())
  if ((!text && promptAttachments.length === 0) || !agent || agent.runtimeBinding.kind !== 'acp' || !composerKey) return false
  const steerNow = turnActive && supportsSteer
  if ((!turnActive || steerNow) && !sendMessage(agent, text, promptAttachments)) return false

  updateComposerState(composerKey, state => ({
    ...state,
    draft: '',
    attachments: [],
    mode: 'default',
    history: addComposerHistoryEntry(state.history, draft),
    ...(turnActive && !steerNow ? {
      pendingFollowUp: {
        messages: [
          ...(state.pendingFollowUp?.messages || []),
          createPendingFollowUpMessage(text, promptAttachments),
        ],
        createdAt: state.pendingFollowUp?.createdAt || Date.now(),
      },
    } : {}),
  }))
  attachments.forEach(revokeComposerAttachmentPreview)
  return true
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
