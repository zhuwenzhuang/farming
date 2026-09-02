import type { MouseEvent as ReactMouseEvent } from 'react'
import {
  workspaceFileTreeStatusTitle,
  type WorkspaceFileTreeRowViewState,
} from '@/lib/workspace-file-tree-row'
import type { WorkspaceFileTreeNode as FileExplorerNode } from '@/lib/workspace-file-tree'
import { MoreHorizontalGlyph } from '@/components/IconGlyphs'
import type { CodeCopy } from '../code/copy'

interface FileTreeRowStatusProps {
  copy: CodeCopy
  item: FileExplorerNode
  viewState: WorkspaceFileTreeRowViewState
  onOpenActions: (event: ReactMouseEvent<HTMLButtonElement>) => void
}

export function FileTreeRowStatus({
  copy,
  item,
  viewState,
  onOpenActions,
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
        {item.symbolicLink && (
          <span className="code-file-symbolic-link" aria-hidden="true">↷</span>
        )}
      </span>
      <span className="code-file-trailing">
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
