import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Agent } from '@/types/agent'
import type { TerminalInputPart } from '@/types/messages'
import { usePooledTerminal } from '@/hooks/usePooledTerminal'
import { isMobileTouchViewport } from '@/lib/responsive-mode'
import type { TerminalPathOpenTarget, TerminalSearchDirection, TerminalSearchResult } from '@/lib/terminal-session-pool'
import type { CodeCopy } from './code/copy'

interface AgentTerminalPaneProps {
  agent: Agent
  active: boolean
  focusSignal: number
  onActivate: (agentId: string, options?: { focusTerminal?: boolean }) => void
  sendInput: (input: string | TerminalInputPart[], agentId?: string) => boolean
  resizeAgent: (agentId: string, cols: number, rows: number) => boolean
  onSessionOutput: (agentId: string, handler: (data: string, replace?: boolean, outputSeq?: number | null) => void) => () => void
  onOpenPath?: (agentId: string, target: TerminalPathOpenTarget) => void
  onResolvePath?: (agentId: string, target: TerminalPathOpenTarget) => Promise<TerminalPathOpenTarget | null> | TerminalPathOpenTarget | null
  onFollowOutputChange?: (agentId: string, state: TerminalFollowState) => void
  copy: CodeCopy
}

interface TerminalFollowState {
  following: boolean
  hasUnreadOutput: boolean
}

function shouldSuppressRendererCursorForAgent(command?: string) {
  const program = String(command || '').trim().split(/\s+/)[0] || ''
  return [
    'claude',
    'codex',
    'qwen',
    'opencode',
    'aider',
    'github-copilot-cli',
    'amazon-q',
  ].includes(program)
}

function isMobileViewport() {
  return isMobileTouchViewport()
}

function isPrimaryFindShortcut(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key'>) {
  const primaryModifier = (event.metaKey && !event.ctrlKey) || (event.ctrlKey && !event.metaKey)
  return primaryModifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f'
}

function isTerminalFindTarget(target: EventTarget | null, paneEl: HTMLElement | null) {
  if (!(target instanceof Node)) return true
  if (paneEl?.contains(target)) return true
  return target === document.body || target === document.documentElement
}

function terminalSearchStatus(
  query: string,
  result: TerminalSearchResult | null,
  copy: CodeCopy,
) {
  if (!query.trim() || !result) return ''
  if (!result.found) return copy.terminalSearchNoResults
  if (
    typeof result.resultCount === 'number' &&
    result.resultCount > 0 &&
    typeof result.resultIndex === 'number' &&
    result.resultIndex >= 0
  ) {
    return copy.terminalSearchResults(result.resultIndex + 1, result.resultCount)
  }
  return ''
}

