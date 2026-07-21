import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type CSSProperties, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import { ArrowUpGlyph, CloseGlyph, PlusGlyph, ReplyGlyph } from '@/components/IconGlyphs'
import type { AcpPendingElicitation, AcpPendingPermission, AgentContextWindowUsage } from '@/types/agent'
import { ComposerAttachments, type ComposerAttachmentView } from '../ComposerAttachments'
import type { ComposerHistoryDirection, ComposerHistoryNavigationInput } from '../composer-history'
import {
  composerDraftForSubmit,
  isComposerImeCompositionEvent,
  shouldSuppressComposerEnterAfterComposition,
  shouldSubmitComposerEnter,
} from '../composer-keyboard'
import { findComposerCommandTrigger } from '../composer-slash-commands'
import type { CodeCopy } from '../copy'
import { useMobileComposerHeight } from '../useMobileComposerHeight'
import { useComposerTextareaAutoSize } from '../useComposerTextareaAutoSize'
import type { ComposerMode } from '../types'
import { AcpPermissionCard } from './AcpPermissionCard'
import { AcpElicitationCard } from './AcpElicitationCard'
import { AcpAuthenticationCard } from './AcpAuthenticationCard'
import {
  AcpModeControl,
  AcpModelControl,
  type AcpComposerMenu,
} from './AcpSessionControls'
import { acpContextUsage } from './acp-usage'
import { useAcpSession } from './useAcpSession'

const COMPOSER_MIC_REGULAR_PATH = 'M8 10.9995C9.654 10.9995 11 9.65351 11 7.99951V3.99951C11 2.34551 9.654 0.999512 8 0.999512C6.346 0.999512 5 2.34551 5 3.99951V7.99951C5 9.65351 6.346 10.9995 8 10.9995ZM6 3.99951C6 2.89651 6.897 1.99951 8 1.99951C9.103 1.99951 10 2.89651 10 3.99951V7.99951C10 9.10251 9.103 9.99951 8 9.99951C6.897 9.99951 6 9.10251 6 7.99951V3.99951ZM13 7.49951V7.99951C13 10.5855 11.02 12.6935 8.5 12.9485V14.4995C8.5 14.7755 8.276 14.9995 8 14.9995C7.724 14.9995 7.5 14.7755 7.5 14.4995V12.9485C4.98 12.6935 3 10.5845 3 7.99951V7.49951C3 7.22351 3.224 6.99951 3.5 6.99951C3.776 6.99951 4 7.22351 4 7.49951V7.99951C4 10.2055 5.794 11.9995 8 11.9995C10.206 11.9995 12 10.2055 12 7.99951V7.49951C12 7.22351 12.224 6.99951 12.5 6.99951C12.776 6.99951 13 7.22351 13 7.49951Z'
const COMPOSER_MIC_FILLED_PATH = 'M8 10.9995C9.654 10.9995 11 9.65351 11 7.99951V3.99951C11 2.34551 9.654 0.999512 8 0.999512C6.346 0.999512 5 2.34551 5 3.99951V7.99951C5 9.65351 6.346 10.9995 8 10.9995ZM13 7.49951V7.99951C13 10.5855 11.02 12.6935 8.5 12.9485V14.4995C8.5 14.7755 8.276 14.9995 8 14.9995C7.724 14.9995 7.5 14.7755 7.5 14.4995V12.9485C4.98 12.6935 3 10.5845 3 7.99951V7.49951C3 7.22351 3.224 6.99951 3.5 6.99951C3.776 6.99951 4 7.22351 4 7.49951V7.99951C4 10.2055 5.794 11.9995 8 11.9995C10.206 11.9995 12 10.2055 12 7.99951V7.49951C12 7.22351 12.224 6.99951 12.5 6.99951C12.776 6.99951 13 7.22351 13 7.49951Z'
function ComposerMicIcon({ listening }: { listening: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d={listening ? COMPOSER_MIC_FILLED_PATH : COMPOSER_MIC_REGULAR_PATH} />
    </svg>
  )
}

function formatContextTokens(value: number) {
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(Math.round(value))
}

