import { useCallback, useSyncExternalStore } from 'react'
import type { WorkspaceFileDecorationStore } from '@/lib/workspace-file-decorations'
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
  decorations: WorkspaceFileDecorationStore
  items: FileStickyContextItem[]
  onFocusDirectory: (node: FileExplorerNode) => void
  onOpenFileContextMenu: (x: number, y: number, node: FileExplorerNode) => void
}

function DirectoryStickyItem({
  copy,
  decorations,
  item,
  onFocusDirectory,
  onOpenFileContextMenu,
}: Omit<FileStickyContextProps, 'items'> & {
  item: Extract<FileStickyContextItem, { kind: 'directory' }>
}) {
  const subscribe = useCallback(
    (listener: () => void) => decorations.subscribe(item.node.path, listener),
    [decorations, item.node.path],
  )
  const getSnapshot = useCallback(
    () => decorations.get(item.node.path),
    [decorations, item.node.path],
  )
  const decoration = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const descendantStatusClassName = workspaceFileTreeDescendantGitStatusClassName(decoration.descendantGitStatus)
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
  decorations,
  items,
  onFocusDirectory,
  onOpenFileContextMenu,
}: FileStickyContextProps) {
  const item = items[0]
  if (!item) return null

  return (
    <div className="code-file-sticky-shell">
      <div className="code-file-sticky-stack" data-testid="code-file-sticky-stack" aria-label={copy.stickyFolderPath}>
        <DirectoryStickyItem
          copy={copy}
          decorations={decorations}
          item={item}
          onFocusDirectory={onFocusDirectory}
          onOpenFileContextMenu={onOpenFileContextMenu}
        />
      </div>
    </div>
  )
}
