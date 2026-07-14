import { useEffect, useState } from 'react'
import type { Agent, TaskHistoryEntry } from '@/types/agent'
import { agentTitle, formatRelativeAge } from '@/lib/format'
import { formatWorkspaceForDisplay } from '@/lib/workspace-options'
import { ArrowRightGlyph, CloseGlyph, ExternalLinkGlyph, SearchGlyph } from '@/components/IconGlyphs'
import {
  agentSessionId,
  agentSessionUpdatedAt,
  effortLabel,
  formatAgentSessionWorkspace,
  projectWorkspaceForAgent,
} from './model'
import type { CodeCopy } from './copy'
import type { AgentSessionHistoryItem } from './types'
import { resumedAgentSessionFromSource } from './session-display'

export type HistoryAgentItem =
  | { kind: 'run'; historyKey: string; updatedAt: number; entry: TaskHistoryEntry }
  | { kind: 'agent'; historyKey: string; updatedAt: number; agent: Agent }
  | { kind: 'session'; historyKey: string; updatedAt: number; session: AgentSessionHistoryItem }

interface HistoryPanelProps {
  archivedRuns: TaskHistoryEntry[]
  archivedAgents: Agent[]
  agentSessions: AgentSessionHistoryItem[]
  now: number
  onResumeSession: (provider: string, sessionId: string, providerHomeId?: string) => void
  onContinueRun: (entry: TaskHistoryEntry) => void
  onOpenArchivedAgent: (agentId: string) => void
  onRestoreArchivedAgent: (agentId: string) => void
  searchAgentSessions: (query: string, signal: AbortSignal) => Promise<AgentSessionHistoryItem[]>
  copy: CodeCopy
}

const HISTORY_SEARCH_DEBOUNCE_MS = 150

function normalizeHistoryProvider(provider?: string) {
  const value = String(provider || '').trim().toLowerCase()
  return value === 'codex' || value === 'claude' || value === 'qoder' ? value : ''
}

function resumedSessionFromHistorySource(source?: string) {
  const session = resumedAgentSessionFromSource(source)
  if (!session) return null
  const provider = normalizeHistoryProvider(session.provider)
  const sessionId = String(session.sessionId || '').trim()
  return provider && sessionId ? { ...session, provider, sessionId } : null
}

function historyRunTitle(entry: TaskHistoryEntry) {
  return entry.title || entry.task || entry.command || 'History agent'
}

function historyRunWorkspace(entry: TaskHistoryEntry) {
  return entry.projectWorkspace || entry.cwd || ''
}

function historyMeta(...parts: Array<string | undefined | null>) {
  return parts.map(part => String(part || '').trim()).filter(Boolean).join(' · ')
}

function historyRunMeta(entry: TaskHistoryEntry) {
  return historyMeta(formatWorkspaceForDisplay(historyRunWorkspace(entry)))
}

function historyAgentMeta(agent: Agent) {
  return historyMeta(
    agent.providerSessionProvider || agent.engineName,
    formatWorkspaceForDisplay(projectWorkspaceForAgent(agent))
  )
}

function historySessionMeta(session: AgentSessionHistoryItem) {
  return historyMeta(
    session.providerName || session.provider,
    session.model,
    session.effort ? effortLabel(session.effort) : '',
    formatAgentSessionWorkspace(session)
  )
}

function historyRunUpdatedAt(entry: TaskHistoryEntry) {
  return Math.max(entry.archivedAt || 0, entry.lastActivity || 0, entry.startedAt || 0)
}

function historyAgentUpdatedAt(agent: Agent) {
  return Math.max(agent.archivedAt || 0, agent.lastActivity || 0, agent.startedAt || 0)
}

function historyItemResumeSession(item: HistoryAgentItem) {
  if (item.kind === 'session') {
    const provider = normalizeHistoryProvider(item.session.provider)
    const sessionId = String(item.session.id || '').trim()
    return provider && sessionId ? {
      provider,
      sessionId,
      providerHomeId: item.session.providerHomeId || 'default',
    } : null
  }

  if (item.kind === 'agent') {
    const provider = normalizeHistoryProvider(item.agent.providerSessionProvider)
    const sessionId = String(item.agent.providerSessionId || '').trim()
    if (provider && sessionId && item.agent.providerSessionTemporary !== true) {
      return {
        provider,
        sessionId,
        providerHomeId: item.agent.providerHomeId || 'default',
      }
    }

    return resumedSessionFromHistorySource(item.agent.source)
  }

  return resumedSessionFromHistorySource(item.entry.source)
}

function historyItemResumeKey(item: HistoryAgentItem) {
  const resumed = historyItemResumeSession(item)
  return resumed ? `resume:${resumed.provider}:${resumed.providerHomeId || 'default'}:${resumed.sessionId}` : ''
}

function historyItemDisplayPriority(item: HistoryAgentItem) {
  if (item.kind === 'session') return 30
  if (item.kind === 'agent') return 20
  return 10
}

