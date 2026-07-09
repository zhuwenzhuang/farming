import { useCallback, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type MutableRefObject, type RefObject } from 'react'
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
  onSubmitFileOperation: () => Promise<void>
  onToggleTreeNode: (path: string) => void
  onTreeFocus: (node: { data: FileExplorerNode } | null | undefined) => void
  onTreeSelect: (nodes: Array<{ data: FileExplorerNode }>) => void
  onUpdateFileOperationName: (name: string) => void
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
  onSubmitFileOperation,
  onToggleTreeNode,
  onTreeFocus,
  onTreeSelect,
  onUpdateFileOperationName,
}: FileTreeViewProps) {
  const handleViewportContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement | null)?.closest('[data-file-path]')) return
    event.preventDefault()
    onCancelPendingFileFocus()
    onOpenFileContextMenu(event.clientX, event.clientY, null)
  }, [onCancelPendingFileFocus, onOpenFileContextMenu])

  const FileNodeRenderer = useCallback(({
    node,
  }: NodeRendererProps<FileExplorerNode>) => (
    <FileTreeRow
      activeFilePath={activeFilePath}
      agentId={agentId}
      copy={copy}
      editorDirtyFilePaths={editorDirtyFilePaths}
      editorExternalChangedFilePaths={editorExternalChangedFilePaths}
      fileOperation={fileOperation}
      fileOperationInputRef={fileOperationInputRef}
      lastFocusedFilePathRef={lastFocusedFilePathRef}
      locatedFilePath={locatedFilePath}
      node={node}
      openFilePendingPath={openFilePendingPath}
      treeViewportRef={treeViewportRef}
      onCancelPendingFileFocus={onCancelPendingFileFocus}
      onCloseFileOperation={onCloseFileOperation}
      onFocusFileTreeTarget={onFocusFileTreeTarget}
      onOpenFileContextMenu={onOpenFileContextMenu}
      onOpenFilePath={onOpenFilePath}
      onRememberFileOperationName={onRememberFileOperationName}
      onSubmitFileOperation={onSubmitFileOperation}
      onUpdateFileOperationName={onUpdateFileOperationName}
    />
  ), [activeFilePath, agentId, copy, editorDirtyFilePaths, editorExternalChangedFilePaths, fileOperation, fileOperationInputRef, lastFocusedFilePathRef, locatedFilePath, onCancelPendingFileFocus, onCloseFileOperation, onFocusFileTreeTarget, onOpenFileContextMenu, onOpenFilePath, onRememberFileOperationName, onSubmitFileOperation, onUpdateFileOperationName, openFilePendingPath, treeViewportRef])

  return (
    <div
      className="code-file-tree-viewport"
      ref={treeViewportRef}
      data-visible-row-count={visibleTreeRowCount}
      style={{ height: treeHeight }}
      onKeyDownCapture={handleTreeKeyDownCapture}
      onContextMenu={handleViewportContextMenu}
    >
      <FileStickyContext
        copy={copy}
        items={stickyContextItems}
        onFocusDirectory={onFocusStickyDirectory}
      />
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
    </div>
  )
}
