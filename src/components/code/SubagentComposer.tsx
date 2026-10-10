import { cancelComposerIntake } from './composer-intake'
import { attachSubagent } from '@/lib/subagent-supervision'
import { useCallback, useRef, useState } from 'react'
import type { Agent } from '@/types/agent'
import { useAgentWithLiveRuntimeState } from '@/lib/agent-live-state'
import { isAcpRuntime } from '@/lib/agent-runtime'
import { readRecentClipboardWrite } from '@/lib/clipboard'
import { appPath } from '@/lib/base-path'
import type { ComposerFollowUpBehavior } from '@/lib/ui-preferences'
import { projectFilesWorkspaceId } from '@/lib/project-workspaces'
import { capabilitiesForAgent } from './capabilities'
import { useComposerProviderCatalog } from './useComposerProviderCatalog'
import { attachPastedText, createPastedTextReference, restorePastedText } from './composer-paste'
import { composerContextReferenceId } from './composer-message'
import { AcpComposer } from './acp/AcpComposer'
import { acpComposerStateKeyForAgent } from './acp/acp-composer-state'
import { isAcpComposerAvailable, respondToAcpElicitation, respondToAcpPermission, resolveAcpFollowUpBehavior, submitAcpDraft } from './acp/acp-composer-behavior'
import { createDefaultAgentComposerState, type AgentComposerState } from './composer-state'
import { canUseComposerHistoryNavigation, navigateComposerHistory } from './composer-history'
import { clipboardAttachmentFiles, composerAttachmentsCanSubmit, revokeComposerAttachmentPreview } from './composer-message'
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
  const { discoveredSlashCommands, slashCatalogStatus } = useComposerProviderCatalog({
    providerKind: capabilitiesForAgent(agent).kind || '',
    homeId: agent.providerHomeId || 'default', workspace: agent.cwd,
    slashCommandDiscovery: agent.providerCapabilities?.slashCommandDiscovery === true,
    modelCatalogOpen: false, onModelCatalogError: setError,
  })
  const references = state.contextReferences || []
  const unavailableReferenceIds = references.filter(reference => reference.kind === 'document' ? reference.status !== 'ready' || !reference.text : (reference.kind === 'quote' || reference.kind === 'pasted-text') ? false : reference.kind === 'skill'
    ? slashCatalogStatus !== 'ready' || !discoveredSlashCommands.some(command => command.source === 'skill'
      && command.command === reference.command && command.scope === reference.source && Boolean(reference.path) && command.skillPath === reference.path)
    : reference.workspace !== agent.cwd || reference.rootId !== projectFilesWorkspaceId(agent.cwd) || !reference.path).map(reference => reference.id)
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
    if (files.length + state.attachments.length + references.length > 64) { setError('Too many attachments. Keep each message within 64 items.'); return }
    files.forEach(file => controller.addMedia(key, file))
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
  const pasteTextAsReference = (text: string, textarea: HTMLTextAreaElement) => {
    if (textarea.dataset.plainPaste === 'true') return false
    let reference
    try { reference = createPastedTextReference(text) }
    catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      return true
    }
    if (!reference) return false
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    update(current => attachPastedText(current, reference, start, end))
    requestAnimationFrame(() => { if (textarea.isConnected) textarea.setSelectionRange(start, start) })
    return true
  }
  const pasteRecent = (textarea: HTMLTextAreaElement) => {
    const text = readRecentClipboardWrite()
    if (!text) return
    if (pasteTextAsReference(text, textarea)) return
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
      contextReferences: references, contextValid: unavailableReferenceIds.length === 0,
      turnActive: followUps.activeAgentTurnActive,
      followUpBehavior: resolveAcpFollowUpBehavior(controller.followUpBehavior,
        options?.oppositeFollowUpBehavior === true, runtime?.canSteer === true),
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
      composerMode={state.mode} contextWindow={null} workspace={agent.cwd}
      contextReferences={references} unavailableReferenceIds={unavailableReferenceIds}
      catalogCommands={discoveredSlashCommands} slashCatalogStatus={slashCatalogStatus}
      onAddContextReference={reference => {
        if (reference.kind !== 'skill' && (reference.workspace !== agent.cwd || reference.rootId !== projectFilesWorkspaceId(agent.cwd))) return
        const item = { ...reference, id: composerContextReferenceId(reference) }
        update(current => current.contextReferences?.some(existing => existing.id === item.id) ? current
          : { ...current, contextReferences: [...(current.contextReferences || []), item] })
      }}
      onRemoveContextReference={id => { cancelComposerIntake(id); update(current => ({ ...current, contextReferences: (current.contextReferences || []).filter(item => item.id !== id) })) }}
      onRestorePastedText={id => { update(current => restorePastedText(current, id)); focus() }}
      pendingFollowUp={state.pendingFollowUp ?? null} submissions={state.submissions ?? []}
      canSteerPendingFollowUp={followUps.activeAgentTurnActive && runtime?.canSteer === true}
      submitAction={!isAcpComposerAvailable(agent) ? 'disabled'
        : unavailableReferenceIds.length === 0 && composerAttachmentsCanSubmit(state.attachments) && (state.draft.trim() || state.attachments.length || references.length) ? 'send'
          : followUps.activeAgentCanInterrupt ? 'interrupt' : 'disabled'}
      textareaRef={textareaRef} attachmentInputRef={attachmentInputRef}
      permissions={runtime?.pendingPermissions?.length ? runtime.pendingPermissions : runtime?.pendingPermission ? [runtime.pendingPermission] : []}
      elicitations={runtime?.pendingElicitations?.length ? runtime.pendingElicitations : runtime?.pendingElicitation ? [runtime.pendingElicitation] : []}
      activeElicitations={runtime?.activeElicitations || []} speechSupported={false} speechListening={false}
      onDraftChange={draft => update(current => ({ ...current, draft, history: { ...current.history, cursor: null } }))}
      onNavigateHistory={(direction, input) => {
        if (!canUseComposerHistoryNavigation(input)) return null
        const result = navigateComposerHistory(state.history, direction, input.value, { attachments: state.attachments, contextReferences: references })
        if (!result.changed) return null
        update(current => ({ ...current, draft: result.value, ...result.snapshot, history: result.history }))
        return result.value
      }}
      onSubmit={submit} onInterrupt={followUps.interruptActiveAgent}
      onReconnect={() => { void perform(fetch(appPath(`/api/agents/${encodeURIComponent(agent.id)}/acp-session/reconnect`), { method: 'POST', signal: AbortSignal.timeout(15000) })) }}
      onDiscardPendingFollowUp={followUps.discardPendingFollowUp} onEditPendingFollowUp={followUps.editPendingFollowUp}
      onSteerPendingFollowUp={followUps.steerPendingFollowUp} onRetrySubmission={followUps.retryAcpSubmission}
      onDiscardSubmission={followUps.discardAcpSubmission} onToggleSpeechInput={() => {}}
      onRemoveAttachment={id => { cancelComposerIntake(id); update(current => {
        const attachment = current.attachments.find(item => item.id === id)
        if (attachment) revokeComposerAttachmentPreview(attachment)
        return { ...current, attachments: current.attachments.filter(item => item.id !== id) }
      }) }}
      onPasteAttachment={event => {
        pasteSequence.current++
        if (event.defaultPrevented) return
        const files = clipboardAttachmentFiles(event.clipboardData)
        const text = event.clipboardData.getData('text/plain') || event.clipboardData.getData('text/uri-list').split('\n').filter(line => !line.startsWith('#')).join('\n')
        if (files.length) {
          event.preventDefault(); void appendFiles(files)
          if (text && event.currentTarget instanceof HTMLTextAreaElement && !pasteTextAsReference(text, event.currentTarget)) {
            const start = event.currentTarget.selectionStart; const end = event.currentTarget.selectionEnd
            update(current => ({ ...current, draft: current.draft.slice(0, start) + text + current.draft.slice(end) }))
          }
          return
        }
        if (text && event.currentTarget instanceof HTMLTextAreaElement && pasteTextAsReference(text, event.currentTarget)) { event.preventDefault(); return }
        if (!text && event.currentTarget instanceof HTMLTextAreaElement && readRecentClipboardWrite()) { event.preventDefault(); pasteRecent(event.currentTarget) }
      }}
      onPasteShortcutFallback={textarea => { const sequence = pasteSequence.current; setTimeout(() => { if (pasteSequence.current === sequence && textarea.isConnected) pasteRecent(textarea) }, 0) }}
      onAttachmentFiles={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void appendFiles(files) }}
      onChooseAttachmentFile={() => attachmentInputRef.current?.click()}
      onActivateComposerMode={mode => update(current => ({ ...current, mode }))}
      onClearComposerMode={() => update(current => ({ ...current, mode: 'default' }))}
      onRespondToPermission={(id, option, cancelled) => { void perform(respondToAcpPermission(agent.id, id, option, cancelled, AbortSignal.timeout(15000))) }}
      onRespondToElicitation={(id, action, content) => respondToAcpElicitation(agent.id, id, action, content)}
      copy={copy} />
  </>
}
