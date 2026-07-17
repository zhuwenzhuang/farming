import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import { CheckGlyph, ChevronDownGlyph, ChevronRightGlyph, ErrorGlyph } from '@/components/IconGlyphs'
import { isMobileTouchViewport } from '@/lib/responsive-mode'
import type { CodeCopy } from '../code/copy'

export interface FileSectionHeaderSearch {
  active: boolean
  activeOptionId?: string
  inputRef: RefObject<HTMLInputElement | null>
  listboxId: string
  query: string
}

export type FileSectionRefreshStatus = 'idle' | 'refreshing' | 'success' | 'error'

interface FileSectionHeaderProps {
  copy: CodeCopy
  filesCollapsed: boolean
  refreshStatus: FileSectionRefreshStatus
  search: FileSectionHeaderSearch
  onCancelPendingFileFocus: () => void
  onFileSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  onSearchQueryChange: (query: string) => void
  onRefreshFiles: () => void
  onToggleFilesCollapsed: () => void
}

export function FileSectionHeader({
  copy,
  filesCollapsed,
  refreshStatus,
  search,
  onCancelPendingFileFocus,
  onFileSearchKeyDown,
  onSearchQueryChange,
  onRefreshFiles,
  onToggleFilesCollapsed,
}: FileSectionHeaderProps) {
  const refreshLabel = refreshStatus === 'refreshing'
    ? copy.refreshingFiles
    : refreshStatus === 'success'
      ? copy.filesRefreshed
      : refreshStatus === 'error'
        ? copy.filesRefreshFailed
        : copy.refreshFiles

  return (
    <div className={`code-files-header ${filesCollapsed ? 'collapsed' : ''}`}>
      <div className="code-files-heading">
        <button
          type="button"
          className="code-files-title"
          aria-expanded={!filesCollapsed}
          onClick={onToggleFilesCollapsed}
        >
          <span className={`code-file-section-chevron ${filesCollapsed ? 'collapsed' : 'expanded'}`} aria-hidden="true">
            {filesCollapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}
          </span>
          <span>{copy.files}</span>
        </button>
        <button
          type="button"
          className="code-files-refresh"
          data-testid="code-files-refresh"
          data-refresh-status={refreshStatus}
          title={refreshLabel}
          aria-label={refreshLabel}
          aria-busy={refreshStatus === 'refreshing'}
          disabled={refreshStatus === 'refreshing'}
          onClick={onRefreshFiles}
        >
          <span className="code-files-refresh-glyph" aria-hidden="true">
            {refreshStatus === 'success'
              ? <CheckGlyph />
              : refreshStatus === 'error'
                ? <ErrorGlyph />
                : '↻'}
          </span>
        </button>
        <span className="code-visually-hidden" role="status" aria-live="polite">
          {refreshStatus === 'idle' ? '' : refreshLabel}
        </span>
      </div>
      {!filesCollapsed && (
        <label className="code-file-search-box">
          <span className="code-file-search-icon" aria-hidden="true" />
          <input
            ref={search.inputRef}
            type="search"
            name="farming-file-search"
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
            value={search.query}
            onChange={event => {
              onCancelPendingFileFocus()
              onSearchQueryChange(event.target.value)
            }}
            onFocus={onCancelPendingFileFocus}
            onPointerDown={event => {
              onCancelPendingFileFocus()
              if (!isMobileTouchViewport()) return
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
            }}
            onMouseDown={onCancelPendingFileFocus}
            onKeyDownCapture={onFileSearchKeyDown}
            placeholder={copy.searchOrPathLine}
            aria-label={copy.searchFilesOrJump}
            aria-autocomplete="list"
            aria-controls={search.active ? search.listboxId : undefined}
            aria-expanded={search.active}
            aria-activedescendant={search.activeOptionId}
            role="combobox"
          />
        </label>
      )}
    </div>
  )
}
