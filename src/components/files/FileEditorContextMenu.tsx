import { useRef } from 'react'
import type { CodeCopy } from '../code/copy'
import { useWorkspaceMenuKeyboard } from './useWorkspaceMenuKeyboard'

export type FileEditorContextAction =
  | 'cut'
  | 'copy'
  | 'paste'
  | 'select-all'
  | 'toggle-blame'
  | 'line-changes-previous'
  | 'line-changes-working'

interface FileEditorContextMenuProps {
  x: number
  y: number
  copy: CodeCopy
  blameOpen: boolean
  readOnly: boolean
  showBlameContextAction: boolean
  showLineChangesContextActions: boolean
  onClose: () => void
  onRunAction: (action: FileEditorContextAction) => void
}

export function FileEditorContextMenu({
  x,
  y,
  copy,
  blameOpen,
  readOnly,
  showBlameContextAction,
  showLineChangesContextActions,
  onClose,
  onRunAction,
}: FileEditorContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const handleMenuKeyDown = useWorkspaceMenuKeyboard({
    menuOpen: true,
    menuRef,
    onClose,
  })

  return (
    <div
      ref={menuRef}
      className="code-editor-context-menu"
      data-testid="code-editor-context-menu"
      role="menu"
      style={{ left: x, top: y }}
      onKeyDown={handleMenuKeyDown}
      onMouseDown={event => event.stopPropagation()}
    >
      {showBlameContextAction && (
        <>
          <button type="button" role="menuitem" onClick={() => onRunAction('toggle-blame')}>
            {blameOpen ? copy.hideBlame : copy.annotateWithBlame}
          </button>
          <div className="code-editor-context-separator" role="separator" />
        </>
      )}
      {showLineChangesContextActions && (
        <>
          <button type="button" role="menuitem" onClick={() => onRunAction('line-changes-previous')}>
            {copy.openLineChangesWithPreviousRevision}
          </button>
          <button type="button" role="menuitem" onClick={() => onRunAction('line-changes-working')}>
            {copy.openLineChangesWithWorkingFile}
          </button>
          <div className="code-editor-context-separator" role="separator" />
        </>
      )}
      <button type="button" role="menuitem" onClick={() => onRunAction('cut')} disabled={readOnly}>{copy.cut}</button>
      <button type="button" role="menuitem" onClick={() => onRunAction('copy')}>{copy.copy}</button>
      <button type="button" role="menuitem" onClick={() => onRunAction('paste')} disabled={readOnly}>{copy.paste}</button>
      <button type="button" role="menuitem" onClick={() => onRunAction('select-all')}>{copy.selectAll}</button>
    </div>
  )
}
