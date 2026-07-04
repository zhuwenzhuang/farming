import type { RefObject } from 'react'
import type {
  WorkspaceFileContextMenuState as FileContextMenuState,
  WorkspaceFileOperationKind,
  WorkspaceFileOperationState,
} from '@/lib/workspace-file-operation-model'
import type { CodeCopy } from '../code/copy'
import { FileContextMenu } from './FileContextMenu'
import { FileOperationDialog } from './FileOperationDialog'

interface FileSectionOverlaysProps {
  agentId: string
  copy: CodeCopy
  fileMenu: FileContextMenuState | null
  fileMenuRef: RefObject<HTMLDivElement | null>
  fileOperation: WorkspaceFileOperationState | null
  fileOperationInputRef: RefObject<HTMLInputElement | null>
  onCloseFileMenu: () => void
  onCloseFileMenuWithFocusRestore: () => void
  onCloseFileOperation: () => void
  onCopyFileMenuPath: () => void
  onRefreshFileMenuTarget: () => void
  onRememberFileOperationName: (name: string) => void
  onStartFileMenuOperation: (kind: WorkspaceFileOperationKind) => void
  onSubmitFileOperation: () => Promise<void>
  onUpdateFileOperationName: (name: string) => void
}

export function FileSectionOverlays({
  agentId,
  copy,
  fileMenu,
  fileMenuRef,
  fileOperation,
  fileOperationInputRef,
  onCloseFileMenu,
  onCloseFileMenuWithFocusRestore,
  onCloseFileOperation,
  onCopyFileMenuPath,
  onRefreshFileMenuTarget,
  onRememberFileOperationName,
  onStartFileMenuOperation,
  onSubmitFileOperation,
  onUpdateFileOperationName,
}: FileSectionOverlaysProps) {
  return (
    <>
      <FileContextMenu
        copy={copy}
        fileMenu={fileMenu}
        menuRef={fileMenuRef}
        onClose={onCloseFileMenu}
        onCloseWithFocusRestore={onCloseFileMenuWithFocusRestore}
        onCopyRelativePath={onCopyFileMenuPath}
        onRefreshTarget={onRefreshFileMenuTarget}
        onStartOperation={onStartFileMenuOperation}
      />
      <FileOperationDialog
        agentId={agentId}
        copy={copy}
        fileOperation={fileOperation}
        inputRef={fileOperationInputRef}
        onCancel={onCloseFileOperation}
        onInputName={onRememberFileOperationName}
        onSubmit={() => {
          void onSubmitFileOperation()
        }}
        onUpdateName={onUpdateFileOperationName}
      />
    </>
  )
}
