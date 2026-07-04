import { iconForDirectoryPath } from '@/lib/file-icons'
import { filePathDepth, type WorkspaceFileTreeNode as FileExplorerNode } from '@/lib/workspace-file-tree'
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
  openEditorsCollapsed: boolean
  onFocusDirectory: (node: FileExplorerNode) => void
  onRevealOpenEditors: () => void
  onToggleFiles: () => void
  onToggleOpenEditors: () => void
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
      <span className="code-file-chevron expanded" aria-hidden="true" />
      <img
        className="code-file-type-icon folder open"
        src={iconForDirectoryPath(item.node.iconPath ?? item.node.path, true, item.node.iconSignals)}
        alt=""
        aria-hidden="true"
      />
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
  openEditorsCollapsed,
  onFocusDirectory,
  onRevealOpenEditors,
  onToggleFiles,
  onToggleOpenEditors,
}: FileStickyContextProps) {
  if (items.length === 0) return null

  return (
    <div className="code-file-sticky-shell">
      <div className="code-file-sticky-stack" data-testid="code-file-sticky-stack" aria-label={copy.stickyFolderPath}>
        {items.map(item => (
          item.kind === 'directory' ? (
            renderDirectoryStickyItem(item, copy, onFocusDirectory)
          ) : (
            <button
              key={item.key}
              type="button"
              className={`code-file-row directory code-file-sticky-row code-file-sticky-context ${item.kind}`}
              style={workspaceFileTreeDepthStyle(0)}
              title={item.name}
              aria-expanded={item.kind === 'open-editors' ? !openEditorsCollapsed : true}
              onClick={event => {
                event.preventDefault()
                event.stopPropagation()
                if (item.kind === 'open-editors') {
                  onToggleOpenEditors()
                  onRevealOpenEditors()
                } else {
                  onToggleFiles()
                }
              }}
            >
              <span
                className={`code-file-section-chevron ${
                  item.kind === 'open-editors' && openEditorsCollapsed ? 'collapsed' : 'expanded'
                }`}
                aria-hidden="true"
              />
              <span className="code-file-name">{item.name}</span>
            </button>
          )
        ))}
      </div>
    </div>
  )
}
