import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { Agent } from '@/types/agent'
import { usePooledTerminal } from '@/hooks/usePooledTerminal'
import { isMobileTouchViewport } from '@/lib/responsive-mode'
import type { TerminalPathOpenTarget, TerminalSearchDirection, TerminalSearchResult } from '@/lib/terminal-session-pool'
import type { TerminalSearchOptions } from '@/lib/terminal-search'
import { sessionBootstrapStateFromPayload } from '@/lib/terminal-bootstrap'
import type { CodeCopy } from './code/copy'
import {
  ArrowDownGlyph,
  ArrowUpGlyph,
  CaseSensitiveGlyph,
  CloseGlyph,
  RegexGlyph,
  WholeWordGlyph,
} from './IconGlyphs'

interface AgentTerminalPaneProps {
  agent: Agent
  active: boolean
  focusSignal: number
  onActivate: (agentId: string, options?: { focusTerminal?: boolean }) => void
  onSessionOutput: (agentId: string, handler: (data: string, replace?: boolean, outputSeq?: number | null, runtimeEpoch?: string, stateRevision?: number | null, cols?: number, rows?: number, kind?: 'output' | 'resize' | 'clear') => void) => () => void
  onOpenPath?: (agentId: string, target: TerminalPathOpenTarget) => void
  onResolvePath?: (agentId: string, target: TerminalPathOpenTarget) => Promise<TerminalPathOpenTarget | null> | TerminalPathOpenTarget | null
  onFollowOutputChange?: (agentId: string, state: TerminalFollowState) => void
  onReadLatest?: (
    agentId: string,
    readCut?: { runtimeEpoch: string; outputSeq: number } | null,
  ) => void
  copy: CodeCopy
}

interface TerminalFollowState {
  following: boolean
  hasUnreadOutput: boolean
}

type TerminalSearchOptionKey = 'caseSensitive' | 'wholeWord' | 'regex'

