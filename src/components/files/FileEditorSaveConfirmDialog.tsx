import type { CodeCopy } from '../code/copy'

interface FileEditorSaveConfirmDialogProps {
  label: string
  saving: boolean
  copy: CodeCopy
  onConfirmSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

export function FileEditorSaveConfirmDialog({
  label,
  saving,
  copy,
  onConfirmSave,
  onDiscard,
  onCancel,
}: FileEditorSaveConfirmDialogProps) {
  return (
    <div
      className="code-file-save-confirm-backdrop"
      data-testid="code-file-save-confirm"
      role="presentation"
      onMouseDown={event => event.stopPropagation()}
    >
      <div
        className="code-file-save-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="code-file-save-confirm-title"
        aria-describedby="code-file-save-confirm-description"
        onKeyDown={event => {
          if (event.key === 'Escape' && !saving) {
            event.preventDefault()
            onCancel()
          }
        }}
      >
        <div className="code-file-save-confirm-brand" aria-hidden="true">F</div>
        <h2 id="code-file-save-confirm-title">{copy.saveBeforeCloseTitle(label)}</h2>
        <p id="code-file-save-confirm-description">{copy.saveBeforeCloseDescription}</p>
        <div className="code-file-save-confirm-actions">
          <button type="button" className="primary" onClick={onConfirmSave} disabled={saving}>
            {saving ? copy.savingFile : copy.save}
          </button>
          <button type="button" onClick={onDiscard} disabled={saving}>
            {copy.dontSave}
          </button>
          <button type="button" onClick={onCancel} disabled={saving}>
            {copy.cancel}
          </button>
        </div>
      </div>
    </div>
  )
}
