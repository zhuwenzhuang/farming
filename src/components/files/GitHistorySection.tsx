import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckGlyph, ChevronDownGlyph, ChevronRightGlyph, ExternalLinkGlyph } from '@/components/IconGlyphs'
import { appPath } from '@/lib/base-path'
import { toGitHistoryItemViewModelArray } from '@/lib/git-history-graph'
import { iconForFilePath } from '@/lib/file-icons'
import {
  fetchWorkspaceGitHistory,
  fetchWorkspaceGitHistoryChanges,
  type WorkspaceGitHistory,
  type WorkspaceGitHistoryChange,
  type WorkspaceGitHistoryChanges,
  type WorkspaceGitHistoryItem,
} from '@/lib/workspace-files'
import type { CodeCopy } from '../code/copy'
import { GitHistoryGraph, GitHistoryGraphPlaceholder } from './GitHistoryGraph'

const GIT_HISTORY_PAGE_SIZE = 50
const GIT_HISTORY_CHANGE_CACHE_LIMIT = 20

interface GitHistorySectionProps {
  agentId: string
  copy: CodeCopy
  projectId: string
}

function commitTimestamp(timestamp?: number) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function appendUniqueHistoryItems(
  currentItems: WorkspaceGitHistoryItem[],
  nextItems: WorkspaceGitHistoryItem[],
) {
  const seen = new Set(currentItems.map(item => item.id))
  return [...currentItems, ...nextItems.filter(item => !seen.has(item.id))]
}

function changeTitle(change: WorkspaceGitHistoryChange) {
  return change.previousPath ? `${change.previousPath} → ${change.path}` : change.path
}

function commitMessageBody(commit: WorkspaceGitHistoryItem) {
  const message = commit.message.trim()
  if (!message || message === commit.subject) return ''
  if (message.startsWith(commit.subject)) return message.slice(commit.subject.length).trim()
  return message
}

