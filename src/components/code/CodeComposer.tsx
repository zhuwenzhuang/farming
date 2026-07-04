import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChangeEvent,
  ClipboardEvent,
  FocusEvent,
  KeyboardEvent,
  RefObject,
  CSSProperties,
} from 'react'
import type { AgentContextWindowUsage } from '@/types/agent'
import { codexModelDisplayName } from './model'
import type { AgentComposerCapabilities, SlashCommandOption } from './capabilities'
import {
  isComposerImeCompositionEvent,
  shouldSubmitComposerEnter,
  shouldSuppressComposerEnterAfterComposition,
} from './composer-keyboard'
import type { CodeCopy } from './copy'
import type { PermissionModeColor, PermissionModeOption } from './composer-profile'
import type {
  CodexModelOption,
  CodeModelPickerPane,
  CodexReasoningOption,
  CodexServiceTierOption,
  ComposerMode,
} from './types'
import type {
  ComposerHistoryDirection,
  ComposerHistoryNavigationInput,
} from './composer-history'

interface PendingFollowUpMessage {
  id: string
  text: string
  createdAt: number
}

function composerModeLabel(copy: CodeCopy, mode: ComposerMode) {
  if (mode === 'goal') return copy.goalMode
  if (mode === 'plan') return copy.planMode
  return copy.messageMode
}

function composerModePlaceholder(copy: CodeCopy, mode: ComposerMode) {
  if (mode === 'goal') return copy.describeAgentGoal
  if (mode === 'plan') return copy.describePlanFirst
  return copy.askFollowUpChanges
}

function isNarrowComposerViewport() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 980px)').matches
}

function compactComposerModelLabel(label: string) {
  const compact = label.trim().replace(/^gpt[-\s]*/i, '')
  return compact || label
}

function compactComposerReasoningLabel(effort: string, label: string) {
  if (effort === 'xhigh' && label.trim().toLowerCase() === 'extra high') return 'XHigh'
  return label
}

function formatContextTokens(value: number) {
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(Math.round(value))
}

interface SlashTrigger {
  start: number
  end: number
  query: string
  trigger: '/' | '$'
}

interface ComposerAttachmentView {
  id: string
  kind: 'image'
  name: string
  status: 'uploading' | 'ready' | 'error'
  previewUrl?: string
  error?: string
}

function findCommandTrigger(draft: string, selectionStart: number): SlashTrigger | null {
  const cursor = Math.max(0, Math.min(selectionStart, draft.length))
  const lineStart = draft.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1
  const lineBeforeCursor = draft.slice(lineStart, cursor)

  const slashMatch = lineBeforeCursor.match(/^(\s*)\/([A-Za-z0-9._:-]*)$/)
  if (slashMatch) {
    return {
      start: lineStart + (slashMatch[1]?.length ?? 0),
      end: cursor,
      query: slashMatch[2] ?? '',
      trigger: '/',
    }
  }

  const mentionMatch = lineBeforeCursor.match(/(^|\s)\$([A-Za-z0-9._:-]*)$/)
  if (!mentionMatch) return null

  return {
    start: lineStart + (mentionMatch.index ?? 0) + (mentionMatch[1]?.length ?? 0),
    end: cursor,
    query: mentionMatch[2] ?? '',
    trigger: '$',
  }
}

function slashCommandMatches(command: SlashCommandOption, query: string, trigger: '/' | '$') {
  const normalizedQuery = query.trim().toLowerCase()
  if (!command.command.startsWith(trigger)) return false
  if (!normalizedQuery) return true
  return (
    command.command.slice(1).toLowerCase().startsWith(normalizedQuery)
    || command.label.toLowerCase().includes(normalizedQuery)
  )
}

function slashCommandRank(command: SlashCommandOption, query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return 0
  return command.command.slice(1).toLowerCase().startsWith(normalizedQuery) ? 0 : 1
}

function slashCommandTestId(command: string) {
  const suffix = command.replace(/^[/$]/, '').replace(/[^A-Za-z0-9_-]+/g, '-')
  return `code-slash-command-${suffix || 'root'}`
}

