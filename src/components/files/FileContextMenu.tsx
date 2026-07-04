import type { RefObject } from 'react'
import type {
  WorkspaceFileContextMenuState as FileContextMenuState,
  WorkspaceFileOperationKind as FileOperationKind,
} from '@/lib/workspace-file-operation-model'
import type { CodeCopy } from '../code/copy'
import { useWorkspaceMenuKeyboard } from './useWorkspaceMenuKeyboard'

interface FileContextMenuProps {
  copy: CodeCopy
  fileMenu: FileContextMenuState | null
  menuRef: RefObject<HTMLDivElement | null>
  onClose: () => void
  onCloseWithFocusRestore: () => void
  onCopyRelativePath: () => void
  onRefreshTarget: () => void
  onStartOperation: (kind: FileOperationKind) => void
}

export function FileContextMenu({
  copy,
  fileMenu,
  menuRef,
  onClose,
  onCloseWithFocusRestore,
  onCopyRelativePath,
  onRefreshTarget,
  onStartOperation,
}: FileContextMenuProps) {
  const handleFileMenuKeyDown = useWorkspaceMenuKeyboard({
    menuOpen: Boolean(fileMenu),
    menuRef,
    onClose,
    onCloseWithFocusRestore,
  })

  if (!fileMenu) return null

  return (
    <div
      ref={menuRef}
      className="code-context-menu code-file-context-menu"
      data-testid="code-file-context-menu"
      style={{ left: fileMenu.x, top: fileMenu.y }}
      role="menu"
      onKeyDown={handleFileMenuKeyDown}
      onMouseDown={event => event.stopPropagation()}
    >
      <button type="button" role="menuitem" autoFocus onClick={() => onStartOperation('new-file')}>
        {copy.newFile}
      </button>
      <button type="button" role="menuitem" onClick={() => onStartOperation('new-folder')}>
        {copy.newFolder}
      </button>
      <button type="button" role="menuitem" onClick={onRefreshTarget}>
        {copy.refresh}
      </button>
      {fileMenu.item && (
        <>
          <div className="code-context-menu-separator" role="separator" />
          <button type="button" role="menuitem" onClick={() => onStartOperation('rename')}>
            {copy.rename}
          </button>
          <button type="button" role="menuitem" onClick={onCopyRelativePath}>
            {copy.copyRelativePath}
          </button>
          <div className="code-context-menu-separator" role="separator" />
          <button type="button" role="menuitem" className="danger" onClick={() => onStartOperation('delete')}>
            {copy.delete}
          </button>
        </>
      )}
    </div>
  )
}
