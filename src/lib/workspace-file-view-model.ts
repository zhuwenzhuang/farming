import { ancestorDirectories, isDescendantPath, type WorkspaceFileTreeNode } from './workspace-file-tree'

export const WORKSPACE_FILE_SEARCH_FOCUS_RETRY_DELAYS = [0, 80, 180, 300, 520, 900, 1200]
export const WORKSPACE_FILE_TREE_FOCUS_RETRY_DELAYS = [80, 180, 360]
const WORKSPACE_FILE_TREE_FOCUS_CANCEL_KEYS = new Set([
  'ArrowDown',
  'ArrowUp',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Enter',
  ' ',
  'F2',
  'Delete',
  'Backspace',
  'ContextMenu',
])

export interface WorkspaceFileViewRect {
  top: number
  bottom: number
}

export interface WorkspaceFileRowSnapshot extends WorkspaceFileViewRect {
  path: string
  type?: string
  depth?: number
}

export interface WorkspaceVisibleFileTreeRow {
  path: string
  type: WorkspaceFileTreeNode['type']
  depth: number
  ancestors: Array<{ path: string; depth: number }>
}

export interface WorkspaceFileTreeSelectedRowState {
  path?: string
  type?: string
  expanded?: boolean
}

export interface WorkspaceFileTreeFocusRowCandidate {
  path: string
  selected: boolean
}

export type WorkspaceFileStickyContextItem = {
  kind: 'directory'
  key: string
  node: WorkspaceFileTreeNode
  nodes: WorkspaceFileTreeNode[]
}

export type WorkspaceFileTreeRowClickIntent = 'toggle-directory' | 'open-file' | 'select'
export type WorkspaceFileTreeActivationIntent = 'open-directory' | 'close-directory' | 'open-file' | 'none'

export function workspaceFileRevealScrollDelta(scrollerRect: WorkspaceFileViewRect, rowRect: WorkspaceFileViewRect) {
  if (rowRect.top < scrollerRect.top) {
    return rowRect.top - scrollerRect.top
  }
  if (rowRect.bottom > scrollerRect.bottom) {
    return rowRect.bottom - scrollerRect.bottom
  }
  return 0
}

export function shouldFocusWorkspaceFileTree(options: {
  focusRow: boolean
  operationActive: boolean
  activeElementIsSearchInput: boolean
  searchInputValue?: string
}) {
  return options.focusRow &&
    !options.operationActive &&
    !options.activeElementIsSearchInput &&
    !options.searchInputValue
}

export function shouldSkipWorkspaceFileSearchFocus(options: {
  activeElementIsSearchInput: boolean
  searchInputValue?: string
}) {
  return options.activeElementIsSearchInput && Boolean(options.searchInputValue)
}

export function shouldSelectWorkspaceFileSearchText(options: {
  requestedSelect: boolean
  searchInputValue?: string
}) {
  return options.requestedSelect || !options.searchInputValue
}

export function shouldCancelPendingWorkspaceFileTreeFocus(key: string) {
  return WORKSPACE_FILE_TREE_FOCUS_CANCEL_KEYS.has(key)
}

export function workspaceFileTreeFocusTargetPath(options: {
  lastFocusedPath?: string | null
  rows: readonly WorkspaceFileTreeFocusRowCandidate[]
}) {
  return options.rows.find(row => row.path === options.lastFocusedPath)?.path
    ?? options.rows.find(row => row.selected)?.path
    ?? options.rows[0]?.path
    ?? null
}

export function workspaceFileTreeKeyboardTargetPath(options: {
  targetPath?: string
  selectedPath?: string
  focusedPath?: string
  lastFocusedPath?: string | null
}) {
  return options.selectedPath ?? options.targetPath ?? options.focusedPath ?? options.lastFocusedPath ?? null
}

export function workspaceFileTreePageJumpSize(viewportHeight: number, rowHeight: number) {
  const safeRowHeight = Math.max(1, rowHeight)
  return Math.max(1, Math.floor(Math.max(0, viewportHeight) / safeRowHeight) - 1)
}

