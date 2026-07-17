import { useMemo, useState, type CSSProperties } from 'react'
import { ChevronDownGlyph, ChevronRightGlyph } from '@/components/IconGlyphs'
import { appPath } from '@/lib/base-path'
import { iconForFilePath } from '@/lib/file-icons'
import {
  workspaceFileChangePathLabel,
  workspaceFileChangeRowKey,
  workspaceFileChangeTitle,
} from '@/lib/workspace-open-files'
import type { WorkspaceFileChange } from '@/lib/workspace-files'
import type { CodeCopy } from '../code/copy'
import type { WorkspaceFileChangesController } from './useWorkspaceFileChanges'

interface FileChangesSectionProps {
  activeFilePath?: string
  agentId: string
  changes: WorkspaceFileChangesController
  collapsed: boolean
  copy: CodeCopy
  projectId: string
  refreshing: boolean
  onOpenChange: (change: WorkspaceFileChange) => void
  onToggleCollapsed: () => void
}

type FileChangeTreeNode =
  | {
    id: string
    displayName?: string
    name: string
    path: string
    type: 'directory'
    children: FileChangeTreeNode[]
    descendantCount: number
    change?: WorkspaceFileChange
  }
  | {
    id: string
    name: string
    path: string
    type: 'file'
    change: WorkspaceFileChange
  }

function changeTreeDepthStyle(depth: number) {
  return {
    '--change-indent': `${18 + depth * 12}px`,
    '--change-guide-width': `${depth * 12}px`,
  } as CSSProperties
}

function sortChangeTreeNodes(nodes: FileChangeTreeNode[]): FileChangeTreeNode[] {
  nodes.sort((left, right) => {
    if (left.type === 'directory' && right.type !== 'directory') return -1
    if (left.type !== 'directory' && right.type === 'directory') return 1
    return left.name.localeCompare(right.name) || left.path.localeCompare(right.path)
  })
  nodes.forEach(node => {
    if (node.type === 'directory') sortChangeTreeNodes(node.children)
  })
  return nodes
}

function countChangeTreeDescendants(nodes: FileChangeTreeNode[]): number {
  return nodes.reduce((count, node) => {
    if (node.type === 'file') return count + 1
    const ownCount = node.change ? 1 : 0
    node.descendantCount = ownCount + countChangeTreeDescendants(node.children)
    return count + node.descendantCount
  }, 0)
}

function compactChangeTreeNodes(nodes: FileChangeTreeNode[]): FileChangeTreeNode[] {
  return nodes.map(node => {
    if (node.type === 'file') return node

    let compacted: Extract<FileChangeTreeNode, { type: 'directory' }> = {
      ...node,
      children: compactChangeTreeNodes(node.children),
    }

    while (
      !compacted.change &&
      compacted.children.length === 1 &&
      compacted.children[0]?.type === 'directory' &&
      !compacted.children[0].change
    ) {
      const child = compacted.children[0]
      compacted = {
        ...child,
        displayName: `${compacted.displayName ?? compacted.name}/${child.displayName ?? child.name}`,
      }
    }

    return compacted
  })
}

function buildChangeTree(changes: WorkspaceFileChange[], groupId: string): FileChangeTreeNode[] {
  const roots: FileChangeTreeNode[] = []
  const directoryChildren = new Map<string, FileChangeTreeNode[]>([['', roots]])
  const directories = new Map<string, Extract<FileChangeTreeNode, { type: 'directory' }>>()

  const ensureDirectory = (directoryPath: string, parentPath: string, name: string) => {
    const existing = directories.get(directoryPath)
    if (existing) return existing
    const children: FileChangeTreeNode[] = []
    const directory: FileChangeTreeNode = {
      id: `${groupId}:dir:${directoryPath}`,
      name,
      path: directoryPath,
      type: 'directory',
      children,
      descendantCount: 0,
    }
    directories.set(directoryPath, directory)
    directoryChildren.set(directoryPath, children)
    directoryChildren.get(parentPath)?.push(directory)
    return directory
  }

  changes.forEach(change => {
    const normalizedPath = change.path.replace(/\/+$/, '')
    const segments = normalizedPath.split('/').filter(Boolean)
    if (segments.length === 0) return

    let parentPath = ''
    const isDirectoryChange = change.type === 'directory' || change.path.endsWith('/')
    const directorySegmentCount = isDirectoryChange ? segments.length : segments.length - 1
    for (let index = 0; index < directorySegmentCount; index += 1) {
      const segment = segments[index]
      if (!segment) continue
      const directoryPath = segments.slice(0, index + 1).join('/')
      ensureDirectory(directoryPath, parentPath, segment)
      parentPath = directoryPath
    }

    if (isDirectoryChange) {
      const directory = directories.get(normalizedPath)
      if (directory) directory.change = change
      return
    }

    directoryChildren.get(parentPath)?.push({
      id: `${groupId}:file:${workspaceFileChangeRowKey(change)}`,
      name: segments[segments.length - 1] || change.name,
      path: change.path,
      type: 'file',
      change,
    })
  })

  const compactedRoots = compactChangeTreeNodes(sortChangeTreeNodes(roots))
  countChangeTreeDescendants(compactedRoots)
  return compactedRoots
}