export function GitHistorySection({ agentId, copy, projectId }: GitHistorySectionProps) {
  const [collapsed, setCollapsed] = useState(true)
  const [history, setHistory] = useState<WorkspaceGitHistory | null>(null)
  const [historyScope, setHistoryScope] = useState<WorkspaceGitHistory['scope']>('current')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [selectedCommitId, setSelectedCommitId] = useState('')
  const [selectedParent, setSelectedParent] = useState('')
  const [selectedChanges, setSelectedChanges] = useState<WorkspaceGitHistoryChanges | null>(null)
  const [changesLoading, setChangesLoading] = useState(false)
  const [changesError, setChangesError] = useState('')
  const [scopeMenu, setScopeMenu] = useState<{ x: number; y: number } | null>(null)
  const historyRequestRef = useRef<AbortController | null>(null)
  const changesRequestRef = useRef<AbortController | null>(null)
  const changesCacheRef = useRef(new Map<string, WorkspaceGitHistoryChanges>())
  const scopeButtonRef = useRef<HTMLButtonElement | null>(null)
  const scopeMenuRef = useRef<HTMLDivElement | null>(null)

  const resetSelection = useCallback(() => {
    changesRequestRef.current?.abort()
    changesRequestRef.current = null
    setSelectedCommitId('')
    setSelectedParent('')
    setSelectedChanges(null)
    setChangesLoading(false)
    setChangesError('')
    setScopeMenu(null)
  }, [])

  useEffect(() => {
    historyRequestRef.current?.abort()
    changesRequestRef.current?.abort()
    historyRequestRef.current = null
    changesRequestRef.current = null
    changesCacheRef.current.clear()
    setCollapsed(true)
    setHistory(null)
    setHistoryScope('current')
    setHistoryLoading(false)
    setHistoryError('')
    setSelectedCommitId('')
    setSelectedParent('')
    setSelectedChanges(null)
    setChangesLoading(false)
    setChangesError('')
    return () => {
      historyRequestRef.current?.abort()
      changesRequestRef.current?.abort()
    }
  }, [agentId, projectId])

  useEffect(() => {
    if (!scopeMenu) return
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && (scopeButtonRef.current?.contains(target) || scopeMenuRef.current?.contains(target))) return
      setScopeMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setScopeMenu(null)
      scopeButtonRef.current?.focus()
    }
    window.addEventListener('pointerdown', closeOnPointerDown, true)
    window.addEventListener('keydown', closeOnEscape, true)
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown, true)
      window.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [scopeMenu])

  const loadHistoryPage = useCallback(async (
    skip: number,
    replace: boolean,
    scope: WorkspaceGitHistory['scope'] = historyScope,
  ) => {
    historyRequestRef.current?.abort()
    const controller = new AbortController()
    historyRequestRef.current = controller
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const page = await fetchWorkspaceGitHistory(agentId, {
        limit: GIT_HISTORY_PAGE_SIZE,
        skip,
        scope,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setHistory(current => {
        if (replace || !current) return page
        return {
          ...page,
          items: appendUniqueHistoryItems(current.items, page.items),
        }
      })
    } catch (error) {
      if (controller.signal.aborted) return
      setHistoryError(error instanceof Error ? error.message : 'Git history request failed')
    } finally {
      if (historyRequestRef.current === controller) {
        historyRequestRef.current = null
        setHistoryLoading(false)
      }
    }
  }, [agentId, historyScope])

  const loadCommitChanges = useCallback(async (commit: WorkspaceGitHistoryItem, parent: string) => {
    const cacheKey = `${commit.id}:${parent || 'root'}`
    const cached = changesCacheRef.current.get(cacheKey)
    changesRequestRef.current?.abort()
    if (cached) {
      setSelectedChanges(cached)
      setChangesLoading(false)
      setChangesError('')
      return
    }

    const controller = new AbortController()
    changesRequestRef.current = controller
    setSelectedChanges(null)
    setChangesLoading(true)
    setChangesError('')
    try {
      const changes = await fetchWorkspaceGitHistoryChanges(agentId, commit.id, {
        parent: parent || undefined,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      changesCacheRef.current.set(cacheKey, changes)
      if (changesCacheRef.current.size > GIT_HISTORY_CHANGE_CACHE_LIMIT) {
        const oldestKey = changesCacheRef.current.keys().next().value
        if (oldestKey) changesCacheRef.current.delete(oldestKey)
      }
      setSelectedChanges(changes)
    } catch (error) {
      if (controller.signal.aborted) return
      setChangesError(error instanceof Error ? error.message : 'Commit changes request failed')
    } finally {
      if (changesRequestRef.current === controller) {
        changesRequestRef.current = null
        setChangesLoading(false)
      }
    }
  }, [agentId])

  const toggleCollapsed = () => {
    setCollapsed(current => {
      if (current && !history && !historyLoading) void loadHistoryPage(0, true)
      return !current
    })
  }

  const refreshHistory = () => {
    changesCacheRef.current.clear()
    resetSelection()
    void loadHistoryPage(0, true)
  }

  const changeHistoryScope = (scope: WorkspaceGitHistory['scope']) => {
    setScopeMenu(null)
    if (scope === historyScope) return
    setHistoryScope(scope)
    setHistory(null)
    changesCacheRef.current.clear()
    resetSelection()
    void loadHistoryPage(0, true, scope)
  }

  const toggleScopeMenu = () => {
    setScopeMenu(current => {
      if (current) return null
      const rect = scopeButtonRef.current?.getBoundingClientRect()
      if (!rect) return null
      const menuWidth = 132
      const menuHeight = 66
      return {
        x: Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth)),
        y: rect.bottom + menuHeight + 8 <= window.innerHeight
          ? rect.bottom + 3
          : Math.max(8, rect.top - menuHeight - 3),
      }
    })
  }

  const selectCommit = (commit: WorkspaceGitHistoryItem) => {
    if (selectedCommitId === commit.id) {
      resetSelection()
      return
    }
    const parent = commit.parentIds[0] || ''
    setSelectedCommitId(commit.id)
    setSelectedParent(parent)
    void loadCommitChanges(commit, parent)
  }

  const selectParent = (commit: WorkspaceGitHistoryItem, parent: string) => {
    setSelectedParent(parent)
    void loadCommitChanges(commit, parent)
  }

  const openReview = (commit: WorkspaceGitHistoryItem, base: string, filePath?: string) => {
    if (!base) return
    const params = new URLSearchParams({ agentId, base, head: commit.id })
    if (filePath) params.append('path', filePath)
    window.open(appPath(`/review?${params.toString()}`), '_blank', 'noopener,noreferrer')
  }

  const viewModels = useMemo(
    () => toGitHistoryItemViewModelArray(history?.items ?? [], history?.head),
    [history?.head, history?.items],
  )

  return (
    <section
      className={`code-git-history-section ${collapsed ? 'collapsed' : ''}`}
      data-testid="code-git-history-section"
      data-project-id={projectId}
      aria-label={copy.gitHistory}
    >
      <div className="code-git-history-header">
        <button
          type="button"
          className="code-git-history-title"
          aria-expanded={!collapsed}
          onClick={toggleCollapsed}
        >
          <span className={`code-file-section-chevron ${collapsed ? 'collapsed' : 'expanded'}`} aria-hidden="true">
            {collapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}
          </span>
          <span>{copy.gitHistory}</span>
        </button>
        {!collapsed && (
          <>
            <button
              ref={scopeButtonRef}
              type="button"
              className="code-git-history-scope"
              aria-label={copy.gitHistoryView}
              title={copy.gitHistoryView}
              aria-haspopup="menu"
              aria-expanded={scopeMenu ? true : undefined}
              disabled={historyLoading}
              onClick={toggleScopeMenu}
            >
              <span>{historyScope === 'current' ? copy.gitHistoryCurrentScope : copy.gitHistoryAllScope}</span>
              <ChevronDownGlyph aria-hidden="true" />
            </button>
            {scopeMenu && typeof document !== 'undefined' && createPortal(
              <div
                ref={scopeMenuRef}
                className="code-git-history-scope-menu"
                data-testid="code-git-history-scope-menu"
                role="menu"
                aria-label={copy.gitHistoryView}
                style={{ left: scopeMenu.x, top: scopeMenu.y }}
              >
                {([
                  ['current', copy.gitHistoryCurrentBranch],
                  ['all', copy.gitHistoryAllBranches],
                ] as const).map(([scope, label]) => (
                  <button
                    key={scope}
                    type="button"
                    role="menuitemradio"
                    aria-checked={historyScope === scope}
                    onClick={() => changeHistoryScope(scope)}
                  >
                    <span className="code-git-history-scope-check" aria-hidden="true">
                      {historyScope === scope && <CheckGlyph />}
                    </span>
                    <span>{label}</span>
                  </button>
                ))}
              </div>,
              document.body,
            )}
            <button
              type="button"
              className={`code-git-history-refresh ${historyLoading ? 'loading' : ''}`}
              title={copy.refresh}
              aria-label={copy.refresh}
              disabled={historyLoading}
              onClick={refreshHistory}
            >
              ↻
            </button>
          </>
        )}
      </div>

      {!collapsed && (
        <div className="code-git-history-body">
          {historyLoading && !history && <div className="code-git-history-status">{copy.loading}</div>}
          {historyError && <div className="code-git-history-status error">{historyError}</div>}
          {history && !history.isGitRepo && <div className="code-git-history-status">{copy.gitHistoryNotRepository}</div>}
          {history?.isGitRepo && history.items.length === 0 && !historyLoading && (
            <div className="code-git-history-status">{copy.gitHistoryEmpty}</div>
          )}

          {viewModels.map(viewModel => {
            const commit = viewModel.historyItem
            const selected = selectedCommitId === commit.id
            const timestamp = commitTimestamp(commit.timestamp)
            const messageBody = commitMessageBody(commit)
            const visibleReferences = commit.references.filter(reference => (
              reference.category !== 'head'
              && !(historyScope === 'current' && history?.branch && reference.name === history.branch)
            ))
            return (
              <div
                key={commit.id}
                className={`code-git-history-entry ${selected ? 'selected' : ''}`}
                data-testid="code-git-history-entry"
                data-commit-id={commit.id}
              >
                <button
                  type="button"
                  className="code-git-history-commit"
                  aria-expanded={selected}
                  title={`${commit.message || commit.subject}\n${commit.id}\n${commit.author}${timestamp ? ` · ${timestamp}` : ''}`}
                  onClick={() => selectCommit(commit)}
                >
                  <GitHistoryGraph viewModel={viewModel} />
                  <span className="code-git-history-commit-content">
                    <span className="code-git-history-subject">{commit.subject || commit.displayId}</span>
                    <span className="code-git-history-footer">
                      <span className="code-git-history-meta">
                        <span className="code-git-history-hash">{commit.displayId}</span>
                        {commit.author && <span>{commit.author}</span>}
                        {timestamp && commit.timestamp !== undefined && (
                          <time dateTime={new Date(commit.timestamp).toISOString()}>{timestamp}</time>
                        )}
                      </span>
                      {visibleReferences.length > 0 && (
                        <span className="code-git-history-references" aria-label={visibleReferences.map(reference => reference.name).join(', ')}>
                          {visibleReferences.slice(0, 1).map(reference => (
                            <span key={reference.id} className={`code-git-history-reference ${reference.category}`} title={reference.name}>
                              {reference.name}
                            </span>
                          ))}
                          {visibleReferences.length > 1 && <span className="code-git-history-reference-more">+{visibleReferences.length - 1}</span>}
                        </span>
                      )}
                    </span>
                  </span>
                </button>

                {selected && (
                  <div className="code-git-history-details" data-testid="code-git-history-details">
                    <GitHistoryGraphPlaceholder columns={viewModel.outputSwimlanes} />
                    <div className="code-git-history-details-content">
                      {(commit.parentIds.length > 1 || commit.parentIds.length === 0) && (
                        <div className="code-git-history-details-header">
                          {commit.parentIds.length > 1 ? (
                            <label className="code-git-history-parent-select">
                              <span>{copy.gitHistoryParent}</span>
                              <select value={selectedParent} onChange={event => selectParent(commit, event.target.value)}>
                                {commit.parentIds.map((parent, index) => (
                                  <option key={parent} value={parent}>{index + 1}: {parent.slice(0, 8)}</option>
                                ))}
                              </select>
                            </label>
                          ) : (
                            <span className="code-git-history-root-label">{copy.gitHistoryRootCommit}</span>
                          )}
                        </div>
                      )}
                      {messageBody && (
                        <div className="code-git-history-message">
                          <span className="code-git-history-message-label">{copy.gitHistoryCommitMessage}</span>
                          <span className="code-git-history-message-body">{messageBody}</span>
                        </div>
                      )}
                      {changesLoading && <div className="code-git-history-status compact">{copy.loading}</div>}
                      {changesError && <div className="code-git-history-status compact error">{changesError}</div>}
                      {selectedChanges && (
                        <>
                          <div className="code-git-history-change-summary-row">
                            <span className="code-git-history-change-summary">
                              {copy.gitHistoryCommitChanges(selectedChanges.items.length)}
                            </span>
                            {selectedChanges.comparisonBase && (
                              <button
                                type="button"
                                className="code-git-history-review"
                                aria-label={copy.gitHistoryReviewCommit}
                                title={copy.gitHistoryReviewCommit}
                                onClick={() => openReview(commit, selectedChanges.comparisonBase)}
                              >
                                <span>{copy.reviewChanges}</span>
                                <ExternalLinkGlyph />
                              </button>
                            )}
                          </div>
                          {selectedChanges.items.length === 0 && (
                            <div className="code-git-history-status compact">{copy.gitHistoryNoChanges}</div>
                          )}
                          <div className="code-git-history-change-list">
                            {selectedChanges.items.map(change => (
                              selectedChanges.comparisonBase ? (
                                <button
                                  key={`${change.status}:${change.path}`}
                                  type="button"
                                  className="code-git-history-change"
                                  title={changeTitle(change)}
                                  onClick={() => openReview(commit, selectedChanges.comparisonBase, change.path)}
                                >
                                  <img src={iconForFilePath(change.path)} alt="" aria-hidden="true" />
                                  <span className="code-git-history-change-path">{change.path}</span>
                                  {change.previousPath && <span className="code-git-history-change-previous">← {change.previousPath}</span>}
                                  <span className={`code-git-history-change-status ${change.status}`}>{change.statusLabel}</span>
                                </button>
                              ) : (
                                <div key={`${change.status}:${change.path}`} className="code-git-history-change static" title={changeTitle(change)}>
                                  <img src={iconForFilePath(change.path)} alt="" aria-hidden="true" />
                                  <span className="code-git-history-change-path">{change.path}</span>
                                  <span className={`code-git-history-change-status ${change.status}`}>{change.statusLabel}</span>
                                </div>
                              )
                            ))}
                          </div>
                          {selectedChanges.truncated && (
                            <div className="code-git-history-status compact">{copy.gitHistoryChangesTruncated}</div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {history?.hasMore && (
            <button
              type="button"
              className="code-git-history-load-more"
              disabled={historyLoading || history.nextSkip === null}
              onClick={() => {
                if (history.nextSkip !== null) void loadHistoryPage(history.nextSkip, false)
              }}
            >
              {historyLoading ? copy.loading : copy.gitHistoryLoadMore}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
