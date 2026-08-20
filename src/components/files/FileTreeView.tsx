import {
  createContext,
  memo,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type RefObject,
} from 'react'
import { Tree, type NodeRendererProps, type TreeApi } from 'react-arborist'
import type { WorkspaceFileOpenTarget } from '@/lib/workspace-file-search'
import type { WorkspaceFileOperationState } from '@/lib/workspace-file-operation-model'
import type { WorkspaceFileTreeNode as FileExplorerNode } from '@/lib/workspace-file-tree'
import type { WorkspaceFileDecorationStore } from '@/lib/workspace-file-decorations'
import type { CodeCopy } from '../code/copy'
import { FileStickyContext } from './FileStickyContext'
import { FileTreeRow } from './FileTreeRow'
import type { FileStickyContextItem } from './useWorkspaceFileStickyContext'

const FILE_TREE_OVERSCAN_ROWS = 6
const FILE_TREE_INITIAL_VIEWPORT_ROWS = 24

export interface FileTreeViewProps {
  activeFilePath?: string
  agentId: string
  copy: CodeCopy
  decorations: WorkspaceFileDecorationStore
  editorDirtyFilePaths: ReadonlySet<string>
  editorExternalChangedFilePaths: ReadonlySet<string>
  fileOperation: WorkspaceFileOperationState | null
  fileOperationInputRef: RefObject<HTMLInputElement | null>
  handleTreeKeyDownCapture: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  lastFocusedFilePathRef: MutableRefObject<string | null>
  locatedFilePath?: string | null
  openFilePendingPath?: string | null
  renderFileTreeRow: NonNullable<Parameters<typeof Tree<FileExplorerNode>>[0]['renderRow']>
  rowHeight: number
  stickyContextItems: FileStickyContextItem[]
  treeData: FileExplorerNode[]
  treeHeight: number
  treeRef: MutableRefObject<TreeApi<FileExplorerNode> | undefined>
  treeViewportRef: RefObject<HTMLDivElement | null>
  visibleTreeRowCount: number
  onCancelPendingFileFocus: () => void
  onCloseFileOperation: () => void
  onFocusFileTreeTarget: (item: FileExplorerNode | null) => void
  onFocusStickyDirectory: (node: FileExplorerNode) => void
  onOpenFileContextMenu: (x: number, y: number, item: FileExplorerNode | null) => void
  onOpenFilePath: (filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void>
  onRememberFileOperationName: (name: string) => void
  onToggleDirectory: (path: string) => boolean
  onSubmitFileOperation: () => Promise<void>
  onToggleTreeNode: (path: string) => void
  onTreeFocus: (node: { data: FileExplorerNode } | null | undefined) => void
  onTreeSelect: (nodes: Array<{ data: FileExplorerNode }>) => void
  onUpdateFileOperationName: (name: string) => void
}

type FileNodeRendererContextValue = Omit<
  FileTreeViewProps,
  | 'activeFilePath'
  | 'handleTreeKeyDownCapture'
  | 'openFilePendingPath'
  | 'renderFileTreeRow'
  | 'rowHeight'
  | 'stickyContextItems'
  | 'treeData'
  | 'treeHeight'
  | 'treeRef'
  | 'visibleTreeRowCount'
  | 'onFocusStickyDirectory'
  | 'onToggleTreeNode'
  | 'onTreeFocus'
  | 'onTreeSelect'
> & {
  activeFilePathStore: ActiveFilePathStore
  openFilePendingPathStore: ActiveFilePathStore
  selectedFilePathStore: SelectedFilePathStore
  onSelectFilePath: (filePath: string) => () => void
}

class ActiveFilePathStore {
  private activeFilePath: string | undefined
  private readonly listeners = new Map<string, Set<() => void>>()

  set(filePath: string | undefined) {
    if (filePath === this.activeFilePath) return
    const previous = this.activeFilePath
    this.activeFilePath = filePath
    if (previous) this.listeners.get(previous)?.forEach(listener => listener())
    if (filePath) this.listeners.get(filePath)?.forEach(listener => listener())
  }

  subscribe(filePath: string, listener: () => void) {
    const listeners = this.listeners.get(filePath) ?? new Set()
    listeners.add(listener)
    this.listeners.set(filePath, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(filePath)
    }
  }

