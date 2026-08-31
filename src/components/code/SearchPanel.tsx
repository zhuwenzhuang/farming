import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { ArrowLeftGlyph, CloseGlyph, FolderGlyph, SearchGlyph } from '@/components/IconGlyphs'
import { iconForFilePath } from '@/lib/file-icons'
import { agentDisplayName } from '@/lib/format'
import { formatWorkspaceForDisplay } from '@/lib/workspace-options'
import type { Agent } from '@/types/agent'
import {
  agentSessionId,
  agentSessionWorkingDirectory,
  compactPath,
  effortLabel,
  projectWorkspaceForAgent,
} from './model'
import { buildAgentRowDisplayState } from './agent-row-state'
import type { CodeCopy } from './copy'
import type { AgentSessionHistoryItem, ProjectGroup, WorkspaceSearchScope, WorkspaceSearchCounts } from './types'
import {
  GLOBAL_FILE_SEARCH_QUERY_MAX_LENGTH,
  type GlobalWorkspaceFileSearchMatch,
} from './useGlobalWorkspaceFileSearch'

const SEARCH_RESULTS_ID = 'code-global-search-results'

function searchResultId(kind: 'agent' | 'session' | 'file', identity: string) {
  return `code-global-search-${kind}-${encodeURIComponent(identity)}`
}

function searchGroupId(identity: string) {
  return `code-global-search-group-${encodeURIComponent(identity)}`
}

interface SearchPanelProps {
  query: string
  displayedProjects: ProjectGroup[]
  hasQuery: boolean
  loading: boolean
  scope: WorkspaceSearchScope
  counts: WorkspaceSearchCounts
  onScopeChange: (scope: WorkspaceSearchScope) => void
  fileSearchLoading: boolean
  resultCount: number
  selectedAgentId: string | null
  selectedSessionHandle: string | null
  selectedFileKey: string | null
  fileMatches: GlobalWorkspaceFileSearchMatch[]
  fileSearchFailedProjectCount: number
  fileSearchIncomplete: boolean
  queryTooLong: boolean
  fileOpenError: string | null
  openingFileKey: string | null
  inputRef: RefObject<HTMLInputElement | null>
  onQueryChange: (value: string) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  onClearSearch: () => void
  onBack: () => void
  onOpenAgent: (agentId: string) => void
  onOpenSession: (session: AgentSessionHistoryItem) => void
  onOpenFile: (match: GlobalWorkspaceFileSearchMatch) => void
  onRetryFileSearch: () => void
  copy: CodeCopy
}

