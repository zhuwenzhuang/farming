import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChangeEvent,
  ClipboardEvent,
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  RefObject,
  CSSProperties,
  PointerEvent,
} from 'react'
import type { AgentContextWindowUsage } from '@/types/agent'
import {
  ArrowUpGlyph,
  CheckGlyph,
  ChevronDownGlyph,
  ChevronRightGlyph,
  CloseGlyph,
  HandGlyph,
  PlusGlyph,
  ReplyGlyph,
} from '@/components/IconGlyphs'
import { isTouchInputViewport } from '@/lib/responsive-mode'
import { codexModelDisplayName } from './model'
import type { AgentComposerCapabilities, ComposerAgentKind, SlashCommandOption } from './capabilities'
import {
  composerDraftForSubmit,
  isComposerImeCompositionEvent,
  shouldSubmitComposerEnter,
  shouldSuppressComposerEnterAfterComposition,
} from './composer-keyboard'
import type { CodeCopy } from './copy'
import type { PermissionModeColor, PermissionModeOption } from './composer-profile'
import { ComposerAttachments, type ComposerAttachmentView } from './ComposerAttachments'
import {
  composerCommandTestId,
  findComposerCommandTrigger,
  matchesComposerCommand,
  rankComposerCommand,
} from './composer-slash-commands'
import { useMobileComposerHeight } from './useMobileComposerHeight'
import type {
  CodexModelOption,
  CodeModelPickerPane,
  CodexReasoningOption,
  CodexServiceTierOption,
  ComposerMode,
} from './types'
import { ModelMatrixPicker, modelMatrixFamily } from './ModelMatrixPicker'
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

function composerModePlaceholder(copy: CodeCopy, mode: ComposerMode, agentKind: ComposerAgentKind) {
  if (mode === 'goal') return copy.describeAgentGoal
  if (mode === 'plan') return copy.describePlanFirst
  if (agentKind === 'shell') return copy.shellCommandPlaceholder
  return copy.askFollowUpChanges
}

function isMobileComposerViewport() {
  return typeof window !== 'undefined' && isTouchInputViewport()
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

function formatRecordingDuration(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safeSeconds / 60)
  const remainder = safeSeconds % 60
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

const COMPOSER_VOICE_WAVEFORM_BARS = [
  0.28, 0.5, 0.72, 0.46, 0.9, 0.36, 0.62, 0.82, 0.42, 0.68, 0.95, 0.52,
  0.33, 0.75, 0.57, 0.88, 0.4, 0.64, 0.93, 0.48, 0.7, 0.31, 0.58, 0.83,
]
const COMPOSER_MIC_REGULAR_PATH = 'M8 10.9995C9.654 10.9995 11 9.65351 11 7.99951V3.99951C11 2.34551 9.654 0.999512 8 0.999512C6.346 0.999512 5 2.34551 5 3.99951V7.99951C5 9.65351 6.346 10.9995 8 10.9995ZM6 3.99951C6 2.89651 6.897 1.99951 8 1.99951C9.103 1.99951 10 2.89651 10 3.99951V7.99951C10 9.10251 9.103 9.99951 8 9.99951C6.897 9.99951 6 9.10251 6 7.99951V3.99951ZM13 7.49951V7.99951C13 10.5855 11.02 12.6935 8.5 12.9485V14.4995C8.5 14.7755 8.276 14.9995 8 14.9995C7.724 14.9995 7.5 14.7755 7.5 14.4995V12.9485C4.98 12.6935 3 10.5845 3 7.99951V7.49951C3 7.22351 3.224 6.99951 3.5 6.99951C3.776 6.99951 4 7.22351 4 7.49951V7.99951C4 10.2055 5.794 11.9995 8 11.9995C10.206 11.9995 12 10.2055 12 7.99951V7.49951C12 7.22351 12.224 6.99951 12.5 6.99951C12.776 6.99951 13 7.22351 13 7.49951Z'
const COMPOSER_MIC_FILLED_PATH = 'M8 10.9995C9.654 10.9995 11 9.65351 11 7.99951V3.99951C11 2.34551 9.654 0.999512 8 0.999512C6.346 0.999512 5 2.34551 5 3.99951V7.99951C5 9.65351 6.346 10.9995 8 10.9995ZM13 7.49951V7.99951C13 10.5855 11.02 12.6935 8.5 12.9485V14.4995C8.5 14.7755 8.276 14.9995 8 14.9995C7.724 14.9995 7.5 14.7755 7.5 14.4995V12.9485C4.98 12.6935 3 10.5845 3 7.99951V7.49951C3 7.22351 3.224 6.99951 3.5 6.99951C3.776 6.99951 4 7.22351 4 7.49951V7.99951C4 10.2055 5.794 11.9995 8 11.9995C10.206 11.9995 12 10.2055 12 7.99951V7.49951C12 7.22351 12.224 6.99951 12.5 6.99951C12.776 6.99951 13 7.22351 13 7.49951Z'

function ComposerMicIcon({ listening }: { listening: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d={listening ? COMPOSER_MIC_FILLED_PATH : COMPOSER_MIC_REGULAR_PATH} />
    </svg>
  )
}

function ComposerSpeedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8.85 1.35a.55.55 0 0 1 .55.68L8.28 6.1h3.07a.55.55 0 0 1 .42.9l-5.5 6.6a.55.55 0 0 1-.96-.48l1.12-4.2H3.65a.55.55 0 0 1-.44-.88l5.2-6.48a.55.55 0 0 1 .44-.21ZM4.8 7.9h2.34a.55.55 0 0 1 .53.69l-.63 2.38L10.17 7.1H7.56a.55.55 0 0 1-.53-.7l.62-2.26L4.8 7.9Z" />
    </svg>
  )
}

