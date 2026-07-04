import type { MutableRefObject, RefObject } from 'react'
import type { NodeRendererProps, TreeApi } from 'react-arborist'
import { iconForDirectoryPath, iconForFilePath } from '@/lib/file-icons'
import type {
  WorkspaceFileOperationState,
} from '@/lib/workspace-file-operation-model'
import type { WorkspaceFileTreeNode as FileExplorerNode } from '@/lib/workspace-file-tree'
import {
  workspaceFileTreeDepthStyle,
  workspaceFileTreeRowViewState,
} from '@/lib/workspace-file-tree-row'
import type { CodeCopy } from '../code/copy'
import { FileTreeInlineOperation } from './FileTreeInlineOperation'
import { FileTreeRowStatus } from './FileTreeRowStatus'
import { useFileTreeRowInteractions } from './useFileTreeRowInteractions'

interface FileTreeRowProps {
  activeFilePath?: string
  agentId: string
  copy: CodeCopy
  editorDirtyFilePaths: ReadonlySet<string>
  editorExternalChangedFilePaths: ReadonlySet<string>
  fileOperation: WorkspaceFileOperationState | null
  fileOperationInputRef: RefObject<HTMLInputElement | null>
  lastFocusedFilePathRef: MutableRefObject<string | null>
  node: NodeRendererProps<FileExplorerNode>['node']
  treeRef: MutableRefObject<TreeApi<FileExplorerNode> | undefined>
  treeViewportRef: RefObject<HTMLDivElement | null>
  onCloseFileOperation: () => void
  onFocusFileTreeTarget: (item: FileExplorerNode | null) => void
  onHydrateCompactDirectoryChains: (path: string) => Promise<unknown>
  onOpenFileContextMenu: (x: number, y: number, item: FileExplorerNode | null) => void
  onOpenFilePath: (filePath: string) => Promise<void>
  onRefreshTreeLayout: () => void
  onRememberFileOperationName: (name: string) => void
  onSetDirectoryOpen: (path: string, open: boolean) => void
  onSubmitFileOperation: () => Promise<void>
  onUpdateFileOperationName: (name: string) => void
}

export function FileTreeRow({
  activeFilePath,
  agentId,
  copy,
  editorDirtyFilePaths,
  editorExternalChangedFilePaths,
  fileOperation,
  fileOperationInputRef,
  lastFocusedFilePathRef,
  node,
  treeRef,
  treeViewportRef,
  onCloseFileOperation,
  onFocusFileTreeTarget,
  onHydrateCompactDirectoryChains,
  onOpenFileContextMenu,
  onOpenFilePath,
  onRefreshTreeLayout,
  onRememberFileOperationName,
  onSetDirectoryOpen,
  onSubmitFileOperation,
  onUpdateFileOperationName,
}: FileTreeRowProps) {
  const item = node.data
  const viewState = workspaceFileTreeRowViewState({
    activeFilePath,
    editorDirtyFilePaths,
    editorExternalChangedFilePaths,
    item,
    isFocused: node.isFocused,
    isOpen: node.isOpen,
    isSelected: node.isSelected,
  })
  const {
    chevronState,
    isDirectory,
    rowClasses,
  } = viewState
  const iconUrl = isDirectory
    ? iconForDirectoryPath(item.iconPath ?? item.path, node.isOpen, item.iconSignals)
    : iconForFilePath(item.path)
  const inlineRenameOperation = fileOperation?.kind === 'rename' && fileOperation.item?.path === item.path
    ? fileOperation
    : null
  const {
    handleRowClick,
    handleRowContextMenu,
  } = useFileTreeRowInteractions({
    isDirectory,
    item,
    lastFocusedFilePathRef,
    node,
    treeRef,
    treeViewportRef,
    onFocusFileTreeTarget,
    onHydrateCompactDirectoryChains,
    onOpenFileContextMenu,
    onOpenFilePath,
    onRefreshTreeLayout,
    onSetDirectoryOpen,
  })

  return (
    <div
      className={rowClasses}
      style={workspaceFileTreeDepthStyle(node.level)}
      data-testid="code-file-row"
      data-file-path={item.path}
      data-file-type={item.type}
      data-tree-level={node.level}
      title={item.path}
      tabIndex={-1}
      aria-expanded={isDirectory ? node.isOpen : undefined}
      onContextMenu={handleRowContextMenu}
      onClick={handleRowClick}
    >
      <span className={`code-file-chevron ${chevronState}`} aria-hidden="true" />
      <img
        className={`code-file-type-icon ${isDirectory ? 'folder' : 'file'} ${isDirectory && node.isOpen ? 'open' : ''}`}
        src={iconUrl}
        alt=""
        aria-hidden="true"
      />
      {inlineRenameOperation ? (
        <FileTreeInlineOperation
          agentId={agentId}
          copy={copy}
          fileOperation={inlineRenameOperation}
          inputRef={fileOperationInputRef}
          item={item}
          onCancel={onCloseFileOperation}
          onInputName={onRememberFileOperationName}
          onSubmit={onSubmitFileOperation}
          onUpdateName={onUpdateFileOperationName}
        />
      ) : (
        <FileTreeRowStatus
          copy={copy}
          item={item}
          viewState={viewState}
        />
      )}
    </div>
  )
}
