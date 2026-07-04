import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import type { CodeCopy } from '../code/copy'

export interface FileSectionHeaderSearch {
  active: boolean
  activeOptionId?: string
  inputRef: RefObject<HTMLInputElement | null>
  listboxId: string
  query: string
}

interface FileSectionHeaderProps {
  copy: CodeCopy
  filesCollapsed: boolean
  search: FileSectionHeaderSearch
  onCancelPendingFileFocus: () => void
  onFileSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  onSearchQueryChange: (query: string) => void
  onToggleFilesCollapsed: () => void
}

export function FileSectionHeader({
  copy,
  filesCollapsed,
  search,
  onCancelPendingFileFocus,
  onFileSearchKeyDown,
  onSearchQueryChange,
  onToggleFilesCollapsed,
}: FileSectionHeaderProps) {
  return (
    <div className={`code-files-header ${filesCollapsed ? 'collapsed' : ''}`}>
      <button
        type="button"
        className="code-files-title"
        aria-expanded={!filesCollapsed}
        onClick={onToggleFilesCollapsed}
      >
        <span className={`code-file-section-chevron ${filesCollapsed ? 'collapsed' : 'expanded'}`} aria-hidden="true" />
        <span>{copy.files}</span>
      </button>
      {!filesCollapsed && (
        <label className="code-file-search-box">
          <span className="code-file-search-icon" aria-hidden="true" />
          <input
            ref={search.inputRef}
            value={search.query}
            onChange={event => {
              onCancelPendingFileFocus()
              onSearchQueryChange(event.target.value)
            }}
            onFocus={onCancelPendingFileFocus}
            onPointerDown={onCancelPendingFileFocus}
            onMouseDown={onCancelPendingFileFocus}
            onKeyDownCapture={onFileSearchKeyDown}
            placeholder={copy.searchOrPathLine}
            aria-label={copy.searchFilesOrJump}
            aria-autocomplete="list"
            aria-controls={search.active ? search.listboxId : undefined}
            aria-expanded={search.active}
            aria-activedescendant={search.activeOptionId}
            role="combobox"
            spellCheck={false}
          />
        </label>
      )}
    </div>
  )
}