interface CodeComposerProps {
  active: boolean
  agentKind: ComposerAgentKind
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
  permissionModeDisabled: boolean
  modelProfileDisabled: boolean
  currentPermissionLabel: string
  currentPermissionColor: PermissionModeColor
  permissionModeHint: string
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
  onSubmit: (draft?: string) => void
  onInterrupt: () => void
  onSendPendingFollowUp: (messageId: string) => void
  onDiscardPendingFollowUp: (messageId: string) => void
  onPasteAttachment: (event: ClipboardEvent<HTMLElement>) => void
  onAttachmentFiles: (event: ChangeEvent<HTMLInputElement>) => void
  onChooseAttachmentFile: () => void
  onActivateComposerMode: (mode: Exclude<ComposerMode, 'default'>) => void
  onClearComposerMode: () => void
  onTogglePlusMenu: () => void
  onToggleApprovalMenu: () => void
  onToggleModelMenu: () => void
  onCloseMenus: () => void
  onSetModelPickerPane: (pane: CodeModelPickerPane) => void
  onComposerMenuKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  onComposerMenuBlur: (event: FocusEvent<HTMLDivElement>) => void
  onUpdatePermissionMode: (mode: string) => void
  onUpdateModel: (model: string) => void
  onUpdateReasoningEffort: (effort: string) => void
  onUpdateServiceTier: (tier: string) => void
  onUpdateModelProfile: (model: string, effort: string) => void
  onUpdateServiceTierInline: (tier: string) => void
  onToggleSpeechInput: () => void
  copy: CodeCopy
}

