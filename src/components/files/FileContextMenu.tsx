import type { RefObject } from 'react'
import type {
  WorkspaceFileContextMenuState as FileContextMenuState,
  WorkspaceFileOperationKind as FileOperationKind,
} from '@/lib/workspace-file-operation-model'
import type { AgentLaunchOption } from '../code/agent-launch-options'
import { AgentLaunchSubmenu } from '../code/AgentLaunchSubmenu'
import type { CodeCopy } from '../code/copy'
import { useWorkspaceMenuKeyboard } from './useWorkspaceMenuKeyboard'

interface FileContextMenuProps {
  copy: CodeCopy
  agentLaunchOptions: AgentLaunchOption[]
  fileMenu: FileContextMenuState | null
  menuRef: RefObject<HTMLDivElement | null>
  onClose: () => void
  onCloseWithFocusRestore: () => void
  onCopyRelativePath: () => void
  onCopyShareUrl: () => void
  onOpenNewAgent: () => void
  onRefreshTarget: () => void
  onStartAgent: (command: string) => void
  onStartOperation: (kind: FileOperationKind) => void
  readOnly?: boolean
}

export function FileContextMenu({
  copy,
  agentLaunchOptions,
  fileMenu,
  menuRef,
  onClose,
  onCloseWithFocusRestore,
  onCopyRelativePath,
  onCopyShareUrl,
  onOpenNewAgent,
  onRefreshTarget,
  onStartAgent,
  onStartOperation,
  readOnly = false,
}: FileContextMenuProps) {
  const handleFileMenuKeyDown = useWorkspaceMenuKeyboard({
    menuOpen: Boolean(fileMenu),
    menuRef,
    onClose,
    onCloseWithFocusRestore,
  })

  if (!fileMenu) return null

  const targetReadOnly = fileMenu.item?.readOnly === true
  const canCreateInTarget = !readOnly && !targetReadOnly
  const canChangeTargetEntry = !readOnly && (!targetReadOnly || fileMenu.item?.symbolicLink === true)

  return (
    <div
      ref={menuRef}
      className="code-context-menu code-file-context-menu"
      data-testid="code-file-context-menu"
      style={{ left: fileMenu.x, top: fileMenu.y }}
      role="menu"
      onKeyDown={handleFileMenuKeyDown}
      onMouseDown={event => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {canCreateInTarget && (
        <>
          <button type="button" role="menuitem" autoFocus onClick={() => onStartOperation('new-file')}>
            {copy.newFile}
          </button>
          <button type="button" role="menuitem" onClick={() => onStartOperation('new-folder')}>
            {copy.newFolder}
          </button>
          <div className="code-context-menu-separator" role="separator" />
          <AgentLaunchSubmenu
            label={copy.newAgent}
            options={agentLaunchOptions}
            testId="file-new-agent-submenu-trigger"
            submenuTestId="file-new-agent-submenu"
            onOpenDialog={onOpenNewAgent}
            onSelect={onStartAgent}
          />
          <div className="code-context-menu-separator" role="separator" />
        </>
      )}
      <button type="button" role="menuitem" onClick={onRefreshTarget}>
        {copy.refresh}
      </button>
      {fileMenu.item && (
        <>
          <div className="code-context-menu-separator" role="separator" />
          {canChangeTargetEntry && (
            <button type="button" role="menuitem" onClick={() => onStartOperation('rename')}>
              {copy.rename}
            </button>
          )}
          <button type="button" role="menuitem" onClick={onCopyRelativePath}>
            {copy.copyRelativePath}
          </button>
          {(fileMenu.item.type === 'file' || fileMenu.item.type === 'directory') && (
            <button type="button" role="menuitem" onClick={onCopyShareUrl}>
              {copy.copyShareUrl}
            </button>
          )}
          {canChangeTargetEntry && (
            <>
              <div className="code-context-menu-separator" role="separator" />
              <button type="button" role="menuitem" className="danger" onClick={() => onStartOperation('delete')}>
                {copy.delete}
              </button>
            </>
          )}
        </>
      )}
    </div>
  )
}
