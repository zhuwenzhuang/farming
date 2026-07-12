import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent, type RefObject } from 'react'
import { ArrowUpGlyph, PlusGlyph } from '@/components/IconGlyphs'
import type { AcpPendingPermission } from '@/types/agent'
import { ComposerAttachments, type ComposerAttachmentView } from '../ComposerAttachments'
import type { ComposerHistoryDirection, ComposerHistoryNavigationInput } from '../composer-history'
import {
  composerDraftForSubmit,
  shouldSubmitComposerEnter,
} from '../composer-keyboard'
import type { CodeCopy } from '../copy'
import { AcpPermissionCard } from './AcpPermissionCard'
import {
  AcpModeControl,
  AcpModelControl,
  type AcpComposerMenu,
} from './AcpSessionControls'
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

export interface AcpComposerProps {
  active: boolean
  agentId: string
  runtimeState: string
  runtimeError: string
  draft: string
  attachments: ComposerAttachmentView[]
  submitAction: 'send' | 'interrupt' | 'disabled'
  textareaRef: RefObject<HTMLTextAreaElement | null>
  attachmentInputRef: RefObject<HTMLInputElement | null>
  permissions: AcpPendingPermission[]
  speechSupported: boolean
  speechListening: boolean
  onDraftChange: (value: string) => void
  onNavigateHistory: (direction: ComposerHistoryDirection, input: ComposerHistoryNavigationInput) => string | null
  onRemoveAttachment: (id: string) => void
  onSubmit: (draft?: string) => void
  onInterrupt: () => void
  onToggleSpeechInput: () => void
  onPasteAttachment: (event: ClipboardEvent<HTMLElement>) => void
  onAttachmentFiles: (event: ChangeEvent<HTMLInputElement>) => void
  onChooseAttachmentFile: () => void
  onRespondToPermission: (requestId: string, optionId?: string, cancelled?: boolean) => void
  copy: CodeCopy
}

export function AcpComposer({
  active,
  agentId,
  runtimeState,
  runtimeError,
  draft,
  attachments,
  submitAction,
  textareaRef,
  attachmentInputRef,
  permissions,
  speechSupported,
  speechListening,
  onDraftChange,
  onNavigateHistory,
  onRemoveAttachment,
  onSubmit,
  onInterrupt,
  onToggleSpeechInput,
  onPasteAttachment,
  onAttachmentFiles,
  onChooseAttachmentFile,
  onRespondToPermission,
  copy,
}: AcpComposerProps) {
  const compositionActiveRef = useRef(false)
  const lastCompositionEndAtRef = useRef(0)
  const latestDraftRef = useRef(draft)
  const composerRef = useRef<HTMLElement | null>(null)
  const [focused, setFocused] = useState(false)
  const [activeCommandIndex, setActiveCommandIndex] = useState(0)
  const [openMenu, setOpenMenu] = useState<AcpComposerMenu>(null)
  const [modelPane, setModelPane] = useState<'model' | 'speed' | null>(null)
  const { session, error: sessionError, updatingId, setMode, setConfigOption } = useAcpSession(agentId, active, runtimeState)
  latestDraftRef.current = draft
  const interrupting = submitAction === 'interrupt'
  const disabled = submitAction === 'disabled'

  const commandMatch = draft.match(/^\/([^\s]*)$/)
  const commandQuery = commandMatch ? (commandMatch[1] || '').toLowerCase() : null
  const filteredCommands = useMemo(() => {
    if (commandQuery === null) return []
    return (session?.availableCommands || [])
      .filter(command => command.name.toLowerCase().includes(commandQuery))
      .slice(0, 12)
  }, [commandQuery, session?.availableCommands])
  const showCommands = active && focused && filteredCommands.length > 0
  const selectedCommand = filteredCommands[activeCommandIndex] || filteredCommands[0] || null

  useEffect(() => setActiveCommandIndex(0), [commandQuery, filteredCommands.length])

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
    const nextDraft = `/${name} `
    setOpenMenu(null)
    latestDraftRef.current = nextDraft
    onDraftChange(nextDraft)
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true })
      textareaRef.current?.setSelectionRange(nextDraft.length, nextDraft.length)
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showCommands && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveCommandIndex(index => (index + direction + filteredCommands.length) % filteredCommands.length)
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
  const usage = Number.isFinite(session?.usage?.totalTokens)
    ? `${Math.round(Number(session?.usage?.totalTokens) / 1000)}k tokens`
    : ''

  return (
    <footer
      ref={composerRef}
      className={`code-composer code-acp-composer ${openMenu ? 'menu-open' : ''} ${attachments.length > 0 ? 'has-attachments' : ''}`}
      data-testid="code-acp-composer"
    >
      {active ? permissions.map(permission => (
        <AcpPermissionCard key={permission.requestId} request={permission} onRespond={onRespondToPermission} copy={copy} />
      )) : null}
      {active && (runtimeError || sessionError) ? (
        <section className="code-app-server-request code-app-server-notice" data-testid="code-acp-error" role="alert">
          <header><strong>ACP</strong><span>{runtimeState || 'error'}</span></header>
          <p>{runtimeError || sessionError}</p>
        </section>
      ) : null}
      {showCommands ? (
        <div className="code-slash-menu code-composer-menu" data-testid="code-acp-command-menu" role="listbox" aria-label="ACP commands">
          <div className="code-slash-menu-header">Agent commands</div>
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
        name="farming-acp-chat-message"
        inputMode="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        value={draft}
        placeholder={active ? copy.askFollowUpChanges : copy.openAgentTerminalFirst}
        disabled={!active}
        onFocus={() => {
          setFocused(true)
          setOpenMenu(null)
          setModelPane(null)
        }}
        onBlur={() => setFocused(false)}
        onChange={event => onDraftChange(event.currentTarget.value)}
        onPaste={onPasteAttachment}
        onCompositionStart={() => { compositionActiveRef.current = true }}
        onCompositionEnd={event => {
          compositionActiveRef.current = false
          lastCompositionEndAtRef.current = Date.now()
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
                {(session?.availableCommands || []).map(command => (
                  <button key={command.name} type="button" role="menuitem" onClick={() => insertCommand(command.name)}>
                    <span>/{command.name}</span>
                    <small>{command.description || command.input?.hint || ''}</small>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {session ? (
            <AcpModeControl
              session={session}
              updatingId={updatingId}
              open={openMenu === 'mode'}
              onToggle={() => toggleMenu('mode')}
              onSetMode={modeId => {
                setOpenMenu(null)
                void setMode(modeId)
              }}
            />
          ) : null}
        </div>
        <div className="code-composer-right-tools" data-testid="code-acp-composer-right-tools">
          {usage ? <span className="code-acp-usage" title="ACP session token usage">{usage}</span> : null}
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
