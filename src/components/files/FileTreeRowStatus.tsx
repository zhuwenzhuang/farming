import type { MouseEvent as ReactMouseEvent } from 'react'
import {
  workspaceFileTreeStatusTitle,
  type WorkspaceFileTreeRowViewState,
} from '@/lib/workspace-file-tree-row'
import type { WorkspaceFileTreeNode as FileExplorerNode } from '@/lib/workspace-file-tree'
import { MoreHorizontalGlyph } from '@/components/IconGlyphs'
import type { CodeCopy } from '../code/copy'

interface FileTreeRowStatusProps {
  isSubmodule?: boolean
  copy: CodeCopy
  directoryError?: { path: string; message: string; tooLarge: boolean }
  item: FileExplorerNode
  viewState: WorkspaceFileTreeRowViewState
  onOpenActions: (event: ReactMouseEvent<HTMLButtonElement>) => void
  onSearchDirectory: (path: string) => void
}

export function FileTreeRowStatus({
  copy,
  isSubmodule,
  directoryError,
  item,
  viewState,
  onOpenActions,
  onSearchDirectory,
}: FileTreeRowStatusProps) {
  const {
    directoryDotClassName,
    directoryDotTitleKind,
    fileChangedClassName,
    fileChangedTitleKind,
    fileOpening,
    isDirectory,
    showDirectoryDot,
    visibleGitStatus,
    visibleGitStatusClassName,
    visibleGitStatusLabel,
  } = viewState

  return (
    <>
      <span className="code-file-label">
        <span className="code-file-name">{item.displayName ?? item.name}</span>
        {isDirectory && isSubmodule && <span className="code-file-repository-kind code-file-submodule-label">{copy.submodule}</span>}
        {directoryError && (
          <span
            className="code-file-directory-error"
            role="alert"
            aria-label={directoryError.tooLarge ? copy.directoryTooLarge : directoryError.message}
            title={directoryError.tooLarge ? copy.directoryTooLarge : directoryError.message}
          >
            {directoryError.tooLarge ? copy.directoryTooLargeShort : directoryError.message}
          </span>
        )}
        {item.symbolicLink && (
          <span className="code-file-symbolic-link" aria-hidden="true">↷</span>
        )}
      </span>
      <span className="code-file-trailing">
        {directoryError?.tooLarge && (
          <button
            type="button"
            className="code-file-directory-search-action inline"
            aria-label={copy.searchThisDirectory}
            onPointerDown={event => event.stopPropagation()}
            onMouseDown={event => event.stopPropagation()}
            onClick={event => {
              event.stopPropagation()
              onSearchDirectory(directoryError.path)
            }}
          >
            {copy.searchThisDirectoryShort}
          </button>
        )}
        {fileOpening && (
          <span className="code-file-open-spinner" title={copy.loading} aria-hidden="true" />
        )}
        {!fileOpening && showDirectoryDot && (
          <span
            className={directoryDotClassName}
            title={workspaceFileTreeStatusTitle(directoryDotTitleKind, copy)}
          />
        )}
        {!fileOpening && !isDirectory && visibleGitStatusLabel && (
          <span className={visibleGitStatusClassName} title={copy.gitStatus(visibleGitStatus || '')}>
            {visibleGitStatusLabel}
          </span>
        )}
        {!fileOpening && !isDirectory && !visibleGitStatusLabel && fileChangedClassName && (
          <span
            className={fileChangedClassName}
            title={workspaceFileTreeStatusTitle(fileChangedTitleKind, copy)}
          />
        )}
        <button
          type="button"
          className="code-file-row-actions"
          aria-label={copy.fileActions(item.displayName ?? item.name)}
          aria-haspopup="menu"
          onMouseDown={event => event.stopPropagation()}
          onClick={onOpenActions}
        >
          <MoreHorizontalGlyph />
        </button>
      </span>
    </>
  )
}
