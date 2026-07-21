import { useCallback, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'
import { iconForDirectoryPath, iconForFilePath } from '@/lib/file-icons'
import {
  normalizeTextRanges,
  pathSearchTextRanges,
  type TextRange,
  type WorkspaceFileJumpQuery,
} from '@/lib/workspace-file-search'
import type { WorkspaceFileSearchMatch } from '@/lib/workspace-files'
import { isCompactViewport } from '@/lib/responsive-mode'
import type { CodeCopy } from '../code/copy'

interface FileSearchResultsProps {
  activeMatchIndex: number
  anchorRef: RefObject<HTMLElement | null>
  copy: CodeCopy
  containerRef?: RefObject<HTMLDivElement | null>
  error: string | null
  jumpTarget: WorkspaceFileJumpQuery | null
  listboxId: string
  loading: boolean
  matches: WorkspaceFileSearchMatch[]
  openFileError: string | null
  query: string
  showIgnoredSearch: boolean
  timeoutMs: number
  truncated: boolean
  onOpenJumpQuery: (query: string) => void
  onOpenMatch: (match: WorkspaceFileSearchMatch) => void
  onSearchIgnored: () => void
  onSelectMatchIndex: (index: number) => void
}

interface FileSearchPanelStyle {
  left: number
  top: number
  width: number
  maxHeight: number
}

function renderSearchText(text: string, ranges: readonly TextRange[] = []) {
  const normalizedRanges = normalizeTextRanges(text, ranges)
  if (normalizedRanges.length === 0) return text

  const parts: ReactNode[] = []
  let cursor = 0
  normalizedRanges.forEach((range, index) => {
    if (range.start > cursor) {
      parts.push(text.slice(cursor, range.start))
    }
    parts.push(
      <span key={`${range.start}:${range.end}:${index}`} className="code-file-search-highlight">
        {text.slice(range.start, range.end)}
      </span>
    )
    cursor = range.end
  })
  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }

  return parts
}

function renderSearchPath(pathText: string, query: string) {
  return renderSearchText(pathText, pathSearchTextRanges(pathText, query))
}

function splitWorkspaceFilePath(pathText: string) {
  const normalized = pathText.replace(/\\/g, '/')
  const slashIndex = normalized.lastIndexOf('/')
  if (slashIndex === -1) {
    return { directory: '', name: normalized }
  }
  return {
    directory: normalized.slice(0, slashIndex),
    name: normalized.slice(slashIndex + 1) || normalized,
  }
}

function fileSearchPanelStyle(anchor: HTMLElement | null): FileSearchPanelStyle | null {
  if (!anchor || typeof window === 'undefined') return null
  const rect = anchor.getBoundingClientRect()
  if (isCompactViewport()) {
    const visualViewport = window.visualViewport
    const viewportTop = visualViewport?.offsetTop ?? 0
    const viewportLeft = visualViewport?.offsetLeft ?? 0
    const viewportWidth = visualViewport?.width ?? window.innerWidth
    const viewportHeight = visualViewport?.height ?? window.innerHeight
    const sidebarRect = anchor.closest('.code-sidebar')?.getBoundingClientRect()
    const left = Math.max(viewportLeft + 6, (sidebarRect?.left ?? viewportLeft) + 6)
    const right = Math.min(viewportLeft + viewportWidth - 6, (sidebarRect?.right ?? (viewportLeft + viewportWidth)) - 6)
    const viewportBottom = viewportTop + viewportHeight
    const availableBelow = viewportBottom - rect.bottom - 10
    const availableAbove = rect.top - viewportTop - 10
    const opensAbove = availableBelow < 120 && availableAbove > availableBelow
    const maxHeight = Math.max(72, Math.min(320, opensAbove ? availableAbove : availableBelow))
    const top = opensAbove
      ? Math.max(viewportTop + 6, rect.top - maxHeight - 4)
      : Math.max(viewportTop + 6, rect.bottom + 4)
    return {
      left,
      top,
      width: Math.max(180, right - left),
      maxHeight,
    }
  }
  const margin = 12
  const viewportWidth = Math.max(document.documentElement.clientWidth, window.innerWidth || 0)
  const viewportHeight = Math.max(document.documentElement.clientHeight, window.innerHeight || 0)
  const availableWidth = Math.max(240, viewportWidth - margin * 2)
  const width = Math.min(620, availableWidth, Math.max(420, rect.width))
  const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin))
  const top = Math.min(rect.bottom + 6, viewportHeight - margin)
  const maxHeight = Math.max(168, Math.min(420, viewportHeight - top - margin))
  return { left, top, width, maxHeight }
}

function FileSearchResultPath({
  path,
  query,
}: {
  path: string
  query: string
}) {
  const { directory, name } = splitWorkspaceFilePath(path)
  return (
    <span className="code-file-search-copy">
      <span className="code-file-search-name">{renderSearchPath(name, query)}</span>
      {directory && (
        <span className="code-file-search-directory">{renderSearchPath(directory, query)}</span>
      )}
    </span>
  )
}

