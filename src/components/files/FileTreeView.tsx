import { createContext, useCallback, useContext, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type MutableRefObject, type RefObject } from 'react'
import { Tree, type NodeRendererProps, type TreeApi } from 'react-arborist'
import type { WorkspaceFileOpenTarget } from '@/lib/workspace-file-search'
import type { WorkspaceFileOperationState } from '@/lib/workspace-file-operation-model'
import type { WorkspaceFileTreeNode as FileExplorerNode } from '@/lib/workspace-file-tree'
import type { CodeCopy } from '../code/copy'
import { FileStickyContext } from './FileStickyContext'
import { FileTreeRow } from './FileTreeRow'
import type { FileStickyContextItem } from './useWorkspaceFileStickyContext'

export interface FileTreeViewProps {
  activeFilePath?: string
  agentId: string
  copy: CodeCopy
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
  | 'handleTreeKeyDownCapture'
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
>

const FileNodeRendererContext = createContext<FileNodeRendererContextValue | null>(null)

function FileNodeRenderer({ node }: NodeRendererProps<FileExplorerNode>) {
  const props = useContext(FileNodeRendererContext)
  if (!props) return null
  return <FileTreeRow {...props} node={node} />
}

export function FileTreeView({
  activeFilePath,
  agentId,
  copy,
  editorDirtyFilePaths,
  editorExternalChangedFilePaths,
  fileOperation,
  fileOperationInputRef,
  handleTreeKeyDownCapture,
  lastFocusedFilePathRef,
  locatedFilePath,
  openFilePendingPath,
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
  onRememberFileOperationName,
  onToggleDirectory,
  onSubmitFileOperation,
  onToggleTreeNode,
  onTreeFocus,
  onTreeSelect,
  onUpdateFileOperationName,
}: FileTreeViewProps) {
  const pointerFileClickRef = useRef<{
    clientX: number
    clientY: number
    filePath: string
    timeStamp: number
  } | null>(null)

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

  const nodeRendererContext: FileNodeRendererContextValue = {
    activeFilePath,
    agentId,
    copy,
    editorDirtyFilePaths,
    editorExternalChangedFilePaths,
    fileOperation,
    fileOperationInputRef,
    lastFocusedFilePathRef,
    locatedFilePath,
    openFilePendingPath,
    treeViewportRef,
    onCancelPendingFileFocus,
    onCloseFileOperation,
    onFocusFileTreeTarget,
    onOpenFileContextMenu,
    onOpenFilePath,
    onRememberFileOperationName,
    onToggleDirectory,
    onSubmitFileOperation,
    onUpdateFileOperationName,
  }

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
        items={stickyContextItems}
        onFocusDirectory={onFocusStickyDirectory}
        onOpenFileContextMenu={onOpenFileContextMenu}
      />
      <FileNodeRendererContext.Provider value={nodeRendererContext}>
        <Tree<FileExplorerNode>
          ref={treeRef}
          data={treeData}
          idAccessor="id"
          childrenAccessor="children"
          rowHeight={rowHeight}
          indent={0}
          height={treeHeight}
          width="100%"
          overscanCount={visibleTreeRowCount}
          openByDefault={false}
          selectionFollowsFocus
          className="code-file-tree"
          rowClassName="code-file-tree-row"
          renderRow={renderFileTreeRow}
          onToggle={onToggleTreeNode}
          onFocus={onTreeFocus}
          onSelect={onTreeSelect}
          disableDrag
          disableEdit
          disableDrop
        >
          {FileNodeRenderer}
        </Tree>
      </FileNodeRendererContext.Provider>
    </div>
  )
}