interface CodeComposerProps {
  active: boolean
  capabilities: AgentComposerCapabilities
  slashCommands: SlashCommandOption[]
  draft: string
  attachments: ComposerAttachmentView[]
  composerMode: ComposerMode
  plusMenuOpen: boolean
  approvalMenuOpen: boolean
  modelMenuOpen: boolean
  modelPickerPane: CodeModelPickerPane
  agentModelPreset: string
  agentModel: string
  agentReasoningEffort: string
  agentServiceTier: string
  agentModelOptions: CodexModelOption[]
  currentPermissionMode: string
  currentPermissionLabel: string
  currentPermissionColor: PermissionModeColor
  currentModelLabel: string
  currentReasoningLabel: string
  currentSpeedLabel: string
  currentReasoningOptions: CodexReasoningOption[]
  currentServiceTierOptions: CodexServiceTierOption[]
  permissionModeOptions: PermissionModeOption[]
  contextWindow: AgentContextWindowUsage | null
  pendingFollowUp: { messages: PendingFollowUpMessage[]; createdAt: number } | null
  submitAction: 'send' | 'interrupt' | 'disabled'
  speechSupported: boolean
  speechListening: boolean
  textareaRef: RefObject<HTMLTextAreaElement | null>
  attachmentInputRef: RefObject<HTMLInputElement | null>
  plusMenuRef: RefObject<HTMLDivElement | null>
  approvalMenuRef: RefObject<HTMLDivElement | null>
  modelMenuRef: RefObject<HTMLDivElement | null>
  onDraftChange: (value: string) => void
  onNavigateHistory: (direction: ComposerHistoryDirection, input: ComposerHistoryNavigationInput) => string | null
  onRemoveAttachment: (id: string) => void
  onSubmit: () => void
  onInterrupt: () => void
  onSteerPendingFollowUp: (messageId: string) => void
  onDiscardPendingFollowUp: (messageId: string) => void
  onPasteAttachment: (event: ClipboardEvent<HTMLTextAreaElement>) => void
  onAttachmentFiles: (event: ChangeEvent<HTMLInputElement>) => void
  onChooseAttachmentFile: () => void
  onActivateComposerMode: (mode: Exclude<ComposerMode, 'default'>) => void
  onClearComposerMode: () => void
  onTogglePlusMenu: () => void
  onToggleApprovalMenu: () => void
  onToggleModelMenu: () => void
  onSetModelPickerPane: (pane: CodeModelPickerPane) => void
  onComposerMenuKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  onComposerMenuBlur: (event: FocusEvent<HTMLDivElement>) => void
  onUpdatePermissionMode: (mode: string) => void
  onUpdateModel: (model: string) => void
  onUpdateReasoningEffort: (effort: string) => void
  onUpdateServiceTier: (tier: string) => void
  onToggleSpeechInput: () => void
  copy: CodeCopy
}

