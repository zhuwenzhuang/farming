import { useRef } from 'react'
import { useModalFocusScope } from '@/hooks/useModalFocusScope'
import { createPortal } from 'react-dom'
import type { CodeCopy } from '../code/copy'

interface FileEditorSaveConfirmDialogProps {
  label: string
  saving: boolean
  allowSave: boolean
  copy: CodeCopy
  onConfirmSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

export function FileEditorSaveConfirmDialog({
  label,
  saving,
  allowSave,
  copy,
  onConfirmSave,
  onDiscard,
  onCancel,
}: FileEditorSaveConfirmDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const dialogRef = useModalFocusScope<HTMLDivElement>({
    open: true,
    initialFocusRef: cancelButtonRef,
    returnFocusRef,
    onEscape: onCancel,
    escapeEnabled: !saving,
  })

  return createPortal(
    <div
      className="code-file-save-confirm-backdrop"
      data-testid="code-file-save-confirm"
      role="presentation"
      onMouseDown={event => event.stopPropagation()}
    >
      <div
        ref={dialogRef}
        className="code-file-save-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="code-file-save-confirm-title"
        aria-describedby="code-file-save-confirm-description"
      >
        <div className="code-file-save-confirm-brand" aria-hidden="true">F</div>
        <h2 id="code-file-save-confirm-title">{copy.saveBeforeCloseTitle(label)}</h2>
        <p id="code-file-save-confirm-description">{copy.saveBeforeCloseDescription}</p>
        <div className="code-file-save-confirm-actions">
          {allowSave ? (
            <button type="button" className="primary" onClick={onConfirmSave} disabled={saving}>
              {saving ? copy.savingFile : copy.save}
            </button>
          ) : null}
          <button type="button" onClick={onDiscard} disabled={saving}>
            {copy.dontSave}
          </button>
          <button ref={cancelButtonRef} type="button" onClick={onCancel} disabled={saving}>
            {copy.cancel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
