import { attachSubagent } from '@/lib/subagent-supervision'
import { useCallback, useRef, useState } from 'react'
import type { Agent } from '@/types/agent'
import { useAgentWithLiveRuntimeState } from '@/lib/agent-live-state'
import { isAcpRuntime } from '@/lib/agent-runtime'
import { readRecentClipboardWrite } from '@/lib/clipboard'
import { appPath } from '@/lib/base-path'
import type { ComposerFollowUpBehavior } from '@/lib/ui-preferences'
import { AcpComposer } from './acp/AcpComposer'
import { acpComposerStateKeyForAgent } from './acp/acp-composer-state'
import { isAcpComposerAvailable, respondToAcpElicitation, respondToAcpPermission, resolveAcpFollowUpBehavior, submitAcpDraft } from './acp/acp-composer-behavior'
import { createDefaultAgentComposerState, type AgentComposerState } from './composer-state'
import { canUseComposerHistoryNavigation, navigateComposerHistory } from './composer-history'
import { appendDraftBlock, clipboardMediaFiles, composerAttachmentsCanSubmit, formatAttachmentError, formatAttachmentFile, isAudioFile, isImageFile, revokeComposerAttachmentPreview } from './composer-message'
import { useComposerFollowUpController, type ComposerFollowUpOwnership, type ComposerMessageSender } from './useComposerFollowUpController'
import type { CodeCopy } from './copy'

type StateUpdater = (key: string, update: (state: AgentComposerState) => AgentComposerState) => void
export interface SubagentComposerController {
  states: Record<string, AgentComposerState>
  update: StateUpdater
  updateExisting: StateUpdater
  send: ComposerMessageSender
  interrupt: (agentId: string) => void
  addMedia: (key: string, file: File) => void
  ownership: ComposerFollowUpOwnership
  followUpBehavior: ComposerFollowUpBehavior
}

/** Both panes share the durable draft store and admission owner, but every
 * action closes over this exact child identity, never the selected parent. */