function shouldSuppressRendererCursorForAgent(command?: string) {
  const program = String(command || '').trim().split(/\s+/)[0] || ''
  return [
    'claude',
    'codex',
    'qwen',
    'opencode',
    'qodercli',
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

function isTerminalFindNavigationShortcut(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'key'>) {
  return event.key === 'F3' && !event.metaKey && !event.ctrlKey && !event.altKey
}

function terminalSearchOptionShortcut(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key' | 'code'>): TerminalSearchOptionKey | null {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return null
  const key = event.code || `Key${event.key.toUpperCase()}`
  if (key === 'KeyC') return 'caseSensitive'
  if (key === 'KeyW') return 'wholeWord'
  if (key === 'KeyR') return 'regex'
  return null
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

function terminalSearchQueryFromSelection(selection: string) {
  const normalized = selection.replace(/\r/g, '').trim()
  if (!normalized) return ''
  const lines = normalized.split('\n').map(line => line.trim()).filter(Boolean)
  if (lines.length !== 1) return ''
  const firstLine = lines[0]
  return firstLine ? firstLine.slice(0, 240) : ''
}

function terminalSearchOptionButtonClass(enabled?: boolean) {
  return `code-terminal-search-button option${enabled ? ' active' : ''}`
}

export function AgentTerminalPane({
  agent,
  active,
  focusSignal,
  onActivate,
  onSessionOutput,
  onOpenPath,
  onResolvePath,
  onFollowOutputChange,
  onReadLatest,
  copy,
}: AgentTerminalPaneProps) {
  const terminalPaneRef = useRef<HTMLElement>(null)
  const terminalContainerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [followOutputState, setFollowOutputState] = useState({
    following: true,
    hasUnreadOutput: false,
  })
  const [followOutputStateKnown, setFollowOutputStateKnown] = useState(false)
  const [terminalSearchOpen, setTerminalSearchOpen] = useState(false)
  const [terminalSearchQuery, setTerminalSearchQuery] = useState('')
  const [terminalSearchOptions, setTerminalSearchOptions] = useState<TerminalSearchOptions>({})
  const [terminalSearchResult, setTerminalSearchResult] = useState<TerminalSearchResult | null>(null)
  const [terminalError, setTerminalError] = useState<string | null>(null)
  const appServerWaitingForFirstMessage = agent.codexCliObserverDeferred === true
  const bootstrapState = sessionBootstrapStateFromPayload({
    session: {
      runtimeEpoch: agent.runtimeEpoch,
      output: agent.output,
      renderOutput: agent.renderOutput,
      outputSeq: agent.outputSeq,
      stateRevision: agent.stateRevision,
      previewSnapshot: agent.previewSnapshot,
      previewCols: agent.previewCols,
      previewRows: agent.previewRows,
    },
  })
  const handleFollowOutputChange = useCallback((state: TerminalFollowState) => {
    setFollowOutputStateKnown(true)
    setFollowOutputState(state)
    onFollowOutputChange?.(agent.id, state)
  }, [agent.id, onFollowOutputChange])

  const handleTerminalReady = useCallback(() => {
    setTerminalError(null)
  }, [])

  const handleTerminalError = useCallback((error: Error) => {
    setTerminalError(error.message || copy.terminalSessionUnavailable)
  }, [copy.terminalSessionUnavailable])

  const {
    focus,
    refreshLayout,
    getSelectionNow,
    getReadCutNow,
    scrollToBottom,
    search,
    clearSearch,
  } = usePooledTerminal({
    agentId: agent.id,
    containerRef: terminalContainerRef,
    onSessionOutput,
    inputDisabled: appServerWaitingForFirstMessage,
    suppressRendererCursor: shouldSuppressRendererCursorForAgent(agent.command),
    onFollowOutputChange: handleFollowOutputChange,
    onPathOpen: onOpenPath,
    onPathResolve: onResolvePath,
    onReady: handleTerminalReady,
    onError: handleTerminalError,
    bootstrapState,
  })

  useEffect(() => {
    if (
      !active
      || !followOutputStateKnown
      || agent.unread !== true
      || !followOutputState.following
      || followOutputState.hasUnreadOutput
    ) return
    const readCut = getReadCutNow()
    if (!readCut) return
    const attentionOutputEpoch = agent.attentionOutputEpoch || ''
    const attentionOutputSeq = Number(agent.attentionOutputSeq)
    if (
      attentionOutputEpoch
      && (
        attentionOutputEpoch !== readCut.runtimeEpoch
        || (Number.isFinite(attentionOutputSeq) && attentionOutputSeq > readCut.outputSeq)
      )
    ) return
    onReadLatest?.(agent.id, readCut)
  }, [
    active,
    agent.attentionOutputEpoch,
    agent.attentionOutputSeq,
    agent.id,
    agent.unread,
    followOutputState.following,
    followOutputState.hasUnreadOutput,
    followOutputStateKnown,
    getReadCutNow,
    onReadLatest,
  ])

  const refreshVisibleTerminalLayout = useCallback((autoFocus = false) => {
    window.requestAnimationFrame(() => {
      refreshLayout({ autoFocus })
      window.requestAnimationFrame(() => refreshLayout({ autoFocus }))
    })
  }, [refreshLayout])

  useEffect(() => {
    if (!active) return
    refreshVisibleTerminalLayout(false)
  }, [active, refreshVisibleTerminalLayout])

  useEffect(() => {
    if (!active || focusSignal <= 0) return
    if (isMobileViewport()) return
    refreshVisibleTerminalLayout(true)
    focus()
  }, [active, focus, focusSignal, refreshVisibleTerminalLayout])

  useEffect(() => {
    return () => {
      void clearSearch()
    }
  }, [clearSearch])

  const runTerminalSearch = useCallback((
    query: string,
    direction: TerminalSearchDirection = 'next',
    options?: TerminalSearchOptions,
  ) => {
    const trimmedQuery = query.trim()
    if (!trimmedQuery) {
      setTerminalSearchResult(null)
      void clearSearch()
      return
    }
    search(trimmedQuery, direction, { ...terminalSearchOptions, ...options })
      .then(setTerminalSearchResult)
      .catch(error => {
        console.error('Failed to search terminal:', error)
        setTerminalSearchResult({ found: false, resultIndex: 0, resultCount: 0 })
      })
  }, [clearSearch, search, terminalSearchOptions])

  const toggleTerminalSearchOption = useCallback((option: TerminalSearchOptionKey) => {
    setTerminalSearchOptions(previous => ({
      ...previous,
      [option]: previous[option] !== true,
    }))
  }, [])

  const openTerminalSearch = useCallback(() => {
    const selectedQuery = terminalSearchQueryFromSelection(getSelectionNow())
    if (selectedQuery) {
      setTerminalSearchQuery(selectedQuery)
      runTerminalSearch(selectedQuery, 'next', { incremental: true })
    }
    setTerminalSearchOpen(true)
    window.requestAnimationFrame(() => {
      const input = searchInputRef.current
      input?.focus()
      input?.select()
    })
  }, [getSelectionNow, runTerminalSearch])

  const closeTerminalSearch = useCallback(() => {
    setTerminalSearchOpen(false)
    setTerminalSearchResult(null)
    void clearSearch()
    if (!isMobileViewport()) focus()
  }, [clearSearch, focus])

  const handleTerminalSearchKeyDown = useCallback((event: ReactKeyboardEvent<HTMLFormElement>) => {
    const optionShortcut = terminalSearchOptionShortcut(event.nativeEvent)
    if (optionShortcut) {
      event.preventDefault()
      event.stopPropagation()
      toggleTerminalSearchOption(optionShortcut)
      return
    }

    if (event.target === searchInputRef.current && event.key === 'Enter') {
      event.preventDefault()
      runTerminalSearch(terminalSearchQuery, event.shiftKey ? 'previous' : 'next')
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeTerminalSearch()
    }
  }, [closeTerminalSearch, runTerminalSearch, terminalSearchQuery, toggleTerminalSearchOption])

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

    if (terminalSearchOpen && isTerminalFindNavigationShortcut(event)) {
      event.preventDefault()
      event.stopPropagation()
      runTerminalSearch(terminalSearchQuery, event.shiftKey ? 'previous' : 'next')
      return
    }

    if (terminalSearchOpen && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeTerminalSearch()
    }
  }, [closeTerminalSearch, openTerminalSearch, runTerminalSearch, terminalSearchOpen, terminalSearchQuery])

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
    onReadLatest?.(agent.id, getReadCutNow())
    if (isMobileViewport()) return
    focus()
  }, [agent.id, focus, getReadCutNow, onReadLatest, scrollToBottom])

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
      {appServerWaitingForFirstMessage ? (
        <div
          className="code-terminal-status-card"
          data-testid="code-terminal-app-server-ready"
          onPointerDown={event => event.stopPropagation()}
          onMouseDown={event => event.stopPropagation()}
        >
          <span>{copy.appServerWaitingForFirstMessage}</span>
        </div>
      ) : terminalError ? (
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
          onKeyDown={handleTerminalSearchKeyDown}
        >
          <input
            ref={searchInputRef}
            type="search"
            name="farming-terminal-search"
            inputMode="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            value={terminalSearchQuery}
            placeholder={copy.terminalSearchPlaceholder}
            aria-label={copy.terminalSearchPlaceholder}
            data-testid="code-terminal-search-input"
            spellCheck={false}
            enterKeyHint="search"
            data-lpignore="true"
            data-1p-ignore="true"
            data-bwignore="true"
            data-form-type="other"
            onChange={event => setTerminalSearchQuery(event.target.value)}
          />
          <span className={`code-terminal-search-status ${terminalSearchResult && !terminalSearchResult.found ? 'empty' : ''}`}>
            {searchStatus}
          </span>
          <button
            type="button"
            className={terminalSearchOptionButtonClass(terminalSearchOptions.caseSensitive)}
            aria-label={copy.terminalSearchCaseSensitive}
            aria-pressed={terminalSearchOptions.caseSensitive === true}
            title={copy.terminalSearchCaseSensitive}
            data-testid="code-terminal-search-case-sensitive"
            onClick={() => toggleTerminalSearchOption('caseSensitive')}
          >
            <CaseSensitiveGlyph />
          </button>
          <button
            type="button"
            className={terminalSearchOptionButtonClass(terminalSearchOptions.wholeWord)}
            aria-label={copy.terminalSearchWholeWord}
            aria-pressed={terminalSearchOptions.wholeWord === true}
            title={copy.terminalSearchWholeWord}
            data-testid="code-terminal-search-whole-word"
            onClick={() => toggleTerminalSearchOption('wholeWord')}
          >
            <WholeWordGlyph />
          </button>
          <button
            type="button"
            className={terminalSearchOptionButtonClass(terminalSearchOptions.regex)}
            aria-label={copy.terminalSearchRegex}
            aria-pressed={terminalSearchOptions.regex === true}
            title={copy.terminalSearchRegex}
            data-testid="code-terminal-search-regex"
            onClick={() => toggleTerminalSearchOption('regex')}
          >
            <RegexGlyph />
          </button>
          <button
            type="button"
            className="code-terminal-search-button"
            aria-label={copy.terminalSearchPrevious}
            title={copy.terminalSearchPrevious}
            onClick={() => runTerminalSearch(terminalSearchQuery, 'previous')}
          >
            <ArrowUpGlyph />
          </button>
          <button
            type="button"
            className="code-terminal-search-button"
            aria-label={copy.terminalSearchNext}
            title={copy.terminalSearchNext}
            onClick={() => runTerminalSearch(terminalSearchQuery, 'next')}
          >
            <ArrowDownGlyph />
          </button>
          <button
            type="button"
            className="code-terminal-search-button close"
            aria-label={copy.terminalSearchClose}
            title={copy.terminalSearchClose}
            onClick={closeTerminalSearch}
          >
            <CloseGlyph />
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
          <ArrowDownGlyph />
        </button>
      ) : null}
    </section>
  )
}