interface FileChangeRowProps {
  activeFilePath?: string
  change: WorkspaceFileChange
  copy: CodeCopy
  onOpenChange: (change: WorkspaceFileChange) => void
}

function FileChangeRow({
  activeFilePath,
  change,
  copy,
  onOpenChange,
}: FileChangeRowProps) {
  const active = activeFilePath === change.path
  const gitStatusTitle = copy.gitStatus(change.gitStatus)
  const visibleGitStatusLabel = change.gitStatus === 'untracked' ? '' : change.gitStatusLabel
  const pathContext = change.previousPath ? workspaceFileChangePathLabel(change) : ''
  return (
    <div
      key={workspaceFileChangeRowKey(change)}
      className={`code-file-change-row ${active ? 'active' : ''}`}
      data-testid="code-file-change-row"
      data-file-path={change.path}
      data-file-type="file"
      title={workspaceFileChangeTitle(change, gitStatusTitle)}
    >
      <button
        type="button"
        className="code-file-change-main"
        onClick={() => onOpenChange(change)}
      >
        <span className="code-file-chevron placeholder" aria-hidden="true" />
        <img className="code-file-type-icon file" src={iconForFilePath(change.path)} alt="" aria-hidden="true" />
        <span className="code-file-change-name">{change.name}</span>
        <span className="code-file-change-path">{pathContext}</span>
        <span className={`code-file-change-status ${change.gitStatus}`} title={gitStatusTitle}>
          {visibleGitStatusLabel}
        </span>
      </button>
    </div>
  )
}

interface FileChangeTreeRowsProps {
  activeFilePath?: string
  copy: CodeCopy
  depth: number
  nodes: FileChangeTreeNode[]
  openDirectoryIds: ReadonlySet<string>
  onOpenChange: (change: WorkspaceFileChange) => void
  onToggleDirectory: (id: string) => void
}