export function workspaceFileTreePageJumpIndex(options: {
  currentIndex: number
  key: 'PageUp' | 'PageDown'
  pageSize: number
  rowCount: number
}) {
  if (options.rowCount <= 0) return -1
  const currentIndex = Math.max(0, Math.min(options.currentIndex, options.rowCount - 1))
  const direction = options.key === 'PageUp' ? -1 : 1
  const nextIndex = currentIndex + direction * Math.max(1, options.pageSize)
  return Math.max(0, Math.min(nextIndex, options.rowCount - 1))
}

export function shouldCloseWorkspaceFileTreeDirectory(options: {
  nodePath: string
  nodeType: string
  nodeOpen: boolean
  selectedRow: WorkspaceFileTreeSelectedRowState
  openDirectoryPaths: ReadonlySet<string>
}) {
  if (options.nodeType !== 'directory') return false
  const selectedDirectoryOpen = options.selectedRow.path === options.nodePath &&
    options.selectedRow.type === 'directory' &&
    options.selectedRow.expanded === true
  return options.nodeOpen || selectedDirectoryOpen || options.openDirectoryPaths.has(options.nodePath)
}

export function workspaceFileTreeRowClickIntent(options: {
  nodeType: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}): WorkspaceFileTreeRowClickIntent {
  const plainClick = !options.metaKey && !options.ctrlKey && !options.shiftKey
  if (options.nodeType === 'directory' && plainClick) return 'toggle-directory'
  if (options.nodeType === 'file' && plainClick) return 'open-file'
  return 'select'
}

export function workspaceFileTreeActivationIntent(options: {
  nodeType: string
  nodeOpen: boolean
}): WorkspaceFileTreeActivationIntent {
  if (options.nodeType === 'directory') return options.nodeOpen ? 'close-directory' : 'open-directory'
  if (options.nodeType === 'file') return 'open-file'
  return 'none'
}

export function workspaceStickyContentTop(scrollerTop: number) {
  return scrollerTop
}

export function isWorkspaceStickyContextVisible(viewportTop: number, stickyTop: number, margin = 1) {
  return viewportTop < stickyTop + margin
}

export function workspaceStickyContextRevealProgress(viewportTop: number, stickyTop: number, rowHeight: number) {
  return Math.min(1, Math.max(0, (stickyTop - viewportTop) / Math.max(1, rowHeight)))
}

export function firstVisibleWorkspaceFilePath(
  rows: readonly WorkspaceFileRowSnapshot[],
  stickyTop: number,
  scrollerBottom: number,
  margin = 1
) {
  return rows.find(row => row.bottom > stickyTop + margin && row.top < scrollerBottom)?.path ?? ''
}

export function workspaceStickyDirectoryPaths(
  firstVisiblePath: string,
  rows: readonly WorkspaceFileRowSnapshot[],
  stickyTop: number
) {
  if (!firstVisiblePath) return []
  const topByPath = new Map(rows.map(row => [row.path, row.top]))
  return ancestorDirectories(firstVisiblePath).filter(directoryPath => {
    const top = topByPath.get(directoryPath)
    return typeof top === 'number' && top < stickyTop
  })
}

export function workspaceStickyDirectoryPathsForViewport(options: {
  rows: readonly WorkspaceFileRowSnapshot[]
  stickyTop: number
  scrollerBottom: number
  rowHeight: number
}) {
  const stickyBottom = options.stickyTop + Math.max(1, options.rowHeight)
  const firstUncoveredIndex = options.rows.findIndex(row => (
    row.top >= stickyBottom - 1 && row.top < options.scrollerBottom
  ))
  if (firstUncoveredIndex < 0) return []

  return workspaceStickyDirectoryPaths(options.rows[firstUncoveredIndex]!.path, options.rows, stickyBottom)
}

export function workspaceVisibleFileTreeRows(
  nodes: readonly WorkspaceFileTreeNode[],
  openDirectoryPaths: ReadonlySet<string>,
  depth = 0,
  ancestors: Array<{ path: string; depth: number }> = []
): WorkspaceVisibleFileTreeRow[] {
  return nodes.flatMap(node => {
    const row: WorkspaceVisibleFileTreeRow = {
      path: node.path,
      type: node.type,
      depth,
      ancestors: [...ancestors],
    }
    if (node.type !== 'directory' || !openDirectoryPaths.has(node.path)) return [row]
    return [
      row,
      ...workspaceVisibleFileTreeRows(
        node.children ?? [],
        openDirectoryPaths,
        depth + 1,
        [...ancestors, { path: node.path, depth }]
      ),
    ]
  })
}

