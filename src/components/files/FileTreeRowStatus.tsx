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
  directoryError?: { path: string; message: string }
  item: FileExplorerNode
  viewState: WorkspaceFileTreeRowViewState
  onOpenActions: (event: ReactMouseEvent<HTMLButtonElement>) => void
}

export function FileTreeRowStatus({
  copy,
  isSubmodule,
  directoryError,
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
        {isDirectory && isSubmodule && <span className="code-file-repository-kind code-file-submodule-label">{copy.submodule}</span>}
        {directoryError && (
          <span
            className="code-file-directory-error"
            role="alert"
            aria-label={directoryError.message}
            title={directoryError.message}
          >
            {directoryError.message}
          </span>
        )}
        {item.symbolicLink && (
          <span
            className={`code-file-symbolic-link ${item.readOnly ? 'read-only' : ''}`.trim()}
            aria-hidden="true"
          >
            <svg className="code-file-symbolic-link-arrow" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d="M2.5 9.5V6.5a2 2 0 0 1 2-2h4.75M7.25 2.5l2.25 2-2.25 2"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {item.readOnly && (
              <svg className="code-file-symbolic-link-lock" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <rect x="2.5" y="5.5" width="7" height="5" rx="1.25" stroke="currentColor" strokeWidth="1.2" />
                <path d="M4.25 5.5V4a1.75 1.75 0 0 1 3.5 0v1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            )}
          </span>
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