function shouldReplaceHistoryItem(current: HistoryAgentItem, candidate: HistoryAgentItem) {
  if (candidate.updatedAt !== current.updatedAt) {
    return candidate.updatedAt > current.updatedAt
  }
  return historyItemDisplayPriority(candidate) > historyItemDisplayPriority(current)
}

function historySessionDisplayKey(item: HistoryAgentItem) {
  if (item.kind !== 'session') return ''
  const title = String(item.session.title || '').trim().toLocaleLowerCase()
  const workspace = String(formatAgentSessionWorkspace(item.session) || '').trim().toLocaleLowerCase()
  const provider = normalizeHistoryProvider(item.session.provider)
  const home = String(item.session.providerHomeId || 'default').trim().toLocaleLowerCase()
  // Empty/provider-default titles are not meaningful enough to collapse.
  return title.length > 4 && workspace ? `${provider}:${home}:${workspace}:${title}` : ''
}

export function dedupeHistoryAgentItems(items: HistoryAgentItem[]) {
  const retainedItems: HistoryAgentItem[] = []
  const resumableItems = new Map<string, HistoryAgentItem>()

  items.forEach(item => {
    const resumeKey = historyItemResumeKey(item)
    if (!resumeKey) {
      retainedItems.push(item)
      return
    }

    const current = resumableItems.get(resumeKey)
    if (!current || shouldReplaceHistoryItem(current, item)) {
      resumableItems.set(resumeKey, item)
    }
  })

  const exactDedupe = [
    ...retainedItems,
    ...resumableItems.values(),
  ]
  const visualSessions = new Map<string, HistoryAgentItem>()
  return exactDedupe.filter(item => {
    const displayKey = historySessionDisplayKey(item)
    if (!displayKey) return true
    const current = visualSessions.get(displayKey)
    if (!current || shouldReplaceHistoryItem(current, item)) {
      visualSessions.set(displayKey, item)
      return true
    }
    return false
  }).filter(item => {
    const displayKey = historySessionDisplayKey(item)
    return !displayKey || visualSessions.get(displayKey) === item
  }).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function buildHistoryAgentItems(
  archivedRuns: TaskHistoryEntry[],
  archivedAgents: Agent[],
  agentSessions: AgentSessionHistoryItem[]
): HistoryAgentItem[] {
  return dedupeHistoryAgentItems([
    ...archivedRuns.map(entry => ({
      kind: 'run' as const,
      historyKey: `run:${entry.id}`,
      updatedAt: historyRunUpdatedAt(entry),
      entry,
    })),
    ...archivedAgents.map(agent => ({
      kind: 'agent' as const,
      historyKey: `agent:${agent.id}`,
      updatedAt: historyAgentUpdatedAt(agent),
      agent,
    })),
    ...agentSessions.map(session => ({
      kind: 'session' as const,
      historyKey: agentSessionId(session),
      updatedAt: agentSessionUpdatedAt(session),
      session,
    })),
  ])
}

export function mergeHistoryAgentSessions(
  loadedSessions: AgentSessionHistoryItem[],
  searchedSessions: AgentSessionHistoryItem[]
) {
  const sessionsById = new Map(loadedSessions.map(session => [agentSessionId(session), session]))
  searchedSessions.forEach(session => sessionsById.set(agentSessionId(session), session))
  return Array.from(sessionsById.values())
}

function normalizeHistorySearchValue(value: unknown) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase()
}

export function filterHistoryAgentItems(items: HistoryAgentItem[], query: string) {
  const normalizedQuery = normalizeHistorySearchValue(query).trim()
  if (!normalizedQuery) return items

  return items.filter(item => {
    if (item.kind === 'run') {
      return normalizeHistorySearchValue([
        historyRunTitle(item.entry),
        historyRunMeta(item.entry),
        item.entry.command,
        item.entry.task,
      ].join('\n')).includes(normalizedQuery)
    }

    if (item.kind === 'agent') {
      return normalizeHistorySearchValue([
        agentTitle(item.agent),
        historyAgentMeta(item.agent),
        item.agent.command,
      ].join('\n')).includes(normalizedQuery)
    }

    return normalizeHistorySearchValue([
      item.session.title,
      historySessionMeta(item.session),
      item.session.provider,
    ].join('\n')).includes(normalizedQuery)
  })
}

