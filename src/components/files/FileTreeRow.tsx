import type { MutableRefObject, RefObject } from 'react'
import type { NodeRendererProps } from 'react-arborist'
import { ChevronDownGlyph, ChevronRightGlyph } from '@/components/IconGlyphs'
import { iconForFilePath } from '@/lib/file-icons'
import type {
  WorkspaceFileOperationState,
} from '@/lib/workspace-file-operation-model'
import type { WorkspaceFileTreeNode as FileExplorerNode } from '@/lib/workspace-file-tree'
import {
  workspaceFileTreeDepthStyle,
  workspaceFileTreeRowViewState,
} from '@/lib/workspace-file-tree-row'
import type { WorkspaceFileOpenTarget } from '@/lib/workspace-open-files'
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
  locatedFilePath?: string | null
  node: NodeRendererProps<FileExplorerNode>['node']
  openFilePendingPath?: string | null
  treeViewportRef: RefObject<HTMLDivElement | null>
  onCancelPendingFileFocus: () => void
  onCloseFileOperation: () => void
  onFocusFileTreeTarget: (item: FileExplorerNode | null) => void
  onOpenFileContextMenu: (x: number, y: number, item: FileExplorerNode | null) => void
  onOpenFilePath: (filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void>
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
  locatedFilePath,
  node,
  openFilePendingPath,
  treeViewportRef,
  onCancelPendingFileFocus,
  onCloseFileOperation,
  onFocusFileTreeTarget,
  onOpenFileContextMenu,
  onOpenFilePath,
  onRememberFileOperationName,
  onSetDirectoryOpen,
  onSubmitFileOperation,
}: FileTreeRowProps) {
  const item = node.data
  const viewState = workspaceFileTreeRowViewState({
    activeFilePath,
    editorDirtyFilePaths,
    editorExternalChangedFilePaths,
    openFilePendingPath,
    item,
    isFocused: node.isFocused,
    isOpen: node.isOpen,
    isSelected: node.isSelected,
  })
  const {
    chevronState,
    isDirectory,
  } = viewState
  const rowClasses = `${viewState.rowClasses} ${locatedFilePath === item.path ? 'located' : ''}`.trim()
  const iconUrl = isDirectory ? '' : iconForFilePath(item.path)
  const inlineRenameOperation = fileOperation?.kind === 'rename' && fileOperation.item?.path === item.path
    ? fileOperation
    : null
  const {
    handleRowClick,
    handleRowContextMenu,
    handleRowMouseDown,
  } = useFileTreeRowInteractions({
    isDirectory,
    item,
    lastFocusedFilePathRef,
    node,
    treeViewportRef,
    onCancelPendingFileFocus,
    onFocusFileTreeTarget,
    onOpenFileContextMenu,
    onOpenFilePath,
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
      aria-label={item.path}
      title={item.linkTarget ? `${item.path} ↷ ${item.linkTarget}` : item.linkError ? `${item.path} (${item.linkError})` : undefined}
      tabIndex={-1}
      aria-expanded={isDirectory ? node.isOpen : undefined}
      onContextMenu={handleRowContextMenu}
      onMouseDown={handleRowMouseDown}
      onClick={handleRowClick}
    >
      <span className={`code-file-chevron ${chevronState}`} aria-hidden="true">
        {chevronState === 'expanded' ? <ChevronDownGlyph /> : chevronState === 'collapsed' ? <ChevronRightGlyph /> : null}
      </span>
      {!isDirectory && (
        <img className="code-file-type-icon file" src={iconUrl} alt="" aria-hidden="true" />
      )}
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
