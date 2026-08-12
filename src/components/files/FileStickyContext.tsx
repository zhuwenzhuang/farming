import type { WorkspaceFileTreeNode as FileExplorerNode } from '@/lib/workspace-file-tree'
import { workspaceStickyDirectoryPresentation } from '@/lib/workspace-file-view-model'
import {
  workspaceFileTreeDescendantGitStatusClassName,
  workspaceFileTreeDepthStyle,
  workspaceFileTreeStatusTitle,
} from '@/lib/workspace-file-tree-row'
import type { CodeCopy } from '../code/copy'
import type { FileStickyContextItem } from './useWorkspaceFileStickyContext'

interface FileStickyContextProps {
  copy: CodeCopy
  items: FileStickyContextItem[]
  onFocusDirectory: (node: FileExplorerNode) => void
  onOpenFileContextMenu: (x: number, y: number, node: FileExplorerNode) => void
}

function renderDirectoryStickyItem(
  item: Extract<FileStickyContextItem, { kind: 'directory' }>,
  copy: CodeCopy,
  onFocusDirectory: (node: FileExplorerNode) => void,
  onOpenFileContextMenu: (x: number, y: number, node: FileExplorerNode) => void,
) {
  const descendantStatusClassName = workspaceFileTreeDescendantGitStatusClassName(item.node.descendantGitStatus)
  const presentation = workspaceStickyDirectoryPresentation(item.nodes)
  return (
    <button
      key={item.key}
      type="button"
      className="code-file-row code-file-sticky-row"
      data-testid="code-file-sticky-row"
      data-sticky-file-path={item.node.path}
      style={workspaceFileTreeDepthStyle(0)}
      title={item.node.path}
      aria-label={item.node.path}
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
        onFocusDirectory(item.node)
      }}
      onContextMenu={event => {
        event.preventDefault()
        event.stopPropagation()
        onOpenFileContextMenu(event.clientX, event.clientY, item.node)
      }}
    >
      <span className="code-file-name">{presentation.compactLabel}</span>
      {descendantStatusClassName && (
        <span
          className={descendantStatusClassName}
          title={workspaceFileTreeStatusTitle('git', copy)}
        />
      )}
    </button>
  )
}

export function FileStickyContext({
  copy,
  items,
  onFocusDirectory,
  onOpenFileContextMenu,
}: FileStickyContextProps) {
  const item = items[0]
  if (!item) return null

  return (
    <div className="code-file-sticky-shell">
      <div className="code-file-sticky-stack" data-testid="code-file-sticky-stack" aria-label={copy.stickyFolderPath}>
        {renderDirectoryStickyItem(item, copy, onFocusDirectory, onOpenFileContextMenu)}
      </div>
    </div>
  )
}
