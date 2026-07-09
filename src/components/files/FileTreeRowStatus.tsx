import {
  workspaceFileTreeStatusTitle,
  type WorkspaceFileTreeRowViewState,
} from '@/lib/workspace-file-tree-row'
import type { WorkspaceFileTreeNode as FileExplorerNode } from '@/lib/workspace-file-tree'
import type { CodeCopy } from '../code/copy'

interface FileTreeRowStatusProps {
  copy: CodeCopy
  item: FileExplorerNode
  viewState: WorkspaceFileTreeRowViewState
}

export function FileTreeRowStatus({
  copy,
  item,
  viewState,
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
      <span className="code-file-name">{item.displayName ?? item.name}</span>
      {item.symbolicLink && (
        <span className="code-file-symbolic-link" aria-hidden="true">↷</span>
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
    </>
  )
}
