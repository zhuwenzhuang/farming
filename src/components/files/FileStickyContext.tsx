import { ChevronDownGlyph } from '@/components/IconGlyphs'
import { filePathDepth, type WorkspaceFileTreeNode as FileExplorerNode } from '@/lib/workspace-file-tree'
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
      style={workspaceFileTreeDepthStyle(filePathDepth(item.node.path))}
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
      <span className="code-file-name">{item.node.displayName ?? item.node.name}</span>
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
  if (items.length === 0) return null
  const directoryItems = items.filter((item): item is Extract<FileStickyContextItem, { kind: 'directory' }> => item.kind === 'directory')
  const compactTarget = directoryItems[directoryItems.length - 1]

  return (
    <div className="code-file-sticky-shell">
      <div className="code-file-sticky-stack" data-testid="code-file-sticky-stack" aria-label={copy.stickyFolderPath}>
        <div className="code-file-sticky-expanded-rows">
          {directoryItems.map(item => renderDirectoryStickyItem(item, copy, onFocusDirectory))}
        </div>
        {compactTarget && (
          <button
            type="button"
            className="code-file-row directory code-file-sticky-row code-file-sticky-compact-row"
            style={workspaceFileTreeDepthStyle(0)}
            title={compactTarget.node.path}
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              onFocusDirectory(compactTarget.node)
            }}
          >
            <span className="code-file-chevron expanded" aria-hidden="true">
              <ChevronDownGlyph />
            </span>
            <span className="code-file-name">{workspaceCompactStickyDirectoryLabel(directoryItems.map(item => item.node))}</span>
          </button>
        )}
      </div>
    </div>
  )
}