export function FileSearchResults({
  activeMatchIndex,
  anchorRef,
  copy,
  containerRef,
  error,
  jumpTarget,
  listboxId,
  loading,
  matches,
  openFileError,
  query,
  showIgnoredSearch,
  timeoutMs,
  truncated,
  onOpenJumpQuery,
  onOpenMatch,
  onSearchIgnored,
  onSelectMatchIndex,
}: FileSearchResultsProps) {
  const [panelStyle, setPanelStyle] = useState<FileSearchPanelStyle | null>(() => fileSearchPanelStyle(anchorRef.current))
  const updatePanelStyle = useCallback(() => {
    setPanelStyle(fileSearchPanelStyle(anchorRef.current))
  }, [anchorRef])

  useLayoutEffect(() => {
    updatePanelStyle()
    const anchor = anchorRef.current
    const scroller = anchor?.closest('.code-project-list')
    window.addEventListener('resize', updatePanelStyle)
    window.addEventListener('scroll', updatePanelStyle, true)
    window.visualViewport?.addEventListener('resize', updatePanelStyle)
    window.visualViewport?.addEventListener('scroll', updatePanelStyle)
    scroller?.addEventListener('scroll', updatePanelStyle, { passive: true })
    return () => {
      window.removeEventListener('resize', updatePanelStyle)
      window.removeEventListener('scroll', updatePanelStyle, true)
      window.visualViewport?.removeEventListener('resize', updatePanelStyle)
      window.visualViewport?.removeEventListener('scroll', updatePanelStyle)
      scroller?.removeEventListener('scroll', updatePanelStyle)
    }
  }, [anchorRef, updatePanelStyle])

  return (
    <div
      ref={containerRef}
      id={listboxId}
      className="code-file-search-results"
      data-testid="code-file-search-results"
      role="listbox"
      aria-label={copy.searchFilesOrJump}
      style={panelStyle ? {
        left: panelStyle.left,
        top: panelStyle.top,
        width: panelStyle.width,
        maxHeight: panelStyle.maxHeight,
      } : undefined}
    >
      {jumpTarget ? (
        openFileError ? (
          <div className="code-file-search-state error">{openFileError}</div>
        ) : (
          <button
            id={`${listboxId}-jump`}
            type="button"
            className="code-file-search-result jump active"
            onClick={() => onOpenJumpQuery(query)}
            role="option"
            aria-selected="true"
          >
            <span className="code-file-search-kind">{copy.go}</span>
            <FileSearchResultPath path={jumpTarget.path} query={query} />
            <span className="code-file-search-line">{jumpTarget.lineNumber}</span>
          </button>
        )
      ) : loading ? (
        <div className="code-file-search-state">{copy.searching}</div>
      ) : error ? (
        <div className="code-file-search-state error">{error}</div>
      ) : matches.length === 0 ? (
        <>
          <div className="code-file-search-state">{copy.noMatches}</div>
          {showIgnoredSearch && (
            <button type="button" className="code-file-search-ignored-action" onClick={onSearchIgnored}>
              {copy.searchIgnoredFolders}
            </button>
          )}
          {truncated && (
            <div className="code-file-search-state muted">{copy.searchIncomplete(timeoutMs)}</div>
          )}
        </>
      ) : (
        <>
          {matches.map((match, index) => (
            <button
              id={`${listboxId}-${index}`}
              key={`${match.path}:${match.lineNumber}:${index}`}
              type="button"
              className={`code-file-search-result ${index === activeMatchIndex ? 'active' : ''}`}
              onPointerMove={event => {
                if (event.pointerType === 'mouse') onSelectMatchIndex(index)
              }}
              onClick={() => onOpenMatch(match)}
              title={match.entryType === 'directory' ? match.path : `${match.path}:${match.lineNumber}`}
              role="option"
              aria-selected={index === activeMatchIndex}
            >
              <img
                className={`code-file-type-icon ${match.entryType === 'directory' ? 'folder' : 'file'}`}
                src={match.entryType === 'directory' ? iconForDirectoryPath(match.path, false) : iconForFilePath(match.path)}
                alt=""
                aria-hidden="true"
              />
              <FileSearchResultPath path={match.path} query={query} />
              {match.kind === 'path' ? (
                <span className="code-file-search-kind">{match.entryType === 'directory' ? copy.folder : copy.file}</span>
              ) : (
                <span className="code-file-search-line">{match.lineNumber}</span>
              )}
              {match.lines && (
                <span className="code-file-search-preview">
                  {renderSearchText(match.lines, match.ranges)}
                </span>
              )}
            </button>
          ))}
          {showIgnoredSearch && (
            <button type="button" className="code-file-search-ignored-action" onClick={onSearchIgnored}>
              {copy.searchIgnoredFolders}
            </button>
          )}
          {truncated && (
            <div className="code-file-search-state muted">{copy.moreMatchesOmitted}</div>
          )}
        </>
      )}
    </div>
  )
}
