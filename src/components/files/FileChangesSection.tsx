import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { ChevronDownGlyph, ChevronRightGlyph } from '@/components/IconGlyphs'
import { appPath } from '@/lib/base-path'
import { iconForFilePath } from '@/lib/file-icons'
import { WORKSPACE_FILE_TREE_INDENT, WORKSPACE_FILE_TREE_ROOT_INDENT } from '@/lib/workspace-file-tree-row'
import {
  workspaceFileChangePathLabel,
  workspaceFileChangeRowKey,
  workspaceFileChangeTitle,
} from '@/lib/workspace-open-files'
import type { WorkspaceFileChange, WorkspaceFileChanges } from '@/lib/workspace-files'
import type { CodeCopy } from '../code/copy'
import {
  loadCodeProjectFilesViewState,
  saveCodeProjectFilesViewState,
} from '../code/workspace-view-state'
import type { WorkspaceFileChangesController } from './useWorkspaceFileChanges'

interface FileChangesSectionProps {
  activeFilePath?: string
  projectWorkspace: string
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
    '--change-indent': `${WORKSPACE_FILE_TREE_ROOT_INDENT + (depth + 1) * WORKSPACE_FILE_TREE_INDENT}px`,
    '--change-guide-width': `${(depth + 1) * WORKSPACE_FILE_TREE_INDENT}px`,
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
      path: changes[0]?.repositoryPath ? `${changes[0].repositoryPath}/${directoryPath}` : directoryPath,
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
    const normalizedPath = (change.repositoryFilePath ?? change.path).replace(/\/+$/, '')
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
  depth: number
  onOpenChange: (change: WorkspaceFileChange) => void
}

