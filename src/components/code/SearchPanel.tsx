import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { CloseGlyph, SearchGlyph } from '@/components/IconGlyphs'
import { agentDisplayName } from '@/lib/format'
import type { Agent } from '@/types/agent'
import {
  agentSessionId,
  compactPath,
  effortLabel,
  formatAgentSessionWorkspace,
  projectWorkspaceForAgent,
} from './model'
import { buildAgentRowDisplayState } from './agent-row-state'
import type { CodeCopy } from './copy'
import type { AgentSessionHistoryItem, ProjectGroup } from './types'

interface SearchPanelProps {
  query: string
  displayedProjects: ProjectGroup[]
  hasQuery: boolean
  loading: boolean
  resultCount: number
  selectedAgentId: string | null
  selectedSessionHandle: string | null
  inputRef: RefObject<HTMLInputElement | null>
  onQueryChange: (value: string) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  onClearSearch: () => void
  onOpenAgent: (agentId: string) => void
  onOpenSession: (session: AgentSessionHistoryItem) => void
  copy: CodeCopy
}

export function SearchPanel({
  query,
  displayedProjects,
  hasQuery,
  loading,
  resultCount,
  selectedAgentId,
  selectedSessionHandle,
  inputRef,
  onQueryChange,
  onKeyDown,
  onClearSearch,
  onOpenAgent,
  onOpenSession,
  copy,
}: SearchPanelProps) {
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    window.requestAnimationFrame(() => {
      input.focus({ preventScroll: true })
    })
  }, [inputRef])

  return (
    <div className="code-search-panel" data-testid="code-search-panel">
      <div className="code-search-panel-header">
        <h2>{copy.search}</h2>
        {hasQuery ? <span>{copy.resultsCount(resultCount)}</span> : null}
      </div>
      <div className="code-search-panel-input" data-testid="code-search-box">
        <span className="code-search-panel-icon" aria-hidden="true"><SearchGlyph /></span>
        <input
          ref={inputRef}
          type="text"
          role="searchbox"
          name="farming-workspace-search"
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="search"
          data-lpignore="true"
          data-1p-ignore="true"
          data-bwignore="true"
          data-form-type="other"
          value={query}
          onChange={event => onQueryChange(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder={copy.searchProjectsOrAgents}
          aria-label={copy.searchProjectsOrAgents}
        />
        {query && (
          <button type="button" onClick={onClearSearch} aria-label={copy.clearSearch}>
            <CloseGlyph />
          </button>
        )}
      </div>
      {hasQuery && loading && resultCount === 0 ? (
        <div className="code-empty-workspace" data-testid="code-search-loading">
          <h2>{copy.searching}</h2>
        </div>
      ) : hasQuery && resultCount === 0 ? (
        <div className="code-empty-workspace" data-testid="code-empty-search">
          <h2>{copy.noMatchingAgents}</h2>
        </div>
      ) : hasQuery ? (
        <div className="code-search-results">
          {displayedProjects.map(project => (
            <section key={project.id} className="code-search-result-group">
              <h3>{project.name}</h3>
              {project.agents.map(agent => (
                <AgentSearchResult
                  key={agent.id}
                  agent={agent}
                  selected={agent.id === selectedAgentId}
                  onOpen={() => onOpenAgent(agent.id)}
                />
              ))}
              {project.agentSessions.map(session => {
                const sessionHandle = agentSessionId(session)
                const sessionDetail = [
                  session.providerName || session.provider,
                  session.model,
                  session.effort ? effortLabel(session.effort) : '',
                ].filter(Boolean).join(' · ') || formatAgentSessionWorkspace(session)
                return (
                  <button
                    key={sessionHandle}
                    type="button"
                    className={`code-search-result code-session-result ${sessionHandle === selectedSessionHandle ? 'active' : ''}`}
                    data-testid="code-session-search-result"
                    onClick={() => onOpenSession(session)}
                  >
                    <span className="code-search-result-copy">
                      <strong>{session.title || copy.sessionFallbackTitle(session.providerName)}</strong>
                      <span>{sessionDetail}</span>
                    </span>
                  </button>
                )
              })}
            </section>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function AgentSearchResult({
  agent,
  selected,
  onOpen,
}: {
  agent: Agent
  selected: boolean
  onOpen: () => void
}) {
  const rowState = buildAgentRowDisplayState({ kind: 'agent', agent })
  const providerLabel = agentDisplayName(agent.providerSessionProvider || agent.command)

  return (
    <button
      type="button"
      className={`code-search-result ${rowState.statusIndicatorVisible ? '' : 'no-status'} ${selected ? 'active' : ''}`}
      data-testid="code-search-result"
      title={rowState.rowTitle || rowState.title}
      onClick={onOpen}
    >
      {rowState.statusIndicatorVisible && (
        <span className={`code-agent-dot ${rowState.lifecycleStatus} ${rowState.turnActive ? 'turn-active' : ''}`} />
      )}
      <span className="code-search-result-copy">
        <strong>{rowState.title}</strong>
        <span>{providerLabel || compactPath(projectWorkspaceForAgent(agent))}</span>
      </span>
    </button>
  )
}