export function SubagentComposer({ agent: structuralAgent, active, controller, copy }: {
  agent: Agent; active: boolean; controller: SubagentComposerController; copy: CodeCopy
}) {
  const agent = useAgentWithLiveRuntimeState(structuralAgent)!
  const key = acpComposerStateKeyForAgent(agent)
  const state = controller.states[key] ?? createDefaultAgentComposerState()
  const runtime = isAcpRuntime(agent) ? agent.runtimeBinding : null
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const pasteSequence = useRef(0)
  const focus = useCallback(() => { textareaRef.current?.focus({ preventScroll: true }) }, [])
  const update = (fn: (value: AgentComposerState) => AgentComposerState) => controller.update(key, fn)
  const followUps = useComposerFollowUpController({
    ownership: controller.ownership, flushQueues: false, agents: [agent], activeAgent: agent,
    activeComposerKey: key, composerByAgentKey: controller.states, terminalCanInterrupt: false,
    sendMessage: controller.send, updateComposerState: controller.update,
    updateExistingComposerState: controller.updateExisting, focusComposer: focus, interruptAgent: controller.interrupt,
  })
  const appendFiles = async (files: File[]) => {
    const blocks: string[] = []
    for (const file of files) {
      if (isImageFile(file) || isAudioFile(file)) controller.addMedia(key, file)
      else {
        try { blocks.push(await formatAttachmentFile(file)) }
        catch { blocks.push(formatAttachmentError(file)) }
      }
    }
    if (blocks.length) update(current => ({ ...current, draft: appendDraftBlock(current.draft, blocks.join('\n\n')) }))
    focus()
  }
  const perform = async (request: Promise<Response>) => {
    try {
      const response = await request
      if (!response.ok) {
        const payload = await response.json()
        throw new Error(payload.error || `Request failed (${response.status})`)
      }
      setError('')
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
  }
  const pasteRecent = (textarea: HTMLTextAreaElement) => {
    const text = readRecentClipboardWrite()
    if (!text) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const draft = textarea.value.slice(0, start) + text + textarea.value.slice(end)
    update(current => ({ ...current, draft }))
    requestAnimationFrame(() => { if (textarea.isConnected) { textarea.focus({ preventScroll: true }); textarea.setSelectionRange(start + text.length, start + text.length) } })
  }
  const submit = (text?: string, options?: { oppositeFollowUpBehavior?: boolean }) => {
    if (agent.subagentParentSessionKey) attachSubagent(agent.subagentParentSessionKey)
    const result = submitAcpDraft({
      agent, composerKey: key, draft: text ?? textareaRef.current?.value ?? state.draft,
      attachments: state.attachments, composerMode: state.mode,
      turnActive: followUps.activeAgentTurnActive,
      followUpBehavior: resolveAcpFollowUpBehavior(controller.followUpBehavior,
        options?.oppositeFollowUpBehavior === true, runtime?.supportsSteer === true),
      sendMessage: controller.send, updateComposerState: controller.update,
    })
    return Promise.resolve(result).then(accepted => {
      if (accepted && !followUps.activeAgentTurnActive) followUps.markPromptStart(agent)
      return accepted
    })
  }
  return <>
    {error ? <div role="alert" className="code-related-session-error">{error}</div> : null}
    <AcpComposer active={active} agentId={agent.id} runtimeState={runtime?.state || ''}
      sessionRevision={runtime?.sessionRevision} sessionUpdatedAt={runtime?.sessionUpdatedAt}
      runtimeError={runtime?.error || ''} draft={state.draft} attachments={state.attachments}
      composerMode={state.mode} contextWindow={null}
      pendingFollowUp={state.pendingFollowUp ?? null} submissions={state.submissions ?? []}
      canSteerPendingFollowUp={followUps.activeAgentTurnActive && runtime?.supportsSteer === true}
      submitAction={!isAcpComposerAvailable(agent) ? 'disabled'
        : composerAttachmentsCanSubmit(state.attachments) && (state.draft.trim() || state.attachments.length) ? 'send'
          : followUps.activeAgentCanInterrupt ? 'interrupt' : 'disabled'}
      textareaRef={textareaRef} attachmentInputRef={attachmentInputRef}
      permissions={runtime?.pendingPermissions?.length ? runtime.pendingPermissions : runtime?.pendingPermission ? [runtime.pendingPermission] : []}
      elicitations={runtime?.pendingElicitations?.length ? runtime.pendingElicitations : runtime?.pendingElicitation ? [runtime.pendingElicitation] : []}
      activeElicitations={runtime?.activeElicitations || []} speechSupported={false} speechListening={false}
      onDraftChange={draft => update(current => ({ ...current, draft, history: { ...current.history, cursor: null } }))}
      onNavigateHistory={(direction, input) => {
        if (!canUseComposerHistoryNavigation(input)) return null
        const result = navigateComposerHistory(state.history, direction, input.value)
        if (!result.changed) return null
        update(current => ({ ...current, draft: result.value, history: result.history }))
        return result.value
      }}
      onSubmit={submit} onInterrupt={followUps.interruptActiveAgent}
      onReconnect={() => { void perform(fetch(appPath(`/api/agents/${encodeURIComponent(agent.id)}/acp-session/reconnect`), { method: 'POST', signal: AbortSignal.timeout(15000) })) }}
      onDiscardPendingFollowUp={followUps.discardPendingFollowUp} onEditPendingFollowUp={followUps.editPendingFollowUp}
      onSteerPendingFollowUp={followUps.steerPendingFollowUp} onRetrySubmission={followUps.retryAcpSubmission}
      onDiscardSubmission={followUps.discardAcpSubmission} onToggleSpeechInput={() => {}}
      onRemoveAttachment={id => update(current => {
        const attachment = current.attachments.find(item => item.id === id)
        if (attachment) revokeComposerAttachmentPreview(attachment)
        return { ...current, attachments: current.attachments.filter(item => item.id !== id) }
      })}
      onPasteAttachment={event => {
        pasteSequence.current++
        const files = clipboardMediaFiles(event.clipboardData)
        if (files.length) { event.preventDefault(); void appendFiles(files); return }
        if (!event.clipboardData.getData('text/plain') && event.currentTarget instanceof HTMLTextAreaElement && readRecentClipboardWrite()) { event.preventDefault(); pasteRecent(event.currentTarget) }
      }}
      onPasteShortcutFallback={textarea => { const sequence = pasteSequence.current; setTimeout(() => { if (pasteSequence.current === sequence && textarea.isConnected) pasteRecent(textarea) }, 0) }}
      onAttachmentFiles={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void appendFiles(files) }}
      onChooseAttachmentFile={() => attachmentInputRef.current?.click()}
      onActivateComposerMode={mode => update(current => ({ ...current, mode }))}
      onClearComposerMode={() => update(current => ({ ...current, mode: 'default' }))}
      onRespondToPermission={(id, option, cancelled) => { void perform(respondToAcpPermission(agent.id, id, option, cancelled, AbortSignal.timeout(15000))) }}
      onRespondToElicitation={(id, action, content) => { void perform(respondToAcpElicitation(agent.id, id, action, content, AbortSignal.timeout(15000))) }}
      copy={copy} />
  </>
}