  isActive(filePath: string) {
    return this.activeFilePath === filePath
  }
}

class SelectedFilePathStore {
  private selectedFilePaths = new Set<string>()
  private readonly listeners = new Map<string, Set<() => void>>()

  set(filePaths: Iterable<string>) {
    const next = new Set(filePaths)
    const changed = new Set<string>()
    this.selectedFilePaths.forEach(filePath => {
      if (!next.has(filePath)) changed.add(filePath)
    })
    next.forEach(filePath => {
      if (!this.selectedFilePaths.has(filePath)) changed.add(filePath)
    })
    if (changed.size === 0) return
    this.selectedFilePaths = next
    changed.forEach(filePath => this.listeners.get(filePath)?.forEach(listener => listener()))
  }

  subscribe(filePath: string, listener: () => void) {
    const listeners = this.listeners.get(filePath) ?? new Set()
    listeners.add(listener)
    this.listeners.set(filePath, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(filePath)
    }
  }

  isSelected(filePath: string) {
    return this.selectedFilePaths.has(filePath)
  }
}

const FileNodeRendererContext = createContext<FileNodeRendererContextValue | null>(null)

function FileNodeRenderer({ node }: NodeRendererProps<FileExplorerNode>) {
  const props = useContext(FileNodeRendererContext)
  if (!props) return null
  return (
    <SubscribedFileTreeRow
      {...props}
      node={node}
      nodeRenderState={{
        isFocused: node.isFocused,
        isOpen: node.isOpen,
        level: node.level,
      }}
    />
  )
}

interface FileNodeRenderState {
  isFocused: boolean
  isOpen: boolean
  level: number
}

type SubscribedFileTreeRowProps = FileNodeRendererContextValue & {
  node: NodeRendererProps<FileExplorerNode>['node']
  nodeRenderState: FileNodeRenderState
}

const SubscribedFileTreeRow = memo(function SubscribedFileTreeRow({
  activeFilePathStore,
  openFilePendingPathStore,
  selectedFilePathStore,
  decorations,
  node,
  nodeRenderState: _nodeRenderState,
  ...rowProps
}: SubscribedFileTreeRowProps) {
  const subscribe = useCallback(
    (listener: () => void) => activeFilePathStore.subscribe(node.data.path, listener),
    [activeFilePathStore, node.data.path],
  )
  const getSnapshot = useCallback(
    () => activeFilePathStore.isActive(node.data.path),
    [activeFilePathStore, node.data.path],
  )
  const active = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const subscribePending = useCallback(
    (listener: () => void) => openFilePendingPathStore.subscribe(node.data.path, listener),
    [node.data.path, openFilePendingPathStore],
  )
  const getPendingSnapshot = useCallback(
    () => openFilePendingPathStore.isActive(node.data.path),
    [node.data.path, openFilePendingPathStore],
  )
  const pending = useSyncExternalStore(subscribePending, getPendingSnapshot, getPendingSnapshot)
  const subscribeSelected = useCallback(
    (listener: () => void) => selectedFilePathStore.subscribe(node.data.path, listener),
    [node.data.path, selectedFilePathStore],
  )
  const getSelectedSnapshot = useCallback(
    () => selectedFilePathStore.isSelected(node.data.path),
    [node.data.path, selectedFilePathStore],
  )
  const selected = useSyncExternalStore(subscribeSelected, getSelectedSnapshot, getSelectedSnapshot)
  const subscribeDecoration = useCallback(
    (listener: () => void) => decorations.subscribe(node.data.path, listener),
    [decorations, node.data.path],
  )
  const getDecorationSnapshot = useCallback(
    () => decorations.get(node.data.path),
    [decorations, node.data.path],
  )
  const decoration = useSyncExternalStore(subscribeDecoration, getDecorationSnapshot, getDecorationSnapshot)
  return (
    <FileTreeRow
      {...rowProps}
      activeFilePath={active ? node.data.path : undefined}
      decoration={decoration}
      node={node}
      openFilePendingPath={pending ? node.data.path : undefined}
      selected={selected}
    />
  )
}, (previous, next) => {
  if (
    previous.node.data !== next.node.data
    || previous.node.tree !== next.node.tree
    || previous.nodeRenderState.isFocused !== next.nodeRenderState.isFocused
    || previous.nodeRenderState.isOpen !== next.nodeRenderState.isOpen
    || previous.nodeRenderState.level !== next.nodeRenderState.level
  ) return false
  return (Object.keys(previous) as Array<keyof SubscribedFileTreeRowProps>).every(key => (
    key === 'node'
    || key === 'nodeRenderState'
    || Object.is(previous[key], next[key])
  ))
})

const FileTreeViewContent = memo(function FileTreeViewContent({
  activeFilePathStore,
  openFilePendingPathStore,
  selectedFilePathStore,
  agentId,
  copy,
  editorDirtyFilePaths,
  editorExternalChangedFilePaths,
  decorations,
  fileOperation,
  fileOperationInputRef,
  handleTreeKeyDownCapture,
  lastFocusedFilePathRef,
  locatedFilePath,
  renderFileTreeRow,
  rowHeight,
  stickyContextItems,
  treeData,
  treeHeight,
  treeRef,
  treeViewportRef,
  visibleTreeRowCount,
  onCancelPendingFileFocus,
  onCloseFileOperation,
  onFocusFileTreeTarget,
  onFocusStickyDirectory,
  onOpenFileContextMenu,
  onOpenFilePath,
  onSelectFilePath,
  onRememberFileOperationName,
  onToggleDirectory,
  onSubmitFileOperation,
  onToggleTreeNode,
  onTreeFocus,
  onTreeSelect,
  onUpdateFileOperationName,
}: Omit<FileTreeViewProps, 'activeFilePath' | 'openFilePendingPath'> & {
  activeFilePathStore: ActiveFilePathStore
  openFilePendingPathStore: ActiveFilePathStore
  selectedFilePathStore: SelectedFilePathStore
  onSelectFilePath: (filePath: string) => () => void
}) {
  const pointerFileClickRef = useRef<{
    clientX: number
    clientY: number
    filePath: string
    timeStamp: number
  } | null>(null)
  const treeWindowRef = useRef<HTMLDivElement | null>(null)
  const virtualScrollOffsetRef = useRef(0)
  const [treeWindowHeight, setTreeWindowHeight] = useState(() => (
    Math.max(rowHeight, Math.min(treeHeight, rowHeight * FILE_TREE_INITIAL_VIEWPORT_ROWS))
  ))

  useLayoutEffect(() => {
    const viewport = treeViewportRef.current
    const scroller = viewport?.closest<HTMLElement>('.code-project-list')
    if (!viewport || !scroller) return undefined
    const updateHeight = () => {
      const nextHeight = Math.max(rowHeight, Math.min(treeHeight, scroller.clientHeight || rowHeight))
      setTreeWindowHeight(current => current === nextHeight ? current : nextHeight)
    }
    updateHeight()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateHeight)
    observer?.observe(scroller)
    window.addEventListener('resize', updateHeight)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateHeight)
    }
  }, [rowHeight, treeHeight, treeViewportRef])

  useLayoutEffect(() => {
    const viewport = treeViewportRef.current
    const scroller = viewport?.closest<HTMLElement>('.code-project-list')
    const treeWindow = treeWindowRef.current
    if (!viewport || !scroller || !treeWindow) return undefined
    let frameId = 0
    const synchronize = () => {
      frameId = 0
      const viewportRect = viewport.getBoundingClientRect()
      const scrollerRect = scroller.getBoundingClientRect()
      const maxOffset = Math.max(0, treeHeight - treeWindowHeight)
      const offset = Math.max(0, Math.min(maxOffset, scrollerRect.top - viewportRect.top))
      virtualScrollOffsetRef.current = offset
      treeWindow.style.transform = `translateY(${offset}px)`
      treeRef.current?.list.current?.scrollTo(offset)
    }
    const scheduleSynchronize = () => {
      if (frameId) return
      frameId = window.requestAnimationFrame(synchronize)
    }
    synchronize()
    scroller.addEventListener('scroll', scheduleSynchronize, { passive: true })
    window.addEventListener('resize', scheduleSynchronize)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleSynchronize)
    observer?.observe(viewport)
    return () => {
      if (frameId) window.cancelAnimationFrame(frameId)
      observer?.disconnect()
      scroller.removeEventListener('scroll', scheduleSynchronize)
      window.removeEventListener('resize', scheduleSynchronize)
    }
  }, [treeHeight, treeRef, treeViewportRef, treeWindowHeight])

  const handleVirtualTreeScroll = useCallback(({
    scrollOffset,
    scrollUpdateWasRequested,
  }: {
    scrollOffset: number
    scrollUpdateWasRequested: boolean
  }) => {
    if (!scrollUpdateWasRequested || Math.abs(scrollOffset - virtualScrollOffsetRef.current) < 1) return
    const viewport = treeViewportRef.current
    const scroller = viewport?.closest<HTMLElement>('.code-project-list')
    if (!viewport || !scroller) return
    const currentOffset = Math.max(0, Math.min(
      Math.max(0, treeHeight - treeWindowHeight),
      scroller.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
    ))
    scroller.scrollTop += scrollOffset - currentOffset
  }, [treeHeight, treeViewportRef, treeWindowHeight])

  const handleViewportContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement | null)?.closest('[data-file-path]')) return
    event.preventDefault()
    onCancelPendingFileFocus()
    onOpenFileContextMenu(event.clientX, event.clientY, null)
  }, [onCancelPendingFileFocus, onOpenFileContextMenu])

  const handleViewportClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-file-path]')
    if (row?.dataset.fileType === 'file' && event.detail === 1) {
      pointerFileClickRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        filePath: row.dataset.filePath ?? '',
        timeStamp: event.timeStamp,
      }
      return
    }
    const firstClick = pointerFileClickRef.current
    if (
      event.detail > 1
      && firstClick?.filePath
      && row?.dataset.filePath !== firstClick.filePath
      && event.timeStamp - firstClick.timeStamp <= 1_000
      && Math.abs(event.clientX - firstClick.clientX) <= 12
      && Math.abs(event.clientY - firstClick.clientY) <= 12
    ) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (!row && event.detail === 1) pointerFileClickRef.current = null
  }, [])

  const handleViewportDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-file-path]')
    const firstClick = pointerFileClickRef.current
    pointerFileClickRef.current = null
    if (
      !firstClick?.filePath
      || row?.dataset.filePath === firstClick.filePath
      || event.timeStamp - firstClick.timeStamp > 1_000
      || Math.abs(event.clientX - firstClick.clientX) > 12
      || Math.abs(event.clientY - firstClick.clientY) > 12
    ) return
    event.preventDefault()
    event.stopPropagation()
    void onOpenFilePath(firstClick.filePath, { transient: false, focusEditor: true })
  }, [onOpenFilePath])

  const nodeRendererContext = useMemo<FileNodeRendererContextValue>(() => ({
    activeFilePathStore,
    openFilePendingPathStore,
    selectedFilePathStore,
    agentId,
    copy,
    editorDirtyFilePaths,
    editorExternalChangedFilePaths,
    decorations,
    fileOperation,
    fileOperationInputRef,
    lastFocusedFilePathRef,
    locatedFilePath,
    treeViewportRef,
    onCancelPendingFileFocus,
    onCloseFileOperation,
    onFocusFileTreeTarget,
    onOpenFileContextMenu,
    onOpenFilePath,
    onSelectFilePath,
    onRememberFileOperationName,
    onToggleDirectory,
    onSubmitFileOperation,
    onUpdateFileOperationName,
  }), [
    activeFilePathStore,
    openFilePendingPathStore,
    selectedFilePathStore,
    agentId,
    copy,
    editorDirtyFilePaths,
    editorExternalChangedFilePaths,
    decorations,
    fileOperation,
    fileOperationInputRef,
    lastFocusedFilePathRef,
    locatedFilePath,
    treeViewportRef,
    onCancelPendingFileFocus,
    onCloseFileOperation,
    onFocusFileTreeTarget,
    onOpenFileContextMenu,
    onOpenFilePath,
    onSelectFilePath,
    onRememberFileOperationName,
    onToggleDirectory,
    onSubmitFileOperation,
    onUpdateFileOperationName,
  ])

  return (
    <div
      className="code-file-tree-viewport"
      ref={treeViewportRef}
      data-visible-row-count={visibleTreeRowCount}
      style={{ height: treeHeight }}
      onKeyDownCapture={handleTreeKeyDownCapture}
      onClickCapture={handleViewportClickCapture}
      onDoubleClickCapture={handleViewportDoubleClick}
      onContextMenu={handleViewportContextMenu}
    >
      <FileStickyContext
        copy={copy}
        decorations={decorations}
        items={stickyContextItems}
        onFocusDirectory={onFocusStickyDirectory}
        onOpenFileContextMenu={onOpenFileContextMenu}
      />
      <FileNodeRendererContext.Provider value={nodeRendererContext}>
        <div
          className="code-file-tree-window"
          ref={treeWindowRef}
          style={{ height: treeWindowHeight }}
        >
          <Tree<FileExplorerNode>
            ref={treeRef}
            data={treeData}
            idAccessor="id"
            childrenAccessor="children"
            rowHeight={rowHeight}
            indent={0}
            height={treeWindowHeight}
            width="100%"
            overscanCount={FILE_TREE_OVERSCAN_ROWS}
            openByDefault={false}
            selectionFollowsFocus
            className="code-file-tree"
            rowClassName="code-file-tree-row"
            renderRow={renderFileTreeRow}
            onScroll={handleVirtualTreeScroll}
            onToggle={onToggleTreeNode}
            onFocus={onTreeFocus}
            onSelect={onTreeSelect}
            disableDrag
            disableEdit
            disableDrop
          >
            {FileNodeRenderer}
          </Tree>
        </div>
      </FileNodeRendererContext.Provider>
    </div>
  )
})