export function workspaceStickyDirectoryPathsForIndexedViewport(options: {
  rows: readonly WorkspaceVisibleFileTreeRow[]
  treeTop: number
  stickyTop: number
  scrollerBottom: number
  rowHeight: number
  stickyHeight: number
}) {
  const rowHeight = Math.max(1, options.rowHeight)
  const stickyBottom = options.stickyTop + Math.max(0, options.stickyHeight)
  const firstUncoveredIndex = Math.max(0, Math.ceil((stickyBottom - 1 - options.treeTop) / rowHeight))
  const firstUncoveredRow = options.rows[firstUncoveredIndex]
  if (!firstUncoveredRow) return []
  if (options.treeTop + firstUncoveredIndex * rowHeight >= options.scrollerBottom) return []

  return firstUncoveredRow.ancestors.map(ancestor => ancestor.path)
}

function workspaceFileIndentShiftDepthForWindow(
  rows: readonly WorkspaceVisibleFileTreeRow[],
  startIndex: number,
  rowCount: number,
  minimumShiftDepth: number
) {
  const visibleRows = rows.slice(startIndex, startIndex + rowCount)
  const firstRow = visibleRows[0]
  if (!firstRow) return 0
  for (let index = firstRow.ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = firstRow.ancestors[index]!
    if (ancestor.depth < minimumShiftDepth) break
    if (visibleRows.every(row => isDescendantPath(ancestor.path, row.path))) {
      return ancestor.depth
    }
  }
  return 0
}

export function workspaceFileIndentShiftDepthForViewport(options: {
  rows: readonly WorkspaceVisibleFileTreeRow[]
  treeTop: number
  stickyTop: number
  scrollerBottom: number
  rowHeight: number
  stickyHeight: number
  minimumShiftDepth?: number
}) {
  if (options.treeTop >= options.stickyTop || options.rows.length === 0) return 0
  const rowHeight = Math.max(1, options.rowHeight)
  const viewportTop = options.stickyTop + Math.max(0, options.stickyHeight)
  const viewportHeight = options.scrollerBottom - viewportTop
  if (viewportHeight <= 0) return 0

  const rowPosition = Math.max(0, (viewportTop - options.treeTop) / rowHeight)
  const startIndex = Math.floor(rowPosition)
  const progress = rowPosition - startIndex
  const rowCount = Math.max(1, Math.floor(viewportHeight / rowHeight))
  const minimumShiftDepth = Math.max(0, options.minimumShiftDepth ?? 2)
  const currentShift = workspaceFileIndentShiftDepthForWindow(
    options.rows,
    startIndex,
    rowCount,
    minimumShiftDepth
  )
  const nextShift = workspaceFileIndentShiftDepthForWindow(
    options.rows,
    startIndex + 1,
    rowCount,
    minimumShiftDepth
  )
  return currentShift + (nextShift - currentShift) * progress
}

export function workspaceStickyContextItems(options: {
  directoryNodes: readonly WorkspaceFileTreeNode[]
}): WorkspaceFileStickyContextItem[] {
  const node = options.directoryNodes[options.directoryNodes.length - 1]
  if (!node) return []
  return [{
    kind: 'directory',
    key: options.directoryNodes.map(item => item.path).join('\0'),
    node,
    nodes: [...options.directoryNodes],
  }]
}

export function workspaceCompactStickyDirectoryLabel(nodes: readonly WorkspaceFileTreeNode[]) {
  return nodes.map(node => node.displayName ?? node.name).filter(Boolean).join('/')
}

export function workspaceStickyDirectoryPresentation(nodes: readonly WorkspaceFileTreeNode[]) {
  const segments = workspaceCompactStickyDirectoryLabel(nodes).split('/').filter(Boolean)
  const fullLabel = segments.join('/')
  const compactLabel = segments.length > 3
    ? [segments[0]!, '…', ...segments.slice(-2)].join('/')
    : fullLabel
  const mediumLabel = segments.length > 5
    ? [segments[0]!, '…', ...segments.slice(-4)].join('/')
    : fullLabel
  return {
    compactLabel,
    mediumLabel,
    fullLabel,
  }
}