function findAcpCommandTrigger(draft: string, selectionStart: number) {
  const trigger = findComposerCommandTrigger(draft, selectionStart)
  if (trigger) return trigger
  const cursor = Math.max(0, Math.min(selectionStart, draft.length))
  const lineStart = draft.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1
  const lineBeforeCursor = draft.slice(lineStart, cursor)
  const skillCommand = lineBeforeCursor.match(/^(\s*)\/(\$[A-Za-z0-9._:-]*)$/)
  if (!skillCommand) return null
  return {
    start: lineStart + (skillCommand[1]?.length ?? 0),
    end: cursor,
    query: skillCommand[2] ?? '',
    trigger: '/' as const,
  }
}

export interface AcpComposerProps {
  active: boolean
  agentId: string
  runtimeState: string
  sessionUpdatedAt?: string
  runtimeError: string
  draft: string
  attachments: ComposerAttachmentView[]
  composerMode: ComposerMode
  contextWindow: AgentContextWindowUsage | null
  pendingFollowUp: { messages: Array<{ id: string; text: string; createdAt: number; attachments?: Array<{ name: string }> }>; createdAt: number } | null
  submitAction: 'send' | 'interrupt' | 'disabled'
  textareaRef: RefObject<HTMLTextAreaElement | null>
  attachmentInputRef: RefObject<HTMLInputElement | null>
  permissions: AcpPendingPermission[]
  elicitations: AcpPendingElicitation[]
  activeElicitations: AcpPendingElicitation[]
  speechSupported: boolean
  speechListening: boolean
  onDraftChange: (value: string) => void
  onNavigateHistory: (direction: ComposerHistoryDirection, input: ComposerHistoryNavigationInput) => string | null
  onRemoveAttachment: (id: string) => void
  onSubmit: (draft?: string) => void
  onInterrupt: () => void
  onDiscardPendingFollowUp: (messageId: string) => void
  onToggleSpeechInput: () => void
  onPasteAttachment: (event: ClipboardEvent<HTMLElement>) => void
  onAttachmentFiles: (event: ChangeEvent<HTMLInputElement>) => void
  onChooseAttachmentFile: () => void
  onActivateComposerMode: (mode: Exclude<ComposerMode, 'default'>) => void
  onClearComposerMode: () => void
  onRespondToPermission: (requestId: string, optionId?: string, cancelled?: boolean) => void
  onRespondToElicitation: (requestId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, string | number | boolean | string[]>) => void
  copy: CodeCopy
}