export function AgentTerminalPane({
  agent,
  active,
  focusSignal,
  onActivate,
  sendInput,
  resizeAgent,
  onSessionOutput,
  onOpenPath,
  onResolvePath,
  onFollowOutputChange,
  copy,
}: AgentTerminalPaneProps) {
  const terminalPaneRef = useRef<HTMLElement>(null)
  const terminalContainerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [followOutputState, setFollowOutputState] = useState({
    following: true,
    hasUnreadOutput: false,
  })
  const [terminalSearchOpen, setTerminalSearchOpen] = useState(false)
  const [terminalSearchQuery, setTerminalSearchQuery] = useState('')
  const [terminalSearchResult, setTerminalSearchResult] = useState<TerminalSearchResult | null>(null)
  const [terminalError, setTerminalError] = useState<string | null>(null)

  const handleTerminalInput = useCallback((data: string) => {
    sendInput(data, agent.id)
  }, [agent.id, sendInput])

  const handleTerminalResize = useCallback((cols: number, rows: number) => {
    return resizeAgent(agent.id, cols, rows)
  }, [agent.id, resizeAgent])

  const handleFollowOutputChange = useCallback((state: TerminalFollowState) => {
    setFollowOutputState(state)
    onFollowOutputChange?.(agent.id, state)
  }, [agent.id, onFollowOutputChange])

  const handleTerminalReady = useCallback(() => {
    setTerminalError(null)
  }, [])

  const handleTerminalError = useCallback((error: Error) => {
    setTerminalError(error.message || copy.terminalSessionUnavailable)
  }, [copy.terminalSessionUnavailable])

  const { focus, scrollToBottom, search, clearSearch } = usePooledTerminal({
    agentId: agent.id,
    containerRef: terminalContainerRef,
    onInput: handleTerminalInput,
    onResize: handleTerminalResize,
    onSessionOutput,
    suppressRendererCursor: shouldSuppressRendererCursorForAgent(agent.command),
    onFollowOutputChange: handleFollowOutputChange,
    onPathOpen: onOpenPath,
    onPathResolve: onResolvePath,
    onReady: handleTerminalReady,
    onError: handleTerminalError,
  })

  useEffect(() => {
    if (!active || focusSignal <= 0) return
    if (isMobileViewport()) return
    focus()
  }, [active, focus, focusSignal])

  useEffect(() => {
    return () => {
      void clearSearch()
    }
  }, [clearSearch])

  const runTerminalSearch = useCallback((
    query: string,
    direction: TerminalSearchDirection = 'next',
    options?: { incremental?: boolean },
  ) => {
    const trimmedQuery = query.trim()
    if (!trimmedQuery) {
      setTerminalSearchResult(null)
      void clearSearch()
      return
    }
    search(trimmedQuery, direction, options)
      .then(setTerminalSearchResult)
      .catch(error => {
        console.error('Failed to search terminal:', error)
        setTerminalSearchResult({ found: false, resultIndex: 0, resultCount: 0 })
      })
  }, [clearSearch, search])

  const openTerminalSearch = useCallback(() => {
    setTerminalSearchOpen(true)
    window.requestAnimationFrame(() => {
      const input = searchInputRef.current
      input?.focus()
      input?.select()
    })
  }, [])

  const closeTerminalSearch = useCallback(() => {
    setTerminalSearchOpen(false)
    setTerminalSearchQuery('')
    setTerminalSearchResult(null)
    void clearSearch()
    if (!isMobileViewport()) focus()
  }, [clearSearch, focus])

  useEffect(() => {
    if (!terminalSearchOpen) return
    runTerminalSearch(terminalSearchQuery, 'next', { incremental: true })
  }, [runTerminalSearch, terminalSearchOpen, terminalSearchQuery])

  const handleTerminalFindKeyDown = useCallback((event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key' | 'target' | 'preventDefault' | 'stopPropagation'>) => {
    if (!isTerminalFindTarget(event.target, terminalPaneRef.current)) return
    if (isPrimaryFindShortcut(event)) {
      event.preventDefault()
      event.stopPropagation()
      openTerminalSearch()
      return
    }

    if (terminalSearchOpen && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeTerminalSearch()
    }
  }, [closeTerminalSearch, openTerminalSearch, terminalSearchOpen])

  useEffect(() => {
    if (!active) return

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      handleTerminalFindKeyDown(event)
    }
    window.addEventListener('keydown', handleWindowKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown, true)
    }
  }, [active, handleTerminalFindKeyDown])

  const activateAndFocus = useCallback((event?: ReactPointerEvent) => {
    const target = event?.target
    const clickedTerminalSurface = target instanceof Element && target.closest('.xterm')
    const pointerType = event && 'pointerType' in event ? event.pointerType : ''
    if (event && event.button !== 0) {
      if (!active) onActivate(agent.id, { focusTerminal: false })
      return
    }
    if (clickedTerminalSurface) {
      if (!active) onActivate(agent.id, { focusTerminal: false })
      if (!isMobileViewport() || (pointerType && pointerType !== 'touch')) {
        focus()
      }
      return
    }
    onActivate(agent.id)
    if (isMobileViewport() && (!pointerType || pointerType === 'touch')) {
      return
    }
    focus()
  }, [active, agent.id, focus, onActivate])

  const jumpToLatestOutput = useCallback(() => {
    scrollToBottom()
    if (isMobileViewport()) return
    focus()
  }, [focus, scrollToBottom])

  const retryTerminalAttach = useCallback(() => {
    setTerminalError(null)
    focus()
  }, [focus])

  const shouldShowJumpButton = !followOutputState.following || followOutputState.hasUnreadOutput
  const searchStatus = terminalSearchStatus(terminalSearchQuery, terminalSearchResult, copy)

  return (
    <section
      className={`code-terminal-pane ${active ? 'active' : ''}`}
      data-testid="code-terminal-pane"
      data-agent-id={agent.id}
      ref={terminalPaneRef}
      onKeyDownCapture={handleTerminalFindKeyDown}
      onPointerDown={activateAndFocus}
    >
      <div
        className="code-terminal-container terminal-container"
        data-testid="code-terminal-container"
        ref={terminalContainerRef}
      />
      {terminalError ? (
        <div
          className="code-terminal-status-card"
          data-testid="code-terminal-status-card"
          title={terminalError}
          onPointerDown={event => event.stopPropagation()}
          onMouseDown={event => event.stopPropagation()}
        >
          <span>{copy.terminalSessionUnavailable}</span>
          <button type="button" onClick={retryTerminalAttach}>
            {copy.retry}
          </button>
        </div>
      ) : null}
      {terminalSearchOpen ? (
        <form
          className="code-terminal-search"
          data-testid="code-terminal-search"
          onPointerDown={event => event.stopPropagation()}
          onMouseDown={event => event.stopPropagation()}
          onSubmit={event => {
            event.preventDefault()
            runTerminalSearch(terminalSearchQuery, 'next')
          }}
        >
          <input
            ref={searchInputRef}
            value={terminalSearchQuery}
            placeholder={copy.terminalSearchPlaceholder}
            aria-label={copy.terminalSearchPlaceholder}
            data-testid="code-terminal-search-input"
            spellCheck={false}
            onChange={event => setTerminalSearchQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                runTerminalSearch(terminalSearchQuery, event.shiftKey ? 'previous' : 'next')
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                closeTerminalSearch()
              }
            }}
          />
          <span className={`code-terminal-search-status ${terminalSearchResult && !terminalSearchResult.found ? 'empty' : ''}`}>
            {searchStatus}
          </span>
          <button
            type="button"
            className="code-terminal-search-button"
            aria-label={copy.terminalSearchPrevious}
            title={copy.terminalSearchPrevious}
            onClick={() => runTerminalSearch(terminalSearchQuery, 'previous')}
          >
            ↑
          </button>
          <button
            type="button"
            className="code-terminal-search-button"
            aria-label={copy.terminalSearchNext}
            title={copy.terminalSearchNext}
            onClick={() => runTerminalSearch(terminalSearchQuery, 'next')}
          >
            ↓
          </button>
          <button
            type="button"
            className="code-terminal-search-button close"
            aria-label={copy.terminalSearchClose}
            title={copy.terminalSearchClose}
            onClick={closeTerminalSearch}
          >
            ×
          </button>
        </form>
      ) : null}
      {shouldShowJumpButton ? (
        <button
          type="button"
          className="code-terminal-jump-bottom"
          data-testid="code-terminal-jump-bottom"
          aria-label="Jump to latest output"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            jumpToLatestOutput()
          }}
        >
          ↓
        </button>
      ) : null}
    </section>
  )
}
