import type { Agent } from '@/types/agent'
import { appPath } from '@/lib/base-path'
import { addComposerHistoryEntry } from '../composer-history'
import type { AgentComposerState } from '../composer-state'
import { composerMessageWithAttachments, revokeComposerAttachmentPreview, type ComposerAttachment } from '../composer-message'

interface SubmitAcpDraftInput {
  agent: Agent | null
  composerKey: string
  draft: string
  attachments: ComposerAttachment[]
  sendMessage: (agent: Agent, message: string) => boolean
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
  sendMessage,
  updateComposerState,
}: SubmitAcpDraftInput) {
  const text = composerMessageWithAttachments(draft, attachments).trim()
  if (!text || !agent || agent.agentRuntimeMode !== 'acp' || !composerKey) return false
  if (!sendMessage(agent, text)) return false

  updateComposerState(composerKey, state => ({
    ...state,
    draft: '',
    attachments: [],
    history: addComposerHistoryEntry(state.history, draft),
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