export function CodeComposer({
  active,
  agentKind,
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
  permissionModeDisabled,
  modelProfileDisabled,
  currentPermissionLabel,
  currentPermissionColor,
  permissionModeHint,
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
  onSendPendingFollowUp,
  onDiscardPendingFollowUp,
  onPasteAttachment,
  onAttachmentFiles,
  onChooseAttachmentFile,
  onActivateComposerMode,
  onClearComposerMode,
  onTogglePlusMenu,
  onToggleApprovalMenu,
  onToggleModelMenu,
  onCloseMenus,
  onSetModelPickerPane,
  onComposerMenuKeyDown,
  onComposerMenuBlur,
  onUpdatePermissionMode,
  onUpdateModel,
  onUpdateReasoningEffort,
  onUpdateServiceTier,
  onUpdateModelProfile,
  onUpdateServiceTierInline,
  onToggleSpeechInput,
  copy,
}: CodeComposerProps) {
  const showPlusMenu = active && capabilities.plusMenu
  const showPermissionMode = active && capabilities.permissionMode
  const showModelPicker = active && capabilities.modelPicker
  const showServiceTierPicker = capabilities.serviceTier && currentServiceTierOptions.length > 0
  const matrixModels = agentModelOptions.map(option => ({
    value: option.value,
    label: codexModelDisplayName(option, option.value),
    reasoning: (option.reasoningLevels || []).map(reasoning => ({
      value: reasoning.value,
      label: copy.reasoningOptionLabel(reasoning.value, reasoning.label),
    })),
  }))
  const hasModelMatrix = agentKind === 'codex' && Boolean(modelMatrixFamily(matrixModels, agentModel))
  const [mobileComposerViewport, setMobileComposerViewport] = useState(isMobileComposerViewport)
  const [recordingElapsedSeconds, setRecordingElapsedSeconds] = useState(0)
  const [textareaFocused, setTextareaFocused] = useState(false)
  const [textareaSelectionStart, setTextareaSelectionStart] = useState(draft.length)
  const [mobileDictationHintVisible, setMobileDictationHintVisible] = useState(false)
  const [dismissedSlashTriggerId, setDismissedSlashTriggerId] = useState<string | null>(null)
  const [activeSlashIndex, setActiveSlashIndex] = useState(0)
  // iOS already provides dictation from the native keyboard. Only render the
  // web control on a touch viewport when the browser actually exposes a
  // usable SpeechRecognition implementation; otherwise it is dead weight in
  // the narrow composer. Desktop keeps the control for supported agents.
  const showSpeechInput = active
    && capabilities.speechInput
    && (!mobileComposerViewport || speechSupported)
  const slashCommandRefs = useRef(new Map<string, HTMLButtonElement>())
  const composerRef = useRef<HTMLElement | null>(null)
  const compositionActiveRef = useRef(false)
  const lastCompositionEndAtRef = useRef(0)
  const latestDraftRef = useRef(draft)
  const mobileSpeechPointerHandledRef = useRef(false)
  useMobileComposerHeight(composerRef)

  const baseComposerMenuOpen = plusMenuOpen || approvalMenuOpen || modelMenuOpen
  const slashTrigger = useMemo(
    () => findComposerCommandTrigger(draft, textareaSelectionStart),
    [draft, textareaSelectionStart]
  )
  const slashTriggerId = slashTrigger
    ? `${slashTrigger.trigger}:${slashTrigger.start}:${slashTrigger.end}:${slashTrigger.query}`
    : ''
  const filteredSlashCommands = useMemo(
    () => slashTrigger
      ? slashCommands
        .filter(command => matchesComposerCommand(command, slashTrigger.query, slashTrigger.trigger))
        .sort((a, b) => rankComposerCommand(a, slashTrigger.query) - rankComposerCommand(b, slashTrigger.query))
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
  const showMobileRecordingBar = mobileComposerViewport && speechListening && showSpeechInput
  const speechControlAvailable = speechSupported || mobileComposerViewport

  const startSpeechInputIntent = () => {
    if (mobileComposerViewport || isTouchInputViewport()) {
      setMobileDictationHintVisible(true)
    }
    onToggleSpeechInput()
  }

  const handleSpeechClick = () => {
    if (mobileSpeechPointerHandledRef.current) {
      mobileSpeechPointerHandledRef.current = false
      return
    }
    startSpeechInputIntent()
  }

  const handleSpeechPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse') return
    event.preventDefault()
    mobileSpeechPointerHandledRef.current = true
    startSpeechInputIntent()
  }

  function focusTextareaForInputIntent(target: EventTarget | null) {
    if (!active) return
    if (target instanceof Element && target.closest('.code-composer-menu, button, input, select, textarea, [role="menuitem"]')) return

    const textarea = textareaRef.current
    if (!textarea || textarea.disabled) return
    textarea.focus({ preventScroll: true })
    updateSelectionFromTextarea(textarea)
  }

  const handleComposerClick = (event: MouseEvent<HTMLElement>) => {
    focusTextareaForInputIntent(event.target)
  }

  useEffect(() => {
    setActiveSlashIndex(0)
  }, [slashTrigger?.query, filteredSlashCommands.length])

  useEffect(() => {
    latestDraftRef.current = draft
  }, [draft])

  useEffect(() => {
    if (!slashTrigger) {
      setDismissedSlashTriggerId(null)
    }
  }, [slashTrigger])

  useEffect(() => {
    if (active) return
    setTextareaFocused(false)
    setDismissedSlashTriggerId(null)
  }, [active])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const query = window.matchMedia('(max-width: 980px)')
    const updateMobileViewport = () => setMobileComposerViewport(isMobileComposerViewport())
    updateMobileViewport()
    window.addEventListener('resize', updateMobileViewport)
    query.addEventListener('change', updateMobileViewport)
    return () => {
      window.removeEventListener('resize', updateMobileViewport)
      query.removeEventListener('change', updateMobileViewport)
    }
  }, [])

  useEffect(() => {
    if (speechListening || !mobileDictationHintVisible) return undefined
    const timer = window.setTimeout(() => setMobileDictationHintVisible(false), 3600)
    return () => window.clearTimeout(timer)
  }, [mobileDictationHintVisible, speechListening])

  useEffect(() => {
    if (speechListening) setMobileDictationHintVisible(false)
  }, [speechListening])

  useEffect(() => {
    if (!speechListening) {
      setRecordingElapsedSeconds(0)
      return undefined
    }

    const startedAt = Date.now()
    setRecordingElapsedSeconds(0)
    const timer = window.setInterval(() => {
      setRecordingElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 250)
    return () => window.clearInterval(timer)
  }, [speechListening])

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

  const composerClasses = [
    'code-composer',
    composerMenuOpen ? 'menu-open' : '',
    showMobileRecordingBar ? 'recording' : '',
    attachments.length > 0 ? 'has-attachments' : '',
    pendingFollowUp && active ? 'has-pending-followup' : '',
  ].filter(Boolean).join(' ')

  return (
    <footer
      ref={composerRef}
      className={composerClasses}
      data-testid="code-composer"
      onClick={handleComposerClick}
    >
      {pendingFollowUp && active && (
        <div className="code-pending-followup" data-testid="code-pending-followup">
          {pendingFollowUp.messages.map(message => (
            <div className="code-pending-followup-row" data-testid="code-pending-followup-row" key={message.id}>
              <span className="code-pending-followup-icon" aria-hidden="true"><ReplyGlyph /></span>
              <p>{message.text}</p>
              <div className="code-pending-followup-actions">
                <button
                  type="button"
                  data-testid="code-pending-followup-send-next"
                  onClick={() => onSendPendingFollowUp(message.id)}
                >
                  <ReplyGlyph />
                  <span>{copy.sendQueuedMessage}</span>
                </button>
                <button
                  type="button"
                  className="icon"
                  data-testid="code-pending-followup-discard"
                  aria-label={copy.discardQueuedMessage}
                  onClick={() => onDiscardPendingFollowUp(message.id)}
                >
                  <CloseGlyph />
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
              data-testid={composerCommandTestId(command.command)}
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
          data-testid="code-composer-input"
          ref={textareaRef}
          enterKeyHint="send"
          name="farming-chat-message"
          inputMode="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          data-lpignore="true"
          data-1p-ignore="true"
          data-bwignore="true"
          data-form-type="other"
          value={draft}
          onFocus={event => {
            onCloseMenus()
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
            latestDraftRef.current = event.currentTarget.value
            updateSelectionFromTextarea(event.currentTarget)
          }}
          onChange={event => {
            latestDraftRef.current = event.target.value
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
            onSubmit(composerDraftForSubmit(event.currentTarget.value, latestDraftRef.current))
          }}
          placeholder={active ? composerModePlaceholder(copy, composerMode, agentKind) : copy.openAgentTerminalFirst}
          disabled={!active}
      />
      {mobileDictationHintVisible && !speechListening && (
        <div className="code-composer-dictation-hint" data-testid="code-composer-dictation-hint">
          {copy.mobileDictationHint}
        </div>
      )}
      <ComposerAttachments attachments={attachments} onRemove={onRemoveAttachment} />
      <input
        ref={attachmentInputRef}
        className="code-composer-file-input"
        data-testid="code-composer-file-input"
        type="file"
        multiple
        onChange={onAttachmentFiles}
      />
      <div className={`code-composer-toolbar ${showMobileRecordingBar ? 'recording' : ''}`} data-testid="code-composer-toolbar">
        {showMobileRecordingBar ? (
          <div className="code-composer-recording-bar" data-testid="code-composer-recording">
            <button
              type="button"
              className="code-composer-recording-stop"
              data-testid="code-composer-recording-stop"
              aria-label={copy.stopDictation}
              onPointerDown={handleSpeechPointerDown}
              onClick={handleSpeechClick}
            >
              <span aria-hidden="true" />
            </button>
            <div className="code-composer-recording-wave" aria-hidden="true">
              {COMPOSER_VOICE_WAVEFORM_BARS.map((scale, index) => (
                <span
                  // eslint-disable-next-line react/no-array-index-key
                  key={index}
                  style={{ '--voice-bar-scale': scale, '--voice-bar-delay': `${index * 38}ms` } as CSSProperties}
                />
              ))}
            </div>
            <span className="code-composer-recording-time">{formatRecordingDuration(recordingElapsedSeconds)}</span>
            <button
              type="button"
              className={`code-composer-send ${submitIsInterrupt ? 'interrupt' : ''}`}
              data-testid="code-composer-send"
              data-action={submitAction}
              aria-label={submitIsInterrupt ? copy.interruptAgent : copy.sendMessage}
              onClick={submitIsInterrupt ? onInterrupt : () => onSubmit(latestDraftRef.current)}
              disabled={submitDisabled}
            >
              {submitIsInterrupt ? <span className="code-composer-stop-icon" aria-hidden="true" /> : <ArrowUpGlyph />}
            </button>
          </div>
        ) : (
          <>
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
              <PlusGlyph />
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
              <span aria-hidden="true"><CloseGlyph /></span>
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
                disabled={permissionModeDisabled}
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
                    <small>{permissionModeHint}</small>
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
                      {option.value === currentPermissionMode && <span className="code-menu-check" aria-hidden="true"><CheckGlyph /></span>}
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
                {agentServiceTier === 'priority' && (
                  <span className="code-composer-speed-active" aria-hidden="true">
                    <ComposerSpeedIcon />
                  </span>
                )}
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
                  className={`code-model-picker-menu code-composer-menu ${hasModelMatrix ? 'has-matrix' : ''}`}
                  role="menu"
                  data-testid="code-model-menu"
                  ref={modelMenuRef}
                  onKeyDown={onComposerMenuKeyDown}
                  onBlur={onComposerMenuBlur}
                  onMouseDown={event => event.preventDefault()}
                >
                  <ModelMatrixPicker
                    models={matrixModels}
                    currentModel={agentModel}
                    currentReasoning={agentReasoningEffort}
                    fastAvailable={showServiceTierPicker && currentServiceTierOptions.some(option => option.value === 'priority')}
                    fast={agentServiceTier === 'priority'}
                    disabled={modelProfileDisabled}
                    onSelect={onUpdateModelProfile}
                    onFastChange={value => onUpdateServiceTierInline(value ? 'priority' : 'default')}
                    advanced={(
                      <>
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
                          disabled={modelProfileDisabled}
                          onClick={() => onUpdateReasoningEffort(option.value)}
                        >
                          <span className="code-model-option-copy">
                            <span>{copy.reasoningOptionLabel(option.value, option.label)}</span>
                          </span>
                          {option.value === agentReasoningEffort && <span className="code-menu-check" aria-hidden="true"><CheckGlyph /></span>}
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
                      disabled={modelProfileDisabled}
                      onClick={() => onSetModelPickerPane(modelPickerPane === 'model' ? null : 'model')}
                    >
                      <span>{currentModelLabel}</span>
                      <ChevronRightGlyph className="code-menu-chevron-right" />
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
                            disabled={modelProfileDisabled}
                            onClick={() => onUpdateModel(option.value)}
                          >
                            <span className="code-model-option-copy">
                              <span>{codexModelDisplayName(option, option.value)}</span>
                            </span>
                            {option.value === agentModel && <span className="code-menu-check" aria-hidden="true"><CheckGlyph /></span>}
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
                        disabled={modelProfileDisabled}
                        onClick={() => onSetModelPickerPane(modelPickerPane === 'speed' ? null : 'speed')}
                      >
                        <span>{copy.speed}</span>
                        <ChevronRightGlyph className="code-menu-chevron-right" />
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
                              disabled={modelProfileDisabled}
                              onClick={() => onUpdateServiceTier(option.value)}
                            >
                              <span className="code-model-option-copy">
                                <span className="code-speed-option-label">
                                  {option.value === 'priority' && <span className="code-speed-option-icon" aria-hidden="true"><ComposerSpeedIcon /></span>}
                                  <span>{copy.serviceTierLabel(option.value, option.label)}</span>
                                </span>
                                {option.description && (
                                  <small>{copy.serviceTierDescription(option.value, option.description)}</small>
                                )}
                              </span>
                              {option.value === agentServiceTier && <span className="code-menu-check" aria-hidden="true"><CheckGlyph /></span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                      </>
                    )}
                  />
                </div>
              )}
            </div>
              )}
              {showSpeechInput && (
            <button
              type="button"
              className={`code-composer-mic ${speechListening ? 'listening' : ''}`}
              data-testid="code-composer-mic"
              aria-label={speechListening ? copy.stopDictation : (speechSupported ? copy.startDictation : copy.mobileDictationHint)}
              aria-pressed={speechListening}
              onPointerDown={handleSpeechPointerDown}
              onClick={handleSpeechClick}
              disabled={!active || !speechControlAvailable}
              title={speechControlAvailable ? (speechListening ? copy.stopDictation : (speechSupported ? copy.startDictation : copy.mobileDictationHint)) : copy.speechUnsupported}
            >
              <ComposerMicIcon listening={speechListening} />
            </button>
              )}
              <button
            type="button"
            className={`code-composer-send ${submitIsInterrupt ? 'interrupt' : ''}`}
            data-testid="code-composer-send"
            data-action={submitAction}
            aria-label={submitIsInterrupt ? copy.interruptAgent : copy.sendMessage}
            onClick={submitIsInterrupt ? onInterrupt : () => onSubmit(latestDraftRef.current)}
            disabled={submitDisabled}
          >
            {submitIsInterrupt ? <span className="code-composer-stop-icon" aria-hidden="true" /> : <ArrowUpGlyph />}
              </button>
            </div>
          </>
        )}
      </div>
    </footer>
  )
}

function ApprovalIcon({ mode }: { mode: string }) {
  if (mode === 'ask') {
    return <HandGlyph className="code-approval-hand-glyph" />
  }

  if (mode === 'custom') {
    return (
      <svg className="filled" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M7.99997 6C6.89497 6 5.99997 6.895 5.99997 8C5.99997 9.105 6.89497 10 7.99997 10C9.10497 10 9.99997 9.105 9.99997 8C9.99997 6.895 9.10497 6 7.99997 6ZM7.99997 9C7.44797 9 6.99997 8.552 6.99997 8C6.99997 7.448 7.44797 7 7.99997 7C8.55197 7 8.99997 7.448 8.99997 8C8.99997 8.552 8.55197 9 7.99997 9ZM14.565 9.715L13.279 8.628C13.245 8.599 13.213 8.567 13.184 8.533C12.888 8.186 12.931 7.667 13.279 7.372L14.565 6.285C14.693 6.177 14.742 6.003 14.691 5.844C14.386 4.903 13.882 4.04 13.219 3.308C13.139 3.22 13.027 3.172 12.912 3.172C12.865 3.172 12.818 3.18 12.773 3.196L11.186 3.761C11.144 3.776 11.1 3.788 11.056 3.796C11.006 3.805 10.956 3.81 10.907 3.81C10.515 3.81 10.167 3.532 10.094 3.134L9.79097 1.482C9.76097 1.318 9.63397 1.188 9.46997 1.153C8.98997 1.051 8.49897 1 8.00097 1C7.50297 1 7.01097 1.052 6.53097 1.153C6.36697 1.188 6.23997 1.318 6.20997 1.482L5.90797 3.134C5.89997 3.178 5.88797 3.221 5.87297 3.263C5.75197 3.6 5.43397 3.81 5.09397 3.81C5.00197 3.81 4.90797 3.794 4.81597 3.762L3.22897 3.197C3.18397 3.181 3.13597 3.173 3.08997 3.173C2.97497 3.173 2.86297 3.221 2.78297 3.309C2.11897 4.041 1.61597 4.904 1.30997 5.845C1.25797 6.004 1.30797 6.178 1.43597 6.286L2.72197 7.373C2.75597 7.402 2.78797 7.434 2.81697 7.468C3.11297 7.815 3.06997 8.334 2.72197 8.629L1.43597 9.716C1.30797 9.824 1.25897 9.998 1.30997 10.157C1.61497 11.098 2.11897 11.961 2.78297 12.693C2.86297 12.781 2.97497 12.829 3.08997 12.829C3.13697 12.829 3.18397 12.821 3.22897 12.805L4.81597 12.24C4.85797 12.225 4.90197 12.213 4.94597 12.205C4.99597 12.196 5.04597 12.192 5.09497 12.192C5.48697 12.192 5.83497 12.47 5.90797 12.868L6.20997 14.52C6.23997 14.684 6.36697 14.814 6.53097 14.849C7.01097 14.951 7.50297 15.002 8.00097 15.002C8.49897 15.002 8.99097 14.95 9.46997 14.849C9.63397 14.814 9.76097 14.684 9.79097 14.52L10.094 12.868C10.102 12.824 10.114 12.781 10.129 12.739C10.25 12.402 10.568 12.192 10.908 12.192C11 12.192 11.094 12.208 11.186 12.24L12.772 12.805C12.818 12.821 12.865 12.829 12.911 12.829C13.026 12.829 13.138 12.781 13.218 12.693C13.882 11.961 14.385 11.098 14.69 10.157C14.742 9.998 14.692 9.824 14.564 9.716L14.565 9.715ZM12.728 11.726L11.521 11.296C11.323 11.226 11.117 11.19 10.908 11.19C10.139 11.19 9.44697 11.676 9.18797 12.399C9.15397 12.492 9.12897 12.588 9.11097 12.686L8.88097 13.937C8.59097 13.979 8.29597 14 8.00097 14C7.70597 14 7.41097 13.979 7.11997 13.936L6.89097 12.685C6.73197 11.818 5.97697 11.189 5.09497 11.189C4.98697 11.189 4.87697 11.199 4.76597 11.219C4.66897 11.237 4.57397 11.262 4.47997 11.295L3.27297 11.725C2.90497 11.264 2.61097 10.759 2.39397 10.214L3.36797 9.391C3.74097 9.076 3.96797 8.634 4.00797 8.148C4.04797 7.662 3.89497 7.19 3.57797 6.818C3.51397 6.743 3.44297 6.672 3.36797 6.608L2.39397 5.785C2.61097 5.24 2.90497 4.734 3.27297 4.274L4.47997 4.704C4.67797 4.774 4.88397 4.81 5.09397 4.81C5.86297 4.81 6.55497 4.324 6.81397 3.601C6.84797 3.507 6.87297 3.411 6.89097 3.314L7.11997 2.063C7.41097 2.021 7.70597 1.999 8.00097 1.999C8.29597 1.999 8.59097 2.02 8.88097 2.062L9.10997 3.313C9.26897 4.18 10.024 4.809 10.906 4.809C11.014 4.809 11.124 4.799 11.234 4.779C11.331 4.761 11.427 4.736 11.521 4.703L12.728 4.273C13.096 4.733 13.39 5.239 13.607 5.784L12.634 6.607C12.261 6.922 12.033 7.364 11.994 7.85C11.954 8.336 12.107 8.809 12.424 9.18C12.489 9.256 12.559 9.326 12.635 9.39L13.609 10.213C13.392 10.758 13.098 11.264 12.73 11.724L12.728 11.726Z" />
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
  return <ChevronDownGlyph />
}
