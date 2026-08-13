import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
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
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const onCancelRef = useRef(onCancel)
  const savingRef = useRef(saving)
  onCancelRef.current = onCancel
  savingRef.current = saving

  useEffect(() => {
    const appRoot = document.getElementById('root')
    const returnFocusTarget = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const previousInert = appRoot?.inert ?? false
    const previousAriaHidden = appRoot?.getAttribute('aria-hidden') ?? null
    if (appRoot) {
      appRoot.inert = true
      appRoot.setAttribute('aria-hidden', 'true')
    }
    cancelButtonRef.current?.focus({ preventScroll: true })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!savingRef.current) onCancelRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const buttons = Array.from(
        dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
      )
      event.preventDefault()
      event.stopImmediatePropagation()
      if (buttons.length === 0) return
      const activeIndex = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const nextIndex = event.shiftKey
        ? (activeIndex <= 0 ? buttons.length - 1 : activeIndex - 1)
        : (activeIndex === -1 || activeIndex === buttons.length - 1 ? 0 : activeIndex + 1)
      buttons[nextIndex]?.focus({ preventScroll: true })
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      if (appRoot) {
        appRoot.inert = previousInert
        if (previousAriaHidden === null) appRoot.removeAttribute('aria-hidden')
        else appRoot.setAttribute('aria-hidden', previousAriaHidden)
      }
      if (returnFocusTarget?.isConnected) returnFocusTarget.focus({ preventScroll: true })
    }
  }, [])

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
          <button type="button" className="primary" onClick={onConfirmSave} disabled={saving}>
            {saving ? copy.savingFile : copy.save}
          </button>
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