export function CodeComposer({
  active,
  capabilities,
  slashCommands,
  draft,
  attachments,
  composerMode,
  plusMenuOpen,
  approvalMenuOpen,
  modelMenuOpen,
  modelPickerPane,
  agentModelPreset,
  agentModel,
  agentReasoningEffort,
  agentServiceTier,
  agentModelOptions,
  currentPermissionMode,
  currentPermissionLabel,
  currentPermissionColor,
  currentModelLabel,
  currentReasoningLabel,
  currentSpeedLabel,
  currentReasoningOptions,
  currentServiceTierOptions,
  permissionModeOptions,
  contextWindow,
  pendingFollowUp,
  submitAction,
  speechSupported,
  speechListening,
  textareaRef,
  attachmentInputRef,
  plusMenuRef,
  approvalMenuRef,
  modelMenuRef,
  onDraftChange,
  onNavigateHistory,
  onRemoveAttachment,
  onSubmit,
  onInterrupt,
  onSteerPendingFollowUp,
  onDiscardPendingFollowUp,
  onPasteAttachment,
  onAttachmentFiles,
  onChooseAttachmentFile,
  onActivateComposerMode,
  onClearComposerMode,
  onTogglePlusMenu,
  onToggleApprovalMenu,
  onToggleModelMenu,
  onSetModelPickerPane,
  onComposerMenuKeyDown,
  onComposerMenuBlur,
  onUpdatePermissionMode,
  onUpdateModel,
  onUpdateReasoningEffort,
  onUpdateServiceTier,
  onToggleSpeechInput,
  copy,
}: CodeComposerProps) {
  const showPlusMenu = active && capabilities.plusMenu
  const showPermissionMode = active && capabilities.permissionMode
  const showModelPicker = active && capabilities.modelPicker
  const showServiceTierPicker = capabilities.serviceTier && currentServiceTierOptions.length > 0
  const [narrowComposerViewport, setNarrowComposerViewport] = useState(isNarrowComposerViewport)
  const showSpeechInput = active && capabilities.speechInput && !narrowComposerViewport
  const [textareaFocused, setTextareaFocused] = useState(false)
  const [textareaSelectionStart, setTextareaSelectionStart] = useState(draft.length)
  const [dismissedSlashTriggerId, setDismissedSlashTriggerId] = useState<string | null>(null)
  const [activeSlashIndex, setActiveSlashIndex] = useState(0)
  const slashCommandRefs = useRef(new Map<string, HTMLButtonElement>())
  const compositionActiveRef = useRef(false)
  const lastCompositionEndAtRef = useRef(0)

  const baseComposerMenuOpen = plusMenuOpen || approvalMenuOpen || modelMenuOpen
  const slashTrigger = useMemo(
    () => findCommandTrigger(draft, textareaSelectionStart),
    [draft, textareaSelectionStart]
  )
  const slashTriggerId = slashTrigger
    ? `${slashTrigger.trigger}:${slashTrigger.start}:${slashTrigger.end}:${slashTrigger.query}`
    : ''
  const filteredSlashCommands = useMemo(
    () => slashTrigger
      ? slashCommands
        .filter(command => slashCommandMatches(command, slashTrigger.query, slashTrigger.trigger))
        .sort((a, b) => slashCommandRank(a, slashTrigger.query) - slashCommandRank(b, slashTrigger.query))
      : [],
    [slashCommands, slashTrigger]
  )
  const showSlashMenu = active
    && textareaFocused
    && !baseComposerMenuOpen
    && Boolean(slashTrigger)
    && slashTriggerId !== dismissedSlashTriggerId
    && filteredSlashCommands.length > 0
  const composerMenuOpen = baseComposerMenuOpen || showSlashMenu
  const selectedSlashCommand = filteredSlashCommands[activeSlashIndex] ?? filteredSlashCommands[0] ?? null
  const displayedPermissionLabel = copy.permissionModeLabel(currentPermissionMode, currentPermissionLabel)
  const displayedReasoningLabel = copy.reasoningOptionLabel(agentReasoningEffort, currentReasoningLabel)
  const displayedSpeedLabel = copy.serviceTierLabel(agentServiceTier, currentSpeedLabel)
  const compactModelLabel = compactComposerModelLabel(currentModelLabel)
  const compactReasoningLabel = compactComposerReasoningLabel(agentReasoningEffort, displayedReasoningLabel)
  const contextWindowTitle = contextWindow
    ? `Context window: ${contextWindow.percentUsed}% used (${contextWindow.percentLeft}% left), ${formatContextTokens(contextWindow.usedTokens)} / ${formatContextTokens(contextWindow.limitTokens)} tokens used`
    : ''
  const submitDisabled = !active || submitAction === 'disabled'
  const submitIsInterrupt = active && submitAction === 'interrupt'
  const commandMenuTitle = slashTrigger?.trigger === '$' ? 'Skills' : 'Commands'

  useEffect(() => {
    setActiveSlashIndex(0)
  }, [slashTrigger?.query, filteredSlashCommands.length])

  useEffect(() => {
    if (!slashTrigger) {
      setDismissedSlashTriggerId(null)
    }
  }, [slashTrigger])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const query = window.matchMedia('(max-width: 980px)')
    const updateNarrowViewport = () => setNarrowComposerViewport(query.matches)
    updateNarrowViewport()
    query.addEventListener('change', updateNarrowViewport)
    return () => query.removeEventListener('change', updateNarrowViewport)
  }, [])

  useEffect(() => {
    if (active) return
    setTextareaFocused(false)
    setDismissedSlashTriggerId(null)
  }, [active])

  useEffect(() => {
    if (!showSlashMenu || !selectedSlashCommand) return
    const selectedButton = slashCommandRefs.current.get(selectedSlashCommand.command)
    selectedButton?.scrollIntoView({ block: 'nearest' })
  }, [showSlashMenu, selectedSlashCommand])

  function updateSelectionFromTextarea(textarea: HTMLTextAreaElement | null = textareaRef.current) {
    if (!textarea) return
    setTextareaSelectionStart(textarea.selectionStart ?? draft.length)
  }

  function insertSlashCommand(command: SlashCommandOption) {
    if (!slashTrigger) return

    const insertText = `${command.command} `
    const nextDraft = `${draft.slice(0, slashTrigger.start)}${insertText}${draft.slice(slashTrigger.end)}`
    const nextCursor = slashTrigger.start + insertText.length
    onDraftChange(nextDraft)
    setTextareaSelectionStart(nextCursor)
    setDismissedSlashTriggerId(null)
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus({ preventScroll: true })
      textarea.setSelectionRange(nextCursor, nextCursor)
      updateSelectionFromTextarea(textarea)
    })
  }

  return (
    <footer className={`code-composer ${composerMenuOpen ? 'menu-open' : ''}`} data-testid="code-composer">
      {pendingFollowUp && active && (
        <div className="code-pending-followup" data-testid="code-pending-followup">
          {pendingFollowUp.messages.map(message => (
            <div className="code-pending-followup-row" data-testid="code-pending-followup-row" key={message.id}>
              <span className="code-pending-followup-icon" aria-hidden="true">↳</span>
              <p>{message.text}</p>
              <div className="code-pending-followup-actions">
                <button
                  type="button"
                  data-testid="code-pending-followup-steer"
                  onClick={() => onSteerPendingFollowUp(message.id)}
                >
                  ↪ {copy.steerQueuedMessage}
                </button>
                <button
                  type="button"
                  className="icon"
                  data-testid="code-pending-followup-discard"
                  aria-label={copy.discardQueuedMessage}
                  onClick={() => onDiscardPendingFollowUp(message.id)}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showSlashMenu && (
        <div
          className="code-slash-menu code-composer-menu"
          data-testid="code-slash-menu"
          role="listbox"
          aria-label={commandMenuTitle}
        >
          <div className="code-slash-menu-header">{commandMenuTitle}</div>
          {filteredSlashCommands.map((command, index) => (
            <button
              key={command.command}
              type="button"
              className={`code-slash-command ${index === activeSlashIndex ? 'active' : ''}`}
              data-testid={slashCommandTestId(command.command)}
              role="option"
              aria-selected={index === activeSlashIndex}
              ref={element => {
                if (element) {
                  slashCommandRefs.current.set(command.command, element)
                } else {
                  slashCommandRefs.current.delete(command.command)
                }
              }}
              onMouseMove={() => setActiveSlashIndex(index)}
              onMouseDown={event => event.preventDefault()}
              onClick={() => insertSlashCommand(command)}
            >
              <span className="code-slash-command-icon" aria-hidden="true">{slashTrigger?.trigger ?? '/'}</span>
              <span className="code-slash-command-copy">
                <span className="code-slash-command-title">
                  <code>{command.command}</code>
                  <strong>{command.label}</strong>
                </span>
                <small>{command.description}</small>
              </span>
              {command.scope && <span className="code-slash-command-source">{command.scope}</span>}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={draft}
        onFocus={event => {
          setTextareaFocused(true)
          updateSelectionFromTextarea(event.currentTarget)
        }}
        onBlur={() => setTextareaFocused(false)}
        onClick={event => updateSelectionFromTextarea(event.currentTarget)}
        onKeyUp={event => updateSelectionFromTextarea(event.currentTarget)}
        onSelect={event => updateSelectionFromTextarea(event.currentTarget)}
        onCompositionStart={() => {
          compositionActiveRef.current = true
        }}
        onCompositionEnd={event => {
          compositionActiveRef.current = false
          lastCompositionEndAtRef.current = Date.now()
          updateSelectionFromTextarea(event.currentTarget)
        }}
        onChange={event => {
          onDraftChange(event.target.value)
          setDismissedSlashTriggerId(null)
          updateSelectionFromTextarea(event.currentTarget)
        }}
        onPaste={onPasteAttachment}
        onKeyDown={event => {
          const compositionActive = compositionActiveRef.current
          if (isComposerImeCompositionEvent(event, compositionActive)) return
          if (shouldSuppressComposerEnterAfterComposition(event, lastCompositionEndAtRef.current)) {
            event.preventDefault()
            event.stopPropagation()
            return
          }

          if (showSlashMenu) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              event.stopPropagation()
              const direction = event.key === 'ArrowDown' ? 1 : -1
              setActiveSlashIndex(index => (index + direction + filteredSlashCommands.length) % filteredSlashCommands.length)
              return
            }

            if (event.key === 'Home') {
              event.preventDefault()
              event.stopPropagation()
              setActiveSlashIndex(0)
              return
            }

            if (event.key === 'End') {
              event.preventDefault()
              event.stopPropagation()
              setActiveSlashIndex(filteredSlashCommands.length - 1)
              return
            }

            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setDismissedSlashTriggerId(slashTriggerId)
              return
            }

            if ((event.key === 'Enter' || event.key === 'Tab') && selectedSlashCommand) {
              event.preventDefault()
              event.stopPropagation()
              insertSlashCommand(selectedSlashCommand)
              return
            }
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
                updateSelectionFromTextarea(textarea)
              })
              return
            }
          }

          if (!shouldSubmitComposerEnter(event, compositionActive, lastCompositionEndAtRef.current)) return
          event.preventDefault()
          event.stopPropagation()
          onSubmit()
        }}
        placeholder={active ? composerModePlaceholder(copy, composerMode) : copy.openAgentTerminalFirst}
        disabled={!active}
      />
      {attachments.length > 0 && (
        <div className="code-composer-attachments" data-testid="code-composer-attachments">
          {attachments.map(attachment => (
            <div
              key={attachment.id}
              className={`code-composer-attachment ${attachment.status}`}
              data-testid="code-composer-attachment"
            >
              {attachment.previewUrl ? (
                <img src={attachment.previewUrl} alt="" />
              ) : (
                <span className="code-composer-attachment-fallback" aria-hidden="true">□</span>
              )}
              <span className="code-composer-attachment-name">{attachment.name}</span>
              {attachment.status !== 'ready' && (
                <span className="code-composer-attachment-status">
                  {attachment.status === 'uploading' ? 'Uploading' : 'Failed'}
                </span>
              )}
              <button
                type="button"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => onRemoveAttachment(attachment.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <input
        ref={attachmentInputRef}
        className="code-composer-file-input"
        data-testid="code-composer-file-input"
        type="file"
        multiple
        onChange={onAttachmentFiles}
      />
      <div className="code-composer-toolbar" data-testid="code-composer-toolbar">
        <div className="code-composer-left-tools" data-testid="code-composer-left-tools">
          {showPlusMenu && (
            <div className="code-composer-menu-anchor">
            <button
              type="button"
              className="code-composer-add"
              data-testid="code-composer-add"
              aria-label={copy.addContext}
              aria-haspopup="menu"
              aria-expanded={plusMenuOpen}
              disabled={!active}
              onClick={onTogglePlusMenu}
            >
              +
            </button>
            {plusMenuOpen && (
              <div
                className="code-plus-menu code-composer-menu"
                role="menu"
                data-testid="code-composer-plus-menu"
                ref={plusMenuRef}
                onKeyDown={onComposerMenuKeyDown}
                onBlur={onComposerMenuBlur}
                onMouseDown={event => event.preventDefault()}
              >
                <button type="button" role="menuitem" data-testid="code-composer-attach-file" onClick={onChooseAttachmentFile}>
                  <span>{copy.attachFile}</span>
                  <small>{copy.fileContext}</small>
                </button>
                <button type="button" role="menuitem" data-testid="code-composer-goal-mode" onClick={() => onActivateComposerMode('goal')}>
                  <span>{copy.goalMode}</span>
                  <small>{copy.setObjective}</small>
                </button>
                <button type="button" role="menuitem" data-testid="code-composer-plan-mode" onClick={() => onActivateComposerMode('plan')}>
                  <span>{copy.planMode}</span>
                  <small>{copy.planFirst}</small>
                </button>
              </div>
            )}
            </div>
          )}
          {composerMode !== 'default' && (
            <button
              type="button"
              className="code-composer-mode-chip"
              data-testid="code-composer-mode-chip"
              aria-label={copy.clearComposerMode}
              onClick={onClearComposerMode}
            >
              <span>{composerModeLabel(copy, composerMode)}</span>
              <span aria-hidden="true">×</span>
            </button>
          )}
          {showPermissionMode && (
            <div className="code-composer-menu-anchor">
              <button
                type="button"
                className={`code-composer-approval ${currentPermissionColor}`}
                data-testid="code-composer-approval"
                aria-label={copy.agentPermissionMode}
                aria-haspopup="menu"
                aria-expanded={approvalMenuOpen}
                onClick={onToggleApprovalMenu}
              >
                <span className="code-tool-icon" aria-hidden="true">
                  <ApprovalIcon mode={currentPermissionMode} />
                </span>
                <span className="code-composer-approval-label">{displayedPermissionLabel}</span>
                <span className="code-chevron" aria-hidden="true">
                  <ChevronDownIcon />
                </span>
              </button>
              {approvalMenuOpen && (
                <div
                  className="code-approval-menu code-composer-menu"
                  role="menu"
                  data-testid="code-approval-menu"
                  ref={approvalMenuRef}
                  onKeyDown={onComposerMenuKeyDown}
                  onBlur={onComposerMenuBlur}
                  onMouseDown={event => event.preventDefault()}
                >
                  <div className="code-approval-menu-header">
                    <span>{copy.permissionsPrompt}</span>
                  </div>
                  {permissionModeOptions.map(option => (
                    <button
                      key={option.value}
                      type="button"
                      className={`code-approval-option ${option.value === currentPermissionMode ? 'selected' : ''}`}
                      role="menuitemradio"
                      aria-checked={option.value === currentPermissionMode}
                      onClick={() => onUpdatePermissionMode(option.value)}
                    >
                      <span className={`code-approval-option-icon ${option.color ?? 'muted'}`} aria-hidden="true">
                        <ApprovalIcon mode={option.value} />
                      </span>
                      <span className="code-approval-option-copy">
                        <span>{copy.permissionModeLabel(option.value, option.label)}</span>
                        <small>{copy.permissionModeDescription(option.value, option.description)}</small>
                      </span>
                      {option.value === currentPermissionMode && <span className="code-menu-check" aria-hidden="true">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="code-composer-right-tools" data-testid="code-composer-right-tools">
          {contextWindow && (
            <div
              className="code-composer-context-window"
              data-testid="code-composer-context-window"
              tabIndex={0}
              role="img"
              aria-label={contextWindowTitle}
            >
              <span
                className="code-context-window-ring"
                aria-hidden="true"
                style={{ '--context-percent': contextWindow.percentUsed } as CSSProperties}
              />
              <div className="code-context-window-popover" role="tooltip">
                <span>Context window:</span>
                <strong>{contextWindow.percentUsed}% used ({contextWindow.percentLeft}% left)</strong>
                <strong>{formatContextTokens(contextWindow.usedTokens)} / {formatContextTokens(contextWindow.limitTokens)} tokens used</strong>
              </div>
            </div>
          )}
          {showModelPicker && (
            <div className="code-composer-menu-anchor model-picker">
              <button
                type="button"
                className="code-composer-model-picker"
                data-testid="code-composer-model-picker"
                data-agent-model-preset={agentModelPreset}
                aria-label={copy.modelAndReasoning}
                aria-haspopup="menu"
                aria-expanded={modelMenuOpen}
                title={[currentModelLabel, displayedReasoningLabel, displayedSpeedLabel].filter(Boolean).join(' · ')}
                onClick={onToggleModelMenu}
              >
                <span className="code-composer-model-label desktop">{currentModelLabel}</span>
                <span className="code-composer-model-label mobile">{compactModelLabel}</span>
                <span className="code-composer-model-picker-muted desktop">{displayedReasoningLabel}</span>
                <span className="code-composer-model-picker-muted mobile">{compactReasoningLabel}</span>
                <span className="code-chevron" aria-hidden="true">
                  <ChevronDownIcon />
                </span>
              </button>
              {modelMenuOpen && (
                <div
                  className="code-model-picker-menu code-composer-menu"
                  role="menu"
                  data-testid="code-model-menu"
                  ref={modelMenuRef}
                  onKeyDown={onComposerMenuKeyDown}
                  onBlur={onComposerMenuBlur}
                  onMouseDown={event => event.preventDefault()}
                >
                  {currentReasoningOptions.length > 0 && (
                    <>
                      <div className="code-model-menu-header">{copy.reasoning}</div>
                      {currentReasoningOptions.map(option => (
                        <button
                          key={option.value}
                          type="button"
                          className={`code-model-option ${option.value === agentReasoningEffort ? 'selected' : ''}`}
                          role="menuitemradio"
                          aria-checked={option.value === agentReasoningEffort}
                          onClick={() => onUpdateReasoningEffort(option.value)}
                        >
                          <span className="code-model-option-copy">
                            <span>{copy.reasoningOptionLabel(option.value, option.label)}</span>
                          </span>
                          {option.value === agentReasoningEffort && <span className="code-menu-check" aria-hidden="true">✓</span>}
                        </button>
                      ))}
                      <div className="code-context-menu-separator" role="separator" />
                    </>
                  )}
                  <div className="code-model-nested-anchor">
                    <button
                      type="button"
                      className={`code-model-nested-trigger ${modelPickerPane === 'model' ? 'selected' : ''}`}
                      role="menuitem"
                      data-testid="code-model-submenu-trigger"
                      onClick={() => onSetModelPickerPane(modelPickerPane === 'model' ? null : 'model')}
                    >
                      <span>{currentModelLabel}</span>
                      <span aria-hidden="true">›</span>
                    </button>
                    {modelPickerPane === 'model' && (
                      <div
                        className="code-model-submenu code-composer-menu"
                        role="menu"
                        data-testid="code-model-submenu"
                        onKeyDown={onComposerMenuKeyDown}
                      >
                        {agentModelOptions.map(option => (
                          <button
                            key={option.value}
                            type="button"
                            className={`code-model-option ${option.value === agentModel ? 'selected' : ''}`}
                            role="menuitemradio"
                            aria-checked={option.value === agentModel}
                            onClick={() => onUpdateModel(option.value)}
                          >
                            <span className="code-model-option-copy">
                              <span>{codexModelDisplayName(option, option.value)}</span>
                            </span>
                            {option.value === agentModel && <span className="code-menu-check" aria-hidden="true">✓</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {showServiceTierPicker && (
                    <div className="code-model-nested-anchor">
                      <button
                        type="button"
                        className={`code-model-nested-trigger ${modelPickerPane === 'speed' ? 'selected' : ''}`}
                        role="menuitem"
                        data-testid="code-speed-submenu-trigger"
                        onClick={() => onSetModelPickerPane(modelPickerPane === 'speed' ? null : 'speed')}
                      >
                        <span>{copy.speed}</span>
                        <span aria-hidden="true">›</span>
                      </button>
                      {modelPickerPane === 'speed' && (
                        <div
                          className="code-speed-submenu code-composer-menu"
                          role="menu"
                          data-testid="code-speed-submenu"
                          onKeyDown={onComposerMenuKeyDown}
                        >
                          {currentServiceTierOptions.map(option => (
                            <button
                              key={option.value}
                              type="button"
                              className={`code-model-option ${option.value === agentServiceTier ? 'selected' : ''}`}
                              role="menuitemradio"
                              aria-checked={option.value === agentServiceTier}
                              onClick={() => onUpdateServiceTier(option.value)}
                            >
                              <span className="code-model-option-copy">
                                <span className="code-speed-option-label">
                                  {option.value === 'priority' && <span className="code-speed-option-icon" aria-hidden="true">↯</span>}
                                  <span>{copy.serviceTierLabel(option.value, option.label)}</span>
                                </span>
                                {option.description && (
                                  <small>{copy.serviceTierDescription(option.value, option.description)}</small>
                                )}
                              </span>
                              {option.value === agentServiceTier && <span className="code-menu-check" aria-hidden="true">✓</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {showSpeechInput && (
            <button
              type="button"
              className={`code-composer-mic ${speechListening ? 'listening' : ''}`}
              data-testid="code-composer-mic"
              aria-label={speechListening ? copy.stopDictation : copy.startDictation}
              aria-pressed={speechListening}
              onClick={onToggleSpeechInput}
              disabled={!speechSupported || !active}
              title={speechSupported ? copy.startDictation : copy.speechUnsupported}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 14.5a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5.5a3 3 0 0 0 3 3Z" />
                <path d="M6.75 10.75v.75a5.25 5.25 0 0 0 10.5 0v-.75" />
                <path d="M12 16.75V21" />
                <path d="M9 21h6" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className={`code-composer-send ${submitIsInterrupt ? 'interrupt' : ''}`}
            data-testid="code-composer-send"
            data-action={submitAction}
            aria-label={submitIsInterrupt ? copy.interruptAgent : copy.sendMessage}
            onClick={submitIsInterrupt ? onInterrupt : onSubmit}
            disabled={submitDisabled}
          >
            {submitIsInterrupt ? <span className="code-composer-stop-icon" aria-hidden="true" /> : '↑'}
          </button>
        </div>
      </div>
    </footer>
  )
}

function ApprovalIcon({ mode }: { mode: string }) {
  if (mode === 'ask') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 11V5.8a1.6 1.6 0 0 1 3.2 0V10" />
        <path d="M11.2 10V4.7a1.6 1.6 0 0 1 3.2 0V10" />
        <path d="M14.4 10V6.2a1.6 1.6 0 0 1 3.2 0v6.2" />
        <path d="M8 11.5 6.5 9.7a1.7 1.7 0 0 0-2.5 2.2l4.4 5.8a6 6 0 0 0 10.8-3.6v-2.3" />
      </svg>
    )
  }

  if (mode === 'custom') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z" />
        <path d="M19 13.3v-2.6l-2.1-.4a7 7 0 0 0-.6-1.4l1.2-1.8-1.9-1.9-1.8 1.2a7 7 0 0 0-1.4-.6L12 3.7H9.4L9 5.8a7 7 0 0 0-1.4.6L5.8 5.2 3.9 7.1l1.2 1.8a7 7 0 0 0-.6 1.4l-2.1.4v2.6l2.1.4a7 7 0 0 0 .6 1.4l-1.2 1.8 1.9 1.9 1.8-1.2a7 7 0 0 0 1.4.6l.4 2.1H12l.4-2.1a7 7 0 0 0 1.4-.6l1.8 1.2 1.9-1.9-1.2-1.8a7 7 0 0 0 .6-1.4l2.1-.4Z" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.6 19 6v5.5c0 4.2-2.7 7.6-7 8.9-4.3-1.3-7-4.7-7-8.9V6l7-2.4Z" />
      {mode === 'full' || mode === 'bypassPermissions' ? <path d="M12 8v5" /> : <path d="M9.5 12.4 11.3 14l3.5-4" />}
      {mode === 'full' || mode === 'bypassPermissions' ? <path d="M12 16.4h.01" /> : null}
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.5 6.25 8 9.75l3.5-3.5" />
    </svg>
  )
}
