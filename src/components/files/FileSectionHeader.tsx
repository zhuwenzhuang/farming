import { useLayoutEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { FileHeaderPath, type FileHeaderPathProps } from './FileHeaderPath'
import { CheckGlyph, ChevronDownGlyph, ChevronRightGlyph, CloseGlyph, ErrorGlyph, SearchGlyph } from '@/components/IconGlyphs'
import { isTouchInputViewport } from '@/lib/responsive-mode'
import type { CodeCopy } from '../code/copy'

export interface FileSectionHeaderSearch {
  active: boolean
  activeOptionId?: string
  inputRef: RefObject<HTMLInputElement | null>
  listboxId: string
  query: string
  scopePath: string
}

export type FileSectionRefreshStatus = 'idle' | 'refreshing' | 'success' | 'error'

interface FileSectionHeaderProps extends FileHeaderPathProps {
  searchOpen: boolean
  searchTriggerRef: RefObject<HTMLButtonElement | null>
  onOpenSearch: () => void
  onCloseSearch: () => void
  copy: CodeCopy
  filesCollapsed: boolean
  refreshStatus: FileSectionRefreshStatus
  refreshError?: string
  search: FileSectionHeaderSearch
  onCancelPendingFileFocus: () => void
  onFileSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  onSearchQueryChange: (query: string) => void
  onRefreshFiles: () => void
  onToggleFilesCollapsed: () => void
}

export function FileSectionHeader({
  copy,
  searchOpen,
  searchTriggerRef,
  onOpenSearch,
  onCloseSearch,
  treeData,
  openDirectoryPaths,
  treeViewportRef,
  rowHeight,
  filesCollapsed,
  refreshStatus,
  refreshError,
  search,
  onCancelPendingFileFocus,
  onFileSearchKeyDown,
  onSearchQueryChange,
  onRefreshFiles,
  onToggleFilesCollapsed,
}: FileSectionHeaderProps) {
  useLayoutEffect(() => {
    if (searchOpen && !filesCollapsed) search.inputRef.current?.focus({ preventScroll: true })
  }, [searchOpen, filesCollapsed, search.inputRef])

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
      </div>
      {!filesCollapsed && !searchOpen && <FileHeaderPath treeData={treeData} openDirectoryPaths={openDirectoryPaths}
        treeViewportRef={treeViewportRef} rowHeight={rowHeight} label={copy.visibleFileDirectory} />}
      {!filesCollapsed && searchOpen && (
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
              if (!isTouchInputViewport()) return
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
            }}
            onMouseDown={onCancelPendingFileFocus}
            onKeyDownCapture={onFileSearchKeyDown}
            placeholder={search.scopePath ? `${copy.searchInDirectory} ${search.scopePath}` : copy.searchOrPathLine}
            aria-label={search.scopePath ? `${copy.searchInDirectory} ${search.scopePath}` : copy.searchFilesOrJump}
            aria-autocomplete="list"
            aria-controls={search.active ? search.listboxId : undefined}
            aria-expanded={search.active}
            aria-activedescendant={search.activeOptionId}
            role="combobox"
          />
        </label>
      )}
      {!filesCollapsed && <button ref={searchTriggerRef} type="button"
        className="code-files-header-search-toggle code-files-refresh"
        data-testid="code-files-search-toggle"
        aria-label={searchOpen ? copy.closeFileSearch : copy.searchFilesOrJump}
        title={searchOpen ? copy.closeFileSearch : copy.searchFilesOrJump}
        aria-expanded={searchOpen}
        onPointerDown={event => {
          if (!isTouchInputViewport()) return
          event.preventDefault()
          event.currentTarget.focus({ preventScroll: true })
        }}
        onClick={() => {
          onCancelPendingFileFocus()
          if (searchOpen) onCloseSearch()
          else onOpenSearch()
        }}>
        <span className="code-files-refresh-glyph">{searchOpen ? <CloseGlyph /> : <SearchGlyph />}</span>
      </button>}
      <span
        className="code-files-header-actions"
        data-testid="code-files-header-actions"
        data-refresh-status={refreshStatus}
      >
        <button
          type="button"
          className="code-files-refresh"
          data-testid="code-files-refresh"
          data-refresh-status={refreshStatus}
          title={refreshError ? `${refreshLabel}\n${refreshError}` : refreshLabel}
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
      </span>
      <span className="code-visually-hidden" role="status" aria-live="polite">
        {refreshStatus === 'idle' ? '' : refreshError ? `${refreshLabel}: ${refreshError}` : refreshLabel}
      </span>
    </div>
  )
}
