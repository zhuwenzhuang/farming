import type { Agent } from '@/types/agent'
import { appPath } from '@/lib/base-path'
import { addComposerHistoryEntry } from '../composer-history'
import type { AgentComposerState } from '../composer-state'

interface SubmitAcpDraftInput {
  agent: Agent | null
  composerKey: string
  draft: string
  sendMessage: (agent: Agent, message: string) => boolean
  updateComposerState: (
    key: string,
    updater: (state: AgentComposerState) => AgentComposerState,
  ) => void
}

/**
 * ACP chat submits one plain user message. It deliberately does not interpret
 * Terminal composer attachments, Goal/Plan modes, pending follow-ups, or PTY
 * input framing.
 */
export function submitAcpDraft({
  agent,
  composerKey,
  draft,
  sendMessage,
  updateComposerState,
}: SubmitAcpDraftInput) {
  const text = draft.trim()
  if (!text || !agent || agent.agentRuntimeMode !== 'acp' || !composerKey) return false
  if (!sendMessage(agent, text)) return false

  updateComposerState(composerKey, state => ({
    ...state,
    draft: '',
    history: addComposerHistoryEntry(state.history, draft),
  }))
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