export function AcpComposer({
  active,
  agentId,
  runtimeState,
  sessionUpdatedAt,
  runtimeError,
  draft,
  attachments,
  composerMode,
  contextWindow,
  pendingFollowUp,
  submitAction,
  textareaRef,
  attachmentInputRef,
  permissions,
  elicitations,
  activeElicitations,
  speechSupported,
  speechListening,
  onDraftChange,
  onNavigateHistory,
  onRemoveAttachment,
  onSubmit,
  onInterrupt,
  onDiscardPendingFollowUp,
  onToggleSpeechInput,
  onPasteAttachment,
  onAttachmentFiles,
  onChooseAttachmentFile,
  onActivateComposerMode,
  onClearComposerMode,
  onRespondToPermission,
  onRespondToElicitation,
  copy,
}: AcpComposerProps) {
  const compositionActiveRef = useRef(false)
  const lastCompositionEndAtRef = useRef(0)
  const latestDraftRef = useRef(draft)
  const composerRef = useRef<HTMLElement | null>(null)
  const [focused, setFocused] = useState(false)
  const [selectionStart, setSelectionStart] = useState(draft.length)
  const [activeCommandIndex, setActiveCommandIndex] = useState(0)
  const [openMenu, setOpenMenu] = useState<AcpComposerMenu>(null)
  const [modelPane, setModelPane] = useState<'model' | 'speed' | null>(null)
  const { session, error: sessionError, updatingId, authenticatingId, loggingOut, setMode, setConfigOption, setConfigOptions, authenticate, logout } = useAcpSession(
    agentId,
    active,
    `${runtimeState}:${sessionUpdatedAt || ''}`,
  )
  useMobileComposerHeight(composerRef)
  useComposerTextareaAutoSize(textareaRef, draft)
  latestDraftRef.current = draft
  const interrupting = submitAction === 'interrupt'
  const disabled = submitAction === 'disabled'

  const commandTrigger = useMemo(
    () => findAcpCommandTrigger(draft, selectionStart),
    [draft, selectionStart]
  )
  const filteredCommands = useMemo(() => {
    if (!commandTrigger) return []
    const query = commandTrigger.query.toLowerCase()
    return (session?.availableCommands || [])
      .filter(command => {
        const name = command.name.toLowerCase()
        if (commandTrigger.trigger === '$' && !name.startsWith('$')) return false
        const searchableName = commandTrigger.trigger === '$' ? name.slice(1) : name
        return searchableName.startsWith(query) || command.description.toLowerCase().includes(query)
      })
      .slice(0, 12)
  }, [commandTrigger, session?.availableCommands])
  const showCommands = active && focused && filteredCommands.length > 0
  const selectedCommand = filteredCommands[activeCommandIndex] || filteredCommands[0] || null

  useEffect(() => setActiveCommandIndex(0), [commandTrigger?.query, commandTrigger?.trigger, filteredCommands.length])

  useEffect(() => {
    if (!openMenu) return undefined
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && composerRef.current?.contains(event.target)) return
      setOpenMenu(null)
      setModelPane(null)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [openMenu])

  const insertCommand = (name: string) => {
    if (!commandTrigger) return
    const insertText = `/${name} `
    const nextDraft = `${draft.slice(0, commandTrigger.start)}${insertText}${draft.slice(commandTrigger.end)}`
    const nextCursor = commandTrigger.start + insertText.length
    setOpenMenu(null)
    latestDraftRef.current = nextDraft
    onDraftChange(nextDraft)
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true })
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor)
      setSelectionStart(nextCursor)
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposerImeCompositionEvent(event, compositionActiveRef.current)) return
    if (shouldSuppressComposerEnterAfterComposition(event, lastCompositionEndAtRef.current)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (showCommands && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveCommandIndex(index => (index + direction + filteredCommands.length) % filteredCommands.length)
      return
    }
    if (showCommands && event.key === 'Home') {
      event.preventDefault()
      setActiveCommandIndex(0)
      return
    }
    if (showCommands && event.key === 'End') {
      event.preventDefault()
      setActiveCommandIndex(filteredCommands.length - 1)
      return
    }
    if (showCommands && (event.key === 'Enter' || event.key === 'Tab') && selectedCommand) {
      event.preventDefault()
      event.stopPropagation()
      insertCommand(selectedCommand.name)
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const direction = event.key === 'ArrowUp' ? 'previous' : 'next'
      const nextHistoryValue = onNavigateHistory(direction, {
        direction,
        value: event.currentTarget.value,
        selectionStart: event.currentTarget.selectionStart,
        selectionEnd: event.currentTarget.selectionEnd,
      })
      if (nextHistoryValue !== null) {
        event.preventDefault()
        event.stopPropagation()
        window.requestAnimationFrame(() => {
          const textarea = textareaRef.current
          if (!textarea) return
          const nextCursor = nextHistoryValue.length
          textarea.setSelectionRange(nextCursor, nextCursor)
        })
        return
      }
    }
    if (!shouldSubmitComposerEnter(event, compositionActiveRef.current, lastCompositionEndAtRef.current)) return
    event.preventDefault()
    event.stopPropagation()
    onSubmit(composerDraftForSubmit(event.currentTarget.value, latestDraftRef.current))
  }

  const toggleMenu = (menu: Exclude<AcpComposerMenu, null>) => {
    setOpenMenu(current => current === menu ? null : menu)
    setModelPane(null)
  }
  const handleComposerClick = (event: MouseEvent<HTMLElement>) => {
    if (!active) return
    if (event.target instanceof Element && event.target.closest('.code-composer-menu, button, input, select, textarea, [role="menuitem"]')) return
    textareaRef.current?.focus({ preventScroll: true })
  }
  const acpUsage = acpContextUsage(session?.usage)
  const displayedContextWindow = acpUsage || contextWindow
  const contextUsageLevel = acpUsage?.level
    || (displayedContextWindow && displayedContextWindow.percentUsed >= 100
      ? 'critical'
      : displayedContextWindow && displayedContextWindow.percentUsed >= 85 ? 'warning' : 'normal')
  const contextWindowTitle = displayedContextWindow
    ? [
      `Context window: ${displayedContextWindow.percentUsed}% used (${displayedContextWindow.percentLeft}% left), ${formatContextTokens(displayedContextWindow.usedTokens)} / ${formatContextTokens(displayedContextWindow.limitTokens)} tokens used`,
      contextUsageLevel === 'critical' ? 'Context window is full' : contextUsageLevel === 'warning' ? 'Context window is nearly full' : '',
      acpUsage?.costLabel ? `Session cost: ${acpUsage.costLabel}` : '',
    ].filter(Boolean).join('. ')
    : ''
  const authenticationRequired = session?.errorKind === 'authentication'
    || /\b(?:auth(?:entication)?|login|sign[ -]?in|unauthorized|401)\b/i.test(runtimeError)
  const hasAcpRequest = active && Boolean(
    permissions.length
    || elicitations.length
    || activeElicitations.length
    || authenticationRequired
    || sessionError
  )
  const composerClasses = [
    'code-composer',
    'code-acp-composer',
    openMenu ? 'menu-open' : '',
    attachments.length > 0 ? 'has-attachments' : '',
    pendingFollowUp && active ? 'has-pending-followup' : '',
    hasAcpRequest ? 'has-acp-request' : '',
  ].filter(Boolean).join(' ')

  return (
    <footer
      ref={composerRef}
      className={composerClasses}
      data-testid="code-acp-composer"
      onClick={handleComposerClick}
    >
      {pendingFollowUp && active ? (
        <div className="code-pending-followup" data-testid="code-acp-pending-followup">
          {pendingFollowUp.messages.map(message => (
            <div className="code-pending-followup-row" data-testid="code-acp-pending-followup-row" key={message.id}>
              <span className="code-pending-followup-icon" aria-hidden="true"><ReplyGlyph /></span>
              <p>{message.text || message.attachments?.map(attachment => attachment.name).join(', ')}</p>
              <div className="code-pending-followup-actions">
                <button type="button" className="icon" data-testid="code-acp-pending-followup-discard" aria-label={copy.discardQueuedMessage} onClick={() => onDiscardPendingFollowUp(message.id)}>
                  <CloseGlyph />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {active ? permissions.map(permission => (
        <AcpPermissionCard key={permission.requestId} request={permission} onRespond={onRespondToPermission} copy={copy} />
      )) : null}
      {active ? elicitations.map(elicitation => (
        <AcpElicitationCard key={elicitation.requestId} request={elicitation} onRespond={onRespondToElicitation} />
      )) : null}
      {active ? activeElicitations.map(elicitation => (
        <AcpElicitationCard key={`active-${elicitation.elicitationId || elicitation.requestId}`} request={elicitation} onRespond={onRespondToElicitation} />
      )) : null}
      {active && authenticationRequired ? (
        <AcpAuthenticationCard
          agentId={agentId}
          methods={session?.authMethods || []}
          authTerminal={session?.authTerminal || null}
          agentName={session?.agentInfo?.title || session?.agentInfo?.name || ''}
          authenticatingId={authenticatingId}
          onAuthenticate={methodId => { void authenticate(methodId) }}
        />
      ) : null}
      {active && sessionError ? (
        <section className="code-acp-request code-acp-notice" data-testid="code-acp-error" role="alert">
          <header><strong>ACP</strong><span>{runtimeState || 'error'}</span></header>
          <p>{sessionError}</p>
        </section>
      ) : null}
      {showCommands ? (
        <div className="code-slash-menu code-composer-menu" data-testid="code-acp-command-menu" role="listbox" aria-label="ACP commands">
          <div className="code-slash-menu-header">{commandTrigger?.trigger === '$' ? 'Skills' : 'Agent commands'}</div>
          {filteredCommands.map((command, index) => (
            <button
              key={command.name}
              type="button"
              className={`code-slash-command ${index === activeCommandIndex ? 'active' : ''}`}
              data-testid={`code-acp-command-${command.name}`}
              role="option"
              aria-selected={index === activeCommandIndex}
              onMouseDown={event => event.preventDefault()}
              onMouseMove={() => setActiveCommandIndex(index)}
              onClick={() => insertCommand(command.name)}
            >
              <span className="code-slash-command-icon" aria-hidden="true">/</span>
              <span className="code-slash-command-copy">
                <span className="code-slash-command-title"><code>/{command.name}</code></span>
                <small>{command.description}{command.input?.hint ? ` · ${command.input.hint}` : ''}</small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <textarea
          data-testid="code-acp-composer-input"
          ref={textareaRef}
          rows={1}
          name="farming-acp-chat-message"
          inputMode="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          value={draft}
          placeholder={active
            ? (composerMode === 'goal' ? copy.describeAgentGoal : composerMode === 'plan' ? copy.describePlanFirst : copy.askFollowUpChanges)
            : copy.openAgentTerminalFirst}
          disabled={!active}
          onFocus={event => {
            setFocused(true)
            setSelectionStart(event.currentTarget.selectionStart)
            setOpenMenu(null)
            setModelPane(null)
          }}
          onBlur={() => setFocused(false)}
          onClick={event => setSelectionStart(event.currentTarget.selectionStart)}
          onKeyUp={event => setSelectionStart(event.currentTarget.selectionStart)}
          onSelect={event => setSelectionStart(event.currentTarget.selectionStart)}
          onChange={event => {
            latestDraftRef.current = event.currentTarget.value
            setSelectionStart(event.currentTarget.selectionStart)
            onDraftChange(event.currentTarget.value)
          }}
          onPaste={onPasteAttachment}
          onCompositionStart={() => { compositionActiveRef.current = true }}
          onCompositionEnd={event => {
            compositionActiveRef.current = false
            lastCompositionEndAtRef.current = Date.now()
            latestDraftRef.current = event.currentTarget.value
            onDraftChange(event.currentTarget.value)
          }}
          onKeyDown={handleKeyDown}
          data-lpignore="true"
          data-1p-ignore="true"
          data-bwignore="true"
          data-form-type="other"
      />
      <ComposerAttachments attachments={attachments} onRemove={onRemoveAttachment} />
      <input
        ref={attachmentInputRef}
        className="code-composer-file-input"
        data-testid="code-acp-composer-file-input"
        type="file"
        multiple
        onChange={onAttachmentFiles}
      />
      <div className="code-composer-toolbar" data-testid="code-acp-composer-toolbar">
        <div className="code-composer-left-tools" data-testid="code-acp-composer-left-tools">
          <div className="code-composer-menu-anchor">
            <button
              type="button"
              className="code-composer-add"
              data-testid="code-acp-composer-add"
              aria-label={copy.addContext}
              aria-haspopup="menu"
              aria-expanded={openMenu === 'commands'}
              disabled={!active}
              onClick={() => toggleMenu('commands')}
            >
              <PlusGlyph />
            </button>
            {openMenu === 'commands' ? (
              <div className="code-plus-menu code-composer-menu" role="menu" data-testid="code-acp-plus-menu">
                <button
                  type="button"
                  role="menuitem"
                  data-testid="code-acp-composer-attach-file"
                  onClick={() => {
                    setOpenMenu(null)
                    onChooseAttachmentFile()
                  }}
                >
                  <span>{copy.attachFile}</span>
                  <small>{copy.fileContext}</small>
                </button>
                {session?.capabilities?.auth?.logout != null ? (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="code-acp-logout"
                    disabled={loggingOut}
                    onClick={() => {
                      setOpenMenu(null)
                      void logout()
                    }}
                  >
                    <span>{loggingOut ? copy.acpSigningOut : copy.acpSignOut}</span>
                    <small>{copy.acpSignOutDescription}</small>
                  </button>
                ) : null}
                <button type="button" role="menuitem" data-testid="code-acp-composer-goal-mode" onClick={() => { setOpenMenu(null); onActivateComposerMode('goal') }}>
                  <span>{copy.goalMode}</span>
                  <small>{copy.setObjective}</small>
                </button>
                <button type="button" role="menuitem" data-testid="code-acp-composer-plan-mode" onClick={() => { setOpenMenu(null); onActivateComposerMode('plan') }}>
                  <span>{copy.planMode}</span>
                  <small>{copy.planFirst}</small>
                </button>
              </div>
            ) : null}
          </div>
          {composerMode !== 'default' ? (
            <button type="button" className="code-composer-mode-chip" data-testid="code-acp-composer-mode-chip" aria-label={copy.clearComposerMode} onClick={onClearComposerMode}>
              <span>{composerMode === 'goal' ? copy.goalMode : copy.planMode}</span>
              <span aria-hidden="true"><CloseGlyph /></span>
            </button>
          ) : null}
          {session ? (
            <AcpModeControl
              session={session}
              updatingId={updatingId}
              copy={copy}
              open={openMenu === 'mode'}
              onToggle={() => toggleMenu('mode')}
              onSetMode={modeId => {
                setOpenMenu(null)
                void setMode(modeId)
              }}
              onSetConfigOption={(configId, value) => {
                setOpenMenu(null)
                void setConfigOption(configId, value)
              }}
            />
          ) : null}
        </div>
        <div className="code-composer-right-tools" data-testid="code-acp-composer-right-tools">
          {displayedContextWindow ? (
            <div className="code-composer-context-window" data-testid="code-acp-context-window" data-level={contextUsageLevel} tabIndex={0} role="img" aria-label={contextWindowTitle}>
              <span className="code-context-window-ring" aria-hidden="true" style={{ '--context-percent': displayedContextWindow.percentUsed } as CSSProperties} />
              <div className="code-context-window-popover" role="tooltip">
                <span>Context window:</span>
                <strong>{displayedContextWindow.percentUsed}% used ({displayedContextWindow.percentLeft}% left)</strong>
                <strong>{formatContextTokens(displayedContextWindow.usedTokens)} / {formatContextTokens(displayedContextWindow.limitTokens)} tokens used</strong>
                {contextUsageLevel === 'critical' ? <strong className="warning">Context window is full</strong> : null}
                {contextUsageLevel === 'warning' ? <strong className="warning">Context window is nearly full</strong> : null}
                {acpUsage?.costLabel ? <strong>{acpUsage.costLabel}</strong> : null}
              </div>
            </div>
          ) : null}
          {session ? (
            <AcpModelControl
              session={session}
              updatingId={updatingId}
              copy={copy}
              open={openMenu === 'model'}
              pane={modelPane}
              onToggle={() => toggleMenu('model')}
              onSetPane={setModelPane}
              onSetConfigOption={(configId, value) => {
                setOpenMenu(null)
                setModelPane(null)
                void setConfigOption(configId, value)
              }}
              onSetProfile={(modelId, modelValue, reasoningId, reasoningValue) => {
                void setConfigOptions([
                  { configId: modelId, value: modelValue },
                  { configId: reasoningId, value: reasoningValue },
                ])
              }}
              onSetFast={(configId, value) => {
                void setConfigOption(configId, value)
              }}
            />
          ) : null}
          {speechSupported ? (
            <button
              type="button"
              className={`code-composer-mic ${speechListening ? 'listening' : ''}`}
              data-testid="code-acp-composer-mic"
              aria-label={speechListening ? copy.stopDictation : copy.startDictation}
              aria-pressed={speechListening}
              onClick={onToggleSpeechInput}
              disabled={!active}
              title={speechListening ? copy.stopDictation : copy.startDictation}
            >
              <ComposerMicIcon listening={speechListening} />
            </button>
          ) : null}
          <button
            type="button"
            className={`code-composer-send ${interrupting ? 'interrupt' : ''}`}
            data-testid="code-acp-composer-send"
            data-action={submitAction}
            aria-label={interrupting ? copy.interruptAgent : copy.sendMessage}
            onClick={interrupting ? onInterrupt : () => onSubmit(latestDraftRef.current)}
            disabled={disabled}
          >
            {interrupting ? <span className="code-composer-stop-icon" aria-hidden="true" /> : <ArrowUpGlyph />}
          </button>
        </div>
      </div>
    </footer>
  )
}