export function FileTreeView({ activeFilePath, openFilePendingPath, onTreeSelect, ...treeProps }: FileTreeViewProps) {
  const activeFilePathStoreRef = useRef<ActiveFilePathStore | null>(null)
  if (!activeFilePathStoreRef.current) activeFilePathStoreRef.current = new ActiveFilePathStore()
  const activeFilePathStore = activeFilePathStoreRef.current
  const openFilePendingPathStoreRef = useRef<ActiveFilePathStore | null>(null)
  if (!openFilePendingPathStoreRef.current) openFilePendingPathStoreRef.current = new ActiveFilePathStore()
  const openFilePendingPathStore = openFilePendingPathStoreRef.current
  const selectedFilePathStoreRef = useRef<SelectedFilePathStore | null>(null)
  if (!selectedFilePathStoreRef.current) selectedFilePathStoreRef.current = new SelectedFilePathStore()
  const selectedFilePathStore = selectedFilePathStoreRef.current
  const treeSelectionTimerRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    activeFilePathStore.set(activeFilePath)
  }, [activeFilePath, activeFilePathStore])
  useLayoutEffect(() => {
    openFilePendingPathStore.set(openFilePendingPath || undefined)
  }, [openFilePendingPath, openFilePendingPathStore])
  const handleSelectFilePath = useCallback((filePath: string) => {
    if (treeSelectionTimerRef.current !== null) {
      window.clearTimeout(treeSelectionTimerRef.current)
      treeSelectionTimerRef.current = null
    }
    selectedFilePathStore.set([filePath])
    return () => {
      if (treeSelectionTimerRef.current !== null) window.clearTimeout(treeSelectionTimerRef.current)
      treeSelectionTimerRef.current = window.setTimeout(() => {
        treeSelectionTimerRef.current = null
        treeProps.treeRef.current?.select(filePath, { focus: false })
      }, 100)
    }
  }, [selectedFilePathStore, treeProps.treeRef])
  const handleTreeSelect = useCallback((nodes: Array<{ data: FileExplorerNode }>) => {
    if (treeSelectionTimerRef.current !== null) {
      window.clearTimeout(treeSelectionTimerRef.current)
      treeSelectionTimerRef.current = null
    }
    // react-arborist may publish an empty selection when its hidden focus
    // target blurs. Keyboard ownership moving to a tab or Monaco must not
    // erase the Explorer's last explicit selection.
    if (nodes.length > 0) selectedFilePathStore.set(nodes.map(node => node.data.path))
    onTreeSelect(nodes)
  }, [onTreeSelect, selectedFilePathStore])
  useLayoutEffect(() => () => {
    if (treeSelectionTimerRef.current !== null) window.clearTimeout(treeSelectionTimerRef.current)
  }, [])
  return (
    <FileTreeViewContent
      {...treeProps}
      activeFilePathStore={activeFilePathStore}
      openFilePendingPathStore={openFilePendingPathStore}
      selectedFilePathStore={selectedFilePathStore}
      onSelectFilePath={handleSelectFilePath}
      onTreeSelect={handleTreeSelect}
    />
  )
}