export function SearchPanel({
  query,
  displayedProjects,
  hasQuery,
  loading,
  scope,
  counts,
  onScopeChange,
  fileSearchLoading,
  resultCount,
  selectedAgentId,
  selectedSessionHandle,
  selectedFileKey,
  fileMatches,
  fileSearchFailedProjectCount,
  fileSearchIncomplete,
  queryTooLong,
  fileOpenError,
  openingFileKey,
  inputRef,
  onQueryChange,
  onKeyDown,
  onClearSearch,
  onBack,
  onOpenAgent,
  onOpenSession,
  onOpenFile,
  onRetryFileSearch,
  copy,
}: SearchPanelProps) {
  const includesFiles = scope === 'all' || scope === 'files'
  const filters = [
    { scope: 'all', label: copy.searchAll },
    { scope: 'files', label: copy.searchFilesAndFolders },
    { scope: 'agents', label: copy.searchCurrentAgents },
    { scope: 'sessions', label: copy.searchSessionHistory },
  ] as const
  const selectedResultId = selectedFileKey
    ? searchResultId('file', selectedFileKey)
    : selectedAgentId
      ? searchResultId('agent', selectedAgentId)
      : selectedSessionHandle
        ? searchResultId('session', selectedSessionHandle)
        : undefined

  useEffect(() => {
    if (!selectedResultId) return
    inputRef.current?.ownerDocument.getElementById(selectedResultId)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }, [inputRef, selectedResultId])

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
        <div className="code-side-view-heading">
          <button
            type="button"
            className="code-side-view-back"
            data-testid="code-search-back"
            aria-label={copy.back}
            title={copy.back}
            onClick={onBack}
          >
            <ArrowLeftGlyph />
          </button>
          <h2>{copy.search}</h2>
        </div>
        {hasQuery ? <span>{copy.resultsCount(resultCount)}</span> : null}
      </div>
      <div className="code-search-panel-input" data-testid="code-search-box">
        <span className="code-search-panel-icon" aria-hidden="true"><SearchGlyph /></span>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          name="farming-workspace-search"
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={GLOBAL_FILE_SEARCH_QUERY_MAX_LENGTH}
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
          aria-autocomplete="list"
          aria-controls={resultCount > 0 ? SEARCH_RESULTS_ID : undefined}
          aria-expanded={resultCount > 0}
          aria-activedescendant={resultCount > 0 ? selectedResultId : undefined}
          aria-invalid={queryTooLong || undefined}
        />
        {query && (
          <button type="button" onClick={onClearSearch} aria-label={copy.clearSearch}>
            <CloseGlyph />
          </button>
        )}
      </div>
      {hasQuery ? (
        <div className="code-search-filters" role="group" aria-label={copy.searchResultType}>
          {filters.map(filter => (
            <button
              key={filter.scope}
              type="button"
              aria-pressed={scope === filter.scope}
              data-testid={`code-search-filter-${filter.scope}`}
              onClick={() => onScopeChange(filter.scope)}
            >
              {filter.label} <span>{filter.scope === 'files' && fileSearchLoading ? '…' : counts[filter.scope]}</span>
            </button>
          ))}
        </div>
      ) : null}
      {hasQuery && includesFiles ? (
        <p className="code-search-scope-note">{copy.searchFileScope}</p>
      ) : null}
      {hasQuery && includesFiles && resultCount > 0 ? (
        <>
          {fileSearchLoading ? (
            <div className="code-search-file-status" data-testid="code-global-file-search-loading" role="status">
              {copy.searchFilesAndFolders} · {copy.searching}
            </div>
          ) : fileMatches.length === 0 && !fileSearchFailedProjectCount && !fileSearchIncomplete ? (
            <div className="code-search-file-status" data-testid="code-global-file-search-empty" role="status">
              {copy.searchNoFiles}
            </div>
          ) : null}
          {fileSearchFailedProjectCount > 0 ? (
            <div className="code-search-file-status error" data-testid="code-global-file-search-partial" role="status">
              <span>{copy.fileSearchUnavailable(fileSearchFailedProjectCount)}</span>
              <button type="button" className="code-search-retry" onClick={onRetryFileSearch}>{copy.retry}</button>
            </div>
          ) : null}
          {fileSearchIncomplete ? (
            <div className="code-search-file-status" data-testid="code-global-file-search-incomplete" role="status">
              {copy.fileSearchIncomplete}
            </div>
          ) : null}
        </>
      ) : null}
      {fileOpenError ? (
        <div className="code-search-file-status error" data-testid="code-global-file-open-error" role="alert">
          {fileOpenError}
        </div>
      ) : null}
      {hasQuery && queryTooLong ? (
        <div className="code-search-file-status error" data-testid="code-search-query-too-long" role="alert">
          {copy.searchQueryTooLong}
        </div>
      ) : hasQuery && loading && resultCount === 0 ? (
        <div className="code-empty-workspace" data-testid="code-search-loading">
          <h2>{copy.searching}</h2>
        </div>
      ) : hasQuery && resultCount === 0 && fileSearchFailedProjectCount > 0 ? (
        <div className="code-empty-workspace" data-testid="code-global-file-search-error" role="alert">
          <h2>{copy.fileSearchUnavailable(fileSearchFailedProjectCount)}</h2>
          {fileSearchIncomplete ? (
            <p data-testid="code-global-file-search-incomplete">{copy.fileSearchIncomplete}</p>
          ) : null}
          <button type="button" className="code-search-retry" onClick={onRetryFileSearch}>{copy.retry}</button>
        </div>
      ) : hasQuery && resultCount === 0 && fileSearchIncomplete ? (
        <div className="code-empty-workspace" data-testid="code-global-file-search-incomplete" role="status">
          <h2>{copy.fileSearchIncomplete}</h2>
          <button type="button" className="code-search-retry" onClick={onRetryFileSearch}>{copy.retry}</button>
        </div>
      ) : hasQuery && resultCount === 0 ? (
        <div className="code-empty-workspace" data-testid="code-empty-search">
          <h2>{scope === 'files' ? copy.searchNoFiles : copy.noMatchingSearchResults}</h2>
        </div>
      ) : hasQuery ? (
        <>
          <div
            className="code-search-results"
            id={SEARCH_RESULTS_ID}
            role="listbox"
            aria-label={copy.resultsCount(resultCount)}
          >
            {(['directory', 'file'] as const).map(entryType => {
              const matches = fileMatches.filter(match => match.entryType === entryType)
              if (matches.length === 0) return null
              const groupName = entryType === 'directory' ? 'directories' : 'files'
              return (
                <section
                  key={entryType}
                  className="code-search-result-group"
                  data-testid={`code-global-${entryType === 'directory' ? 'directory' : 'file'}-search-results`}
                  role="group"
                  aria-labelledby={searchGroupId(groupName)}
                >
                  <h3 id={searchGroupId(groupName)}>{entryType === 'directory' ? copy.searchFolders : copy.files} <span aria-hidden="true">{matches.length}</span></h3>
                  {matches.map(match => {
                    const opening = match.key === openingFileKey
                    return (
                      <button
                        key={match.key}
                        type="button"
                        id={searchResultId('file', match.key)}
                        role="option"
                        aria-selected={match.key === selectedFileKey}
                        aria-busy={opening || undefined}
                        disabled={opening}
                        className={`code-search-result code-search-file-result ${match.key === selectedFileKey ? 'active' : ''}`}
                        data-testid={`code-global-${entryType === 'directory' ? 'directory' : 'file'}-search-result`}
                        title={`${match.projectName} · ${formatWorkspaceForDisplay(match.workspace)} · ${match.path}`}
                        aria-label={`${entryType === 'directory' ? copy.folder : copy.file}: ${match.projectName} · ${formatWorkspaceForDisplay(match.workspace)} · ${match.path}`}
                        onClick={() => onOpenFile(match)}
                      >
                        {entryType === 'directory'
                          ? <FolderGlyph className="code-search-file-icon" aria-hidden="true" />
                          : <img className="code-file-type-icon code-search-file-icon" src={iconForFilePath(match.path)} alt="" aria-hidden="true" />}
                        <span className="code-search-result-copy">
                          <strong>{fileName(match.path) || match.projectName}</strong>
                          <SearchResultProjectName
                            name={match.projectName}
                            workspace={match.workspace}
                            workspacePeers={fileMatches
                              .filter(candidate => candidate.projectName === match.projectName && candidate.path === match.path)
                              .map(candidate => candidate.workspace)}
                            showWorkspace
                          />
                          <span className="code-search-file-path">{opening ? (entryType === 'directory' ? copy.openingDirectory : copy.openingFile) : match.path || '.'}</span>
                        </span>
                      </button>
                    )
                  })}
                </section>
              )
            })}
            {displayedProjects.map(project => {
              const groupLabelId = searchGroupId(`project-${project.id}`)
              return (
                <section
                  key={project.id}
                  className="code-search-result-group"
                  role="group"
                  aria-labelledby={groupLabelId}
                >
                  <h3
                    id={groupLabelId}
                    title={project.workspace ? formatWorkspaceForDisplay(project.workspace) : project.name}
                  >
                    <span>{project.name}</span>
                    {project.workspace ? (
                      <span className="code-search-group-workspace" data-testid="code-search-group-workspace">
                        {compactWorkspaceForSearch(project.workspace, displayedProjects
                          .filter(candidate => candidate.name === project.name)
                          .map(candidate => candidate.workspace))}
                      </span>
                    ) : null}
                  </h3>
                  {project.agents.map(agent => (
                    <AgentSearchResult
                      key={agent.id}
                      agent={agent}
                      copy={copy}
                      selected={agent.id === selectedAgentId}
                      optionId={searchResultId('agent', agent.id)}
                      onOpen={() => onOpenAgent(agent.id)}
                    />
                  ))}
                  {project.agentSessions.map(session => {
                    const sessionHandle = agentSessionId(session)
                    const sessionDetail = [
                      copy.searchSessionHistory,
                      session.providerName || session.provider,
                      session.model,
                      session.effort ? effortLabel(session.effort) : '',
                      formatSessionDate(session.updatedAt || session.createdAt),
                    ].filter(Boolean).join(' · ')
                    return (
                      <button
                        key={sessionHandle}
                        type="button"
                        id={searchResultId('session', sessionHandle)}
                        role="option"
                        aria-selected={sessionHandle === selectedSessionHandle}
                        className={`code-search-result no-status code-session-result ${sessionHandle === selectedSessionHandle ? 'active' : ''}`}
                        data-testid="code-session-search-result"
                        onClick={() => onOpenSession(session)}
                      >
                        <span className="code-search-result-copy">
                          <strong>{session.title || copy.sessionFallbackTitle(session.providerName)}</strong>
                          <span className="code-search-session-detail">{sessionDetail}</span>
                          {agentSessionWorkingDirectory(session) && agentSessionWorkingDirectory(session) !== project.workspace ? (
                            <span className="code-search-working-directory">
                              {copy.searchWorkingDirectory}: {formatWorkspaceForDisplay(agentSessionWorkingDirectory(session))}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    )
                  })}
                </section>
              )
            })}
          </div>
        </>
      ) : null}
    </div>
  )
}

function fileName(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').pop() || normalized
}

function compactWorkspaceForSearch(workspace: string, peers: readonly string[] = []) {
  const formatted = formatWorkspaceForDisplay(workspace).replace(/\\/g, '/').replace(/\/+$/, '')
  const segments = formatted.split('/').filter(Boolean)
  if (segments.length === 0) return formatted
  const peerSegments = peers
    .map(peer => formatWorkspaceForDisplay(peer).replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean))
    .filter(peer => peer.join('/') !== segments.join('/'))
  let suffixLength = Math.min(3, segments.length)
  while (suffixLength < segments.length) {
    const suffix = segments.slice(-suffixLength).join('/')
    if (peerSegments.every(peer => peer.slice(-suffixLength).join('/') !== suffix)) break
    suffixLength += 1
  }
  const label = segments.slice(-suffixLength).join('/')
  return suffixLength < segments.length ? `…/${label}` : label
}

