import type { RefObject } from 'react'
import type {
  WorkspaceFileContextMenuState as FileContextMenuState,
  WorkspaceFileOperationKind,
  WorkspaceFileOperationState,
} from '@/lib/workspace-file-operation-model'
import type { AgentLaunchOption } from '../code/agent-launch-options'
import type { CodeCopy } from '../code/copy'
import { FileContextMenu } from './FileContextMenu'
import { FileOperationDialog } from './FileOperationDialog'

interface FileSectionOverlaysProps {
  agentId: string
  copy: CodeCopy
  agentLaunchOptions: AgentLaunchOption[]
  fileMenu: FileContextMenuState | null
  fileMenuRef: RefObject<HTMLDivElement | null>
  fileOperation: WorkspaceFileOperationState | null
  fileOperationInputRef: RefObject<HTMLInputElement | null>
  onCloseFileMenu: () => void
  onCloseFileMenuWithFocusRestore: () => void
  onCloseFileOperation: () => void
  onCopyFileMenuPath: () => void
  onCopyFileMenuShareUrl: () => void
  onOpenNewAgent: () => void
  onRefreshFileMenuTarget: () => void
  onRememberFileOperationName: (name: string) => void
  onStartAgent: (command: string) => void
  onStartFileMenuOperation: (kind: WorkspaceFileOperationKind) => void
  onSubmitFileOperation: () => Promise<void>
  onUpdateFileOperationName: (name: string) => void
  readOnly?: boolean
}

export function FileSectionOverlays({
  agentId,
  copy,
  agentLaunchOptions,
  fileMenu,
  fileMenuRef,
  fileOperation,
  fileOperationInputRef,
  onCloseFileMenu,
  onCloseFileMenuWithFocusRestore,
  onCloseFileOperation,
  onCopyFileMenuPath,
  onCopyFileMenuShareUrl,
  onOpenNewAgent,
  onRefreshFileMenuTarget,
  onRememberFileOperationName,
  onStartAgent,
  onStartFileMenuOperation,
  onSubmitFileOperation,
  onUpdateFileOperationName,
  readOnly = false,
}: FileSectionOverlaysProps) {
  return (
    <>
      <FileContextMenu
        copy={copy}
        agentLaunchOptions={agentLaunchOptions}
        fileMenu={fileMenu}
        menuRef={fileMenuRef}
        onClose={onCloseFileMenu}
        onCloseWithFocusRestore={onCloseFileMenuWithFocusRestore}
        onCopyRelativePath={onCopyFileMenuPath}
        onCopyShareUrl={onCopyFileMenuShareUrl}
        onOpenNewAgent={onOpenNewAgent}
        onRefreshTarget={onRefreshFileMenuTarget}
        onStartAgent={onStartAgent}
        onStartOperation={onStartFileMenuOperation}
        readOnly={readOnly}
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