function FileChangeTreeRows({
  activeFilePath,
  copy,
  depth,
  nodes,
  openDirectoryIds,
  onOpenChange,
  onToggleDirectory,
}: FileChangeTreeRowsProps) {
  return (
    <>
      {nodes.map(node => {
        if (node.type === 'file') {
          return (
            <div key={node.id} style={changeTreeDepthStyle(depth)}>
              <FileChangeRow
                activeFilePath={activeFilePath}
                change={node.change}
                copy={copy}
                onOpenChange={onOpenChange}
              />
            </div>
          )
        }

        const canExpand = node.children.length > 0
        const expanded = canExpand && openDirectoryIds.has(node.id)
        return (
          <div key={node.id}>
            <div
              className="code-file-change-row directory"
              data-testid="code-file-change-directory-row"
              data-file-path={node.path}
              data-file-type="directory"
              title={node.path}
              style={changeTreeDepthStyle(depth)}
            >
              <button
                type="button"
                className="code-file-change-main directory"
                aria-expanded={canExpand ? expanded : undefined}
                onClick={() => {
                  if (canExpand) onToggleDirectory(node.id)
                }}
              >
                <span className={`code-file-chevron ${canExpand ? expanded ? 'expanded' : 'collapsed' : 'placeholder'}`} aria-hidden="true">
                  {canExpand ? expanded ? <ChevronDownGlyph /> : <ChevronRightGlyph /> : null}
                </span>
                <span className="code-file-change-name">{node.displayName ?? node.name}</span>
                <span className="code-file-change-status directory">{node.descendantCount || ''}</span>
              </button>
            </div>
            {expanded && (
              <FileChangeTreeRows
                activeFilePath={activeFilePath}
                copy={copy}
                depth={depth + 1}
                nodes={node.children}
                openDirectoryIds={openDirectoryIds}
                onOpenChange={onOpenChange}
                onToggleDirectory={onToggleDirectory}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

export function FileChangesSection({
  activeFilePath,
  agentId,
  changes,
  collapsed,
  copy,
  projectId,
  refreshing,
  onOpenChange,
  onToggleCollapsed,
}: FileChangesSectionProps) {
  const [untrackedCollapsed, setUntrackedCollapsed] = useState(true)
  const [openDirectoryIds, setOpenDirectoryIds] = useState<ReadonlySet<string>>(() => new Set())
  const trackedChanges = useMemo(() => changes.items.filter(change => change.gitStatus !== 'untracked'), [changes.items])
  const untrackedChanges = useMemo(() => changes.items.filter(change => change.gitStatus === 'untracked'), [changes.items])
  const trackedTree = useMemo(() => buildChangeTree(trackedChanges, 'tracked'), [trackedChanges])
  const untrackedTree = useMemo(() => buildChangeTree(untrackedChanges, 'untracked'), [untrackedChanges])
  const countsRefreshing = refreshing || changes.loading
  const countRefreshState = countsRefreshing ? 'refreshing' : changes.error ? 'stale' : 'refreshed'
  if (changes.items.length === 0 && !changes.error) return null

  const toggleCollapsed = () => {
    if (collapsed) changes.refreshChanges()
    onToggleCollapsed()
  }
  const toggleUntrackedCollapsed = () => {
    setUntrackedCollapsed(current => {
      if (current) changes.refreshChanges()
      return !current
    })
  }
  const toggleDirectory = (id: string) => {
    setOpenDirectoryIds(current => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }
  const openReview = (scope: 'tracked' | 'untracked') => {
    const params = new URLSearchParams({ agentId, scope })
    if (scope === 'untracked') params.set('modifiedWithinDays', '3')
    window.open(appPath(`/review?${params.toString()}`), '_blank', 'noopener,noreferrer')
  }

  return (
    <div
      className="code-file-changes-section"
      data-testid="code-file-changes-section"
      data-project-id={projectId}
      aria-label={copy.changedFiles}
      aria-busy={countsRefreshing}
    >
      {trackedChanges.length > 0 && (
        <div className={`code-file-change-group tracked ${collapsed ? 'collapsed' : ''}`} data-testid="code-file-change-tracked-group">
          <div className="code-file-change-group-header">
            <button
              type="button"
              className="code-file-change-group-toggle"
              aria-expanded={!collapsed}
              onClick={toggleCollapsed}
            >
              <span className={`code-file-section-chevron ${collapsed ? 'collapsed' : 'expanded'}`} aria-hidden="true">
                {collapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}
              </span>
              <span>{copy.changes}</span>
              <span
                className={`code-file-changes-count ${countRefreshState}`}
                data-testid="code-file-changes-tracked-count"
                data-refresh-state={countRefreshState}
                aria-label={countsRefreshing ? copy.refreshingFiles : undefined}
                title={changes.error ?? undefined}
              >
                {countsRefreshing
                  ? <span className="code-file-changes-count-loader" aria-hidden="true">···</span>
                  : trackedChanges.length}
              </span>
            </button>
            <button type="button" className="code-file-change-review" onClick={() => openReview('tracked')}>
              {copy.reviewChanges}
            </button>
          </div>
          {!collapsed && (
            <FileChangeTreeRows
              activeFilePath={activeFilePath}
              copy={copy}
              depth={0}
              nodes={trackedTree}
              openDirectoryIds={openDirectoryIds}
              onOpenChange={onOpenChange}
              onToggleDirectory={toggleDirectory}
            />
          )}
        </div>
      )}
      {untrackedChanges.length > 0 && (
        <div className={`code-file-change-group untracked ${untrackedCollapsed ? 'collapsed' : ''}`} data-testid="code-file-change-untracked-group">
          <div className="code-file-change-group-header">
            <button
              type="button"
              className="code-file-change-group-toggle"
              aria-expanded={!untrackedCollapsed}
              onClick={toggleUntrackedCollapsed}
            >
              <span className={`code-file-section-chevron ${untrackedCollapsed ? 'collapsed' : 'expanded'}`} aria-hidden="true">
                {untrackedCollapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}
              </span>
              <span>{copy.untrackedChanges}</span>
              <span
                className={`code-file-changes-count ${countRefreshState}`}
                data-testid="code-file-changes-untracked-count"
                data-refresh-state={countRefreshState}
                aria-label={countsRefreshing ? copy.refreshingFiles : undefined}
                title={changes.error ?? undefined}
              >
                {countsRefreshing
                  ? <span className="code-file-changes-count-loader" aria-hidden="true">···</span>
                  : <>{untrackedChanges.length}{changes.truncated ? '+' : ''}</>}
              </span>
            </button>
            <button type="button" className="code-file-change-review" onClick={() => openReview('untracked')}>
              {copy.reviewChanges}
            </button>
          </div>
          {!untrackedCollapsed && (
            <FileChangeTreeRows
              activeFilePath={activeFilePath}
              copy={copy}
              depth={0}
              nodes={untrackedTree}
              openDirectoryIds={openDirectoryIds}
              onOpenChange={onOpenChange}
              onToggleDirectory={toggleDirectory}
            />
          )}
        </div>
      )}
      {changes.error && (
        <div className="code-file-changes-status error" data-testid="code-file-changes-error">
          {changes.error}
        </div>
      )}
    </div>
  )
}