function AgentSearchResult({
  agent,
  copy,
  selected,
  optionId,
  onOpen,
}: {
  agent: Agent
  copy: CodeCopy
  selected: boolean
  optionId: string
  onOpen: () => void
}) {
  const rowState = buildAgentRowDisplayState({ kind: 'agent', agent })
  const providerLabel = agentDisplayName(agent.providerSessionProvider || agent.command)

  return (
    <button
      type="button"
      id={optionId}
      role="option"
      aria-selected={selected}
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
        <span>{copy.searchCurrentAgents} · {providerLabel || compactPath(projectWorkspaceForAgent(agent))}</span>
      </span>
    </button>
  )
}

function SearchResultProjectName({
  name,
  workspace,
  workspacePeers = [],
  showWorkspace = false,
}: {
  name: string
  workspace: string
  workspacePeers?: readonly string[]
  showWorkspace?: boolean
}) {
  if (!name) return null
  return (
    <span
      className="code-search-result-project"
      data-testid="code-search-result-project"
      title={workspace ? formatWorkspaceForDisplay(workspace) : name}
    >
      {name}{showWorkspace && workspace ? ` · ${compactWorkspaceForSearch(workspace, workspacePeers)}` : ''}
    </span>
  )
}

function formatSessionDate(value: string | undefined) {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}
