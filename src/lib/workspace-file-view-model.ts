import { ancestorDirectories, type WorkspaceFileTreeNode } from './workspace-file-tree'

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

export type WorkspaceFileStickyContextItem = { kind: 'directory'; key: string; node: WorkspaceFileTreeNode }

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

export function workspaceStickyContentTop(scrollerTop: number, projectRowHeight = 30, precedingSectionHeight = 0, filesHeaderHeight = 25) {
  return scrollerTop + projectRowHeight + precedingSectionHeight + filesHeaderHeight
}

export function isWorkspaceStickyContextVisible(viewportTop: number, stickyTop: number, margin = 1) {
  return viewportTop < stickyTop + margin
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

export function workspaceStickyContextItems(options: {
  visible: boolean
  directoryNodes: readonly WorkspaceFileTreeNode[]
}): WorkspaceFileStickyContextItem[] {
  if (!options.visible && options.directoryNodes.length === 0) return []
  return options.directoryNodes.map(node => ({ kind: 'directory' as const, key: node.path, node }))
}

export function workspaceCompactStickyDirectoryLabel(nodes: readonly WorkspaceFileTreeNode[]) {
  return nodes.map(node => node.displayName ?? node.name).filter(Boolean).join('/')
}

export function preserveWorkspaceFileScrollPosition(scroller: HTMLElement | null | undefined) {
  if (!scroller) return () => {}
  const scrollTop = scroller.scrollTop
  const restore = () => {
    scroller.scrollTop = scrollTop
  }

  restore()
  window.requestAnimationFrame(restore)
  window.setTimeout(restore, 0)
  window.setTimeout(restore, 80)
  window.setTimeout(restore, 180)
  return restore
}
