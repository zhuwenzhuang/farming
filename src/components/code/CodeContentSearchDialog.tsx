import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronDownGlyph, ChevronRightGlyph, CloseGlyph, SearchGlyph } from '@/components/IconGlyphs'
import { useInteractionLayer } from '@/hooks/useInteractionLayer'
import { iconForFilePath } from '@/lib/file-icons'
import { projectFilesWorkspaceId } from '@/lib/project-workspaces'
import { normalizeTextRanges, type TextRange } from '@/lib/workspace-file-search'
import { searchWorkspaceFiles } from '@/lib/workspace-files'
import { WorkspaceTransportError } from '@/lib/workspace-request-client'
import type { CodeCopy } from './copy'
import type { GlobalWorkspaceFileSearchMatch, GlobalWorkspaceFileSearchProject } from './useGlobalWorkspaceFileSearch'

const CONTENT_SEARCH_DEBOUNCE_MS = 180
const CONTENT_SEARCH_PER_PROJECT_LIMIT = 120
const CONTENT_SEARCH_TOTAL_LIMIT = 300
const CONTENT_SEARCH_CONCURRENCY = 3

interface ContentSearchMatchItem {
  key: string
  projectId: string
  projectName: string
  rootId: string
  workspace: string
  path: string
  lineNumber: number
  lines: string
  ranges: TextRange[]
}

interface ContentSearchFileGroup {
  groupKey: string
  projectName: string
  workspace: string
  rootId: string
  path: string
  matches: Array<ContentSearchMatchItem & { flatIndex: number }>
}

interface CodeContentSearchDialogProps {
  open: boolean
  projects: readonly GlobalWorkspaceFileSearchProject[]
  initialProjectWorkspace?: string
  initialQuery?: string
  copy: CodeCopy
  onClose: () => void
  onOpenMatch: (match: GlobalWorkspaceFileSearchMatch) => void
}

function splitFilePath(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/')
  const slashIndex = normalized.lastIndexOf('/')
  if (slashIndex === -1) return { name: normalized, directory: '' }
  return {
    name: normalized.slice(slashIndex + 1) || normalized,
    directory: normalized.slice(0, slashIndex),
  }
}