export function HistoryPanel({
  archivedRuns,
  archivedAgents,
  agentSessions,
  now,
  onResumeSession,
  onContinueRun,
  onOpenArchivedAgent,
  onRestoreArchivedAgent,
  searchAgentSessions,
  copy,
}: HistoryPanelProps) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim()
  const hasQuery = Boolean(normalizedQuery)
  const [searchState, setSearchState] = useState<{
    query: string
    sessions: AgentSessionHistoryItem[]
    loading: boolean
  }>({ query: '', sessions: [], loading: false })
  const searchedSessions = searchState.query === normalizedQuery ? searchState.sessions : []
  const historyAgents = buildHistoryAgentItems(
    archivedRuns,
    archivedAgents,
    hasQuery ? mergeHistoryAgentSessions(agentSessions, searchedSessions) : agentSessions
  )
  const displayedHistoryAgents = filterHistoryAgentItems(historyAgents, normalizedQuery)
  const totalHistoryItems = historyAgents.length
  const searchLoading = hasQuery && (
    searchState.query !== normalizedQuery || searchState.loading
  )

  useEffect(() => {
    if (!normalizedQuery) {
      setSearchState({ query: '', sessions: [], loading: false })
      return undefined
    }

    const controller = new AbortController()
    setSearchState({ query: normalizedQuery, sessions: [], loading: true })
    const timer = window.setTimeout(() => {
      searchAgentSessions(normalizedQuery, controller.signal)
        .then(sessions => {
          if (!controller.signal.aborted) {
            setSearchState({ query: normalizedQuery, sessions, loading: false })
          }
        })
        .catch(error => {
          if (error instanceof DOMException && error.name === 'AbortError') return
          if (!controller.signal.aborted) {
            setSearchState({ query: normalizedQuery, sessions: [], loading: false })
          }
        })
    }, HISTORY_SEARCH_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [normalizedQuery, searchAgentSessions])

  return (
    <div className="code-history-panel" data-testid="code-history-panel">
      <div className="code-history-panel-header">
        <h2>{copy.history}</h2>
        <div className="code-search-panel-input code-history-search" data-testid="code-history-search-box">
          <span className="code-search-panel-icon" aria-hidden="true"><SearchGlyph /></span>
          <input
            type="text"
            role="searchbox"
            inputMode="search"
            value={query}
            onChange={event => setQuery(event.currentTarget.value)}
            placeholder={copy.searchHistory}
            aria-label={copy.searchHistory}
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label={copy.clearSearch}>
              <CloseGlyph />
            </button>
          )}
        </div>
      </div>
      {totalHistoryItems === 0 ? (
        <div className="code-empty-workspace">
          <h2>{copy.noHistoryYet}</h2>
          <p>{copy.noHistoryDescription}</p>
        </div>
      ) : hasQuery && searchLoading && displayedHistoryAgents.length === 0 ? (
        <div className="code-empty-workspace" data-testid="code-history-search-loading">
          <h2>{copy.searching}</h2>
        </div>
      ) : hasQuery && displayedHistoryAgents.length === 0 ? (
        <div className="code-empty-workspace" data-testid="code-empty-history-search">
          <h2>{copy.noMatchingAgents}</h2>
        </div>
      ) : (
        <div className="code-history-list">
          <section className="code-history-section" data-testid="code-history-agents">
            {displayedHistoryAgents.map(item => {
              if (item.kind === 'run') {
                const { entry } = item
                return (
                  <article key={item.historyKey} className="code-history-card archived" data-testid="code-archived-run-card">
                    <div>
                      <h3>{historyRunTitle(entry)}</h3>
                      <p>{historyRunMeta(entry)}</p>
                    </div>
                    <div className="code-history-actions">
                      <span>{formatRelativeAge(item.updatedAt, now)}</span>
                      <button
                        type="button"
                        data-testid="code-archived-run-continue"
                        onClick={() => onContinueRun(entry)}
                        aria-label={copy.continueRun}
                        title={copy.continueRun}
                      >
                        <ArrowRightGlyph />
                      </button>
                    </div>
                  </article>
                )
              }

              if (item.kind === 'agent') {
                const { agent } = item
                return (
                  <article key={item.historyKey} className="code-history-card archived" data-testid="code-archived-agent-card">
                    <div>
                      <h3>{agentTitle(agent)}</h3>
                      <p>{historyAgentMeta(agent)}</p>
                    </div>
                    <div className="code-history-actions">
                      <span>{formatRelativeAge(item.updatedAt, now)}</span>
                      <button
                        type="button"
                        data-testid="code-archived-agent-open"
                        onClick={() => onOpenArchivedAgent(agent.id)}
                        aria-label={copy.open}
                        title={copy.open}
                      >
                        <ExternalLinkGlyph />
                      </button>
                      <button
                        type="button"
                        data-testid="code-archived-agent-restore"
                        onClick={() => onRestoreArchivedAgent(agent.id)}
                        aria-label={copy.restore}
                        title={copy.restore}
                      >
                        <ArrowRightGlyph />
                      </button>
                    </div>
                  </article>
                )
              }

              const { session } = item
              const sessionTitle = session.title || copy.sessionFallbackTitle(session.providerName)
              return (
                <article key={item.historyKey} className="code-history-card code-session" data-testid="code-session-history-card">
                  <div>
                    <h3>{sessionTitle}</h3>
                    <p>{historySessionMeta(session)}</p>
                  </div>
                  <div className="code-history-actions">
                    <span>{formatRelativeAge(item.updatedAt, now)}</span>
                    <button
                      type="button"
                      aria-label={copy.resumeSessionAria(sessionTitle)}
                      title={copy.restore}
                      onClick={() => onResumeSession(session.provider, session.id, session.providerHomeId)}
                    >
                      <ArrowRightGlyph />
                    </button>
                  </div>
                </article>
              )
            })}
          </section>
        </div>
      )}
    </div>
  )
}
