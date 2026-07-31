import { ChevronDownGlyph } from '@/components/IconGlyphs'
import type { WorkspaceFileTreeNode as FileExplorerNode } from '@/lib/workspace-file-tree'
import { workspaceCompactStickyDirectoryLabel } from '@/lib/workspace-file-view-model'
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
}

function renderDirectoryStickyItem(
  item: Extract<FileStickyContextItem, { kind: 'directory' }>,
  copy: CodeCopy,
  onFocusDirectory: (node: FileExplorerNode) => void
) {
  const descendantStatusClassName = workspaceFileTreeDescendantGitStatusClassName(item.node.descendantGitStatus)
  return (
    <button
      key={item.key}
      type="button"
      className="code-file-row directory code-file-sticky-row"
      style={workspaceFileTreeDepthStyle(0)}
      title={item.node.path}
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
        onFocusDirectory(item.node)
      }}
    >
      <span className="code-file-chevron expanded" aria-hidden="true">
        <ChevronDownGlyph />
      </span>
      <span className="code-file-name">{workspaceCompactStickyDirectoryLabel(item.nodes)}</span>
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
}: FileStickyContextProps) {
  const item = items[0]
  if (!item) return null

  return (
    <div className="code-file-sticky-shell">
      <div className="code-file-sticky-stack" data-testid="code-file-sticky-stack" aria-label={copy.stickyFolderPath}>
        {renderDirectoryStickyItem(item, copy, onFocusDirectory)}
      </div>
    </div>
  )
}
