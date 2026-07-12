import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { ArrowUpGlyph } from '@/components/IconGlyphs'
import type { AcpPendingPermission } from '@/types/agent'
import {
  composerDraftForSubmit,
  shouldSubmitComposerEnter,
} from '../composer-keyboard'
import type { CodeCopy } from '../copy'
import { AcpPermissionCard } from './AcpPermissionCard'
import { AcpSessionControls } from './AcpSessionControls'
import { useAcpSession } from './useAcpSession'

export interface AcpComposerProps {
  active: boolean
  agentId: string
  runtimeState: string
  runtimeError: string
  draft: string
  submitAction: 'send' | 'interrupt' | 'disabled'
  textareaRef: RefObject<HTMLTextAreaElement | null>
  permissions: AcpPendingPermission[]
  onDraftChange: (value: string) => void
  onSubmit: (draft?: string) => void
  onInterrupt: () => void
  onRespondToPermission: (requestId: string, optionId?: string, cancelled?: boolean) => void
  copy: CodeCopy
}

export function AcpComposer({
  active,
  agentId,
  runtimeState,
  runtimeError,
  draft,
  submitAction,
  textareaRef,
  permissions,
  onDraftChange,
  onSubmit,
  onInterrupt,
  onRespondToPermission,
  copy,
}: AcpComposerProps) {
  const compositionActiveRef = useRef(false)
  const lastCompositionEndAtRef = useRef(0)
  const latestDraftRef = useRef(draft)
  const [focused, setFocused] = useState(false)
  const [activeCommandIndex, setActiveCommandIndex] = useState(0)
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

  const insertCommand = (name: string) => {
    const nextDraft = `/${name} `
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
    if (!shouldSubmitComposerEnter(event, compositionActiveRef.current, lastCompositionEndAtRef.current)) return
    event.preventDefault()
    event.stopPropagation()
    onSubmit(composerDraftForSubmit(event.currentTarget.value, latestDraftRef.current))
  }

  return (
    <div className="code-composer code-acp-composer" data-testid="code-acp-composer">
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
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={event => onDraftChange(event.currentTarget.value)}
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
      <div className="code-composer-toolbar" data-testid="code-acp-composer-toolbar">
        <div className="code-composer-left-tools">
          {session ? (
            <AcpSessionControls
              session={session}
              updatingId={updatingId}
              onSetMode={modeId => { void setMode(modeId) }}
              onSetConfigOption={(configId, value) => { void setConfigOption(configId, value) }}
            />
          ) : null}
        </div>
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
  )
}