function renderHighlightedLine(text: string, ranges: readonly TextRange[]): ReactNode {
  const normalized = normalizeTextRanges(text, ranges)
  if (normalized.length === 0) return text
  const parts: ReactNode[] = []
  let cursor = 0
  normalized.forEach((range, index) => {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start))
    parts.push(
      <span key={`${range.start}:${range.end}:${index}`} className="code-search-content-highlight">
        {text.slice(range.start, range.end)}
      </span>,
    )
    cursor = range.end
  })
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function CodeContentSearchDialog({
  open,
  projects,
  initialProjectWorkspace = '',
  initialQuery = '',
  copy,
  onClose,
  onOpenMatch,
}: CodeContentSearchDialogProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState(initialQuery)
  const [pathFilter, setPathFilter] = useState('')
  const [selectedWorkspace, setSelectedWorkspace] = useState(initialProjectWorkspace)
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [matches, setMatches] = useState<ContentSearchMatchItem[]>([])
  const [loading, setLoading] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [failedProjectCount, setFailedProjectCount] = useState(0)
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const [activeIndex, setActiveIndex] = useState(0)
  const [retryNonce, setRetryNonce] = useState(0)

  const searchableProjects = useMemo(() => {
    const seen = new Set<string>()
    return projects.flatMap(project => {
      const workspace = project.workspace.trim()
      if (!workspace || workspace === '/') return []
      const rootId = projectFilesWorkspaceId(workspace)
      if (seen.has(rootId)) return []
      seen.add(rootId)
      return [{ ...project, workspace, rootId }]
    })
  }, [projects])

  useEffect(() => {
    if (!open) return
    if (initialQuery) setQuery(initialQuery)
    if (initialProjectWorkspace && searchableProjects.some(p => p.workspace === initialProjectWorkspace)) {
      setSelectedWorkspace(initialProjectWorkspace)
    }
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true })
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [initialProjectWorkspace, initialQuery, open, searchableProjects])

  useInteractionLayer({
    enabled: open,
    elements: () => [surfaceRef.current],
    onDismiss: onClose,
    dismissOnPointerOutside: true,
    dismissOnEscape: true,
  })

  const effectiveTargets = useMemo(() => {
    if (!selectedWorkspace) return searchableProjects
    const exact = searchableProjects.filter(project => project.workspace === selectedWorkspace)
    return exact.length > 0 ? exact : searchableProjects
  }, [searchableProjects, selectedWorkspace])

  useEffect(() => {
    if (!open) return undefined
    const trimmedQuery = query.trim()
    if (!trimmedQuery || effectiveTargets.length === 0) {
      setMatches([])
      setLoading(false)
      setTruncated(false)
      setErrorMessage(null)
      setFailedProjectCount(0)
      return undefined
    }

    if (regex) {
      try {
        new RegExp(trimmedQuery)
      } catch (caught) {
        setMatches([])
        setLoading(false)
        setTruncated(false)
        setFailedProjectCount(0)
        setErrorMessage(copy.searchInvalidRegex(caught instanceof Error ? caught.message : ''))
        return undefined
      }
    }

    setLoading(true)
    setErrorMessage(null)
    setFailedProjectCount(0)
    const abortController = new AbortController()
    let cancelled = false

    const timer = window.setTimeout(async () => {
      const nextMatches: ContentSearchMatchItem[] = []
      let anyTruncated = false
      let failedCount = 0
      let invalidRegexError: string | null = null
      let nextIndex = 0
      const cleanPath = pathFilter.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

      const worker = async () => {
        while (!abortController.signal.aborted) {
          const idx = nextIndex++
          const target = effectiveTargets[idx]
          if (!target) return
          try {
            const response = await searchWorkspaceFiles(target.rootId, trimmedQuery, {
              scope: 'content',
              path: cleanPath || undefined,
              matchCase,
              wholeWord,
              regex,
              limit: CONTENT_SEARCH_PER_PROJECT_LIMIT,
              signal: abortController.signal,
            })
            if (abortController.signal.aborted) return
            if (response.truncated) anyTruncated = true
            for (const match of response.matches) {
              if (match.kind !== 'content') continue
              if (nextMatches.length >= CONTENT_SEARCH_TOTAL_LIMIT) {
                anyTruncated = true
                break
              }
              nextMatches.push({
                key: `${target.rootId}:${match.path}:${match.lineNumber}:${nextMatches.length}`,
                projectId: target.id,
                projectName: target.name,
                rootId: target.rootId,
                workspace: target.workspace,
                path: match.path,
                lineNumber: match.lineNumber,
                lines: match.lines,
                ranges: match.ranges,
              })
            }
          } catch (caught) {
            if (isAbortError(caught) || abortController.signal.aborted) return
            if (caught instanceof WorkspaceTransportError && caught.status === 400) {
              invalidRegexError = caught.message
              abortController.abort()
              return
            }
            failedCount += 1
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(CONTENT_SEARCH_CONCURRENCY, effectiveTargets.length) }, () => worker()),
      )

      if (cancelled) return
      if (invalidRegexError) {
        setMatches([])
        setErrorMessage(invalidRegexError)
        setTruncated(false)
        setFailedProjectCount(0)
        setLoading(false)
        return
      }
      setMatches(nextMatches)
      setTruncated(anyTruncated)
      setFailedProjectCount(failedCount)
      setActiveIndex(0)
      setCollapsedGroups(new Set())
      setLoading(false)
    }, CONTENT_SEARCH_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      abortController.abort()
    }
  }, [copy, effectiveTargets, matchCase, open, pathFilter, query, regex, retryNonce, wholeWord])

  const fileGroups = useMemo<ContentSearchFileGroup[]>(() => {
    const groups = new Map<string, ContentSearchFileGroup>()
    let flatIndex = 0
    for (const item of matches) {
      const groupKey = `${item.rootId}:${item.path}`
      let group = groups.get(groupKey)
      if (!group) {
        group = {
          groupKey,
          projectName: item.projectName,
          workspace: item.workspace,
          rootId: item.rootId,
          path: item.path,
          matches: [],
        }
        groups.set(groupKey, group)
      }
      group.matches.push({ ...item, flatIndex })
      flatIndex += 1
    }
    return Array.from(groups.values())
  }, [matches])

  const visibleMatches = useMemo(
    () => fileGroups.flatMap(group => (collapsedGroups.has(group.groupKey) ? [] : group.matches)),
    [collapsedGroups, fileGroups],
  )

  const handleOpenItem = useCallback((item: ContentSearchMatchItem) => {
    const firstRange = item.ranges[0]
    onClose()
    onOpenMatch({
      key: item.key,
      entryType: 'file',
      path: item.path,
      projectId: item.projectId,
      projectName: item.projectName,
      rootId: item.rootId,
      workspace: item.workspace,
      lineNumber: item.lineNumber,
      ...(firstRange ? { column: firstRange.start + 1 } : {}),
    })
  }, [onClose, onOpenMatch])

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && visibleMatches.length > 0) {
      event.preventDefault()
      setActiveIndex(current => (current + 1) % visibleMatches.length)
      return
    }
    if (event.key === 'ArrowUp' && visibleMatches.length > 0) {
      event.preventDefault()
      setActiveIndex(current => (current - 1 + visibleMatches.length) % visibleMatches.length)
      return
    }
    if (event.key === 'Enter' && visibleMatches.length > 0) {
      event.preventDefault()
      const selected = visibleMatches[Math.min(activeIndex, visibleMatches.length - 1)]
      if (selected) handleOpenItem(selected)
    }
  }, [activeIndex, handleOpenItem, visibleMatches])

  const toggleGroup = useCallback((groupKey: string) => {
    setCollapsedGroups(current => {
      const next = new Set(current)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
  }, [])

  if (!open) return null

  const hasQuery = Boolean(query.trim())

  const dialog = (
    <div className="code-search-content-backdrop" data-testid="code-content-search-backdrop">
      <div
        ref={surfaceRef}
        className="code-menu-surface code-search-content-dialog"
        data-testid="code-content-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={copy.searchCodeContents}
      >
        <div className="code-search-content-header">
          <div className="code-search-content-input-row">
            <span className="code-search-panel-icon" aria-hidden="true">
              <SearchGlyph />
            </span>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={event => setQuery(event.currentTarget.value)}
              onKeyDown={handleKeyDown}
              placeholder={copy.searchCodeContentsPlaceholder}
              aria-label={copy.searchCodeContents}
              data-testid="code-content-search-input"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
            <div className="code-search-content-options" role="group" aria-label={copy.searchCodeContents}>
              <button
                type="button"
                className="code-search-content-option"
                data-testid="code-content-search-match-case"
                aria-pressed={matchCase}
                aria-label={copy.searchMatchCase}
                title={copy.searchMatchCase}
                onClick={() => setMatchCase(value => !value)}
              >
                Aa
              </button>
              <button
                type="button"
                className="code-search-content-option"
                data-testid="code-content-search-whole-word"
                aria-pressed={wholeWord}
                aria-label={copy.searchWholeWord}
                title={copy.searchWholeWord}
                onClick={() => setWholeWord(value => !value)}
              >
                \b
              </button>
              <button
                type="button"
                className="code-search-content-option"
                data-testid="code-content-search-regex"
                aria-pressed={regex}
                aria-label={copy.searchRegex}
                title={copy.searchRegex}
                onClick={() => setRegex(value => !value)}
              >
                .*
              </button>
            </div>
            <button
              type="button"
              className="code-search-content-close"
              data-testid="code-content-search-close"
              aria-label={copy.close}
              title={copy.close}
              onClick={onClose}
            >
              <CloseGlyph />
            </button>
          </div>
          <div className="code-search-content-toolbar">
            {searchableProjects.length > 1 ? (
              <select
                className="code-search-content-select"
                data-testid="code-content-search-project"
                aria-label={copy.searchAllProjects}
                value={selectedWorkspace}
                onChange={event => setSelectedWorkspace(event.currentTarget.value)}
              >
                <option value="">{copy.searchAllProjects} ({searchableProjects.length})</option>
                {searchableProjects.map(project => (
                  <option key={project.rootId} value={project.workspace}>
                    {project.name}
                  </option>
                ))}
              </select>
            ) : searchableProjects[0] ? (
              <span className="code-search-content-project-label">{searchableProjects[0].name}</span>
            ) : null}
            <input
              type="text"
              className="code-search-content-path-input"
              data-testid="code-content-search-path"
              value={pathFilter}
              onChange={event => setPathFilter(event.currentTarget.value)}
              onKeyDown={handleKeyDown}
              placeholder={copy.searchPathFilterPlaceholder}
              aria-label={copy.searchPathFilterPlaceholder}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
            {hasQuery && !loading && !errorMessage ? (
              <span className="code-search-content-summary" data-testid="code-content-search-summary">
                {copy.searchContentMatchesSummary(matches.length, fileGroups.length)}
              </span>
            ) : null}
          </div>
        </div>

        <div className="code-search-content-body" data-testid="code-content-search-results">
          {errorMessage ? (
            <div className="code-search-file-status error" data-testid="code-content-search-error" role="alert">
              {errorMessage}
            </div>
          ) : !hasQuery ? (
            <div className="code-search-content-empty">{copy.searchCodeContentsPlaceholder}</div>
          ) : loading ? (
            <div className="code-search-content-empty" role="status">{copy.searching}</div>
          ) : matches.length === 0 ? (
            <div className="code-search-content-empty" data-testid="code-content-search-empty">
              {copy.searchContentEmpty}
            </div>
          ) : (
            <>
              {failedProjectCount > 0 ? (
                <div className="code-search-file-status error" role="status">
                  <span>{copy.fileSearchUnavailable(failedProjectCount)}</span>
                  <button type="button" className="code-search-retry" onClick={() => setRetryNonce(v => v + 1)}>
                    {copy.retry}
                  </button>
                </div>
              ) : null}
              {truncated ? (
                <div className="code-search-file-status" role="status">
                  {copy.fileSearchIncomplete}
                </div>
              ) : null}
              <div className="code-search-content-groups" role="listbox" aria-label={copy.searchCodeContents}>
                {fileGroups.map(group => {
                  const collapsed = collapsedGroups.has(group.groupKey)
                  const { name, directory } = splitFilePath(group.path)
                  return (
                    <section
                      key={group.groupKey}
                      className="code-search-content-group"
                      data-testid="code-content-search-file-group"
                    >
                      <button
                        type="button"
                        className="code-search-content-group-header"
                        aria-expanded={!collapsed}
                        onClick={() => toggleGroup(group.groupKey)}
                      >
                        <span className="code-search-content-chevron" aria-hidden="true">
                          {collapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}
                        </span>
                        <img
                          className="code-file-type-icon code-search-file-icon"
                          src={iconForFilePath(group.path)}
                          alt=""
                          aria-hidden="true"
                        />
                        <span className="code-search-content-group-name">{name}</span>
                        {directory ? (
                          <span className="code-search-content-group-dir">{directory}</span>
                        ) : null}
                        {searchableProjects.length > 1 ? (
                          <span className="code-search-content-group-project">{group.projectName}</span>
                        ) : null}
                        <span className="code-search-content-group-count">{group.matches.length}</span>
                      </button>
                      {!collapsed ? (
                        <div className="code-search-content-rows">
                          {group.matches.map(item => {
                            const visibleIndex = visibleMatches.findIndex(v => v.key === item.key)
                            const selected = visibleIndex === activeIndex
                            return (
                              <button
                                key={item.key}
                                type="button"
                                role="option"
                                aria-selected={selected}
                                className={`code-search-content-row ${selected ? 'active' : ''}`}
                                data-testid="code-content-search-row"
                                onPointerMove={event => {
                                  if (event.pointerType === 'mouse' && visibleIndex >= 0) setActiveIndex(visibleIndex)
                                }}
                                onClick={() => handleOpenItem(item)}
                              >
                                <span className="code-search-content-line-number">{item.lineNumber}</span>
                                <span className="code-search-content-line-text">
                                  {renderHighlightedLine(item.lines, item.ranges)}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      ) : null}
                    </section>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog
}
