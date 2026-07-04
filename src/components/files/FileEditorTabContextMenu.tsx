import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import { hasCleanWorkspaceWorkingCopy } from '@/lib/workspace-working-copy'
import type { CodeCopy } from '../code/copy'
import type { FileEditorTabContextMenuState } from './useFileEditorTabsController'

interface FileEditorTabContextMenuProps {
  menu: FileEditorTabContextMenuState
  openFiles: OpenWorkspaceFile[]
  copy: CodeCopy
  onRunAction: (action: 'close' | 'close-others' | 'close-right' | 'close-saved' | 'close-all') => void
}

export function FileEditorTabContextMenu({
  menu,
  openFiles,
  copy,
  onRunAction,
}: FileEditorTabContextMenuProps) {
  return (
    <div
      className="code-context-menu code-file-tab-context-menu"
      data-testid="code-file-tab-context-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
    >
      <button type="button" role="menuitem" onClick={() => onRunAction('close')}>{copy.close}</button>
      <button type="button" role="menuitem" onClick={() => onRunAction('close-others')} disabled={openFiles.length <= 1}>{copy.closeOthers}</button>
      <button type="button" role="menuitem" onClick={() => onRunAction('close-right')} disabled={menu.index >= openFiles.length - 1}>{copy.closeToRight}</button>
      <button
        type="button"
        role="menuitem"
        onClick={() => onRunAction('close-saved')}
        disabled={!hasCleanWorkspaceWorkingCopy(openFiles)}
      >
        {copy.closeSaved}
      </button>
      <div className="code-context-menu-separator" role="separator" />
      <button type="button" role="menuitem" onClick={() => onRunAction('close-all')}>{copy.closeAll}</button>
    </div>
  )
}