function FileChangeRow({
  activeFilePath,
  change,
  copy,
  depth,
  onOpenChange,
}: FileChangeRowProps) {
  const active = activeFilePath === change.path
  const gitStatusTitle = copy.gitStatus(change.gitStatus)
  const visibleGitStatusLabel = change.gitStatus === 'untracked' ? '' : change.gitStatusLabel
  const stageLabel = change.gitStatus !== 'untracked' && (change.indexStatus || change.workingTreeStatus)
    ? change.indexStatus?.trim() && change.workingTreeStatus?.trim() ? copy.stagedAndUnstagedChanges : change.indexStatus?.trim() ? copy.stagedChanges : copy.unstagedChanges
    : ''
  const pathContext = [change.previousPath ? workspaceFileChangePathLabel(change) : '', stageLabel].filter(Boolean).join(' · ')
  return (
    <div
      key={workspaceFileChangeRowKey(change)}
      className={`code-file-change-row ${active ? 'active' : ''}`}
      data-testid="code-file-change-row"
      data-file-path={change.path}
      data-file-type="file"
      title={[workspaceFileChangeTitle(change, gitStatusTitle), stageLabel].filter(Boolean).join(' · ')}
      style={changeTreeDepthStyle(depth)}
    >
      <button
        type="button"
        className="code-file-change-main"
        onClick={() => onOpenChange(change)}
      >
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
                depth={depth}
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
                  else if (node.change) onOpenChange(node.change)
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

function openRepositoryReview(root: string, scope: 'tracked' | 'untracked') {
  const params = new URLSearchParams({ root, scope })
  window.open(appPath(`/review?${params.toString()}`), '_blank', 'noopener,noreferrer')
}

function ChangesDisclosure({ collapsed, label, onToggle }: {
  collapsed: boolean
  label: string
  onToggle: () => void
}) {
  return <button type="button" className="code-file-change-group-toggle" aria-expanded={!collapsed} onClick={onToggle}>
    <span className="code-file-section-chevron" aria-hidden="true">{collapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}</span>
    <span>{label}</span>
  </button>
}

function RepositoryFileChangesSection({
  activeFilePath, projectWorkspace, changes, collapsed, copy, projectId, refreshing,
  onOpenChange, onToggleCollapsed, grouped = false,
}: FileChangesSectionProps & { grouped?: boolean }) {
  const [initialState] = useState(() => loadCodeProjectFilesViewState(projectId))
  const [untrackedCollapsed, setUntrackedCollapsed] = useState(initialState.untrackedChangesCollapsed ?? true)
  const [openDirectoryIds, setOpenDirectoryIds] = useState<ReadonlySet<string>>(() => new Set(initialState.openChangeDirectoryIds ?? []))
  const trackedChanges = useMemo(() => changes.items.filter(change => change.gitStatus !== 'untracked'), [changes.items])
  const untrackedChanges = useMemo(() => changes.items.filter(change => change.gitStatus === 'untracked'), [changes.items])
  const trackedTree = useMemo(() => buildChangeTree(trackedChanges, 'tracked'), [trackedChanges])
  const untrackedTree = useMemo(() => buildChangeTree(untrackedChanges, 'untracked'), [untrackedChanges])
  const countsRefreshing = refreshing || changes.loading
  const countRefreshState = countsRefreshing ? 'refreshing' : changes.error ? 'stale' : 'refreshed'
  useEffect(() => {
    saveCodeProjectFilesViewState(projectId, { openChangeDirectoryIds: Array.from(openDirectoryIds), untrackedChangesCollapsed: untrackedCollapsed })
  }, [openDirectoryIds, projectId, untrackedCollapsed])

  const toggleDirectory = (id: string) => setOpenDirectoryIds(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const groups = [
    { scope: 'tracked', label: grouped ? copy.trackedChanges : copy.changes, items: trackedChanges, tree: trackedTree,
      collapsed, truncated: changes.trackedTruncated ?? changes.truncated, toggle: onToggleCollapsed },
    { scope: 'untracked', label: copy.untrackedChanges, items: untrackedChanges, tree: untrackedTree,
      collapsed: untrackedCollapsed, truncated: changes.untrackedTruncated ?? changes.truncated,
      toggle: () => setUntrackedCollapsed(current => !current) },
  ] as const
  if (!changes.items.length && !changes.error && !changes.truncated) return null
  return <div className="code-file-changes-section" data-testid="code-file-changes-section" data-project-id={projectId}
    aria-label={copy.changedFiles} aria-busy={countsRefreshing}>
    {groups.map(group => (group.items.length > 0 || group.truncated) && <div key={group.scope}
      className={`code-file-change-group ${group.scope} ${group.collapsed ? 'collapsed' : ''}`}
      data-testid={`code-file-change-${group.scope}-group`}>
      <div className="code-file-change-group-header">
        <button type="button" className="code-file-change-group-toggle" aria-expanded={!group.collapsed}
          onClick={() => { if (group.collapsed) void changes.refreshChanges(); group.toggle() }}>
          <span className="code-file-section-chevron" aria-hidden="true">{group.collapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}</span>
          <span>{group.label}</span>
          <span className={`code-file-changes-count ${countRefreshState}`} data-testid={`code-file-changes-${group.scope}-count`}
            data-refresh-state={countRefreshState} aria-label={countsRefreshing ? copy.refreshingFiles : undefined}
            title={changes.error ?? (group.truncated ? copy.partialChanges : undefined)}>
            {countsRefreshing ? <span className="code-file-changes-count-loader" aria-hidden="true">···</span>
              : <>{group.items.length}{group.truncated ? '+' : ''}</>}
          </span>
        </button>
        {!grouped && group.scope === 'tracked' && <button type="button" className="code-file-change-review"
          title={copy.trackedChanges} onClick={() => openRepositoryReview(projectWorkspace, 'tracked')}>{copy.reviewChanges}</button>}
      </div>
      {!group.collapsed && <>
        {group.scope === 'untracked' && <div className="code-file-change-scope-actions"><button type="button" className="code-file-change-review"
          onClick={() => openRepositoryReview(projectWorkspace, 'untracked')}>{copy.reviewUntracked}</button></div>}
        <FileChangeTreeRows activeFilePath={activeFilePath} copy={copy} depth={0} nodes={group.tree}
          openDirectoryIds={openDirectoryIds} onOpenChange={onOpenChange} onToggleDirectory={toggleDirectory} />
        {group.truncated && <div className="code-file-changes-status" role="status">{copy.partialChangesDescription}</div>}
      </>}
    </div>)}
    {changes.error && <div className="code-file-changes-status error" data-testid="code-file-changes-error" role="alert">{changes.error}</div>}
  </div>
}

function RepositoryChangesGroup({ repository, ...props }: FileChangesSectionProps & {
  repository: NonNullable<WorkspaceFileChanges['repositories']>[number]
}) {
  const projectId = repository.path ? `${props.projectId}:repository:${repository.path}` : props.projectId
  const [saved] = useState(() => loadCodeProjectFilesViewState(projectId))
  const [collapsed, setCollapsed] = useState(saved.repositoryCollapsed ?? false)
  const [childTrackedCollapsed, setChildTrackedCollapsed] = useState(saved.changesCollapsed ?? true)
  const trackedCollapsed = repository.path ? childTrackedCollapsed : props.collapsed
  useEffect(() => {
    saveCodeProjectFilesViewState(projectId, { repositoryCollapsed: collapsed,
      ...(repository.path ? { changesCollapsed: childTrackedCollapsed } : {}) })
  }, [collapsed, projectId, childTrackedCollapsed, repository.path])
  const items = props.changes.items.filter(item => (item.repositoryPath ?? '') === repository.path)
  if (!items.length && !repository.error && !repository.truncated) return null
  const root = repository.path ? `${props.projectWorkspace.replace(/\/$/, '')}/${repository.path}` : props.projectWorkspace
  const canReview = !repository.error && (items.some(item => item.gitStatus !== 'untracked') || repository.trackedTruncated)
  return <div className="code-file-repository" data-repository-path={repository.path}>
    <div className="code-file-change-group-header">
      <button type="button" className="code-file-change-group-toggle" aria-expanded={!collapsed}
        onClick={() => { if (collapsed) void props.changes.refreshChanges(); setCollapsed(value => !value) }}>
        <span className="code-file-section-chevron" aria-hidden="true">{collapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}</span>
        <span className="code-file-repository-label" title={repository.path || props.copy.mainRepository}>
          <span>{repository.path || props.copy.mainRepository}</span>
          {repository.path && <span className="code-file-repository-kind">{props.copy.submodule}</span>}
        </span>
        {(repository.error || (collapsed && repository.truncated)) && <span className="code-file-repository-status" title={repository.error || props.copy.partialChangesDescription}>
          {repository.error ? props.copy.repositoryUnavailable : props.copy.partialChanges}</span>}
      </button>
      {canReview && <button type="button" className="code-file-change-review" title={props.copy.trackedChanges}
        onClick={() => openRepositoryReview(root, 'tracked')}>{props.copy.reviewChanges}</button>}
    </div>
    {!collapsed && <div className="code-file-repository-body"><RepositoryFileChangesSection {...props} grouped
      projectWorkspace={root} projectId={projectId} collapsed={trackedCollapsed}
      onToggleCollapsed={repository.path ? () => setChildTrackedCollapsed(value => !value) : props.onToggleCollapsed}
      changes={{ ...props.changes, items, truncated: repository.truncated, trackedTruncated: repository.trackedTruncated,
        untrackedTruncated: repository.untrackedTruncated, error: repository.error ?? null }} /></div>}
  </div>
}

export function FileChangesSection(props: FileChangesSectionProps) {
  const [collapsed, setCollapsed] = useState(() => loadCodeProjectFilesViewState(props.projectId).repositoriesCollapsed ?? false)
  useEffect(() => { saveCodeProjectFilesViewState(props.projectId, { repositoriesCollapsed: collapsed }) }, [collapsed, props.projectId])
  const repositories = props.changes.repositories
  if (!repositories || repositories.length <= 1) return <RepositoryFileChangesSection {...props}
    changes={{ ...props.changes, error: props.changes.error || repositories?.[0]?.error || null }} />
  if (!props.changes.items.length && !props.changes.error && !props.changes.truncated && !repositories.some(repository => repository.error)) return null
  return <div data-testid="code-repository-changes">
    <div className="code-file-change-group-header">
      <ChangesDisclosure collapsed={collapsed} label={props.copy.changes}
        onToggle={() => { if (collapsed) void props.changes.refreshChanges(); setCollapsed(value => !value) }} />
      {collapsed && (props.changes.error || props.changes.truncated || repositories.some(repository => repository.error)) &&
        <span className="code-file-repository-status">{props.changes.error || repositories.some(repository => repository.error) ? props.copy.repositoryUnavailable : props.copy.partialChanges}</span>}
    </div>
    {props.changes.error && <div className="code-file-changes-status error" role="alert">{props.changes.error}</div>}
    {!collapsed && repositories.map(repository => <RepositoryChangesGroup key={repository.path} {...props} repository={repository} />)}
  </div>
}
