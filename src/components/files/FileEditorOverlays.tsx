import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import type { WorkspaceFileBlame } from '@/lib/workspace-files'
import type { CodeCopy } from '../code/copy'
import { FileEditorBlameToast } from './FileEditorBlameToast'
import { FileEditorContextMenu, type FileEditorContextAction } from './FileEditorContextMenu'
import { FileEditorSaveConfirmDialog } from './FileEditorSaveConfirmDialog'
import { FileEditorTabContextMenu } from './FileEditorTabContextMenu'
import type { FileEditorTabContextMenuState } from './useFileEditorTabsController'

interface FileEditorContextMenuOverlayState {
  x: number
  y: number
}

interface FileEditorOverlaysProps {
  blame: WorkspaceFileBlame | null
  blameError: string | null
  blameLoading: boolean
  blameOpen: boolean
  copy: CodeCopy
  editorContextMenu: FileEditorContextMenuOverlayState | null
  readOnly: boolean
  openFiles: OpenWorkspaceFile[]
  pendingCloseOpen: boolean
  pendingCloseLabel: string
  pendingCloseSaving: boolean
  showBlameContextAction: boolean
  showLineChangesContextActions: boolean
  tabContextMenu: FileEditorTabContextMenuState | null
  onCancelPendingClose: () => void
  onCloseEditorContextMenu: () => void
  onConfirmSaveAndClose: () => Promise<void>
  onDiscardAndClose: () => void
  onRunEditorContextAction: (action: FileEditorContextAction) => Promise<void>
  onRunTabContextAction: (action: 'close' | 'close-others' | 'close-right' | 'close-saved' | 'close-all') => void
}

export function FileEditorOverlays({
  blame,
  blameError,
  blameLoading,
  blameOpen,
  copy,
  editorContextMenu,
  readOnly,
  openFiles,
  pendingCloseOpen,
  pendingCloseLabel,
  pendingCloseSaving,
  showBlameContextAction,
  showLineChangesContextActions,
  tabContextMenu,
  onCancelPendingClose,
  onCloseEditorContextMenu,
  onConfirmSaveAndClose,
  onDiscardAndClose,
  onRunEditorContextAction,
  onRunTabContextAction,
}: FileEditorOverlaysProps) {
  return (
    <>
      {editorContextMenu && (
        <FileEditorContextMenu
          x={editorContextMenu.x}
          y={editorContextMenu.y}
	          copy={copy}
	          blameOpen={blameOpen}
	          readOnly={readOnly}
          showBlameContextAction={showBlameContextAction}
          showLineChangesContextActions={showLineChangesContextActions}
          onClose={onCloseEditorContextMenu}
          onRunAction={action => void onRunEditorContextAction(action)}
        />
      )}
      {tabContextMenu && (
        <FileEditorTabContextMenu
          menu={tabContextMenu}
          openFiles={openFiles}
          copy={copy}
          onRunAction={onRunTabContextAction}
        />
      )}
      {pendingCloseOpen && (
        <FileEditorSaveConfirmDialog
          label={pendingCloseLabel}
          saving={pendingCloseSaving}
          copy={copy}
          onConfirmSave={() => void onConfirmSaveAndClose()}
          onDiscard={onDiscardAndClose}
          onCancel={onCancelPendingClose}
        />
      )}
      {blameOpen && (
        <FileEditorBlameToast
          blame={blame}
          loading={blameLoading}
          error={blameError}
          copy={copy}
        />
      )}
    </>
  )
}
